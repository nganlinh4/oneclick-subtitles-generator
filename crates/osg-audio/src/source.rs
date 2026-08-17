//! One input of a mix: where its audio comes from, how loud it is, which part of it is used, and
//! where in the output timeline it starts.
//!
//! The volume vocabulary is the one OSG ships, not a new one. `src/components/VideoRenderingSection/
//! renderPreferences.js` persists `originalAudioVolume` and `narrationVolume` as integers in
//! `0..=100`, both defaulting to `100`; `src/platform/renderService.js` re-validates them as
//! integers in the same range; and the export composition applies them as a plain linear
//! multiplier, `volume={(metadata.originalAudioVolume ?? 100) / 100}` and
//! `volume={(metadata.narrationVolume ?? 100) / 100}` in
//! the shipped JavaScript renderer. Muting is that slider at 0, and a narration
//! source of `none` simply omits the narration track. [`Volume`] is exactly that: percent over a
//! hundred, applied as a linear gain.

use std::path::{Path, PathBuf};

use osg_scene::ExactTime;

use crate::channels;
use crate::decode::{AudioDecoder, MAX_SOURCE_FRAMES};
use crate::error::AudioError;
use crate::format::{OutputFormat, frames_floor, span_floor};
use crate::resample::Resampler;
use crate::window::FrameWindow;

/// A linear gain taken from OSG's shipped 0-100 volume control.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Volume {
    gain: f32,
}

impl Volume {
    /// The shipped default: 100 percent, gain 1.0.
    pub const FULL: Self = Self { gain: 1.0 };
    /// Silence. The source is not opened at all.
    pub const MUTED: Self = Self { gain: 0.0 };

    /// Build a volume from the shipped percentage.
    ///
    /// # Errors
    /// Returns [`AudioError::VolumeOutOfRange`] outside `0..=100`, the range both the UI slider and
    /// the render request validator enforce.
    pub fn from_percent(percent: u32) -> Result<Self, AudioError> {
        if percent > 100 {
            return Err(AudioError::VolumeOutOfRange { value: percent });
        }
        #[expect(
            clippy::cast_precision_loss,
            reason = "the percentage is at most 100, exactly representable in f32"
        )]
        let gain = percent as f32 / 100.0;
        Ok(Self { gain })
    }

    /// The linear multiplier applied to every sample of the source.
    #[must_use]
    pub const fn gain(self) -> f32 {
        self.gain
    }

    /// Whether this source contributes nothing.
    #[must_use]
    pub fn is_muted(self) -> bool {
        self.gain == 0.0
    }
}

impl Default for Volume {
    fn default() -> Self {
        Self::FULL
    }
}

/// The part of a source's own timeline a mix uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrimWindow {
    start: ExactTime,
    end: Option<ExactTime>,
}

impl TrimWindow {
    /// The whole source, from its first frame to its last.
    pub const FULL: Self = Self {
        start: ExactTime::ZERO,
        end: None,
    };

    /// Build a trim window. `end` of `None` means "to the end of the source", which is how the
    /// shipped `trimEnd: 0` is persisted.
    ///
    /// # Errors
    /// Returns [`AudioError::InvalidTrim`] when the window is negative, empty or inverted.
    pub fn new(start: ExactTime, end: Option<ExactTime>) -> Result<Self, AudioError> {
        if start.numerator() < 0 {
            return Err(AudioError::InvalidTrim);
        }
        if let Some(end) = end
            && end.cmp_exact(start) != core::cmp::Ordering::Greater
        {
            return Err(AudioError::InvalidTrim);
        }
        Ok(Self { start, end })
    }

    /// Where the window starts in the source's own timeline.
    #[must_use]
    pub const fn start(self) -> ExactTime {
        self.start
    }

    /// Where the window ends, if it is bounded.
    #[must_use]
    pub const fn end(self) -> Option<ExactTime> {
        self.end
    }
}

/// Where a source's bytes come from.
#[derive(Debug, Clone)]
enum SourceInput {
    Path(PathBuf),
    Bytes(Vec<u8>),
}

/// One input of a mix.
#[derive(Debug, Clone)]
pub struct AudioSource {
    input: SourceInput,
    volume: Volume,
    trim: TrimWindow,
    offset: ExactTime,
}

impl AudioSource {
    /// A source read from the filesystem. The path never leaves this crate.
    #[must_use]
    pub fn from_path(path: impl AsRef<Path>) -> Self {
        Self::with_input(SourceInput::Path(path.as_ref().to_path_buf()))
    }

    /// A source already held in memory.
    #[must_use]
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self::with_input(SourceInput::Bytes(bytes))
    }

    fn with_input(input: SourceInput) -> Self {
        Self {
            input,
            volume: Volume::FULL,
            trim: TrimWindow::FULL,
            offset: ExactTime::ZERO,
        }
    }

    /// Set the linear gain. Defaults to [`Volume::FULL`], matching the shipped default of 100.
    #[must_use]
    pub const fn with_volume(mut self, volume: Volume) -> Self {
        self.volume = volume;
        self
    }

    /// Use only part of the source. Defaults to [`TrimWindow::FULL`].
    #[must_use]
    pub const fn with_trim(mut self, trim: TrimWindow) -> Self {
        self.trim = trim;
        self
    }

    /// Start this source partway through the output, which is what a narration track needs.
    ///
    /// # Errors
    /// Returns [`AudioError::InvalidOffset`] when the offset is negative.
    pub fn with_offset(mut self, offset: ExactTime) -> Result<Self, AudioError> {
        if offset.numerator() < 0 {
            return Err(AudioError::InvalidOffset);
        }
        self.offset = offset;
        Ok(self)
    }

    /// The gain this source contributes at.
    #[must_use]
    pub const fn volume(&self) -> Volume {
        self.volume
    }

    /// The part of the source this mix uses.
    #[must_use]
    pub const fn trim(&self) -> TrimWindow {
        self.trim
    }

    /// Where in the output timeline the source starts.
    #[must_use]
    pub const fn offset(&self) -> ExactTime {
        self.offset
    }

    fn open(&self) -> Result<AudioDecoder, AudioError> {
        match &self.input {
            SourceInput::Path(path) => AudioDecoder::open_path(path),
            SourceInput::Bytes(bytes) => AudioDecoder::open_bytes(bytes.clone()),
        }
    }
}

/// A source prepared for mixing: decoder, sliding window, resampler and its place in the output.
#[derive(Debug)]
pub(crate) struct SourceReader {
    decoder: AudioDecoder,
    window: FrameWindow,
    resampler: Resampler,
    scratch: Vec<f32>,
    gain: f32,
    source_channels: usize,
    channels: usize,
    /// The first output frame this source contributes to.
    start: u64,
    /// One past the last output frame this source contributes to.
    end: u64,
    /// The source frame the trim window starts at.
    source_start: u64,
}

impl SourceReader {
    /// Open a source and place it on the output timeline.
    ///
    /// A muted source is not opened at all: muting is the user saying "do not use this audio", so
    /// there is nothing to read and no reason for a broken file behind a muted slider to fail a
    /// render. The caller filters those out before calling this.
    pub(crate) fn open(source: &AudioSource, format: OutputFormat) -> Result<Self, AudioError> {
        let decoder = source.open()?;
        let source_rate = decoder.sample_rate();
        let source_channels = usize::from(decoder.channels());
        let channels = format.channel_count();

        let start =
            frames_floor(source.offset, format.sample_rate()).ok_or(AudioError::InvalidOffset)?;
        let source_start =
            frames_floor(source.trim.start(), source_rate).ok_or(AudioError::InvalidTrim)?;
        let end = match source.trim.end() {
            None => u64::MAX,
            Some(trim_end) => {
                let length = span_floor(source.trim.start(), trim_end, format.sample_rate())
                    .ok_or(AudioError::InvalidTrim)?;
                start.saturating_add(length)
            }
        };

        Ok(Self {
            decoder,
            window: FrameWindow::new(channels),
            resampler: Resampler::new(source_rate, format.sample_rate()),
            scratch: Vec::new(),
            gain: source.volume.gain(),
            source_channels,
            channels,
            start,
            end,
            source_start,
        })
    }

    /// Add this source's contribution to one block of output frames.
    ///
    /// `block` is `frames * channels` samples starting at output frame `block_start`. Samples are
    /// accumulated, never overwritten, so the caller controls the summation order.
    pub(crate) fn add_into(
        &mut self,
        block: &mut [f32],
        block_start: u64,
        frames: u64,
    ) -> Result<(), AudioError> {
        let first = block_start.max(self.start);
        let last = block_start.saturating_add(frames).min(self.end);
        if first >= last {
            return Ok(());
        }

        let (first_base, _) = self.resampler.position(first - self.start);
        let (last_base, _) = self.resampler.position(last - 1 - self.start);
        let needed_from = self
            .source_start
            .saturating_add(first_base)
            .saturating_sub(self.resampler.history());
        let needed_to = self
            .source_start
            .saturating_add(last_base)
            .saturating_add(self.resampler.lookahead())
            .saturating_add(1);

        self.window.drop_before(needed_from);
        self.fill(needed_from, needed_to)?;

        for output in first..last {
            let (base, phase) = self.resampler.position(output - self.start);
            let base = self.source_start.saturating_add(base);
            let offset =
                usize::try_from(output - block_start).unwrap_or(usize::MAX) * self.channels;
            for channel in 0..self.channels {
                let sample = self.resampler.render(&self.window, base, phase, channel);
                block[offset + channel] += self.gain * sample;
            }
        }
        Ok(())
    }

    /// Decode until the window covers `needed_to`, keeping only frames at or after `keep_from`.
    fn fill(&mut self, keep_from: u64, needed_to: u64) -> Result<(), AudioError> {
        while !self.window.ended() && self.window.next_index() < needed_to {
            let Some(decoded) = self.decoder.next_frames()? else {
                self.window.mark_ended();
                break;
            };
            let length = channels::remapped_len(decoded.len(), self.source_channels, self.channels);
            if self.scratch.len() < length {
                self.scratch.resize(length, 0.0);
            }
            channels::remap(
                decoded,
                self.source_channels,
                self.channels,
                &mut self.scratch[..length],
            );
            self.window.extend(&self.scratch[..length], keep_from);
            if self.window.next_index() > MAX_SOURCE_FRAMES {
                return Err(AudioError::SourceTooLong {
                    max: MAX_SOURCE_FRAMES,
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{AudioError, AudioSource, TrimWindow, Volume};
    use osg_scene::ExactTime;

    #[test]
    fn volume_is_the_shipped_percent_over_a_hundred() {
        assert!((Volume::from_percent(100).expect("full").gain() - 1.0).abs() < f32::EPSILON);
        assert!((Volume::from_percent(50).expect("half").gain() - 0.5).abs() < f32::EPSILON);
        assert!(Volume::from_percent(0).expect("muted").is_muted());
        assert_eq!(Volume::default(), Volume::FULL);
        assert!(matches!(
            Volume::from_percent(101),
            Err(AudioError::VolumeOutOfRange { value: 101 })
        ));
    }

    #[test]
    fn trim_windows_must_be_forward_and_non_empty() {
        let one = ExactTime::new(1, 1).expect("exact time");
        let two = ExactTime::new(2, 1).expect("exact time");
        assert!(TrimWindow::new(one, Some(two)).is_ok());
        assert!(TrimWindow::new(one, None).is_ok());
        assert!(matches!(
            TrimWindow::new(two, Some(one)),
            Err(AudioError::InvalidTrim)
        ));
        assert!(matches!(
            TrimWindow::new(one, Some(one)),
            Err(AudioError::InvalidTrim)
        ));
        let negative = ExactTime::new(-1, 2).expect("exact time");
        assert!(matches!(
            TrimWindow::new(negative, None),
            Err(AudioError::InvalidTrim)
        ));
    }

    #[test]
    fn offsets_may_not_be_negative() {
        let negative = ExactTime::new(-1, 30).expect("exact time");
        assert!(matches!(
            AudioSource::from_bytes(Vec::new()).with_offset(negative),
            Err(AudioError::InvalidOffset)
        ));
    }

    #[test]
    fn sources_default_to_full_volume_and_the_whole_timeline() {
        let source = AudioSource::from_bytes(Vec::new());
        assert_eq!(source.volume(), Volume::FULL);
        assert_eq!(source.trim(), TrimWindow::FULL);
        assert_eq!(source.offset(), ExactTime::ZERO);
    }
}
