//! The Windows backend, built on Media Foundation.
//!
//! Five private modules, and the only `unsafe` in the crate:
//!
//! - `platform` brings up COM and the media platform and translates platform failures;
//! - `media_type` asks the source what it is and tells the reader what to decode into;
//! - `format` decides what the source's two media types mean when they disagree or say nothing;
//! - `sample` owns a decoded sample and the lock that makes its pixels readable — the only
//!   pointer-level code here;
//! - `reader` drives the source reader to frame-exact answers.

mod format;
mod media_type;
pub(crate) mod platform;
mod reader;
pub(crate) mod sample;

pub(crate) use reader::MediaFoundationDecoder;
pub use sample::{SampleLock, SourceSample};
