//! The audio track of an export: which sources exist, and how they interleave with the video.
//!
//! Two decisions live here and nowhere else.
//!
//! **A source video with no audio track is a silent export, not a failure.** That is not a
//! fallback: nothing is substituted and no feature is made to look present. The file genuinely
//! carries no audio, so there is nothing to mix, and an export of it has no audio stream. A
//! narration file supplied explicitly is held to the opposite rule — a narration track that carries
//! no audio is a refusal, because the caller asserted it had some.
//!
//! **The mix is read in blocks and interleaved with the video.** The container carries one
//! monotonic timeline per stream, so the loop pumps audio up to the sample the next video frame
//! starts on and no further. The sample index of a video frame is `osg-audio`'s own conversion from
//! the shared timeline, so the two streams cannot disagree about where a frame boundary is.

use std::path::Path;

use osg_audio::{AudioDecoder, AudioError, AudioSource, MixPlan, MixStats, Mixer};
use osg_encode::{AudioBlock, AudioConfig, ChannelCount, SampleRate, VideoEncoder};

use crate::convert::ExportPlan;
use crate::error::ExportError;

/// The audio stage of a running export.
#[derive(Debug)]
pub(crate) struct AudioRuntime {
    mixer: Mixer,
    config: AudioConfig,
    written: u64,
}

impl AudioRuntime {
    /// Opens every audible source the plan names, or reports that there are none.
    ///
    /// Returns `Ok(None)` when the export carries no audio at all: both volumes muted, no narration
    /// and a source video with no audio track.
    pub(crate) fn open(
        plan: &ExportPlan,
        source: &Path,
        narration: Option<&Path>,
    ) -> Result<Option<Self>, ExportError> {
        let audio = plan.audio();
        let mut sources: Vec<AudioSource> = Vec::with_capacity(2);

        if !audio.original().is_muted() && source_carries_audio(source)? {
            sources.push(
                AudioSource::from_path(source)
                    .with_volume(audio.original())
                    .with_trim(audio.window()),
            );
        }
        if let Some(path) = narration
            && !audio.narration().is_muted()
        {
            sources.push(
                AudioSource::from_path(path)
                    .with_volume(audio.narration())
                    .with_trim(audio.window()),
            );
        }
        if sources.is_empty() {
            return Ok(None);
        }

        let mix = MixPlan::from_timeline(audio.format(), plan.scene().timeline(), sources)?;
        Ok(Some(Self {
            mixer: Mixer::new(mix)?,
            config: AudioConfig::new(
                SampleRate::Hz48000,
                ChannelCount::Stereo,
                osg_encode::AudioBitrate::Kbps128,
            ),
            written: 0,
        }))
    }

    /// How many interleaved sample frames have reached the encoder.
    pub(crate) const fn written(&self) -> u64 {
        self.written
    }

    /// What the mix has done to its samples so far.
    pub(crate) const fn stats(&self) -> MixStats {
        self.mixer.stats()
    }

    /// Writes blocks until the mix has reached sample frame `through`, or until it is exhausted.
    ///
    /// `u64::MAX` drains the rest of the mix, which is what the end of the video loop asks for.
    pub(crate) fn pump(
        &mut self,
        encoder: &mut dyn VideoEncoder,
        through: u64,
    ) -> Result<(), ExportError> {
        while self.written < through {
            let Some(block) = self.mixer.next_block()? else {
                break;
            };
            let block = AudioBlock::new(block, self.config)?;
            let frames = block.frame_count();
            encoder.write_audio(self.written, &block)?;
            self.written = self.written.saturating_add(frames);
        }
        Ok(())
    }
}

/// Whether a file carries an audio track this build can decode.
///
/// The probe opens the source and decodes its first packet, which is what `osg-audio` does anyway
/// when the mix starts, so a file whose header lies is refused here rather than half way through an
/// export. Only the "no audio track" answer is turned into a `false`; every other failure — an
/// unreadable file, an unrecognised container, a codec with no decoder — stays a refusal, because
/// exporting silence for any of those would hide a real problem.
fn source_carries_audio(source: &Path) -> Result<bool, ExportError> {
    match AudioDecoder::open_path(source) {
        Ok(_) => Ok(true),
        Err(AudioError::NoAudioTrack) => Ok(false),
        Err(other) => Err(other.into()),
    }
}
