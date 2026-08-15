//! The PCM block the caller and the encoder meet at.
//!
//! The platform AAC encoder is fed 32-bit float PCM, interleaved, in the machine's byte order.
//! Every Windows target is little-endian, so the packing below is both the native order and a fixed
//! one — which matters, because a byte order that depended on the host would make an export
//! non-reproducible for no benefit.

use crate::config::AudioConfig;
use crate::error::EncodeError;

/// A validated, borrowed block of interleaved 32-bit float PCM.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioBlock<'samples> {
    samples: &'samples [f32],
    channels: u32,
}

impl<'samples> AudioBlock<'samples> {
    /// Validates `samples` as a whole number of interleaved frames for `config`.
    ///
    /// # Errors
    /// Returns [`EncodeError::AudioBlockMisaligned`] when the sample count is not a multiple of the
    /// channel count.
    pub fn new(samples: &'samples [f32], config: AudioConfig) -> Result<Self, EncodeError> {
        let channels = config.channels().count();
        let divisor = usize::try_from(channels).unwrap_or(usize::MAX);
        if divisor == 0 || !samples.len().is_multiple_of(divisor) {
            return Err(EncodeError::AudioBlockMisaligned {
                channels,
                samples: samples.len(),
            });
        }
        Ok(Self { samples, channels })
    }

    /// The interleaved samples.
    #[must_use]
    pub const fn samples(&self) -> &'samples [f32] {
        self.samples
    }

    /// How many interleaved frames the block carries.
    #[must_use]
    pub fn frame_count(&self) -> u64 {
        let channels = u64::from(self.channels).max(1);
        u64::try_from(self.samples.len()).unwrap_or(u64::MAX) / channels
    }

    /// The number of bytes [`Self::copy_as_le_bytes`] writes.
    #[must_use]
    pub fn byte_len(&self) -> usize {
        self.samples.len() * 4
    }

    /// Writes the block into `destination` as little-endian `f32`.
    ///
    /// # Errors
    /// Returns [`EncodeError::AudioBlockMisaligned`] when `destination` is not exactly
    /// [`Self::byte_len`] bytes.
    pub fn copy_as_le_bytes(&self, destination: &mut [u8]) -> Result<(), EncodeError> {
        if destination.len() != self.byte_len() {
            return Err(EncodeError::AudioBlockMisaligned {
                channels: self.channels,
                samples: destination.len(),
            });
        }
        for (sample, slot) in self.samples.iter().zip(destination.chunks_exact_mut(4)) {
            slot.copy_from_slice(&sample.to_le_bytes());
        }
        Ok(())
    }
}
