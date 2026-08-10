//! Application use cases that sit between the pure domain and platform adapters.

mod error;
mod jobs;
mod media;
mod projects;
mod session;
mod subtitles;

pub use error::{ApplicationError, ErrorCode};
pub use jobs::{
    JobRegistry, JobRegistryError, JobStore, JobTicket, JobWrite, RESIDENT_TERMINAL_JOB_LIMIT,
};
pub use media::{ImportedMedia, inspect_media};
pub use projects::{
    MAX_PROJECT_CUES, MAX_PROJECT_MEDIA_ASSETS, MAX_PROJECT_STATE_VERSION, MAX_PROJECT_TRACKS,
    ProjectHistoryStatus, ProjectRepository, ProjectSnapshot, ProjectSnapshotError,
    ProjectTrackHistoryMutation, ProjectTrackHistoryStatus, ProjectTrackSelector,
    ProjectTrackSelectorError, RevisionCommit,
};
pub use session::{Session, SessionSnapshot};
pub use subtitles::import_subtitle_track;
