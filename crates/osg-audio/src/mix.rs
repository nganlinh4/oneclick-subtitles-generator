//! Mixing N sources into one interleaved `f32` stream.
//!
//! # Determinism
//!
//! The same plan always produces bit-identical samples. There is no RNG, no clock and no
//! parallelism: sources are summed in the order the plan lists them, block by block, and each
//! block's frames are computed from their absolute output index rather than from a running
//! position. Reading the mix in blocks and reading it as one buffer therefore produce the same
//! bytes, and so do two runs on the same machine.
//!
//! # Clipping
//!
//! Sums are hard limited to `-1.0..=1.0` — saturating, never wrapping, because a wrap turns a loud
//! passage into a burst of noise. Clipping is never silent: [`MixStats`] reports how many samples
//! were limited and the peak magnitude before limiting, so a caller can warn, or re-run with lower
//! gains, on evidence rather than by guessing. A sample that arrives non-finite (a decoder fault)
//! is counted separately and forced to a finite value rather than being allowed to poison the
//! stream.

use osg_scene::{ExactTime, FrameTimeline};

use crate::error::AudioError;
use crate::format::{MAX_MIX_DURATION_SECONDS, OutputFormat};
use crate::source::{AudioSource, SourceReader};

/// How many frames one block of the mix carries.
pub const MIX_BLOCK_FRAMES: u64 = 4_096;
/// The most sources one mix may carry.
pub const MAX_SOURCES: usize = 8;
/// The most samples [`mix_to_buffer`] will hold in memory at once.
///
/// About eleven minutes of 48 kHz stereo. Longer mixes are read block by block through [`Mixer`],
/// which is what the encoder does; this ceiling exists so that asking for a whole render as one
/// `Vec` fails loudly instead of exhausting memory.
pub const MAX_BUFFERED_SAMPLES: u64 = 1 << 26;

/// What a mix did to its samples.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MixStats {
    clipped_samples: u64,
    non_finite_samples: u64,
    peak: f32,
}

impl MixStats {
    const EMPTY: Self = Self {
        clipped_samples: 0,
        non_finite_samples: 0,
        peak: 0.0,
    };

    /// How many samples were limited to full scale.
    #[must_use]
    pub const fn clipped_samples(self) -> u64 {
        self.clipped_samples
    }

    /// How many samples arrived non-finite and were forced to a finite value.
    #[must_use]
    pub const fn non_finite_samples(self) -> u64 {
        self.non_finite_samples
    }

    /// The largest magnitude seen before limiting. Above 1.0 means the mix clipped.
    #[must_use]
    pub const fn peak(self) -> f32 {
        self.peak
    }

    /// Whether any sample was limited.
    #[must_use]
    pub const fn clipped(self) -> bool {
        self.clipped_samples > 0
    }
}

/// A validated description of one mix.
#[derive(Debug)]
pub struct MixPlan {
    format: OutputFormat,
    frames: u64,
    sources: Vec<AudioSource>,
}

impl MixPlan {
    /// Build a plan for an explicit duration.
    ///
    /// # Errors
    /// Returns [`AudioError::TooManySources`] or [`AudioError::DurationOutOfRange`].
    pub fn new(
        format: OutputFormat,
        duration: ExactTime,
        sources: Vec<AudioSource>,
    ) -> Result<Self, AudioError> {
        if sources.len() > MAX_SOURCES {
            return Err(AudioError::TooManySources {
                value: sources.len(),
                max: MAX_SOURCES,
            });
        }
        let frames = format.frame_index(duration)?;
        if frames == 0 {
            return Err(AudioError::DurationOutOfRange {
                max: MAX_MIX_DURATION_SECONDS,
            });
        }
        Ok(Self {
            format,
            frames,
            sources,
        })
    }

    /// Build a plan whose duration is exactly the render's frame grid.
    ///
    /// This is the path the exporter uses: the audio ends on the same instant as the last video
    /// frame because both come from the same [`FrameTimeline`].
    ///
    /// # Errors
    /// Returns [`AudioError::UnsupportedTimeline`] when the timeline has no representable duration,
    /// and otherwise fails on the same terms as [`Self::new`].
    pub fn from_timeline(
        format: OutputFormat,
        timeline: FrameTimeline,
        sources: Vec<AudioSource>,
    ) -> Result<Self, AudioError> {
        let duration = timeline
            .duration()
            .map_err(|_| AudioError::UnsupportedTimeline)?;
        Self::new(format, duration, sources)
    }

    /// The format the mix produces.
    #[must_use]
    pub const fn format(&self) -> OutputFormat {
        self.format
    }

    /// How many output frames the mix produces.
    #[must_use]
    pub const fn frames(&self) -> u64 {
        self.frames
    }
}

/// A mix, read one block at a time.
#[derive(Debug)]
pub struct Mixer {
    format: OutputFormat,
    frames: u64,
    produced: u64,
    readers: Vec<SourceReader>,
    block: Vec<f32>,
    stats: MixStats,
}

impl Mixer {
    /// Open every source the plan needs and prepare the first block.
    ///
    /// A source at [`Volume::MUTED`](crate::Volume::MUTED) is skipped rather than opened: muting is
    /// the user saying "do not use this audio", so there is nothing to decode and no reason for a
    /// broken file behind a muted slider to fail the render.
    ///
    /// # Errors
    /// Returns whatever opening or validating a source returns.
    pub fn new(plan: MixPlan) -> Result<Self, AudioError> {
        let MixPlan {
            format,
            frames,
            sources,
        } = plan;
        let mut readers = Vec::with_capacity(sources.len());
        for source in &sources {
            if source.volume().is_muted() {
                continue;
            }
            readers.push(SourceReader::open(source, format)?);
        }
        let block_samples =
            usize::try_from(MIX_BLOCK_FRAMES).unwrap_or(usize::MAX) * format.channel_count();
        Ok(Self {
            format,
            frames,
            produced: 0,
            readers,
            block: vec![0.0; block_samples],
            stats: MixStats::EMPTY,
        })
    }

    /// The format of the samples this mixer produces.
    #[must_use]
    pub const fn format(&self) -> OutputFormat {
        self.format
    }

    /// How many frames the whole mix will produce.
    #[must_use]
    pub const fn total_frames(&self) -> u64 {
        self.frames
    }

    /// What the mix has done to its samples so far.
    #[must_use]
    pub const fn stats(&self) -> MixStats {
        self.stats
    }

    /// The next block of interleaved samples, or `None` at the end of the mix.
    ///
    /// The slice borrows the mixer's own buffer and is valid until the next call. Every block but
    /// the last carries [`MIX_BLOCK_FRAMES`] frames.
    ///
    /// # Errors
    /// Returns whatever decoding a source returns.
    pub fn next_block(&mut self) -> Result<Option<&[f32]>, AudioError> {
        if self.produced >= self.frames {
            return Ok(None);
        }
        let frames = MIX_BLOCK_FRAMES.min(self.frames - self.produced);
        let samples = usize::try_from(frames).unwrap_or(usize::MAX) * self.format.channel_count();
        let block = &mut self.block[..samples];
        block.fill(0.0);
        for reader in &mut self.readers {
            reader.add_into(block, self.produced, frames)?;
        }
        limit(block, &mut self.stats);
        self.produced += frames;
        Ok(Some(&self.block[..samples]))
    }
}

/// A whole mix held in memory.
#[derive(Debug)]
pub struct MixBuffer {
    format: OutputFormat,
    samples: Vec<f32>,
    stats: MixStats,
}

impl MixBuffer {
    /// The interleaved samples, `-1.0..=1.0`.
    #[must_use]
    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    /// Take ownership of the samples.
    #[must_use]
    pub fn into_samples(self) -> Vec<f32> {
        self.samples
    }

    /// The format the samples are in.
    #[must_use]
    pub const fn format(&self) -> OutputFormat {
        self.format
    }

    /// What the mix did to its samples.
    #[must_use]
    pub const fn stats(&self) -> MixStats {
        self.stats
    }

    /// How many frames the buffer holds.
    #[must_use]
    pub fn frames(&self) -> u64 {
        let channels = u64::from(self.format.channels()).max(1);
        u64::try_from(self.samples.len()).unwrap_or(u64::MAX) / channels
    }
}

/// Mix a whole plan into one buffer.
///
/// # Errors
/// Returns [`AudioError::MixTooLargeToBuffer`] when the plan does not fit
/// [`MAX_BUFFERED_SAMPLES`], and otherwise fails on the same terms as [`Mixer::next_block`].
pub fn mix_to_buffer(plan: MixPlan) -> Result<MixBuffer, AudioError> {
    let format = plan.format();
    let total = format
        .samples_for(plan.frames())
        .ok_or(AudioError::MixTooLargeToBuffer {
            max: MAX_BUFFERED_SAMPLES,
        })?;
    if total > MAX_BUFFERED_SAMPLES {
        return Err(AudioError::MixTooLargeToBuffer {
            max: MAX_BUFFERED_SAMPLES,
        });
    }
    let mut mixer = Mixer::new(plan)?;
    let mut samples = Vec::with_capacity(usize::try_from(total).unwrap_or(0));
    while let Some(block) = mixer.next_block()? {
        samples.extend_from_slice(block);
    }
    Ok(MixBuffer {
        format,
        samples,
        stats: mixer.stats(),
    })
}

/// Saturate a block to full scale, recording what it cost.
fn limit(block: &mut [f32], stats: &mut MixStats) {
    for sample in block.iter_mut() {
        let value = *sample;
        if !value.is_finite() {
            stats.non_finite_samples += 1;
            *sample = if value.is_nan() {
                0.0
            } else if value.is_sign_positive() {
                1.0
            } else {
                -1.0
            };
            continue;
        }
        let magnitude = value.abs();
        if magnitude > stats.peak {
            stats.peak = magnitude;
        }
        if value > 1.0 {
            stats.clipped_samples += 1;
            *sample = 1.0;
        } else if value < -1.0 {
            stats.clipped_samples += 1;
            *sample = -1.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{MixStats, limit};

    #[test]
    #[expect(
        clippy::float_cmp,
        reason = "the assertion is exact by design: samples must be bit-identical"
    )]
    fn limiting_saturates_and_counts() {
        let mut block = [0.5, 1.5, -2.0, -0.25];
        let mut stats = MixStats::EMPTY;
        limit(&mut block, &mut stats);
        assert_eq!(block, [0.5, 1.0, -1.0, -0.25]);
        assert_eq!(stats.clipped_samples(), 2);
        assert!(stats.clipped());
        assert!((stats.peak() - 2.0).abs() < f32::EPSILON);
        assert_eq!(stats.non_finite_samples(), 0);
    }

    #[test]
    #[expect(
        clippy::float_cmp,
        reason = "the assertion is exact by design: samples must be bit-identical"
    )]
    fn limiting_forces_non_finite_samples_to_a_finite_value() {
        let mut block = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY];
        let mut stats = MixStats::EMPTY;
        limit(&mut block, &mut stats);
        assert_eq!(block, [0.0, 1.0, -1.0]);
        assert_eq!(stats.non_finite_samples(), 3);
        assert_eq!(stats.clipped_samples(), 0);
    }

    #[test]
    #[expect(
        clippy::float_cmp,
        reason = "the assertion is exact by design: samples must be bit-identical"
    )]
    fn a_block_at_exactly_full_scale_is_not_counted_as_clipped() {
        let mut block = [1.0, -1.0];
        let mut stats = MixStats::EMPTY;
        limit(&mut block, &mut stats);
        assert_eq!(block, [1.0, -1.0]);
        assert_eq!(stats.clipped_samples(), 0);
        assert!((stats.peak() - 1.0).abs() < f32::EPSILON);
    }
}
