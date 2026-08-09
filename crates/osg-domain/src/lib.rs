//! Pure domain types and format contracts for One-Click Subtitles Generator.

pub mod formats;
pub mod media;
pub mod subtitles;

pub use media::{
    AUDIO_EXTENSIONS, MediaAsset, MediaKind, VIDEO_EXTENSIONS, media_kind_for_extension,
};
pub use subtitles::{SubtitleCue, SubtitleError, SubtitleTrack, TrackOrigin};
