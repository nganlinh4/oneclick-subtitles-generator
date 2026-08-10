//! Pure domain types and format contracts for One-Click Subtitles Generator.

pub mod formats;
pub mod ids;
pub mod jobs;
pub mod media;
pub mod projects;
pub mod subtitles;

pub use ids::{AssetId, CueId, IdError, JobId, ProjectId, RevisionId, TrackId};
pub use jobs::{
    JOB_PROGRESS_COMPLETE, JobError, JobKind, JobMutation, JobProgress, JobProgressError,
    JobSnapshot, JobState, JobUpdate,
};
pub use media::{
    AUDIO_EXTENSIONS, MAX_MEDIA_DISPLAY_NAME_CHARS, MediaAsset, MediaError, MediaKind,
    VIDEO_EXTENSIONS, media_kind_for_extension,
};
pub use projects::{
    MAX_PROJECT_NAME_CHARS, MAX_REVISION_REASON_CHARS, ProjectError, ProjectMetadata,
    RevisionReason,
};
pub use subtitles::{
    MAX_CUE_TEXT_CHARS, MAX_TRACK_LABEL_CHARS, SubtitleCue, SubtitleError, SubtitleTrack,
    TrackOrigin,
};
