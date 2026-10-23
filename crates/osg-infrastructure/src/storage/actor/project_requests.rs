//! Project requests: revisions, undo/redo, editor-track history, speech references, and render
//! scenes.

use std::sync::mpsc::SyncSender;

use osg_application::{
    ProjectHistoryStatus, ProjectSnapshot, ProjectTrackHistoryMutation, ProjectTrackHistoryStatus,
    ProjectTrackSelector, RevisionCommit,
};
use osg_domain::{ProjectId, ProjectMetadata, RevisionReason, SubtitleTrack};
use rusqlite::Connection;

use super::{Database, Request};
use crate::storage::error::DatabaseError;
use crate::storage::project_render_scenes;
use crate::storage::project_speech_references;
use crate::storage::projects;
use crate::storage::track_history;
use crate::storage::{
    ProjectRenderSceneRecord, ProjectRenderSceneWrite, ProjectSpeechReference,
    ProjectSpeechReferenceWrite,
};

pub(super) enum ProjectRequest {
    GetProjectSpeechReference {
        project_id: ProjectId,
        reply: SyncSender<Result<Option<ProjectSpeechReference>, DatabaseError>>,
    },
    PutProjectSpeechReference {
        write: ProjectSpeechReferenceWrite,
        reply: SyncSender<Result<ProjectSpeechReference, DatabaseError>>,
    },
    DeleteProjectSpeechReference {
        project_id: ProjectId,
        expected_project_state_version: u64,
        expected_reference_version: u64,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
    GetProjectRenderScene {
        project_id: ProjectId,
        reply: SyncSender<Result<Option<ProjectRenderSceneRecord>, DatabaseError>>,
    },
    PutProjectRenderScene {
        write: ProjectRenderSceneWrite,
        reply: SyncSender<Result<ProjectRenderSceneRecord, DatabaseError>>,
    },
    CreateProject {
        metadata: ProjectMetadata,
        reply: SyncSender<Result<ProjectSnapshot, DatabaseError>>,
    },
    CreateProjectIdempotent {
        metadata: ProjectMetadata,
        idempotency_key: String,
        reply: SyncSender<Result<ProjectSnapshot, DatabaseError>>,
    },
    LoadProject {
        id: ProjectId,
        reply: SyncSender<Result<Option<ProjectSnapshot>, DatabaseError>>,
    },
    ProjectHistoryStatus {
        id: ProjectId,
        reply: SyncSender<Result<ProjectHistoryStatus, DatabaseError>>,
    },
    ProjectTrackHistoryStatus {
        id: ProjectId,
        selector: ProjectTrackSelector,
        reply: SyncSender<Result<ProjectTrackHistoryStatus, DatabaseError>>,
    },
    CommitProjectTrack {
        id: ProjectId,
        selector: ProjectTrackSelector,
        expected_history_version: u64,
        before: Option<SubtitleTrack>,
        after: Option<SubtitleTrack>,
        reason: RevisionReason,
        reply: SyncSender<Result<ProjectTrackHistoryMutation, DatabaseError>>,
    },
    UndoProjectTrack {
        id: ProjectId,
        selector: ProjectTrackSelector,
        expected_history_version: u64,
        expected_reason: RevisionReason,
        reply: SyncSender<Result<Option<ProjectTrackHistoryMutation>, DatabaseError>>,
    },
    RedoProjectTrack {
        id: ProjectId,
        selector: ProjectTrackSelector,
        expected_history_version: u64,
        expected_reason: RevisionReason,
        reply: SyncSender<Result<Option<ProjectTrackHistoryMutation>, DatabaseError>>,
    },
    CommitProject {
        snapshot: ProjectSnapshot,
        reason: RevisionReason,
        reply: SyncSender<Result<RevisionCommit, DatabaseError>>,
    },
    UndoProject {
        id: ProjectId,
        expected_version: u64,
        expected_reason: Option<RevisionReason>,
        reply: SyncSender<Result<Option<ProjectSnapshot>, DatabaseError>>,
    },
    RedoProject {
        id: ProjectId,
        expected_version: u64,
        expected_reason: Option<RevisionReason>,
        reply: SyncSender<Result<Option<ProjectSnapshot>, DatabaseError>>,
    },
}

impl std::fmt::Debug for ProjectRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::GetProjectSpeechReference { .. } => "GetProjectSpeechReference",
            Self::PutProjectSpeechReference { .. } => "PutProjectSpeechReference",
            Self::DeleteProjectSpeechReference { .. } => "DeleteProjectSpeechReference",
            Self::GetProjectRenderScene { .. } => "GetProjectRenderScene",
            Self::PutProjectRenderScene { .. } => "PutProjectRenderScene",
            Self::CreateProject { .. } => "CreateProject",
            Self::CreateProjectIdempotent { .. } => "CreateProjectIdempotent",
            Self::LoadProject { .. } => "LoadProject",
            Self::ProjectHistoryStatus { .. } => "ProjectHistoryStatus",
            Self::ProjectTrackHistoryStatus { .. } => "ProjectTrackHistoryStatus",
            Self::CommitProjectTrack { .. } => "CommitProjectTrack",
            Self::UndoProjectTrack { .. } => "UndoProjectTrack",
            Self::RedoProjectTrack { .. } => "RedoProjectTrack",
            Self::CommitProject { .. } => "CommitProject",
            Self::UndoProject { .. } => "UndoProject",
            Self::RedoProject { .. } => "RedoProject",
        })
    }
}

impl From<ProjectRequest> for Request {
    fn from(request: ProjectRequest) -> Self {
        Self::Projects(request)
    }
}

impl ProjectRequest {
    #[allow(clippy::too_many_lines)]
    pub(super) fn handle(self, connection: &mut Connection) {
        match self {
            Self::GetProjectSpeechReference { project_id, reply } => {
                let _ = reply.send(project_speech_references::get(connection, project_id));
            }
            Self::PutProjectSpeechReference { write, reply } => {
                let _ = reply.send(project_speech_references::put(connection, &write));
            }
            Self::DeleteProjectSpeechReference {
                project_id,
                expected_project_state_version,
                expected_reference_version,
                reply,
            } => {
                let _ = reply.send(project_speech_references::delete(
                    connection,
                    project_id,
                    expected_project_state_version,
                    expected_reference_version,
                ));
            }
            Self::GetProjectRenderScene { project_id, reply } => {
                let _ = reply.send(project_render_scenes::get(connection, project_id));
            }
            Self::PutProjectRenderScene { write, reply } => {
                let _ = reply.send(project_render_scenes::put(connection, &write));
            }
            Self::CreateProject { metadata, reply } => {
                let _ = reply.send(projects::create_project(connection, &metadata));
            }
            Self::CreateProjectIdempotent {
                metadata,
                idempotency_key,
                reply,
            } => {
                let _ = reply.send(projects::create_project_idempotent(
                    connection,
                    &metadata,
                    &idempotency_key,
                ));
            }
            Self::LoadProject { id, reply } => {
                let _ = reply.send(projects::load_project(connection, id));
            }
            Self::ProjectHistoryStatus { id, reply } => {
                let _ = reply.send(projects::project_history_status(connection, id));
            }
            Self::ProjectTrackHistoryStatus {
                id,
                selector,
                reply,
            } => {
                let _ = reply.send(track_history::status(connection, id, &selector));
            }
            Self::CommitProjectTrack {
                id,
                selector,
                expected_history_version,
                before,
                after,
                reason,
                reply,
            } => {
                let _ = reply.send(track_history::commit(
                    connection,
                    id,
                    &selector,
                    expected_history_version,
                    before.as_ref(),
                    after.as_ref(),
                    &reason,
                ));
            }
            Self::UndoProjectTrack {
                id,
                selector,
                expected_history_version,
                expected_reason,
                reply,
            } => {
                let _ = reply.send(track_history::undo(
                    connection,
                    id,
                    &selector,
                    expected_history_version,
                    &expected_reason,
                ));
            }
            Self::RedoProjectTrack {
                id,
                selector,
                expected_history_version,
                expected_reason,
                reply,
            } => {
                let _ = reply.send(track_history::redo(
                    connection,
                    id,
                    &selector,
                    expected_history_version,
                    &expected_reason,
                ));
            }
            Self::CommitProject {
                snapshot,
                reason,
                reply,
            } => {
                let _ = reply.send(projects::commit_project(connection, &snapshot, &reason));
            }
            Self::UndoProject {
                id,
                expected_version,
                expected_reason,
                reply,
            } => {
                let _ = reply.send(projects::undo_project(
                    connection,
                    id,
                    expected_version,
                    expected_reason.as_ref(),
                ));
            }
            Self::RedoProject {
                id,
                expected_version,
                expected_reason,
                reply,
            } => {
                let _ = reply.send(projects::redo_project(
                    connection,
                    id,
                    expected_version,
                    expected_reason.as_ref(),
                ));
            }
        }
    }
}

impl Database {
    pub fn get_project_speech_reference(
        &self,
        project_id: ProjectId,
    ) -> Result<Option<ProjectSpeechReference>, DatabaseError> {
        self.request(|reply| ProjectRequest::GetProjectSpeechReference { project_id, reply })
    }

    pub fn put_project_speech_reference(
        &self,
        write: &ProjectSpeechReferenceWrite,
    ) -> Result<ProjectSpeechReference, DatabaseError> {
        self.request(|reply| ProjectRequest::PutProjectSpeechReference {
            write: write.clone(),
            reply,
        })
    }

    pub fn delete_project_speech_reference(
        &self,
        project_id: ProjectId,
        expected_project_state_version: u64,
        expected_reference_version: u64,
    ) -> Result<bool, DatabaseError> {
        self.request(|reply| ProjectRequest::DeleteProjectSpeechReference {
            project_id,
            expected_project_state_version,
            expected_reference_version,
            reply,
        })
    }

    pub fn get_project_render_scene(
        &self,
        project_id: ProjectId,
    ) -> Result<Option<ProjectRenderSceneRecord>, DatabaseError> {
        self.request(|reply| ProjectRequest::GetProjectRenderScene { project_id, reply })
    }

    pub fn put_project_render_scene(
        &self,
        write: &ProjectRenderSceneWrite,
    ) -> Result<ProjectRenderSceneRecord, DatabaseError> {
        self.request(|reply| ProjectRequest::PutProjectRenderScene {
            write: write.clone(),
            reply,
        })
    }

    pub fn create_project(
        &self,
        metadata: &ProjectMetadata,
    ) -> Result<ProjectSnapshot, DatabaseError> {
        self.request(|reply| ProjectRequest::CreateProject {
            metadata: metadata.clone(),
            reply,
        })
    }

    pub fn create_project_idempotent(
        &self,
        metadata: &ProjectMetadata,
        idempotency_key: &str,
    ) -> Result<ProjectSnapshot, DatabaseError> {
        self.request(|reply| ProjectRequest::CreateProjectIdempotent {
            metadata: metadata.clone(),
            idempotency_key: idempotency_key.to_owned(),
            reply,
        })
    }

    pub fn load_project(&self, id: ProjectId) -> Result<Option<ProjectSnapshot>, DatabaseError> {
        self.request(|reply| ProjectRequest::LoadProject { id, reply })
    }

    pub fn project_history_status(
        &self,
        id: ProjectId,
    ) -> Result<ProjectHistoryStatus, DatabaseError> {
        self.request(|reply| ProjectRequest::ProjectHistoryStatus { id, reply })
    }

    pub fn project_track_history_status(
        &self,
        id: ProjectId,
        selector: &ProjectTrackSelector,
    ) -> Result<ProjectTrackHistoryStatus, DatabaseError> {
        self.request(|reply| ProjectRequest::ProjectTrackHistoryStatus {
            id,
            selector: selector.clone(),
            reply,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn commit_project_track(
        &self,
        id: ProjectId,
        selector: &ProjectTrackSelector,
        expected_history_version: u64,
        before: Option<&SubtitleTrack>,
        after: Option<&SubtitleTrack>,
        reason: &RevisionReason,
    ) -> Result<ProjectTrackHistoryMutation, DatabaseError> {
        self.request(|reply| ProjectRequest::CommitProjectTrack {
            id,
            selector: selector.clone(),
            expected_history_version,
            before: before.cloned(),
            after: after.cloned(),
            reason: reason.clone(),
            reply,
        })
    }

    pub fn undo_project_track(
        &self,
        id: ProjectId,
        selector: &ProjectTrackSelector,
        expected_history_version: u64,
        expected_reason: &RevisionReason,
    ) -> Result<Option<ProjectTrackHistoryMutation>, DatabaseError> {
        self.request(|reply| ProjectRequest::UndoProjectTrack {
            id,
            selector: selector.clone(),
            expected_history_version,
            expected_reason: expected_reason.clone(),
            reply,
        })
    }

    pub fn redo_project_track(
        &self,
        id: ProjectId,
        selector: &ProjectTrackSelector,
        expected_history_version: u64,
        expected_reason: &RevisionReason,
    ) -> Result<Option<ProjectTrackHistoryMutation>, DatabaseError> {
        self.request(|reply| ProjectRequest::RedoProjectTrack {
            id,
            selector: selector.clone(),
            expected_history_version,
            expected_reason: expected_reason.clone(),
            reply,
        })
    }

    pub fn commit_project(
        &self,
        snapshot: &ProjectSnapshot,
        reason: &RevisionReason,
    ) -> Result<RevisionCommit, DatabaseError> {
        self.request(|reply| ProjectRequest::CommitProject {
            snapshot: snapshot.clone(),
            reason: reason.clone(),
            reply,
        })
    }

    pub fn undo_project(
        &self,
        id: ProjectId,
        expected_version: u64,
    ) -> Result<Option<ProjectSnapshot>, DatabaseError> {
        self.request(|reply| ProjectRequest::UndoProject {
            id,
            expected_version,
            expected_reason: None,
            reply,
        })
    }

    pub fn undo_project_guarded(
        &self,
        id: ProjectId,
        expected_version: u64,
        expected_reason: &RevisionReason,
    ) -> Result<Option<ProjectSnapshot>, DatabaseError> {
        self.request(|reply| ProjectRequest::UndoProject {
            id,
            expected_version,
            expected_reason: Some(expected_reason.clone()),
            reply,
        })
    }

    pub fn redo_project(
        &self,
        id: ProjectId,
        expected_version: u64,
    ) -> Result<Option<ProjectSnapshot>, DatabaseError> {
        self.request(|reply| ProjectRequest::RedoProject {
            id,
            expected_version,
            expected_reason: None,
            reply,
        })
    }

    pub fn redo_project_guarded(
        &self,
        id: ProjectId,
        expected_version: u64,
        expected_reason: &RevisionReason,
    ) -> Result<Option<ProjectSnapshot>, DatabaseError> {
        self.request(|reply| ProjectRequest::RedoProject {
            id,
            expected_version,
            expected_reason: Some(expected_reason.clone()),
            reply,
        })
    }
}
