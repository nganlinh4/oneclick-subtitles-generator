//! Artifact registry and content-addressed cache requests.

use std::sync::mpsc::SyncSender;

use osg_domain::ProjectId;
use rusqlite::Connection;

use super::{Database, MAX_ARTIFACT_LIST_ITEMS, Request};
use crate::storage::artifacts;
use crate::storage::artifacts::ArtifactRoot;
use crate::storage::error::DatabaseError;
use crate::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRecord,
    ArtifactRegistration, CacheCategory, CacheClearOutcome, CacheClearResult, CacheInfo, CacheKey,
    CacheLeaseId, CacheWrite, LeasedArtifact, ReconciliationReport, ResolvedArtifact,
};

pub(super) enum ArtifactRequest {
    RegisterArtifact {
        draft: ArtifactDraft,
        reply: SyncSender<Result<ArtifactRegistration, DatabaseError>>,
    },
    GetArtifact {
        id: ArtifactId,
        reply: SyncSender<Result<Option<ArtifactRecord>, DatabaseError>>,
    },
    ListReadyArtifacts {
        project_id: ProjectId,
        kind: ArtifactKind,
        limit: usize,
        reply: SyncSender<Result<Vec<ArtifactRecord>, DatabaseError>>,
    },
    MarkArtifactReady {
        id: ArtifactId,
        reply: SyncSender<Result<ArtifactRecord, DatabaseError>>,
    },
    MarkArtifactFailed {
        id: ArtifactId,
        failure_code: ArtifactFailureCode,
        reply: SyncSender<Result<ArtifactRecord, DatabaseError>>,
    },
    ResolveArtifact {
        id: ArtifactId,
        reply: SyncSender<Result<Option<ResolvedArtifact>, DatabaseError>>,
    },
    RemoveArtifact {
        id: ArtifactId,
        reply: SyncSender<Result<Option<ArtifactRecord>, DatabaseError>>,
    },
    PutCache {
        write: CacheWrite,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    CommitCacheArtifact {
        write: CacheWrite,
        reply: SyncSender<Result<ResolvedArtifact, DatabaseError>>,
    },
    LookupCache {
        key: CacheKey,
        reply: SyncSender<Result<Option<ResolvedArtifact>, DatabaseError>>,
    },
    InvalidateCache {
        key: CacheKey,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
    LeaseCache {
        key: CacheKey,
        owner: String,
        ttl_ms: u64,
        reply: SyncSender<Result<Option<LeasedArtifact>, DatabaseError>>,
    },
    ReleaseCacheLease {
        id: CacheLeaseId,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
    CacheInfo {
        reply: SyncSender<Result<CacheInfo, DatabaseError>>,
    },
    ClearCache {
        category: Option<CacheCategory>,
        reply: SyncSender<Result<CacheClearResult, DatabaseError>>,
    },
    ClearCacheWithInfo {
        category: Option<CacheCategory>,
        reply: SyncSender<Result<CacheClearOutcome, DatabaseError>>,
    },
    ReconcileArtifacts {
        reply: SyncSender<Result<ReconciliationReport, DatabaseError>>,
    },
}

impl std::fmt::Debug for ArtifactRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::RegisterArtifact { .. } => "RegisterArtifact",
            Self::GetArtifact { .. } => "GetArtifact",
            Self::ListReadyArtifacts { .. } => "ListReadyArtifacts",
            Self::MarkArtifactReady { .. } => "MarkArtifactReady",
            Self::MarkArtifactFailed { .. } => "MarkArtifactFailed",
            Self::ResolveArtifact { .. } => "ResolveArtifact",
            Self::RemoveArtifact { .. } => "RemoveArtifact",
            Self::PutCache { .. } => "PutCache",
            Self::CommitCacheArtifact { .. } => "CommitCacheArtifact",
            Self::LookupCache { .. } => "LookupCache",
            Self::InvalidateCache { .. } => "InvalidateCache",
            Self::LeaseCache { .. } => "LeaseCache",
            Self::ReleaseCacheLease { .. } => "ReleaseCacheLease",
            Self::CacheInfo { .. } => "CacheInfo",
            Self::ClearCache { .. } => "ClearCache",
            Self::ClearCacheWithInfo { .. } => "ClearCacheWithInfo",
            Self::ReconcileArtifacts { .. } => "ReconcileArtifacts",
        })
    }
}

impl From<ArtifactRequest> for Request {
    fn from(request: ArtifactRequest) -> Self {
        Self::Artifacts(request)
    }
}

impl ArtifactRequest {
    #[allow(clippy::too_many_lines)]
    pub(super) fn handle(self, connection: &mut Connection, artifact_root: &ArtifactRoot) {
        match self {
            Self::RegisterArtifact { draft, reply } => {
                let _ = reply.send(artifacts::register(connection, artifact_root, &draft));
            }
            Self::GetArtifact { id, reply } => {
                let _ = reply.send(artifacts::get(connection, id));
            }
            Self::ListReadyArtifacts {
                project_id,
                kind,
                limit,
                reply,
            } => {
                let _ = reply.send(artifacts::list_ready_for_project(
                    connection, project_id, &kind, limit,
                ));
            }
            Self::MarkArtifactReady { id, reply } => {
                let _ = reply.send(artifacts::ready(connection, artifact_root, id));
            }
            Self::MarkArtifactFailed {
                id,
                failure_code,
                reply,
            } => {
                let _ = reply.send(artifacts::fail(
                    connection,
                    artifact_root,
                    id,
                    &failure_code,
                ));
            }
            Self::ResolveArtifact { id, reply } => {
                let _ = reply.send(artifacts::resolve(connection, artifact_root, id));
            }
            Self::RemoveArtifact { id, reply } => {
                let _ = reply.send(artifacts::remove(connection, artifact_root, id));
            }
            Self::PutCache { write, reply } => {
                let _ = reply.send(artifacts::put_cache(connection, &write));
            }
            Self::CommitCacheArtifact { write, reply } => {
                let _ = reply.send(artifacts::commit_cache_artifact(
                    connection,
                    artifact_root,
                    &write,
                ));
            }
            Self::LookupCache { key, reply } => {
                let _ = reply.send(artifacts::lookup_cache(connection, artifact_root, key));
            }
            Self::InvalidateCache { key, reply } => {
                let _ = reply.send(artifacts::invalidate_cache(connection, artifact_root, key));
            }
            Self::LeaseCache {
                key,
                owner,
                ttl_ms,
                reply,
            } => {
                let _ = reply.send(artifacts::lease_cache(
                    connection,
                    artifact_root,
                    key,
                    &owner,
                    ttl_ms,
                ));
            }
            Self::ReleaseCacheLease { id, reply } => {
                let _ = reply.send(artifacts::release_cache_lease(connection, id));
            }
            Self::CacheInfo { reply } => {
                let _ = reply.send(artifacts::cache_info(connection, artifact_root));
            }
            Self::ClearCache { category, reply } => {
                let _ = reply.send(artifacts::clear_cache(
                    connection,
                    artifact_root,
                    category.as_ref(),
                ));
            }
            Self::ClearCacheWithInfo { category, reply } => {
                let _ = reply.send(artifacts::clear_cache_with_info(
                    connection,
                    artifact_root,
                    category.as_ref(),
                ));
            }
            Self::ReconcileArtifacts { reply } => {
                let _ = reply.send(artifacts::reconcile(connection, artifact_root));
            }
        }
    }
}

impl Database {
    pub fn register_artifact(
        &self,
        draft: &ArtifactDraft,
    ) -> Result<ArtifactRegistration, DatabaseError> {
        self.request(|reply| ArtifactRequest::RegisterArtifact {
            draft: draft.clone(),
            reply,
        })
    }

    pub fn get_artifact(&self, id: ArtifactId) -> Result<Option<ArtifactRecord>, DatabaseError> {
        self.request(|reply| ArtifactRequest::GetArtifact { id, reply })
    }

    pub fn list_ready_artifacts(
        &self,
        project_id: ProjectId,
        kind: &ArtifactKind,
        limit: usize,
    ) -> Result<Vec<ArtifactRecord>, DatabaseError> {
        if limit == 0 || limit > MAX_ARTIFACT_LIST_ITEMS {
            return Err(DatabaseError::InvalidArtifactMetadata);
        }
        self.request(|reply| ArtifactRequest::ListReadyArtifacts {
            project_id,
            kind: kind.clone(),
            limit,
            reply,
        })
    }

    pub fn mark_artifact_ready(&self, id: ArtifactId) -> Result<ArtifactRecord, DatabaseError> {
        self.request(|reply| ArtifactRequest::MarkArtifactReady { id, reply })
    }

    pub fn mark_artifact_failed(
        &self,
        id: ArtifactId,
        failure_code: &ArtifactFailureCode,
    ) -> Result<ArtifactRecord, DatabaseError> {
        self.request(|reply| ArtifactRequest::MarkArtifactFailed {
            id,
            failure_code: failure_code.clone(),
            reply,
        })
    }

    pub fn resolve_artifact(
        &self,
        id: ArtifactId,
    ) -> Result<Option<ResolvedArtifact>, DatabaseError> {
        self.request(|reply| ArtifactRequest::ResolveArtifact { id, reply })
    }

    pub fn remove_artifact(&self, id: ArtifactId) -> Result<Option<ArtifactRecord>, DatabaseError> {
        self.request(|reply| ArtifactRequest::RemoveArtifact { id, reply })
    }

    pub fn put_cache_entry(&self, write: &CacheWrite) -> Result<(), DatabaseError> {
        self.request(|reply| ArtifactRequest::PutCache {
            write: write.clone(),
            reply,
        })
    }

    /// Publishes a staged cache artifact and its lookup row as one database transaction.
    ///
    /// The content-addressed file is validated and sealed before the transaction. If the process
    /// stops between those steps, startup reconciliation sees a pending, unreferenced cache
    /// artifact and removes it; callers never observe a ready artifact without its cache key.
    pub fn commit_cache_artifact(
        &self,
        write: &CacheWrite,
    ) -> Result<ResolvedArtifact, DatabaseError> {
        self.request(|reply| ArtifactRequest::CommitCacheArtifact {
            write: write.clone(),
            reply,
        })
    }

    pub fn lookup_cache(&self, key: CacheKey) -> Result<Option<ResolvedArtifact>, DatabaseError> {
        self.request(|reply| ArtifactRequest::LookupCache { key, reply })
    }

    /// Removes one semantically invalid cache mapping and its now-unreferenced cache bytes.
    pub fn invalidate_cache(&self, key: CacheKey) -> Result<bool, DatabaseError> {
        self.request(|reply| ArtifactRequest::InvalidateCache { key, reply })
    }

    pub fn lease_cache(
        &self,
        key: CacheKey,
        owner: &str,
        ttl_ms: u64,
    ) -> Result<Option<LeasedArtifact>, DatabaseError> {
        self.request(|reply| ArtifactRequest::LeaseCache {
            key,
            owner: owner.to_owned(),
            ttl_ms,
            reply,
        })
    }

    pub fn release_cache_lease(&self, id: CacheLeaseId) -> Result<bool, DatabaseError> {
        self.request(|reply| ArtifactRequest::ReleaseCacheLease { id, reply })
    }

    pub fn cache_info(&self) -> Result<CacheInfo, DatabaseError> {
        self.request(|reply| ArtifactRequest::CacheInfo { reply })
    }

    pub fn clear_cache_category(
        &self,
        category: &CacheCategory,
    ) -> Result<CacheClearResult, DatabaseError> {
        self.request(|reply| ArtifactRequest::ClearCache {
            category: Some(category.clone()),
            reply,
        })
    }

    pub fn clear_all_cache(&self) -> Result<CacheClearResult, DatabaseError> {
        self.request(|reply| ArtifactRequest::ClearCache {
            category: None,
            reply,
        })
    }

    /// Captures cache state immediately before and after a clear without allowing another actor
    /// request to interleave between either snapshot and the clear operation.
    pub fn clear_cache_with_info(
        &self,
        category: Option<&CacheCategory>,
    ) -> Result<CacheClearOutcome, DatabaseError> {
        self.request(|reply| ArtifactRequest::ClearCacheWithInfo {
            category: category.cloned(),
            reply,
        })
    }

    pub fn reconcile_artifacts(&self) -> Result<ReconciliationReport, DatabaseError> {
        self.request(|reply| ArtifactRequest::ReconcileArtifacts { reply })
    }
}
