//! Frame-exact source video decoding for the OSG native renderer.
//!
//! Removing `FFmpeg` from the render path removed the frame **extractor** as well as the encoder. The
//! shipped renderer pulled source frames out with `ffmpeg.exe`; nothing else in the product could
//! do it. This crate is the replacement, and it takes the same route `osg-encode` takes in the
//! other direction: on Windows it drives the operating system's own `IMFSourceReader`, whose codecs
//! are part of Windows and licensed by Microsoft to the person running the machine. No codec, no
//! GPL library and no downloaded tool is redistributed, so there is nothing here to write a notice
//! for and no runtime package to keep current.
//!
//! # The three things that are easy to get wrong
//!
//! Each of them is structural here rather than a rule someone has to remember.
//!
//! **Seeking is not frame-exact.** `IMFSourceReader` seeks to a keyframe, not to a frame index. A
//! decoder that trusts its own seek samples the wrong source frame near every cut, and near every
//! output frame whose rate differs from the source's — which, once trim and frame-rate conversion
//! are in play, is most of them. So no method here returns the frame a seek landed on. Every
//! request resolves to an exact instant on the shared `osg-scene` timeline, and the decoder walks
//! forward from whatever keyframe it reached until it holds the sample that actually covers that
//! instant. [`VideoDecoder::source_frame`] and [`VideoDecoder::next_frame`] are two routes to the
//! same answer, which is what makes "seek equals play" a property a test can assert rather than a
//! hope.
//!
//! **A decoded frame's memory belongs to its sample.** The reference implementation records that
//! the surface allocator reclaims the memory as soon as the `IMFSample` refcount reaches zero, even
//! mid-read, and that the corruption this produces looks like a compositor bug. Here the sample is
//! owned by [`mf::SourceSample`], the lock that exposes its bytes borrows the sample, and the pixel
//! slice borrows the lock, so the bytes cannot be named without both being alive.
//!
//! **Colour range is not cosmetic.** A studio-range source decoded as full range comes back washed
//! out; a full-range source decoded as studio range comes back with crushed blacks. Neither
//! announces itself. [`colorimetry`] reads the description off the source rather than assuming one,
//! says out loud where a convention is being applied, and refuses a description it cannot reproduce
//! faithfully instead of approximating it.
//!
//! # What comes out
//!
//! Tightly packed RGBA8, top row first, fully opaque — the same representation
//! `osg_compositor::Frame` uses, so the decoded underlay and the subtitle layer meet without either
//! side reinterpreting the other's bytes.
//!
//! # Platforms
//!
//! [`open_decoder`] returns [`DecodeError::UnsupportedPlatform`] anywhere without an audited
//! backend. There is no fallback to a system decoder, and no path that returns a frame the crate
//! did not read out of the file it was given.
//!
//! # `unsafe`
//!
//! The workspace is `unsafe_code = "forbid"`. `osg-encode` is the first documented exception and
//! this crate is the second, for the same reason and under the same discipline: Media Foundation is
//! a COM API that cannot be driven from safe Rust. Everything unsafe is confined to [`mf`], every
//! block carries a `// SAFETY:` comment, and the manifest additionally enables
//! `clippy::undocumented_unsafe_blocks` and `clippy::multiple_unsafe_ops_per_block` so that stays
//! true.
//!
//! ```no_run
//! use osg_decode::{DecoderConfig, open_decoder};
//! use osg_scene::{ExactTime, FrameTimeline};
//!
//! # fn main() -> Result<(), osg_decode::DecodeError> {
//! // The export's own timeline: 30000/1001 fps, 900 frames, starting at the trim point.
//! let timeline = FrameTimeline::new(30_000, 1_001, 900, ExactTime::ZERO).expect("a timeline");
//! let mut decoder = open_decoder(
//!     std::path::Path::new(r"C:\media\opaque-id.mp4"),
//!     DecoderConfig::new(timeline),
//! )?;
//!
//! let source = decoder.source();
//! println!("{}x{}", source.width(), source.height());
//!
//! for index in 0..900 {
//!     let frame = decoder.frame_for_output(index)?;
//!     assert_eq!(frame.pixels().len(), frame.width() * frame.height() * 4);
//! }
//! # Ok(())
//! # }
//! ```

pub mod cancel;
pub mod colorimetry;
pub mod decoder;
pub mod error;
pub mod frame;
pub mod input;
pub mod limits;
pub mod planes;
pub mod sampling;
pub mod source;

#[cfg(windows)]
pub mod mf;

pub use cancel::CancelToken;
pub use colorimetry::{NominalRange, SourceColorimetry, YuvMatrix, YuvToRgb};
pub use decoder::{DecodeStats, DecoderConfig, VideoDecoder, open_decoder};
pub use error::{DecodeError, MfStage, SourceBound, SourceRejection};
pub use frame::DecodedFrame;
pub use input::check_source_path;
pub use limits::{DecodeLimits, HUNDRED_NANOS_PER_SECOND};
pub use planes::{FrameGeometry, NvPlanes};
pub use sampling::{OutputSampler, SourceGrid, exact_time_to_100ns};
pub use source::SourceInfo;
