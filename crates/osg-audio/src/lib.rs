//! The audio half of the OSG native renderer: decode, resample, mix, hand the encoder PCM.
//!
//! The accepted design (`docs/rewrite/NATIVE_RENDERER.md`) ends with the operating system's own
//! codecs doing the encoding and nothing being redistributed to make that work. This crate is the
//! stage before it. It reads the audio a render needs, brings every source onto one clock and one
//! layout, sums them, and produces interleaved `f32` PCM that `osg-encode` can hand straight to
//! `IMFSinkWriter` as `MFAudioFormat_Float`.
//!
//! # What it reproduces
//!
//! The export has to keep doing what OSG already does: carry the original video's audio, carry the
//! generated narration, honour a volume for each, and let either be silenced. Those semantics are
//! taken from the shipped implementation rather than invented here:
//!
//! - `src/components/VideoRenderingSection/renderPreferences.js` persists `originalAudioVolume` and
//!   `narrationVolume` as integers in `0..=100`, both defaulting to `100`.
//! - `src/components/VideoRenderingSection/InputSelectionRow.js` drives them from two sliders,
//!   `min={0} max={100} step={1}`, and disables the narration slider when the narration source is
//!   `none`.
//! - `src/platform/renderService.js` re-validates both as integers in `0..=100` before a render.
//! - `video-renderer/src/components/SubtitledVideo.tsx` applies them as a plain linear multiplier —
//!   `volume={(metadata.originalAudioVolume ?? 100) / 100}` for the original audio and
//!   `volume={(metadata.narrationVolume ?? 100) / 100}` for the narration — and renders the
//!   narration element only when a narration URL exists.
//!
//! So: gain is `percent / 100`, linear, with a default of 1.0; muting the original audio is that
//! slider at 0; and "no narration" is the absence of the source, not a special case. [`Volume`]
//! encodes exactly that and nothing more.
//!
//! # Properties
//!
//! - **Deterministic.** No RNG, no clock, no threads, no accumulation. Output frame `n` is computed
//!   from `n`. Two runs of the same plan produce bit-identical samples, and reading a mix in blocks
//!   produces the same bytes as reading it whole.
//! - **Exact time.** Trim and offset are [`ExactTime`](osg_scene::ExactTime) rationals from
//!   `osg-scene`, converted to sample indices by integer arithmetic. The sample index of video
//!   frame `n` is exact, so audio and video agree on where a frame boundary is even at 30000/1001.
//! - **Saturating, audible-by-report clipping.** Sums are hard limited to `-1.0..=1.0` and
//!   [`MixStats`] reports how many samples were limited and the peak before limiting. Nothing wraps
//!   and nothing clips silently.
//! - **Bounded.** Sample rate, channel count, source count, packet size, source length, mix
//!   duration and whole-buffer size all have ceilings. A hostile or corrupt file is a typed
//!   [`AudioError`], never an unbounded allocation and never a panic.
//! - **Path-safe.** No error carries a filesystem path, a decoder message, or any of the media.
//! - **Pure Rust.** Decoding is `symphonia` (`MPL-2.0`). No `FFmpeg`, no C codec, no downloaded tool.
//!
//! The crate contains no `unsafe` code, in line with the workspace's `unsafe_code = "forbid"`.
//!
//! # Formats
//!
//! WAV and FLAC, MP3, AAC in MP4, and Vorbis in Ogg or `WebM`/Matroska all decode. **Opus does
//! not**: `symphonia` 0.5.5 ships no pure Rust Opus decoder, so an Opus track — what a `WebM`
//! download from a site often carries — is refused with [`AudioError::UnsupportedCodec`] rather
//! than silently dropped. Adding it means adding a decoder to the registry in `decode.rs`; it is
//! not something this crate papers over.
//!
//! ```no_run
//! use osg_audio::{AudioSource, MixPlan, OutputFormat, Volume, mix_to_buffer};
//! use osg_scene::{ExactTime, FrameTimeline};
//!
//! # fn main() -> Result<(), osg_audio::AudioError> {
//! let format = OutputFormat::new(48_000, 2)?;
//! let timeline = FrameTimeline::new(30, 1, 150, ExactTime::ZERO)
//!     .map_err(|_| osg_audio::AudioError::UnsupportedTimeline)?;
//! let original = AudioSource::from_path("video.mp4").with_volume(Volume::from_percent(100)?);
//! let narration = AudioSource::from_path("narration.wav")
//!     .with_volume(Volume::from_percent(80)?)
//!     .with_offset(ExactTime::new(1, 2).unwrap_or(ExactTime::ZERO))?;
//! let mixed = mix_to_buffer(MixPlan::from_timeline(
//!     format,
//!     timeline,
//!     vec![original, narration],
//! )?)?;
//! assert!(!mixed.stats().clipped());
//! # Ok(())
//! # }
//! ```

mod channels;
mod decode;
mod error;
mod format;
mod mix;
mod resample;
mod source;
mod window;

pub use decode::{AudioDecoder, MAX_PACKET_FRAMES, MAX_SOURCE_CHANNELS, MAX_SOURCE_FRAMES};
pub use error::{AccessFailure, AudioError};
pub use format::{
    MAX_CHANNELS, MAX_MIX_DURATION_SECONDS, MAX_SAMPLE_RATE, MIN_SAMPLE_RATE, OutputFormat,
};
pub use mix::{
    MAX_BUFFERED_SAMPLES, MAX_SOURCES, MIX_BLOCK_FRAMES, MixBuffer, MixPlan, MixStats, Mixer,
    mix_to_buffer,
};
pub use source::{AudioSource, TrimWindow, Volume};
