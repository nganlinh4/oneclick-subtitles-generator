//! The whole conversion, assembled.
//!
//! This is the single place a validated `RenderRequest` becomes the inputs the native pipeline
//! consumes: an `osg-scene` [`Scene`], the compositor's style and crop, the audio plan and the
//! encoder configuration. Every parity decision in `src/platform/renderParityLedger.js` that this
//! stage owns is applied through the modules beside this one, so the decisions are reviewable in
//! one directory instead of scattered through a renderer.
//!
//! Nothing here re-derives pipeline maths. Layout, animation, easing, cue selection, scaling and
//! colour live in `osg-scene`; crop, backfill and blending live in `osg-compositor`; timing lives
//! in the shared timeline. What this module contributes is the mapping and the refusals.

use osg_compositor::{Crop, SubtitleStyle};
use osg_encode::config::{MAX_VIDEO_BITRATE_KBPS, MIN_VIDEO_BITRATE_KBPS};
use osg_encode::{AudioBitrate, AudioConfig, ChannelCount, EncoderConfig, SampleRate, VideoConfig};
use osg_render::RenderPlan;
use osg_scene::scene::{ResolvedFace, SCENE_SCHEMA_VERSION, Scene};
use osg_scene::{ExactTime, FrameTimeline};

use super::audio::{self, AudioPlan};
use super::crop;
use super::font::primary_font_family;
use super::style;
use super::timeline::{self, Timelines};
use crate::error::ExportError;

/// Ten thousandths of a bit per pixel per second: the bitrate rule, as one integer.
///
/// `width * height * fps * 2 / 10_000` is 0.2 bits per pixel, which puts a 1080p30 export at
/// `12_441` kbit/s — the same order as the encoder's own 1080p default — and scales the rest of the
/// resolution ladder from it. Integer arithmetic on purpose: the configuration a request produces
/// has to be the same number on every machine.
const BITRATE_BITS_PER_PIXEL_TEN_THOUSANDTHS: u64 = 2_000;

/// Everything the native pipeline needs to export one request.
///
/// Holding one means the conversion succeeded: the scene is within every bound, the style and crop
/// resolved, the audio volumes and window are in range, and the encoder configuration is valid.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportPlan {
    scene: Scene,
    source_timeline: FrameTimeline,
    style: SubtitleStyle,
    crop: Crop,
    audio: AudioPlan,
    video: VideoConfig,
}

impl ExportPlan {
    /// Converts a validated request, against the face the caller resolved and staged an atlas for.
    ///
    /// # Errors
    /// Returns [`ExportError::FontUnavailable`] when `face` is not the face the request's
    /// `fontFamily` names, and otherwise the first scene, timeline, style, crop, audio or encoder
    /// refusal. Nothing is clamped or repaired: a request the editor could not have meant is
    /// refused rather than exported differently.
    pub fn convert(plan: &RenderPlan, face: &ResolvedFace) -> Result<Self, ExportError> {
        check_face(plan, face)?;
        let Timelines { scene, source } = timeline::build(plan)?;
        let cues = timeline::rebased_cues(plan)?;
        let scene = Scene::new(
            SCENE_SCHEMA_VERSION,
            plan.width,
            plan.height,
            scene,
            face.clone(),
            cues,
        )?;
        let fps = u32::from(plan.settings.frame_rate.value());
        let video = VideoConfig::new(plan.width, plan.height, fps, 1, plan.duration_frames)?
            .with_bitrate_kbps(video_bitrate_kbps(plan.width, plan.height, fps))?;
        Ok(Self {
            scene,
            source_timeline: source,
            style: style::resolve(&plan.customization)?,
            crop: crop::resolve(&plan.crop)?,
            audio: audio::build(plan)?,
            video,
        })
    }

    /// The validated scene: composition size, zero-based timeline, resolved face, rebased cues.
    #[must_use]
    pub const fn scene(&self) -> &Scene {
        &self.scene
    }

    /// The same frame grid offset to the trim point, which is what the decoder samples against.
    #[must_use]
    pub const fn source_timeline(&self) -> FrameTimeline {
        self.source_timeline
    }

    /// The resolved subtitle style.
    #[must_use]
    pub const fn style(&self) -> &SubtitleStyle {
        &self.style
    }

    /// The resolved crop, flips and canvas backfill.
    #[must_use]
    pub const fn crop(&self) -> Crop {
        self.crop
    }

    /// The two volumes and the window the audio is read through.
    #[must_use]
    pub const fn audio(&self) -> AudioPlan {
        self.audio
    }

    /// The validated video encoder configuration.
    #[must_use]
    pub const fn video(&self) -> VideoConfig {
        self.video
    }

    /// How many frames the export writes.
    ///
    /// From the timeline, never from however many frames a decode happened to produce. This is the
    /// `DURATION_SOURCE` decision, and it is the same number in the scene, the source timeline, the
    /// encoder configuration and the audio mix.
    #[must_use]
    pub const fn frame_count(&self) -> u32 {
        self.video.frame_count()
    }

    /// The composition width in pixels.
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.video.width()
    }

    /// The composition height in pixels.
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.video.height()
    }

    /// The encoder configuration, with an `AAC` stream when the export carries audio.
    #[must_use]
    pub fn encoder_config(&self, with_audio: bool) -> EncoderConfig {
        let config = EncoderConfig::video_only(self.video);
        if with_audio {
            config.with_audio(AudioConfig::new(
                SampleRate::Hz48000,
                ChannelCount::Stereo,
                AudioBitrate::Kbps128,
            ))
        } else {
            config
        }
    }

    /// The first audio sample frame that belongs to output frame `index`.
    ///
    /// Used to interleave the mix with the video: the loop pumps audio until it has reached the
    /// sample the next video frame starts on. The conversion is `osg-audio`'s own, so the audio and
    /// the video agree on where a frame boundary is even at a non-integer sample rate ratio.
    ///
    /// # Errors
    /// Returns a timeline refusal when `index` is past the end, and an audio refusal when the
    /// instant is not a representable sample index.
    pub fn audio_frame_at(&self, index: u32) -> Result<u64, ExportError> {
        let instant = self.scene.timeline().frame_time(index)?;
        Ok(self.audio.format().frame_index(instant)?)
    }

    /// The exact end of the composition, for the audio mix and for reporting.
    ///
    /// # Errors
    /// Returns a timeline refusal when the duration cannot be represented.
    pub fn duration(&self) -> Result<ExactTime, ExportError> {
        Ok(self.scene.timeline().duration()?)
    }
}

/// Refuses a face that is not the one the request asked for.
fn check_face(plan: &RenderPlan, face: &ResolvedFace) -> Result<(), ExportError> {
    let requested =
        primary_font_family(&plan.customization.font_family).ok_or(ExportError::FontUnavailable)?;
    if requested == face.family {
        Ok(())
    } else {
        Err(ExportError::FontUnavailable)
    }
}

/// The average video bitrate a composition of this size and rate is encoded at, in kbit/s.
fn video_bitrate_kbps(width: u32, height: u32, fps: u32) -> u32 {
    let raw = u64::from(width)
        .saturating_mul(u64::from(height))
        .saturating_mul(u64::from(fps))
        .saturating_mul(BITRATE_BITS_PER_PIXEL_TEN_THOUSANDTHS)
        / 10_000_000;
    let clamped = raw.clamp(
        u64::from(MIN_VIDEO_BITRATE_KBPS),
        u64::from(MAX_VIDEO_BITRATE_KBPS),
    );
    u32::try_from(clamped).unwrap_or(MAX_VIDEO_BITRATE_KBPS)
}

#[cfg(test)]
mod tests {
    use osg_encode::config::{MAX_VIDEO_BITRATE_KBPS, MIN_VIDEO_BITRATE_KBPS};

    use super::video_bitrate_kbps;

    #[test]
    fn the_bitrate_rule_is_integer_bounded_and_monotonic() {
        // 1080p30 lands beside the encoder's own 1080p default rather than an invented number.
        assert_eq!(video_bitrate_kbps(1_920, 1_080, 30), 12_441);
        assert_eq!(video_bitrate_kbps(1_280, 720, 30), 5_529);
        // The smallest supported composition still gets a usable floor.
        assert_eq!(video_bitrate_kbps(16, 16, 24), MIN_VIDEO_BITRATE_KBPS);
        // 8K at 120fps is far past the ceiling and clamps rather than overflowing.
        assert_eq!(
            video_bitrate_kbps(7_680, 4_320, 120),
            MAX_VIDEO_BITRATE_KBPS
        );
        assert!(video_bitrate_kbps(1_920, 1_080, 60) > video_bitrate_kbps(1_920, 1_080, 30));
    }
}
