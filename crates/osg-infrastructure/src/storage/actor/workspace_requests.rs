//! Active-workspace pointer and project-alias index requests.

use std::sync::mpsc::SyncSender;

use osg_domain::ProjectId;
use rusqlite::Connection;
use uuid::Uuid;

use super::{Database, Request};
use crate::storage::active_workspace;
use crate::storage::error::DatabaseError;
use crate::storage::{
    ActiveWorkspace, ActiveWorkspacePointer, ActiveWorkspaceState, ProjectAliasEntry,
    ProjectAliasIndex, ProjectAliasMutation,
};

pub(super) enum WorkspaceRequest {
    GetActiveWorkspace {
        reply: SyncSender<Result<ActiveWorkspaceState, DatabaseError>>,
    },
    BeginActiveWorkspaceIntent {
        intent_id: Uuid,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    SetActiveWorkspace {
        pointer: ActiveWorkspacePointer,
        intent_id: Uuid,
        reply: SyncSender<Result<ActiveWorkspace, DatabaseError>>,
    },
    ClearActiveWorkspace {
        expected: Option<ActiveWorkspacePointer>,
        intent_id: Uuid,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
    GetProjectAliasIndex {
        reply: SyncSender<Result<Option<ProjectAliasIndex>, DatabaseError>>,
    },
    SetProjectAliasIndex {
        index: ProjectAliasIndex,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    ActivateProjectAlias {
        entry: ProjectAliasEntry,
        reply: SyncSender<Result<ProjectAliasIndex, DatabaseError>>,
    },
    RemoveProjectAlias {
        cache_id: String,
        expected_project_id: ProjectId,
        reply: SyncSender<Result<ProjectAliasMutation, DatabaseError>>,
    },
}

impl std::fmt::Debug for WorkspaceRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::GetActiveWorkspace { .. } => "GetActiveWorkspace",
            Self::BeginActiveWorkspaceIntent { .. } => "BeginActiveWorkspaceIntent",
            Self::SetActiveWorkspace { .. } => "SetActiveWorkspace",
            Self::ClearActiveWorkspace { .. } => "ClearActiveWorkspace",
            Self::GetProjectAliasIndex { .. } => "GetProjectAliasIndex",
            Self::SetProjectAliasIndex { .. } => "SetProjectAliasIndex",
            Self::ActivateProjectAlias { .. } => "ActivateProjectAlias",
            Self::RemoveProjectAlias { .. } => "RemoveProjectAlias",
        })
    }
}

impl From<WorkspaceRequest> for Request {
    fn from(request: WorkspaceRequest) -> Self {
        Self::Workspace(request)
    }
}

impl WorkspaceRequest {
    pub(super) fn handle(self, connection: &mut Connection) {
        match self {
            Self::GetActiveWorkspace { reply } => {
                let _ = reply.send(active_workspace::get_active_workspace(connection));
            }
            Self::BeginActiveWorkspaceIntent { intent_id, reply } => {
                let _ = reply.send(active_workspace::begin_active_workspace_intent(
                    connection, intent_id,
                ));
            }
            Self::SetActiveWorkspace {
                pointer,
                intent_id,
                reply,
            } => {
                let _ = reply.send(active_workspace::set_active_workspace(
                    connection, &pointer, intent_id,
                ));
            }
            Self::ClearActiveWorkspace {
                expected,
                intent_id,
                reply,
            } => {
                let _ = reply.send(active_workspace::clear_active_workspace(
                    connection,
                    expected.as_ref(),
                    intent_id,
                ));
            }
            Self::GetProjectAliasIndex { reply } => {
                let _ = reply.send(active_workspace::get_project_alias_index(connection));
            }
            Self::SetProjectAliasIndex { index, reply } => {
                let _ = reply.send(active_workspace::set_project_alias_index(
                    connection, &index,
                ));
            }
            Self::ActivateProjectAlias { entry, reply } => {
                let _ = reply.send(active_workspace::activate_project_alias(connection, &entry));
            }
            Self::RemoveProjectAlias {
                cache_id,
                expected_project_id,
                reply,
            } => {
                let _ = reply.send(active_workspace::remove_project_alias(
                    connection,
                    &cache_id,
                    expected_project_id,
                ));
            }
        }
    }
}

impl Database {
    pub fn get_active_workspace(&self) -> Result<ActiveWorkspaceState, DatabaseError> {
        self.request(|reply| WorkspaceRequest::GetActiveWorkspace { reply })
    }

    pub fn set_active_workspace(
        &self,
        pointer: &ActiveWorkspacePointer,
        intent_id: Uuid,
    ) -> Result<ActiveWorkspace, DatabaseError> {
        self.request(|reply| WorkspaceRequest::SetActiveWorkspace {
            pointer: pointer.clone(),
            intent_id,
            reply,
        })
    }

    pub fn begin_active_workspace_intent(&self, intent_id: Uuid) -> Result<(), DatabaseError> {
        self.request(|reply| WorkspaceRequest::BeginActiveWorkspaceIntent { intent_id, reply })
    }

    pub fn clear_active_workspace(
        &self,
        expected: Option<&ActiveWorkspacePointer>,
        intent_id: Uuid,
    ) -> Result<bool, DatabaseError> {
        self.request(|reply| WorkspaceRequest::ClearActiveWorkspace {
            expected: expected.cloned(),
            intent_id,
            reply,
        })
    }

    pub fn get_project_alias_index(&self) -> Result<Option<ProjectAliasIndex>, DatabaseError> {
        self.request(|reply| WorkspaceRequest::GetProjectAliasIndex { reply })
    }

    pub fn set_project_alias_index(&self, index: &ProjectAliasIndex) -> Result<(), DatabaseError> {
        self.request(|reply| WorkspaceRequest::SetProjectAliasIndex {
            index: index.clone(),
            reply,
        })
    }

    pub fn activate_project_alias(
        &self,
        entry: &ProjectAliasEntry,
    ) -> Result<ProjectAliasIndex, DatabaseError> {
        self.request(|reply| WorkspaceRequest::ActivateProjectAlias {
            entry: entry.clone(),
            reply,
        })
    }

    pub fn remove_project_alias(
        &self,
        cache_id: &str,
        expected_project_id: ProjectId,
    ) -> Result<ProjectAliasMutation, DatabaseError> {
        self.request(|reply| WorkspaceRequest::RemoveProjectAlias {
            cache_id: cache_id.to_owned(),
            expected_project_id,
            reply,
        })
    }
}
