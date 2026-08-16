//! The NV12 planes a decoded sample exposes, and their conversion to what the compositor consumes.
//!
//! Media Foundation hands back 4:2:0 planar bytes: a full-resolution luma plane, then a
//! half-resolution plane of interleaved blue and red chroma. Both are laid out by *stride*, not by
//! width — the platform is free to pad every row — so reading them as `width * height` bytes works
//! on the machine it was written on and produces a sheared image on the next one.
//!
//! Everything here is pure: a borrowed view over bytes, with the geometry checked once on
//! construction so the per-pixel loop can index without a bound in sight. That makes the whole
//! conversion testable from plain vectors, with no GPU, no media file and no platform.

use core::fmt;

use crate::colorimetry::{SourceColorimetry, YuvToRgb};
use crate::error::DecodeError;
use crate::presentation::Rotation;

/// The size of one decoded frame, checked against what 4:2:0 chroma can describe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameGeometry {
    width: usize,
    height: usize,
}

impl FrameGeometry {
    /// Checks `width` and `height` as an NV12 frame size.
    ///
    /// # Errors
    /// Returns [`DecodeError::UnsupportedFrameLayout`] when either edge is zero or odd — 4:2:0
    /// chroma is half resolution in both axes, so an odd edge has no chroma sample to cover its
    /// last row or column — or when the RGBA frame the size implies would not be addressable.
    pub fn new(width: u32, height: u32) -> Result<Self, DecodeError> {
        let layout = DecodeError::UnsupportedFrameLayout;
        if width == 0 || height == 0 || !width.is_multiple_of(2) || !height.is_multiple_of(2) {
            return Err(layout);
        }
        let width = usize::try_from(width).map_err(|_| layout)?;
        let height = usize::try_from(height).map_err(|_| layout)?;
        // Checked once, here, so `rgba_bytes` and the conversion loop cannot overflow later.
        width
            .checked_mul(height)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(layout)?;
        Ok(Self { width, height })
    }

    /// The frame width in pixels.
    #[must_use]
    pub const fn width(self) -> usize {
        self.width
    }

    /// The frame height in pixels.
    #[must_use]
    pub const fn height(self) -> usize {
        self.height
    }

    /// The number of chroma rows, one per two luma rows.
    #[must_use]
    pub const fn chroma_rows(self) -> usize {
        self.height / 2
    }

    /// The same frame with its axes swapped, which is what a quarter turn produces.
    ///
    /// Infallible, and const, because every invariant [`Self::new`] checked is symmetric in the two
    /// edges: both stay even and non-zero, and the pixel count — and therefore the addressability of
    /// the RGBA frame — is unchanged.
    #[must_use]
    pub const fn transposed(self) -> Self {
        Self {
            width: self.height,
            height: self.width,
        }
    }

    /// The smallest NV12 buffer that can hold this frame at `stride`.
    ///
    /// Tight rather than generous: the last row only has to be `width` bytes long, so a platform
    /// buffer that stops exactly at the end of the image is accepted instead of being refused for
    /// missing padding nobody reads.
    #[must_use]
    pub fn required_bytes(self, stride: usize) -> Option<usize> {
        let luma = stride.checked_mul(self.height)?;
        let chroma = stride.checked_mul(self.chroma_rows().checked_sub(1)?)?;
        luma.checked_add(chroma)?.checked_add(self.width)
    }

    /// The byte count of the RGBA8 frame this geometry converts to.
    ///
    /// Infallible because [`Self::new`] already proved the product is addressable.
    #[must_use]
    pub const fn rgba_bytes(self) -> usize {
        self.width * self.height * 4
    }
}

/// A borrowed, validated view of one decoded frame's NV12 planes.
///
/// The lifetime is the point. On the Windows backend this view is produced from a locked sample
/// buffer, so `'pixels` is bounded by the lock, which is itself bounded by the `IMFSample` that
/// owns the memory. There is no way to hold these bytes past the sample's life, because there is no
/// way to name them without the borrow.
#[derive(Clone, Copy)]
pub struct NvPlanes<'pixels> {
    luma: &'pixels [u8],
    chroma: &'pixels [u8],
    luma_stride: usize,
    chroma_stride: usize,
    geometry: FrameGeometry,
}

impl fmt::Debug for NvPlanes<'_> {
    /// Redacted on purpose: these bytes are the user's video. A `{:?}` of a frame must be as safe
    /// to log as an error is, so it reports the shape and not the picture.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NvPlanes")
            .field("width", &self.geometry.width())
            .field("height", &self.geometry.height())
            .field("luma_stride", &self.luma_stride)
            .field("chroma_stride", &self.chroma_stride)
            .finish_non_exhaustive()
    }
}

impl<'pixels> NvPlanes<'pixels> {
    /// Views two separately addressed planes.
    ///
    /// # Errors
    /// Returns [`DecodeError::UnsupportedFrameLayout`] when either stride is narrower than the
    /// frame, and [`DecodeError::SampleTooSmall`] when either plane is shorter than the rows it is
    /// supposed to hold.
    pub fn new(
        luma: &'pixels [u8],
        luma_stride: usize,
        chroma: &'pixels [u8],
        chroma_stride: usize,
        geometry: FrameGeometry,
    ) -> Result<Self, DecodeError> {
        if luma_stride < geometry.width() || chroma_stride < geometry.width() {
            return Err(DecodeError::UnsupportedFrameLayout);
        }
        let luma_needed = plane_bytes(luma_stride, geometry.height(), geometry.width())?;
        check_plane(luma.len(), luma_needed)?;
        let chroma_needed = plane_bytes(chroma_stride, geometry.chroma_rows(), geometry.width())?;
        check_plane(chroma.len(), chroma_needed)?;

        Ok(Self {
            luma,
            chroma,
            luma_stride,
            chroma_stride,
            geometry,
        })
    }

    /// Views one contiguous NV12 buffer, where the chroma plane follows the luma plane at the same
    /// stride.
    ///
    /// This is the layout every Media Foundation NV12 buffer uses, and the one a test can build by
    /// hand.
    ///
    /// # Errors
    /// Returns [`DecodeError::UnsupportedFrameLayout`] when the stride is narrower than the frame,
    /// and [`DecodeError::SampleTooSmall`] when the buffer is shorter than the frame it declares.
    pub fn from_contiguous(
        bytes: &'pixels [u8],
        stride: usize,
        geometry: FrameGeometry,
    ) -> Result<Self, DecodeError> {
        if stride < geometry.width() {
            return Err(DecodeError::UnsupportedFrameLayout);
        }
        let needed = geometry
            .required_bytes(stride)
            .ok_or(DecodeError::UnsupportedFrameLayout)?;
        check_plane(bytes.len(), needed)?;
        let split = stride
            .checked_mul(geometry.height())
            .ok_or(DecodeError::UnsupportedFrameLayout)?;
        let (luma, chroma) = bytes.split_at(split);
        Self::new(luma, stride, chroma, stride, geometry)
    }

    /// The frame's geometry.
    #[must_use]
    pub const fn geometry(&self) -> FrameGeometry {
        self.geometry
    }

    /// The luma sample at `(x, y)`, or `None` outside the frame.
    #[must_use]
    pub fn luma_at(&self, x: usize, y: usize) -> Option<u8> {
        if x >= self.geometry.width() || y >= self.geometry.height() {
            return None;
        }
        self.luma.get(y * self.luma_stride + x).copied()
    }

    /// The blue and red chroma samples covering `(x, y)`, or `None` outside the frame.
    ///
    /// 4:2:0 chroma is shared by a two-by-two block of luma samples, so this returns the same pair
    /// for all four.
    #[must_use]
    pub fn chroma_at(&self, x: usize, y: usize) -> Option<(u8, u8)> {
        if x >= self.geometry.width() || y >= self.geometry.height() {
            return None;
        }
        let start = (y / 2) * self.chroma_stride + (x & !1);
        Some((*self.chroma.get(start)?, *self.chroma.get(start + 1)?))
    }

    /// Converts the frame to tightly packed RGBA8, top row first.
    ///
    /// This is the representation `osg_compositor::Frame` uses, so the decoded underlay and the
    /// subtitle layer meet without either side reinterpreting the other's bytes. Every pixel is
    /// opaque, which makes the result simultaneously valid as premultiplied and as straight alpha —
    /// there is nothing to un-premultiply when alpha is one everywhere.
    ///
    /// Chroma is upsampled by replication rather than interpolation. That is deterministic, which
    /// the parity contract requires, and it keeps a flat region of the source exactly flat instead
    /// of introducing a gradient across the block boundary that was never in the file.
    #[must_use]
    pub fn to_rgba8(&self, colorimetry: SourceColorimetry) -> Vec<u8> {
        let convert = YuvToRgb::new(colorimetry);
        let width = self.geometry.width();
        let height = self.geometry.height();
        // `NvPlanes::new` proved every row below is present, and `FrameGeometry::new` proved this
        // length is addressable, so nothing in the loop can be out of bounds.
        let mut pixels = vec![0_u8; self.geometry.rgba_bytes()];

        for row in 0..height {
            let luma = &self.luma[row * self.luma_stride..][..width];
            let chroma = &self.chroma[(row / 2) * self.chroma_stride..][..width];
            let output = &mut pixels[row * width * 4..][..width * 4];

            for (column, (rgba, &luma_sample)) in output.chunks_exact_mut(4).zip(luma).enumerate() {
                let pair = column & !1;
                let [red, green, blue] = convert.pixel(luma_sample, chroma[pair], chroma[pair + 1]);
                rgba[0] = red;
                rgba[1] = green;
                rgba[2] = blue;
                rgba[3] = u8::MAX;
            }
        }
        pixels
    }

    /// Converts the frame to tightly packed RGBA8, top row first, turned upright.
    ///
    /// The turn is applied while the pixels are being written, so a rotated source costs one scatter
    /// rather than a conversion followed by a copy of the whole frame. [`Rotation::None`] is
    /// delegated to [`Self::to_rgba8`] unchanged: an ordinary source keeps the row-at-a-time path it
    /// was measured on and pays nothing at all for rotation support.
    #[must_use]
    pub fn to_rgba8_rotated(&self, colorimetry: SourceColorimetry, rotation: Rotation) -> Vec<u8> {
        if rotation == Rotation::None {
            return self.to_rgba8(colorimetry);
        }
        let convert = YuvToRgb::new(colorimetry);
        let width = self.geometry.width();
        let height = self.geometry.height();
        let destination = rotation.geometry(self.geometry);
        let row_bytes = destination.width() * 4;
        // `NvPlanes::new` proved every source row below is present, `FrameGeometry::new` proved this
        // length is addressable, and `Rotation::place` is a bijection of the frame onto the
        // transposed one, so every index below is inside both buffers.
        let mut pixels = vec![0_u8; destination.rgba_bytes()];

        for row in 0..height {
            let luma = &self.luma[row * self.luma_stride..][..width];
            let chroma = &self.chroma[(row / 2) * self.chroma_stride..][..width];

            for (column, &luma_sample) in luma.iter().enumerate() {
                let pair = column & !1;
                let [red, green, blue] = convert.pixel(luma_sample, chroma[pair], chroma[pair + 1]);
                let (x, y) = rotation.place(column, row, width, height);
                let start = y * row_bytes + x * 4;
                pixels[start..start + 4].copy_from_slice(&[red, green, blue, u8::MAX]);
            }
        }
        pixels
    }
}

/// The smallest plane that holds `rows` rows of `width` bytes at `stride`.
fn plane_bytes(stride: usize, rows: usize, width: usize) -> Result<usize, DecodeError> {
    let layout = DecodeError::UnsupportedFrameLayout;
    let rows_before_last = rows.checked_sub(1).ok_or(layout)?;
    stride
        .checked_mul(rows_before_last)
        .and_then(|full| full.checked_add(width))
        .ok_or(layout)
}

/// Refuses a plane the platform reported as shorter than the rows it must hold.
fn check_plane(actual: usize, needed: usize) -> Result<(), DecodeError> {
    if actual >= needed {
        return Ok(());
    }
    Err(DecodeError::SampleTooSmall {
        expected: byte_count(needed),
        actual: byte_count(actual),
    })
}

/// A length as a `u64` for an error message.
///
/// Saturating rather than fallible: on every target this crate builds for, `usize` is 64 bits or
/// narrower, so the fallback is unreachable and does not deserve an error path of its own.
fn byte_count(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}
