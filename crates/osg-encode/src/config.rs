//! Bounded, validated encoder configuration.
//!
//! Every value is checked once, here, and the checked value is what the backend reads. There is no
//! path by which an unvalidated number reaches a platform call.

use crate::error::{ConfigField, EncodeError};
use crate::timing::{FrameClock, MAX_ENCODE_FRAME_COUNT};

/// The smallest frame edge the encoder accepts.
pub const MIN_FRAME_DIMENSION: u32 = 16;
/// The largest frame edge the encoder accepts, covering 8K in either orientation.
///
/// Spelled `MAX_FRAME_DIMENSION` rather than a resolution name so it is one number, not a table.
pub const MAX_FRAME_DIMENSION: u32 = 7680;
/// The smallest average video bitrate, in kbit/s.
pub const MIN_VIDEO_BITRATE_KBPS: u32 = 100;
/// The largest average video bitrate, in kbit/s.
pub const MAX_VIDEO_BITRATE_KBPS: u32 = 200_000;
/// The default average video bitrate, in kbit/s: a 1080p export that holds up against its preview.
pub const DEFAULT_VIDEO_BITRATE_KBPS: u32 = 12_000;
/// The largest keyframe gap the encoder accepts.
///
/// Bounded on purpose. A web view scrubbing an exported file seeks to the previous keyframe and
/// decodes forward from there, so an unbounded gap makes the render tab feel broken.
pub const MAX_KEYFRAME_INTERVAL: u32 = 600;
/// The default keyframe gap, ported from the reference implementation.
pub const DEFAULT_KEYFRAME_INTERVAL: u32 = 60;

/// The video half of an encode. Immutable once built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoConfig {
    width: u32,
    height: u32,
    fps_numerator: u32,
    fps_denominator: u32,
    frame_count: u32,
    bitrate_kbps: u32,
    keyframe_interval: u32,
}

impl VideoConfig {
    /// Validates a video configuration, with the default bitrate and keyframe interval.
    ///
    /// Both dimensions must be even: H.264 encodes 4:2:0 chroma, whose planes are half-resolution,
    /// and an odd edge is either rejected by the encoder or silently cropped by it.
    ///
    /// # Errors
    /// Returns [`EncodeError::UnsupportedConfig`] naming the first field that fell outside its
    /// documented range.
    pub fn new(
        width: u32,
        height: u32,
        fps_numerator: u32,
        fps_denominator: u32,
        frame_count: u32,
    ) -> Result<Self, EncodeError> {
        check_dimension(width, ConfigField::Width)?;
        check_dimension(height, ConfigField::Height)?;
        if frame_count == 0 || frame_count > MAX_ENCODE_FRAME_COUNT {
            return Err(EncodeError::UnsupportedConfig {
                field: ConfigField::FrameCount,
            });
        }
        // Building the clock is the frame-rate check: it is the same bound the shared timeline
        // enforces, so a configuration that validates here cannot fail to produce timestamps.
        FrameClock::new(fps_numerator, fps_denominator, frame_count)?;
        Ok(Self {
            width,
            height,
            fps_numerator,
            fps_denominator,
            frame_count,
            bitrate_kbps: DEFAULT_VIDEO_BITRATE_KBPS,
            keyframe_interval: DEFAULT_KEYFRAME_INTERVAL,
        })
    }

    /// Sets the average video bitrate in kbit/s.
    ///
    /// # Errors
    /// Returns [`EncodeError::UnsupportedConfig`] outside
    /// [`MIN_VIDEO_BITRATE_KBPS`]`..=`[`MAX_VIDEO_BITRATE_KBPS`].
    pub fn with_bitrate_kbps(mut self, bitrate_kbps: u32) -> Result<Self, EncodeError> {
        if !(MIN_VIDEO_BITRATE_KBPS..=MAX_VIDEO_BITRATE_KBPS).contains(&bitrate_kbps) {
            return Err(EncodeError::UnsupportedConfig {
                field: ConfigField::VideoBitrate,
            });
        }
        self.bitrate_kbps = bitrate_kbps;
        Ok(self)
    }

    /// Sets the largest permitted gap between keyframes, in frames.
    ///
    /// # Errors
    /// Returns [`EncodeError::UnsupportedConfig`] outside `1..=`[`MAX_KEYFRAME_INTERVAL`].
    pub fn with_keyframe_interval(mut self, frames: u32) -> Result<Self, EncodeError> {
        if frames == 0 || frames > MAX_KEYFRAME_INTERVAL {
            return Err(EncodeError::UnsupportedConfig {
                field: ConfigField::KeyframeInterval,
            });
        }
        self.keyframe_interval = frames;
        Ok(self)
    }

    /// The frame width in pixels.
    #[must_use]
    pub const fn width(self) -> u32 {
        self.width
    }

    /// The frame height in pixels.
    #[must_use]
    pub const fn height(self) -> u32 {
        self.height
    }

    /// The frame rate numerator.
    #[must_use]
    pub const fn fps_numerator(self) -> u32 {
        self.fps_numerator
    }

    /// The frame rate denominator.
    #[must_use]
    pub const fn fps_denominator(self) -> u32 {
        self.fps_denominator
    }

    /// How many frames the encode carries.
    #[must_use]
    pub const fn frame_count(self) -> u32 {
        self.frame_count
    }

    /// The average video bitrate in kbit/s.
    #[must_use]
    pub const fn bitrate_kbps(self) -> u32 {
        self.bitrate_kbps
    }

    /// The largest permitted gap between keyframes, in frames.
    #[must_use]
    pub const fn keyframe_interval(self) -> u32 {
        self.keyframe_interval
    }

    /// The frame clock this configuration implies.
    ///
    /// # Errors
    /// Cannot fail for a configuration built through [`Self::new`]; the signature is kept fallible
    /// so the bound lives in exactly one place.
    pub fn frame_clock(self) -> Result<FrameClock, EncodeError> {
        FrameClock::new(self.fps_numerator, self.fps_denominator, self.frame_count)
    }
}

fn check_dimension(value: u32, field: ConfigField) -> Result<(), EncodeError> {
    let in_range = (MIN_FRAME_DIMENSION..=MAX_FRAME_DIMENSION).contains(&value);
    if in_range && value.is_multiple_of(2) {
        Ok(())
    } else {
        Err(EncodeError::UnsupportedConfig { field })
    }
}

/// The sample rates the platform AAC encoder accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleRate {
    /// `44_100` Hz.
    Hz44100,
    /// `48_000` Hz.
    Hz48000,
}

impl SampleRate {
    /// The rate in hertz.
    #[must_use]
    pub const fn hz(self) -> u32 {
        match self {
            Self::Hz44100 => 44_100,
            Self::Hz48000 => 48_000,
        }
    }
}

/// The channel layouts the platform AAC encoder accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelCount {
    /// One channel.
    Mono,
    /// Two interleaved channels.
    Stereo,
}

impl ChannelCount {
    /// The number of interleaved channels.
    #[must_use]
    pub const fn count(self) -> u32 {
        match self {
            Self::Mono => 1,
            Self::Stereo => 2,
        }
    }
}

/// The average AAC bitrates the platform encoder accepts.
///
/// The platform encoder takes an average *bytes* per second and only recognises these four values;
/// anything else is refused when the stream is added, long after the caller could have been told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioBitrate {
    /// 96 kbit/s.
    Kbps96,
    /// 128 kbit/s.
    Kbps128,
    /// 160 kbit/s.
    Kbps160,
    /// 192 kbit/s.
    Kbps192,
}

impl AudioBitrate {
    /// The bitrate in kbit/s.
    #[must_use]
    pub const fn kbps(self) -> u32 {
        match self {
            Self::Kbps96 => 96,
            Self::Kbps128 => 128,
            Self::Kbps160 => 160,
            Self::Kbps192 => 192,
        }
    }

    /// The bitrate as the average bytes per second the platform asks for.
    #[must_use]
    pub const fn bytes_per_second(self) -> u32 {
        self.kbps() * 1000 / 8
    }
}

/// The audio half of an encode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioConfig {
    sample_rate: SampleRate,
    channels: ChannelCount,
    bitrate: AudioBitrate,
}

impl AudioConfig {
    /// Builds an audio configuration from already-typed parts.
    #[must_use]
    pub const fn new(
        sample_rate: SampleRate,
        channels: ChannelCount,
        bitrate: AudioBitrate,
    ) -> Self {
        Self {
            sample_rate,
            channels,
            bitrate,
        }
    }

    /// Builds an audio configuration from plain numbers, refusing anything the platform encoder
    /// does not accept.
    ///
    /// # Errors
    /// Returns [`EncodeError::UnsupportedConfig`] naming the field that was refused.
    pub fn from_parts(
        sample_rate_hz: u32,
        channels: u32,
        bitrate_kbps: u32,
    ) -> Result<Self, EncodeError> {
        let sample_rate = match sample_rate_hz {
            44_100 => SampleRate::Hz44100,
            48_000 => SampleRate::Hz48000,
            _ => {
                return Err(EncodeError::UnsupportedConfig {
                    field: ConfigField::AudioSampleRate,
                });
            }
        };
        let channels = match channels {
            1 => ChannelCount::Mono,
            2 => ChannelCount::Stereo,
            _ => {
                return Err(EncodeError::UnsupportedConfig {
                    field: ConfigField::AudioChannels,
                });
            }
        };
        let bitrate = match bitrate_kbps {
            96 => AudioBitrate::Kbps96,
            128 => AudioBitrate::Kbps128,
            160 => AudioBitrate::Kbps160,
            192 => AudioBitrate::Kbps192,
            _ => {
                return Err(EncodeError::UnsupportedConfig {
                    field: ConfigField::AudioBitrate,
                });
            }
        };
        Ok(Self::new(sample_rate, channels, bitrate))
    }

    /// The sample rate.
    #[must_use]
    pub const fn sample_rate(self) -> SampleRate {
        self.sample_rate
    }

    /// The channel layout.
    #[must_use]
    pub const fn channels(self) -> ChannelCount {
        self.channels
    }

    /// The average bitrate.
    #[must_use]
    pub const fn bitrate(self) -> AudioBitrate {
        self.bitrate
    }

    /// The size in bytes of one interleaved sample frame of 32-bit float PCM.
    #[must_use]
    pub const fn input_block_align(self) -> u32 {
        self.channels.count() * 4
    }
}

/// A whole encode: one video stream and optionally one audio stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderConfig {
    video: VideoConfig,
    audio: Option<AudioConfig>,
}

impl EncoderConfig {
    /// A video-only encode.
    #[must_use]
    pub const fn video_only(video: VideoConfig) -> Self {
        Self { video, audio: None }
    }

    /// Adds an AAC audio stream.
    #[must_use]
    pub const fn with_audio(mut self, audio: AudioConfig) -> Self {
        self.audio = Some(audio);
        self
    }

    /// The video configuration.
    #[must_use]
    pub const fn video(self) -> VideoConfig {
        self.video
    }

    /// The audio configuration, when the encode carries audio.
    #[must_use]
    pub const fn audio(self) -> Option<AudioConfig> {
        self.audio
    }
}
