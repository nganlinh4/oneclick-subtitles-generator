//! Bounded narration edits and timeline mixes.

use super::{AudioOutput, has_extension};
use crate::{MediaError, MediaInput, MediaOutput, Result};

pub const MAX_NARRATION_MIX_INPUTS: usize = 64;
pub const MAX_NARRATION_MIX_DURATION_US: u64 = 4 * 60 * 60 * 1_000_000;

/// A bounded narration edit expressed entirely as typed timing and speed
/// values. The resulting `FFmpeg` filter graph is derived internally; callers
/// cannot provide filter names or process arguments.
#[derive(Clone, Debug)]
pub struct NarrationAudioEditPlan {
    pub(super) input: MediaInput,
    pub(super) output: MediaOutput,
    pub(super) start_us: u64,
    pub(super) end_us: u64,
    pub(super) speed_milli: u16,
    pub(super) expected_duration_us: u64,
}

impl NarrationAudioEditPlan {
    pub fn new(
        input: MediaInput,
        output: MediaOutput,
        start_us: u64,
        end_us: u64,
        speed_milli: u16,
    ) -> Result<Self> {
        if start_us >= end_us {
            return Err(MediaError::InvalidOption(
                "narration edit start must precede its end",
            ));
        }
        if !(250..=4_000).contains(&speed_milli) {
            return Err(MediaError::InvalidOption(
                "narration edit speed must be between 0.25x and 4x",
            ));
        }
        if !has_extension(&output, &["wav"]) {
            return Err(MediaError::InvalidOption(
                "narration edit output must use WAV",
            ));
        }
        let trimmed_duration = end_us - start_us;
        let expected_duration_us =
            u64::try_from(u128::from(trimmed_duration) * 1_000 / u128::from(speed_milli))
                .map_err(|_| MediaError::InvalidOption("narration edit duration overflow"))?;
        if expected_duration_us == 0 || expected_duration_us > MAX_NARRATION_MIX_DURATION_US {
            return Err(MediaError::InvalidOption(
                "narration edit duration is outside the supported range",
            ));
        }
        Ok(Self {
            input,
            output,
            start_us,
            end_us,
            speed_milli,
            expected_duration_us,
        })
    }
}

/// One internally-authorized audio input on a narration timeline. The path is
/// retained as a native capability and the offset is represented in integer
/// microseconds until the fixed 48 kHz render graph is built.
#[derive(Clone, Debug)]
pub struct NarrationMixClip {
    pub(super) input: MediaInput,
    pub(super) start_us: u64,
}

impl NarrationMixClip {
    #[must_use]
    pub const fn new(input: MediaInput, start_us: u64) -> Self {
        Self { input, start_us }
    }
}

/// A bounded narration timeline mix. `FFmpeg` arguments and filters are derived
/// exclusively from these typed values; callers cannot supply a filter graph.
#[derive(Clone, Debug)]
pub struct NarrationMixPlan {
    pub(super) clips: Vec<NarrationMixClip>,
    pub(super) output: MediaOutput,
    pub(super) format: AudioOutput,
    pub(super) duration_us: u64,
}

impl NarrationMixPlan {
    pub fn new(
        clips: Vec<NarrationMixClip>,
        output: MediaOutput,
        format: AudioOutput,
        duration_us: u64,
    ) -> Result<Self> {
        if clips.is_empty() || clips.len() > MAX_NARRATION_MIX_INPUTS {
            return Err(MediaError::InvalidOption(
                "narration mix requires between one and 64 clips",
            ));
        }
        if duration_us == 0 || duration_us > MAX_NARRATION_MIX_DURATION_US {
            return Err(MediaError::InvalidOption(
                "narration mix duration must be between one microsecond and four hours",
            ));
        }
        if clips.iter().any(|clip| clip.start_us >= duration_us) {
            return Err(MediaError::InvalidOption(
                "narration clip starts outside the output timeline",
            ));
        }
        let extensions: &[&str] = match format {
            AudioOutput::WavPcm16 { .. } => &["wav"],
            AudioOutput::M4aAac { .. } => &["m4a", "mp4"],
            AudioOutput::Flac { .. } => &["flac"],
            AudioOutput::Mp3 { .. } => {
                return Err(MediaError::InvalidOption(
                    "narration mix output must use WAV, FLAC, or M4A",
                ));
            }
        };
        if !has_extension(&output, extensions) {
            return Err(MediaError::InvalidOption(
                "narration mix output extension does not match its codec",
            ));
        }
        Ok(Self {
            clips,
            output,
            format,
            duration_us,
        })
    }
}
