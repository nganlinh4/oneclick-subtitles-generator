use std::io;

use osg_domain::formats::SubtitleFormatError;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    EmptyFile,
    InvalidPath,
    InvalidSubtitle,
    Io,
    UnsupportedMedia,
    UnsupportedSubtitle,
}

impl ErrorCode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::EmptyFile => "emptyFile",
            Self::InvalidPath => "invalidPath",
            Self::InvalidSubtitle => "invalidSubtitle",
            Self::Io => "io",
            Self::UnsupportedMedia => "unsupportedMedia",
            Self::UnsupportedSubtitle => "unsupportedSubtitle",
        }
    }
}

#[derive(Debug, Error)]
pub enum ApplicationError {
    #[error("the selected path does not point to a regular local file")]
    InvalidPath,
    #[error("the selected file is empty")]
    EmptyFile,
    #[error("the media type `.{0}` is not supported")]
    UnsupportedMedia(String),
    #[error("the subtitle type `.{0}` is not supported")]
    UnsupportedSubtitle(String),
    #[error("the subtitle file is too large to import safely")]
    SubtitleFileTooLarge,
    #[error("the subtitle file is not valid UTF-8")]
    InvalidSubtitleEncoding,
    #[error("could not {operation}: {source}")]
    Io {
        operation: &'static str,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    SubtitleFormat(#[from] SubtitleFormatError),
}

impl ApplicationError {
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::InvalidPath => ErrorCode::InvalidPath,
            Self::EmptyFile => ErrorCode::EmptyFile,
            Self::UnsupportedMedia(_) => ErrorCode::UnsupportedMedia,
            Self::UnsupportedSubtitle(_) => ErrorCode::UnsupportedSubtitle,
            Self::SubtitleFileTooLarge
            | Self::InvalidSubtitleEncoding
            | Self::SubtitleFormat(_) => ErrorCode::InvalidSubtitle,
            Self::Io { .. } => ErrorCode::Io,
        }
    }
}
