//! The Windows backend, built on Media Foundation.
//!
//! Four private modules, and the only `unsafe` in the crate:
//!
//! - `platform` brings up COM and the media platform and translates platform failures;
//! - `media_type` builds the four media types, including the colour description;
//! - `sample` wraps caller bytes as a timestamped sample — the only pointer arithmetic;
//! - `writer` drives the sink writer through its lifecycle.
//!
//! `inspect` adds no encoding behaviour: it reads media-type attributes back so the colour and
//! stream settings can be asserted against the platform instead of against a copy of the
//! constants.

mod inspect;
mod media_type;
mod platform;
mod sample;
mod writer;

pub use inspect::{VideoMediaTypeReadback, read_back_video_media_types};
pub(crate) use writer::MediaFoundationEncoder;
