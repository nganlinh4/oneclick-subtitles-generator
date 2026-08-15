//! The deterministic test scene.
//!
//! The scene exists to prove the pipeline, not to draw subtitles: it is the fixed reference image
//! the foundation tests assert against. It has no RNG and reads no clock. Every pixel is a pure
//! function of the frame size and the caller-supplied [`TestScene::phase`], so a frame rendered at a
//! given phase is byte-identical across runs and seeking is exact.

use crate::error::CompositorError;
use crate::size::FrameSize;

/// The byte length of the uniform block the shader reads.
pub(crate) const UNIFORM_LEN: usize = 16;

/// A deterministic reference scene.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TestScene {
    phase: f32,
}

impl TestScene {
    /// Builds a scene at a normalised animation phase.
    ///
    /// `phase` stands in for the sampled frame time the real renderer will supply. It must be a
    /// finite value in `0.0..=1.0`; a clock is never consulted.
    pub fn new(phase: f32) -> Result<Self, CompositorError> {
        if !phase.is_finite() || !(0.0..=1.0).contains(&phase) {
            return Err(CompositorError::PhaseOutOfRange { value: phase });
        }
        Ok(Self { phase })
    }

    /// The scene at phase zero.
    ///
    /// This is the golden frame the determinism tests compare against.
    #[must_use]
    pub const fn origin() -> Self {
        Self { phase: 0.0 }
    }

    /// The normalised animation phase.
    #[must_use]
    pub const fn phase(self) -> f32 {
        self.phase
    }

    /// Packs the shader uniform block: `vec2<f32>` size, `f32` phase, `f32` padding.
    ///
    /// Bytes are laid out explicitly in little-endian order rather than transmuted, so the crate
    /// needs no `bytemuck` and no `unsafe`.
    #[allow(
        clippy::cast_precision_loss,
        reason = "frame edges are bounded to 8192 and are exactly representable in f32"
    )]
    pub(crate) fn uniform_bytes(self, size: FrameSize) -> [u8; UNIFORM_LEN] {
        let mut bytes = [0_u8; UNIFORM_LEN];
        let fields = [
            size.width() as f32,
            size.height() as f32,
            self.phase,
            0.0_f32,
        ];
        for (slot, value) in bytes.chunks_exact_mut(4).zip(fields) {
            slot.copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }
}

impl Default for TestScene {
    fn default() -> Self {
        Self::origin()
    }
}
