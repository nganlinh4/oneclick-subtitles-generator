//! A decoded sample, and the lock that makes its pixels readable.
//!
//! This is where the reference implementation's hardest-won lesson is made structural. It records
//! that the surface allocator reclaims a decoded frame's memory as soon as the `IMFSample`'s
//! refcount reaches zero — *even while something is still reading from it* — and that the resulting
//! corruption looks like a compositor bug rather than a lifetime bug, so it is diagnosed in the
//! wrong crate for a long time before anyone suspects the decoder.
//!
//! The rule "keep the sample alive while you read its pixels" is therefore not written down here as
//! a rule. It is written down as a lifetime: [`SampleLock`] borrows the [`SourceSample`] that owns
//! the memory, and the pixel slice borrows the lock. There is no way to name the bytes without
//! holding both, so the mistake is not one a later change can reintroduce by forgetting.
//!
//! ```compile_fail
//! # use osg_decode::mf::SourceSample;
//! # use osg_decode::planes::FrameGeometry;
//! fn escape(sample: SourceSample, geometry: FrameGeometry) -> Vec<u8> {
//!     let lock = sample.lock(0).expect("locked");
//!     let planes = lock.planes(geometry).expect("planes");
//!     drop(sample);            // the memory may be reclaimed here
//!     planes.to_rgba8(osg_decode::colorimetry::SourceColorimetry::STUDIO_BT709)
//! }
//! ```
//!
//! That example fails to compile with `E0505`, "cannot move out of `sample` because it is
//! borrowed" — the borrow checker refusing to release the memory while something can still read it.
//!
//! The two `unsafe` blocks that take a pointer are the only pointer-level code in the crate;
//! everything that decides *what* to read is safe code over the slice they produce.

use core::fmt;
use core::marker::PhantomData;
use core::ptr;
use core::slice;

use windows::Win32::Media::MediaFoundation::{
    IMF2DBuffer2, IMFMediaBuffer, IMFSample, MF2DBuffer_LockFlags_Read,
};
use windows::core::Interface as _;

use crate::error::{DecodeError, MfStage};
use crate::mf::platform::platform_error;
use crate::planes::{FrameGeometry, NvPlanes};

/// One decoded sample, holding the platform's frame memory alive.
///
/// Dropping this releases the sample, at which point the platform may reuse the memory
/// immediately. Nothing that reads pixels can outlive it; see the module documentation.
pub struct SourceSample {
    sample: IMFSample,
    presentation_100ns: i64,
    duration_100ns: i64,
}

impl fmt::Debug for SourceSample {
    /// Reports the sample's place on the timeline and nothing about the interface behind it, so a
    /// decoder's debug output carries no process addresses.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SourceSample")
            .field("presentation_100ns", &self.presentation_100ns)
            .field("duration_100ns", &self.duration_100ns)
            .finish_non_exhaustive()
    }
}

impl SourceSample {
    pub(crate) const fn new(
        sample: IMFSample,
        presentation_100ns: i64,
        duration_100ns: i64,
    ) -> Self {
        Self {
            sample,
            presentation_100ns,
            duration_100ns,
        }
    }

    /// The instant this frame is presented at, in 100ns units, as the container reports it.
    #[must_use]
    pub const fn presentation_100ns(&self) -> i64 {
        self.presentation_100ns
    }

    /// How long this frame is shown for, in 100ns units.
    #[must_use]
    pub const fn duration_100ns(&self) -> i64 {
        self.duration_100ns
    }

    /// The GPU-resident Media Foundation sample.
    ///
    /// Kept crate-private: callers receive the typed DXGI surface wrapper instead of being able to
    /// detach the COM sample from the texture whose allocator lifetime it owns.
    pub(crate) fn interface(&self) -> &IMFSample {
        &self.sample
    }

    /// Locks the sample's memory for reading.
    ///
    /// `fallback_stride` is used only when the platform hands back a buffer that cannot describe
    /// its own row pitch; it comes from the media type's declared stride, or the frame width when
    /// even that is absent.
    ///
    /// # Errors
    /// Returns [`DecodeError::MediaFoundation`] when the platform refuses the lock, and
    /// [`DecodeError::UnsupportedFrameLayout`] for a buffer whose rows run bottom-up or whose
    /// reported extent does not contain the frame it is supposed to hold.
    pub fn lock(&self, fallback_stride: usize) -> Result<SampleLock<'_>, DecodeError> {
        // SAFETY: the sample is live for the duration of the call and hands back an owned,
        // reference-counted buffer; when the sample already holds exactly one buffer this is that
        // buffer rather than a copy.
        let buffer = unsafe { self.sample.ConvertToContiguousBuffer() }
            .map_err(|error| platform_error(MfStage::SampleBuffer, &error))?;

        match buffer.cast::<IMF2DBuffer2>() {
            Ok(planar) => SampleLock::planar(planar),
            Err(_) => SampleLock::linear(buffer, fallback_stride),
        }
    }
}

/// Which flavour of buffer is locked, so the matching unlock can be issued on drop.
#[derive(Debug)]
enum LockedBuffer {
    /// Locked through `IMF2DBuffer2::Lock2DSize`, which reports the row pitch and the real extent.
    Planar(IMF2DBuffer2),
    /// Locked through `IMFMediaBuffer::Lock`, which reports neither and has to be told the stride.
    Linear(IMFMediaBuffer),
}

/// An acquired lock on a decoded sample's memory, released on drop.
///
/// The guard exists so the buffer is unlocked on every exit path, including a panic in a caller. A
/// media buffer that stays locked is never released by the platform, and the source reader
/// eventually stalls waiting for it.
pub struct SampleLock<'sample> {
    buffer: LockedBuffer,
    start: *const u8,
    length: usize,
    stride: usize,
    /// Ties this lock, and therefore every slice taken from it, to the sample that owns the memory.
    sample: PhantomData<&'sample SourceSample>,
}

impl fmt::Debug for SampleLock<'_> {
    /// Reports the shape of the locked region and not its address or its contents.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SampleLock")
            .field("bytes", &self.length)
            .field("stride", &self.stride)
            .finish_non_exhaustive()
    }
}

impl SampleLock<'_> {
    /// Locks a buffer that can describe its own layout.
    fn planar(planar: IMF2DBuffer2) -> Result<Self, DecodeError> {
        let mut scanline0: *mut u8 = ptr::null_mut();
        let mut pitch: i32 = 0;
        let mut start: *mut u8 = ptr::null_mut();
        let mut length: u32 = 0;

        // SAFETY: all four out-parameters are live locals for the duration of the call. `Lock2DSize`
        // writes the first scanline, the row pitch, the buffer origin and the buffer extent, and the
        // pointers stay valid until the matching `Unlock2D`, which this guard's `Drop` performs.
        unsafe {
            planar.Lock2DSize(
                MF2DBuffer_LockFlags_Read,
                &raw mut scanline0,
                &raw mut pitch,
                &raw mut start,
                &raw mut length,
            )
        }
        .map_err(|error| platform_error(MfStage::LockBuffer, &error))?;

        // Constructed empty first, so every rejection below still unlocks.
        let mut guard = Self {
            buffer: LockedBuffer::Planar(planar),
            start: ptr::null(),
            length: 0,
            stride: 0,
            sample: PhantomData,
        };
        if scanline0.is_null() || start.is_null() || pitch <= 0 {
            // A non-positive pitch means the rows run bottom-up. Nothing this crate decodes
            // produces one, and quietly reading it as top-down would mirror every exported frame.
            return Err(DecodeError::UnsupportedFrameLayout);
        }

        let origin = start.addr();
        let first_row = scanline0.addr();
        let offset = first_row
            .checked_sub(origin)
            .ok_or(DecodeError::UnsupportedFrameLayout)?;
        let extent = usize::try_from(length).map_err(|_| DecodeError::UnsupportedFrameLayout)?;
        let readable = extent
            .checked_sub(offset)
            .ok_or(DecodeError::UnsupportedFrameLayout)?;

        guard.start = scanline0.cast_const();
        guard.length = readable;
        guard.stride = usize::try_from(pitch).map_err(|_| DecodeError::UnsupportedFrameLayout)?;
        Ok(guard)
    }

    /// Locks a buffer that cannot, using the stride the media type declared.
    fn linear(buffer: IMFMediaBuffer, stride: usize) -> Result<Self, DecodeError> {
        let mut data: *mut u8 = ptr::null_mut();
        let mut max_length: u32 = 0;
        let mut current_length: u32 = 0;

        // SAFETY: all three out-parameters are live locals for the duration of the call. `Lock`
        // writes a pointer to the buffer's storage together with its capacity and its filled
        // length, and the pointer stays valid until the matching `Unlock`, which this guard's
        // `Drop` performs.
        unsafe {
            buffer.Lock(
                &raw mut data,
                Some(&raw mut max_length),
                Some(&raw mut current_length),
            )
        }
        .map_err(|error| platform_error(MfStage::LockBuffer, &error))?;

        // Constructed empty first, so every rejection below still unlocks.
        let mut guard = Self {
            buffer: LockedBuffer::Linear(buffer),
            start: ptr::null(),
            length: 0,
            stride: 0,
            sample: PhantomData,
        };
        if data.is_null() || stride == 0 {
            return Err(DecodeError::UnsupportedFrameLayout);
        }
        // A buffer that has not been told how much of it is filled still holds its capacity, and a
        // decoded frame fills what it was allocated for.
        //
        // Be clear about what this is: an assumption, not a report. When the platform says the
        // current length is zero we substitute the allocated capacity, which stays inside the
        // allocation — `Lock` hands back `max_length` as the size it allocated — so this cannot read
        // out of bounds. What it can read is bytes the decoder did not write, which would surface as
        // a corrupt frame rather than a crash. The frame-size check downstream still has to pass, so
        // a buffer too small for the declared geometry is refused either way.
        let filled = if current_length == 0 {
            max_length
        } else {
            current_length
        };

        guard.start = data.cast_const();
        guard.length = usize::try_from(filled).map_err(|_| DecodeError::UnsupportedFrameLayout)?;
        guard.stride = stride;
        Ok(guard)
    }

    /// The row pitch of the locked frame, in bytes.
    #[must_use]
    pub const fn stride(&self) -> usize {
        self.stride
    }

    /// The locked bytes.
    ///
    /// The returned slice borrows `self`, which borrows the sample, so it cannot outlive the memory
    /// it points at.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        if self.start.is_null() || self.length == 0 {
            return &[];
        }
        // SAFETY: `planar`/`linear` established that `start` is non-null and that `length` bytes
        // behind it are inside the allocation the platform reported through `Lock` — either its
        // current length or, when that is zero, the capacity it allocated, which bounds the former.
        // The lock is held for as long as `self` lives, `self` borrows the sample that owns the
        // memory, and `&self` means no mutable view of the region exists.
        unsafe { slice::from_raw_parts(self.start, self.length) }
    }

    /// The locked bytes as NV12 planes.
    ///
    /// # Errors
    /// Returns [`DecodeError::SampleTooSmall`] when the platform's buffer is shorter than the frame
    /// it declares, and [`DecodeError::UnsupportedFrameLayout`] when the stride cannot hold a row.
    pub fn planes(&self, geometry: FrameGeometry) -> Result<NvPlanes<'_>, DecodeError> {
        NvPlanes::from_contiguous(self.bytes(), self.stride, geometry)
    }
}

impl Drop for SampleLock<'_> {
    fn drop(&mut self) {
        match &self.buffer {
            LockedBuffer::Planar(planar) => {
                // SAFETY: this variant is only constructed after a successful `Lock2DSize` on the
                // same buffer, and exactly once per lock, so this is the matching `Unlock2D`. A
                // failure here cannot be reported from `drop` and cannot be recovered from either.
                let _ = unsafe { planar.Unlock2D() };
            }
            LockedBuffer::Linear(linear) => {
                // SAFETY: as above, for the matching `Unlock` of a successful `Lock`.
                let _ = unsafe { linear.Unlock() };
            }
        }
    }
}
