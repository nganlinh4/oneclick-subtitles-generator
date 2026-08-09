mod legacy_json;
mod srt;

pub use legacy_json::{parse_legacy_json, write_legacy_json};
pub use srt::{parse_srt, write_srt, write_text};

use thiserror::Error;

use crate::SubtitleError;

#[derive(Debug, Error)]
pub enum SubtitleFormatError {
    #[error("the subtitle document is empty")]
    EmptyDocument,
    #[error("invalid SRT cue {block}: {reason}")]
    InvalidSrtCue { block: usize, reason: String },
    #[error("invalid subtitle timestamp `{0}`")]
    InvalidTimestamp(String),
    #[error("invalid legacy subtitle JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("invalid legacy subtitle cue {index}: {reason}")]
    InvalidLegacyCue { index: usize, reason: String },
    #[error(transparent)]
    InvalidCue(#[from] SubtitleError),
}
