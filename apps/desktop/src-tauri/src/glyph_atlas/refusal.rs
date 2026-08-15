//! Refusals

use std::fmt;

use osg_scene::glyph::GlyphAtlasError;

use crate::error::CommandError;

/// Why one staged glyph atlas frame was refused.
///
/// Deliberately coarse and value-free: every variant names the part of the frame that failed, never
/// its contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StagingRefusal {
    /// The request did not declare the glyph atlas frame media type.
    UnsupportedMediaType,
    /// The request body was not a raw binary body.
    UnsupportedBody,
    /// The frame is larger than the staging budget.
    FrameTooLarge,
    /// The frame is shorter than a frame header.
    FrameTooShort,
    /// The frame does not begin with the staging magic.
    UnsupportedMagic,
    /// The frame declares a staging version this build does not implement.
    UnsupportedFrameVersion,
    /// The declared metadata length is past the metadata budget or past the end of the frame.
    UnsupportedMetadataLength,
    /// The metadata is not the UTF-8 JSON object this build reads.
    UnsupportedMetadata,
    /// The frame length disagrees with the atlas the metadata declares.
    PixelLengthMismatch,
    /// The staged descriptor is not one the baker could have produced.
    Descriptor(GlyphAtlasError),
    /// The staging registry is unavailable.
    Unavailable,
}

impl fmt::Display for StagingRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::UnsupportedMediaType => "the request does not declare the glyph atlas media type",
            Self::UnsupportedBody => "the glyph atlas frame is not a raw binary body",
            Self::FrameTooLarge => "the glyph atlas frame is larger than the staging budget",
            Self::FrameTooShort => "the glyph atlas frame is shorter than a frame header",
            Self::UnsupportedMagic => "the glyph atlas frame does not begin with the staging magic",
            Self::UnsupportedFrameVersion => "the glyph atlas frame version is not supported",
            Self::UnsupportedMetadataLength => {
                "the glyph atlas metadata length is not supported by this frame"
            }
            Self::UnsupportedMetadata => "the glyph atlas metadata is not readable",
            Self::PixelLengthMismatch => {
                "the glyph atlas frame length disagrees with the declared atlas"
            }
            Self::Descriptor(error) => return error.fmt(formatter),
            Self::Unavailable => "the glyph atlas staging registry is unavailable",
        };
        formatter.write_str(message)
    }
}

impl From<GlyphAtlasError> for StagingRefusal {
    fn from(error: GlyphAtlasError) -> Self {
        Self::Descriptor(error)
    }
}

impl From<StagingRefusal> for CommandError {
    fn from(refusal: StagingRefusal) -> Self {
        // Every `StagingRefusal` message names a field and never a value, so the whole of it is
        // safe to surface. The `WebView` reduces it to a typed code anyway.
        match refusal {
            StagingRefusal::Unavailable => Self::internal("Glyph atlas staging is unavailable."),
            refusal => Self::invalid_input(format!("The glyph atlas was not staged: {refusal}.")),
        }
    }
}
