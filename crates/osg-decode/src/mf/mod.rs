//! The Windows backend, built on Media Foundation.
//!
//! Four private modules, and the only `unsafe` in the crate:
//!
//! - `platform` brings up COM and the media platform and translates platform failures;
//! - `media_type` asks the source what it is and tells the reader what to decode into;
//! - `sample` owns a decoded sample and the lock that makes its pixels readable — the only
//!   pointer-level code here;
//! - `reader` drives the source reader to frame-exact answers.

mod media_type;
mod platform;
mod reader;
mod sample;

pub(crate) use reader::MediaFoundationDecoder;
pub use sample::{SampleLock, SourceSample};
