use std::collections::HashSet;
use std::error::Error;

use osg_domain::{
    AssetId, CueId, MAX_TRACK_LABEL_CHARS, MediaAsset, ProjectId, ProjectMetadata, RevisionId,
    RevisionReason, SubtitleTrack, TrackId, TrackOrigin,
};
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

pub const MAX_PROJECT_MEDIA_ASSETS: usize = 1_024;
pub const MAX_PROJECT_TRACKS: usize = 256;
pub const MAX_PROJECT_CUES: usize = 1_000_000;
pub const MAX_PROJECT_STATE_VERSION: u64 = i64::MAX as u64;

/// A durable, path-free view of one editable project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    metadata: ProjectMetadata,
    state_version: u64,
    media: Vec<MediaAsset>,
    tracks: Vec<SubtitleTrack>,
}

impl ProjectSnapshot {
    pub fn new(
        metadata: ProjectMetadata,
        state_version: u64,
        media: Vec<MediaAsset>,
        tracks: Vec<SubtitleTrack>,
    ) -> Result<Self, ProjectSnapshotError> {
        if state_version > MAX_PROJECT_STATE_VERSION {
            return Err(ProjectSnapshotError::StateVersionTooLarge(state_version));
        }
        if media.len() > MAX_PROJECT_MEDIA_ASSETS {
            return Err(ProjectSnapshotError::TooManyMediaAssets {
                maximum: MAX_PROJECT_MEDIA_ASSETS,
                actual: media.len(),
            });
        }
        if tracks.len() > MAX_PROJECT_TRACKS {
            return Err(ProjectSnapshotError::TooManyTracks {
                maximum: MAX_PROJECT_TRACKS,
                actual: tracks.len(),
            });
        }
        validate_unique_media(&media)?;
        validate_unique_tracks(&tracks)?;
        validate_cues(&tracks)?;
        Ok(Self {
            metadata,
            state_version,
            media,
            tracks,
        })
    }

    #[must_use]
    pub const fn metadata(&self) -> &ProjectMetadata {
        &self.metadata
    }

    #[must_use]
    pub const fn state_version(&self) -> u64 {
        self.state_version
    }

    #[must_use]
    pub fn media(&self) -> &[MediaAsset] {
        &self.media
    }

    #[must_use]
    pub fn tracks(&self) -> &[SubtitleTrack] {
        &self.tracks
    }

    pub fn with_state_version(&self, state_version: u64) -> Result<Self, ProjectSnapshotError> {
        Self::new(
            self.metadata.clone(),
            state_version,
            self.media.clone(),
            self.tracks.clone(),
        )
    }
}

impl<'de> Deserialize<'de> for ProjectSnapshot {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawProjectSnapshot {
            metadata: ProjectMetadata,
            state_version: u64,
            media: Vec<MediaAsset>,
            tracks: Vec<SubtitleTrack>,
        }

        let raw = RawProjectSnapshot::deserialize(deserializer)?;
        Self::new(raw.metadata, raw.state_version, raw.media, raw.tracks)
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionCommit {
    pub revision_id: RevisionId,
    pub state_version: u64,
}

/// A bounded, path-free view of the durable revision cursor.
///
/// `undo_reason` describes the selected revision that an undo would leave, while
/// `redo_reason` describes the revision at the top of the redo stack. Keeping the
/// reasons typed prevents corrupt or unbounded database strings from crossing IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHistoryStatus {
    pub state_version: u64,
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_reason: Option<RevisionReason>,
    pub redo_reason: Option<RevisionReason>,
}

/// Stable, path-free identity for one independently edited subtitle-track slot.
///
/// A selector is deliberately label/origin based instead of using a track UUID: the editor can
/// durably represent the empty state after deleting its last cue and later restore the same slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrackSelector {
    label: String,
    origin: TrackOrigin,
}

impl ProjectTrackSelector {
    pub fn new(
        label: impl Into<String>,
        origin: TrackOrigin,
    ) -> Result<Self, ProjectTrackSelectorError> {
        let label = label.into();
        let label = label.trim();
        if label.is_empty() {
            return Err(ProjectTrackSelectorError::BlankLabel);
        }
        if label.chars().any(char::is_control) {
            return Err(ProjectTrackSelectorError::ControlCharacter);
        }
        let actual_chars = label.chars().count();
        if actual_chars > MAX_TRACK_LABEL_CHARS {
            return Err(ProjectTrackSelectorError::LabelTooLong {
                maximum: MAX_TRACK_LABEL_CHARS,
                actual: actual_chars,
            });
        }
        Ok(Self {
            label: label.to_owned(),
            origin,
        })
    }

    #[must_use]
    pub fn label(&self) -> &str {
        &self.label
    }

    #[must_use]
    pub const fn origin(&self) -> TrackOrigin {
        self.origin
    }

    #[must_use]
    pub fn matches(&self, track: &SubtitleTrack) -> bool {
        track.label() == self.label && track.origin() == self.origin
    }
}

impl<'de> Deserialize<'de> for ProjectTrackSelector {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawSelector {
            label: String,
            origin: TrackOrigin,
        }

        let raw = RawSelector::deserialize(deserializer)?;
        Self::new(raw.label, raw.origin).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProjectTrackSelectorError {
    #[error("the project track selector label cannot be blank")]
    BlankLabel,
    #[error("the project track selector label cannot contain control characters")]
    ControlCharacter,
    #[error("the project track selector label has {actual} characters, exceeding {maximum}")]
    LabelTooLong { maximum: usize, actual: usize },
}

/// Bounded cursor state for the independent editor-track history.
///
/// `state_version` follows the whole project, while `history_version` changes only when this
/// editor cursor commits or navigates. That separation lets lyric undo preserve a newer media or
/// options revision while still rejecting a stale lyric writer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrackHistoryStatus {
    pub state_version: u64,
    pub history_version: u64,
    pub diverged: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_reason: Option<RevisionReason>,
    pub redo_reason: Option<RevisionReason>,
}

impl ProjectTrackHistoryStatus {
    #[must_use]
    pub fn new(
        state_version: u64,
        history_version: u64,
        diverged: bool,
        undo_reason: Option<RevisionReason>,
        redo_reason: Option<RevisionReason>,
    ) -> Self {
        let (undo_reason, redo_reason) = if diverged {
            (None, None)
        } else {
            (undo_reason, redo_reason)
        };
        Self {
            state_version,
            history_version,
            diverged,
            can_undo: undo_reason.is_some(),
            can_redo: redo_reason.is_some(),
            undo_reason,
            redo_reason,
        }
    }
}

/// Atomic result of applying or navigating one editor-track revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrackHistoryMutation {
    pub snapshot: ProjectSnapshot,
    pub status: ProjectTrackHistoryStatus,
}

impl ProjectHistoryStatus {
    #[must_use]
    pub fn new(
        state_version: u64,
        undo_reason: Option<RevisionReason>,
        redo_reason: Option<RevisionReason>,
    ) -> Self {
        Self {
            state_version,
            can_undo: undo_reason.is_some(),
            can_redo: redo_reason.is_some(),
            undo_reason,
            redo_reason,
        }
    }
}

/// Storage port for atomic project snapshots and optimistic revision commits.
pub trait ProjectRepository: Send + Sync {
    type Error: Error + Send + Sync + 'static;

    fn create(&self, metadata: &ProjectMetadata) -> Result<ProjectSnapshot, Self::Error>;

    fn load(&self, id: ProjectId) -> Result<Option<ProjectSnapshot>, Self::Error>;

    fn commit(
        &self,
        snapshot: &ProjectSnapshot,
        reason: &RevisionReason,
    ) -> Result<RevisionCommit, Self::Error>;
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProjectSnapshotError {
    #[error("a project contains an invalid asset identifier")]
    InvalidAssetId,
    #[error("a project contains an invalid track identifier")]
    InvalidTrackId,
    #[error("a project contains the asset {0} more than once")]
    DuplicateAsset(AssetId),
    #[error("a project contains the track {0} more than once")]
    DuplicateTrack(TrackId),
    #[error("a project contains cue {0} in more than one track")]
    DuplicateCue(CueId),
    #[error("a project state version {0} exceeds the durable storage range")]
    StateVersionTooLarge(u64),
    #[error("a project contains {actual} media assets, exceeding the limit of {maximum}")]
    TooManyMediaAssets { maximum: usize, actual: usize },
    #[error("a project contains {actual} tracks, exceeding the limit of {maximum}")]
    TooManyTracks { maximum: usize, actual: usize },
    #[error("a project contains {actual} cues, exceeding the limit of {maximum}")]
    TooManyCues { maximum: usize, actual: usize },
}

fn validate_unique_media(media: &[MediaAsset]) -> Result<(), ProjectSnapshotError> {
    let mut ids = HashSet::with_capacity(media.len());
    for asset in media {
        let id = asset.id();
        if !ids.insert(id) {
            return Err(ProjectSnapshotError::DuplicateAsset(id));
        }
    }
    Ok(())
}

fn validate_unique_tracks(tracks: &[SubtitleTrack]) -> Result<(), ProjectSnapshotError> {
    let mut ids = HashSet::with_capacity(tracks.len());
    for track in tracks {
        let id = track.id();
        if !ids.insert(id) {
            return Err(ProjectSnapshotError::DuplicateTrack(id));
        }
    }
    Ok(())
}

fn validate_cues(tracks: &[SubtitleTrack]) -> Result<(), ProjectSnapshotError> {
    let mut cue_count = 0_usize;
    let mut ids = HashSet::new();
    for track in tracks {
        cue_count = cue_count.saturating_add(track.cues().len());
        if cue_count > MAX_PROJECT_CUES {
            return Err(ProjectSnapshotError::TooManyCues {
                maximum: MAX_PROJECT_CUES,
                actual: cue_count,
            });
        }
        for cue in track.cues() {
            if !ids.insert(cue.id()) {
                return Err(ProjectSnapshotError::DuplicateCue(cue.id()));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use osg_domain::{
        MediaAsset, MediaKind, ProjectMetadata, RevisionReason, SubtitleCue, SubtitleTrack,
        TrackOrigin,
    };

    use super::{
        MAX_PROJECT_STATE_VERSION, ProjectHistoryStatus, ProjectSnapshot, ProjectSnapshotError,
        ProjectTrackHistoryStatus, ProjectTrackSelector,
    };

    #[test]
    fn snapshot_is_path_free_and_preserves_canonical_content() {
        let snapshot = ProjectSnapshot::new(
            ProjectMetadata::new("Demo").expect("valid project"),
            3,
            vec![
                MediaAsset::new(
                    "clip.mp4".to_owned(),
                    "mp4".to_owned(),
                    42,
                    MediaKind::Video,
                )
                .expect("valid media"),
            ],
            vec![
                SubtitleTrack::new(
                    "English",
                    TrackOrigin::Srt,
                    vec![SubtitleCue::new(0, 1_000, "Hello".to_owned()).expect("valid cue")],
                )
                .expect("valid track"),
            ],
        )
        .expect("valid snapshot");
        let json = serde_json::to_string(&snapshot).expect("serializable snapshot");

        assert_eq!(snapshot.state_version(), 3);
        assert!(json.contains("clip.mp4"));
        assert!(!json.contains("canonicalPath"));
        assert!(!json.contains("C:\\\\"));

        let restored: ProjectSnapshot =
            serde_json::from_str(&json).expect("valid persisted snapshot");
        assert_eq!(restored, snapshot);
    }

    #[test]
    fn duplicate_assets_and_tracks_are_rejected() {
        let asset = MediaAsset::new(
            "clip.mp4".to_owned(),
            "mp4".to_owned(),
            42,
            MediaKind::Video,
        )
        .expect("valid media");
        let track = SubtitleTrack::new(
            "English",
            TrackOrigin::Srt,
            vec![SubtitleCue::new(0, 1_000, "Hello".to_owned()).expect("valid cue")],
        )
        .expect("valid track");
        let metadata = ProjectMetadata::new("Demo").expect("valid project");

        assert!(matches!(
            ProjectSnapshot::new(metadata.clone(), 0, vec![asset.clone(), asset], vec![]),
            Err(ProjectSnapshotError::DuplicateAsset(_))
        ));
        assert!(matches!(
            ProjectSnapshot::new(metadata, 0, vec![], vec![track.clone(), track]),
            Err(ProjectSnapshotError::DuplicateTrack(_))
        ));
    }

    #[test]
    fn cue_ids_are_unique_across_the_whole_project_and_versions_fit_sqlite() {
        let cue = SubtitleCue::new(0, 1_000, "Hello".to_owned()).expect("valid cue");
        let first = SubtitleTrack::new("First", TrackOrigin::Srt, vec![cue.clone()])
            .expect("valid first track");
        let second =
            SubtitleTrack::new("Second", TrackOrigin::Srt, vec![cue]).expect("valid second track");
        let metadata = ProjectMetadata::new("Demo").expect("valid project");

        assert!(matches!(
            ProjectSnapshot::new(metadata.clone(), 0, vec![], vec![first, second]),
            Err(ProjectSnapshotError::DuplicateCue(_))
        ));
        assert!(matches!(
            ProjectSnapshot::new(
                metadata,
                MAX_PROJECT_STATE_VERSION + 1,
                Vec::new(),
                Vec::new()
            ),
            Err(ProjectSnapshotError::StateVersionTooLarge(_))
        ));
    }

    #[test]
    fn history_status_serializes_an_exact_bounded_cursor_contract() {
        let status = ProjectHistoryStatus::new(
            7,
            Some(RevisionReason::new("Edit subtitles").expect("valid reason")),
            None,
        );
        assert_eq!(
            serde_json::to_value(status).expect("serializable status"),
            serde_json::json!({
                "stateVersion": 7,
                "canUndo": true,
                "canRedo": false,
                "undoReason": "Edit subtitles",
                "redoReason": null,
            })
        );
    }

    #[test]
    fn track_history_contract_separates_project_and_editor_versions() {
        let selector = ProjectTrackSelector::new("  Cached subtitles  ", TrackOrigin::LegacyJson)
            .expect("valid selector");
        assert_eq!(selector.label(), "Cached subtitles");

        let status = ProjectTrackHistoryStatus::new(
            12,
            4,
            false,
            Some(RevisionReason::new("Editor text").expect("valid reason")),
            None,
        );
        assert_eq!(
            serde_json::to_value(status).expect("serializable status"),
            serde_json::json!({
                "stateVersion": 12,
                "historyVersion": 4,
                "diverged": false,
                "canUndo": true,
                "canRedo": false,
                "undoReason": "Editor text",
                "redoReason": null,
            })
        );

        let diverged = ProjectTrackHistoryStatus::new(
            13,
            4,
            true,
            Some(RevisionReason::new("hidden").expect("valid reason")),
            None,
        );
        assert!(diverged.diverged);
        assert!(!diverged.can_undo);
        assert!(diverged.undo_reason.is_none());
    }
}
