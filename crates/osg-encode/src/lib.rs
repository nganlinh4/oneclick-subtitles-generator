//! H.264/AAC MP4 encoding for the OSG native renderer.
//!
//! This is the final stage of the native render pipeline and the one that closes the licensing
//! question that started the renderer migration. It ships **no encoder**: on Windows it drives the
//! operating system's own `IMFSinkWriter`, whose H.264 and AAC codecs are part of Windows and
//! licensed by Microsoft to the person running the machine. No codec, no GPL library and no
//! downloaded tool is redistributed, so there is nothing here to write a notice for and no runtime
//! package to keep current.
//!
//! # What this crate is responsible for
//!
//! Being a faithful carrier, and nothing more. Parity is proven at the frame, in `osg-compositor`;
//! hardware encoders differ between vendors and driver versions, so an H.264 bitstream is not
//! reproducible and is not the determinism contract. What the encoder owes the pipeline is that the
//! pixels it is handed arrive intact, at the right instants, in the colour space they were composed
//! in.
//!
//! Two of those are easy to get wrong, so they are structural here rather than incidental:
//!
//! - **Timing.** Presentation timestamps come from [`osg_scene::FrameTimeline`] via [`timing`], one
//!   rounding per frame, derived from that frame's own index. Nothing is accumulated, so a
//!   multi-hour export ends exactly where a one-second export would predict.
//! - **Colour.** Full-range Rec.709 is declared on the input *and* output media types, in
//!   [`colorimetry`]. Left to the platform default, the conversion into H.264 compresses 0-255 into
//!   16-235 and every export comes back washed out against the preview it is supposed to match.
//!
//! # Platforms
//!
//! [`open_encoder`] returns [`EncodeError::UnsupportedPlatform`] anywhere without an audited
//! backend. There is no fallback to a system encoder, and no path that reports success for a file
//! the crate did not write.
//!
//! # `unsafe`
//!
//! The workspace is `unsafe_code = "forbid"`. This crate is the single documented exception,
//! declared in its own manifest, because Media Foundation is a COM API that cannot be driven from
//! safe Rust. Everything unsafe is confined to [`mf`], every block carries a `// SAFETY:`
//! comment, and the manifest additionally enables `clippy::undocumented_unsafe_blocks` and
//! `clippy::multiple_unsafe_ops_per_block` so that stays true.
//!
//! ```no_run
//! use osg_encode::{EncoderConfig, FrameBuffer, PixelLayout, VideoConfig, open_encoder};
//!
//! # fn main() -> Result<(), osg_encode::EncodeError> {
//! let video = VideoConfig::new(1920, 1080, 30_000, 1_001, 90)?.with_bitrate_kbps(12_000)?;
//! let mut encoder = open_encoder(
//!     std::path::Path::new(r"C:\exports\opaque-id.mp4"),
//!     EncoderConfig::video_only(video),
//! )?;
//!
//! let pixels = vec![0_u8; 1920 * 1080 * 4];
//! for index in 0..90 {
//!     let frame = FrameBuffer::new(&pixels, 1920, 1080, PixelLayout::Rgba8)?;
//!     encoder.write_frame(index, &frame)?;
//! }
//! let outcome = encoder.finalize()?;
//! assert_eq!(outcome.frames_written(), 90);
//! # Ok(())
//! # }
//! ```

pub mod audio;
pub mod colorimetry;
pub mod config;
pub mod encoder;
pub mod error;
pub mod output;
pub mod pixels;
pub mod timing;

#[cfg(windows)]
pub mod mf;

pub use audio::AudioBlock;
pub use colorimetry::{
    Colorimetry, NOMINAL_RANGE_0_255, TRANSFER_MATRIX_BT709, VIDEO_PRIMARIES_BT709,
    full_range_bt709,
};
pub use config::{AudioBitrate, AudioConfig, ChannelCount, EncoderConfig, SampleRate, VideoConfig};
pub use encoder::{CancelToken, EncodeOutcome, VideoEncoder, open_encoder};
pub use error::{ConfigField, EncodeError, MfStage, OutputRejection};
#[cfg(windows)]
pub use mf::{VideoMediaTypeReadback, read_back_video_media_types};
pub use output::check_output_path;
pub use pixels::{FrameBuffer, PixelLayout};
pub use timing::{FrameClock, HUNDRED_NANOS_PER_SECOND, MAX_ENCODE_FRAME_COUNT};
