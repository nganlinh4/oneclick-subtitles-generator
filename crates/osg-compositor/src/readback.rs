//! Copying a composed texture back into host memory.
//!
//! GPU readback rows are padded to [`wgpu::COPY_BYTES_PER_ROW_ALIGNMENT`]. This module owns the one
//! place that padding is understood, and hands back tightly packed rows so no caller has to know
//! about it.

use std::sync::mpsc;

use wgpu::{
    Buffer, BufferDescriptor, BufferUsages, CommandEncoder, MapMode, Origin3d, PollType,
    TexelCopyBufferInfo, TexelCopyBufferLayout, TexelCopyTextureInfo, Texture, TextureAspect,
};

use crate::error::CompositorError;
use crate::size::FrameSize;

/// The number of RGBA8 bytes in one unpadded row.
const BYTES_PER_PIXEL: u32 = 4;

/// The padded row stride a texture-to-buffer copy requires.
pub(crate) const fn padded_bytes_per_row(width: u32) -> u32 {
    let unpadded = width * BYTES_PER_PIXEL;
    let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    unpadded.div_ceil(alignment) * alignment
}

/// Allocates the staging buffer a readback of `size` needs.
pub(crate) fn staging_buffer(device: &wgpu::Device, size: FrameSize) -> Buffer {
    let stride = u64::from(padded_bytes_per_row(size.width()));
    device.create_buffer(&BufferDescriptor {
        label: Some("osg-compositor readback"),
        size: stride * u64::from(size.height()),
        usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
        mapped_at_creation: false,
    })
}

/// Records the texture-to-buffer copy for a whole frame.
pub(crate) fn record_copy(
    encoder: &mut CommandEncoder,
    texture: &Texture,
    staging: &Buffer,
    size: FrameSize,
) {
    encoder.copy_texture_to_buffer(
        TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: Origin3d::ZERO,
            aspect: TextureAspect::All,
        },
        TexelCopyBufferInfo {
            buffer: staging,
            layout: TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_bytes_per_row(size.width())),
                rows_per_image: Some(size.height()),
            },
        },
        frame_extent(size),
    );
}

/// The 2D copy extent for a whole frame.
pub(crate) const fn frame_extent(size: FrameSize) -> wgpu::Extent3d {
    wgpu::Extent3d {
        width: size.width(),
        height: size.height(),
        depth_or_array_layers: 1,
    }
}

/// Maps the staging buffer and copies the padded rows into a tightly packed vector.
pub(crate) fn read_packed(
    device: &wgpu::Device,
    staging: &Buffer,
    size: FrameSize,
) -> Result<Vec<u8>, CompositorError> {
    let (sender, receiver) = mpsc::channel();
    staging.slice(..).map_async(MapMode::Read, move |result| {
        // A closed channel only means the compositor gave up first; the map result is then moot.
        let _ = sender.send(result);
    });

    device
        .poll(PollType::wait_indefinitely())
        .map_err(|error| CompositorError::ReadbackFailed {
            reason: format!("waiting for the GPU queue failed: {error}"),
        })?;

    receiver
        .recv()
        .map_err(|_| CompositorError::ReadbackFailed {
            reason: "the buffer mapping never completed".to_owned(),
        })?
        .map_err(|error| CompositorError::ReadbackFailed {
            reason: format!("mapping the readback buffer failed: {error}"),
        })?;

    let packed = {
        let view = staging.slice(..).get_mapped_range().map_err(|error| {
            CompositorError::ReadbackFailed {
                reason: format!("reading the readback buffer failed: {error}"),
            }
        })?;
        unpad_rows(&view, size)
    };
    staging.unmap();

    Ok(packed)
}

fn unpad_rows(padded: &[u8], size: FrameSize) -> Vec<u8> {
    let stride = padded_bytes_per_row(size.width()) as usize;
    let row_len = (size.width() * BYTES_PER_PIXEL) as usize;
    let mut packed = Vec::with_capacity(row_len * size.height() as usize);
    for row in padded.chunks(stride).take(size.height() as usize) {
        packed.extend_from_slice(&row[..row_len]);
    }
    packed
}
