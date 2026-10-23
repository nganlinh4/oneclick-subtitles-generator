//! Memory-budgeted shared texture rings that bound decode and encode backpressure.

use std::sync::Arc;

use osg_compositor::FrameSize;
use windows::Win32::Graphics::Direct3D11::ID3D11Device;

use crate::GpuVideoError;
use crate::shared::SharedSurface;

pub(super) const DECODE_RING_MAX: usize = 3;
pub(super) const ENCODE_RING_MAX: usize = 16;
const MIN_RING_SIZE: usize = 2;
const RING_MEMORY_BUDGET: u64 = 256 * 1024 * 1024;

pub(super) fn shared_ring(
    owner: &ID3D11Device,
    wgpu_device: &wgpu::Device,
    size: FrameSize,
    usage: wgpu::TextureUsages,
    count: usize,
) -> Result<Vec<Arc<SharedSurface>>, GpuVideoError> {
    (0..count)
        .map(|_| {
            SharedSurface::new(owner, wgpu_device, size.width(), size.height(), usage).map(Arc::new)
        })
        .collect()
}

pub(super) fn ring_size(size: FrameSize, maximum: usize) -> usize {
    let bytes_per_frame = u64::from(size.width())
        .saturating_mul(u64::from(size.height()))
        .saturating_mul(4);
    let within_budget = RING_MEMORY_BUDGET
        .checked_div(bytes_per_frame)
        .and_then(|count| usize::try_from(count).ok())
        .unwrap_or(maximum);
    within_budget.clamp(MIN_RING_SIZE, maximum)
}

#[cfg(test)]
mod tests {
    use osg_compositor::FrameSize;

    use super::{DECODE_RING_MAX, ENCODE_RING_MAX, ring_size};

    #[test]
    fn output_ring_uses_depth_sixteen_at_1080p() {
        let size = FrameSize::new(1_920, 1_080).expect("1080p");
        assert_eq!(ring_size(size, ENCODE_RING_MAX), 16);
    }

    #[test]
    fn output_ring_stays_inside_the_vram_budget_at_4k() {
        let size = FrameSize::new(3_840, 2_160).expect("4K");
        assert_eq!(ring_size(size, ENCODE_RING_MAX), 8);
    }

    #[test]
    fn small_frames_are_capped_at_the_ring_maximum() {
        let size = FrameSize::new(64, 64).expect("small");
        assert_eq!(ring_size(size, ENCODE_RING_MAX), ENCODE_RING_MAX);
        assert_eq!(ring_size(size, DECODE_RING_MAX), DECODE_RING_MAX);
    }

    #[test]
    fn extreme_frames_keep_only_the_two_slots_needed_for_overlap() {
        let size = FrameSize::new(7_680, 4_320).expect("8K");
        assert_eq!(ring_size(size, ENCODE_RING_MAX), 2);
        assert_eq!(ring_size(size, DECODE_RING_MAX), 2);
    }
}
