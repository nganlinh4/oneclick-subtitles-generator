//! Media identity requests: remembering, committing, promoting, discarding, and resolving media.

use std::fs;
use std::path::Path;
use std::sync::mpsc::SyncSender;

use osg_domain::{AssetId, JobId, MediaAsset, ProjectId};
use rusqlite::Connection;
use uuid::Uuid;

use super::{Database, MAX_MEDIA_RESOLUTION_BATCHES, Request};
use crate::storage::artifacts;
use crate::storage::artifacts::ArtifactRoot;
use crate::storage::error::DatabaseError;
use crate::storage::media;
use crate::storage::media::{MediaResolutionPlan, ResolvedMedia};
use crate::storage::{
    ArtifactDraft, ArtifactId, ArtifactRegistration, ContentHash, ResolvedArtifact,
};

pub(super) enum MediaRequest {
    CommitMediaArtifact {
        asset: MediaAsset,
        artifact_id: ArtifactId,
        job_id: Option<JobId>,
        candidate: bool,
        reply: SyncSender<Result<ResolvedArtifact, DatabaseError>>,
    },
    RegisterMediaArtifact {
        draft: ArtifactDraft,
        media_id: AssetId,
        job_id: JobId,
        reply: SyncSender<Result<ArtifactRegistration, DatabaseError>>,
    },
    PromoteMediaCandidate {
        id: AssetId,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
    DiscardMediaCandidate {
        id: AssetId,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
    ResolveMedia {
        id: AssetId,
        require_project_owner: bool,
        project_revision: Option<(ProjectId, u64)>,
        reply: SyncSender<Result<Option<MediaResolutionPlan>, DatabaseError>>,
    },
    AuthorizeProjectMedia {
        project_id: ProjectId,
        expected_state_version: u64,
        id: AssetId,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
    MarkMediaLocation {
        media_id: AssetId,
        location_id: Uuid,
        available: bool,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
}

impl std::fmt::Debug for MediaRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::CommitMediaArtifact { .. } => "CommitMediaArtifact",
            Self::RegisterMediaArtifact { .. } => "RegisterMediaArtifact",
            Self::PromoteMediaCandidate { .. } => "PromoteMediaCandidate",
            Self::DiscardMediaCandidate { .. } => "DiscardMediaCandidate",
            Self::ResolveMedia { .. } => "ResolveMedia",
            Self::AuthorizeProjectMedia { .. } => "AuthorizeProjectMedia",
            Self::MarkMediaLocation { .. } => "MarkMediaLocation",
        })
    }
}

impl From<MediaRequest> for Request {
    fn from(request: MediaRequest) -> Self {
        Self::Media(request)
    }
}

impl MediaRequest {
    pub(super) fn handle(self, connection: &mut Connection, artifact_root: &ArtifactRoot) {
        match self {
            Self::CommitMediaArtifact {
                asset,
                artifact_id,
                job_id,
                candidate,
                reply,
            } => {
                let _ = reply.send(media::commit_media_artifact(
                    connection,
                    artifact_root,
                    &asset,
                    artifact_id,
                    job_id,
                    candidate,
                ));
            }
            Self::RegisterMediaArtifact {
                draft,
                media_id,
                job_id,
                reply,
            } => {
                let _ = reply.send(artifacts::register_media(
                    connection,
                    artifact_root,
                    &draft,
                    media_id,
                    job_id,
                ));
            }
            Self::PromoteMediaCandidate { id, reply } => {
                let _ = reply.send(media::promote_candidate(connection, id));
            }
            Self::DiscardMediaCandidate { id, reply } => {
                let _ = reply.send(discard_media_candidate(connection, artifact_root, id));
            }
            Self::ResolveMedia {
                id,
                require_project_owner,
                project_revision,
                reply,
            } => {
                let _ = reply.send(media::resolution_plan(
                    connection,
                    artifact_root,
                    id,
                    require_project_owner,
                    project_revision,
                ));
            }
            Self::AuthorizeProjectMedia {
                project_id,
                expected_state_version,
                id,
                reply,
            } => {
                let _ = reply.send(media::project_media_is_current(
                    connection,
                    project_id,
                    expected_state_version,
                    id,
                ));
            }
            Self::MarkMediaLocation {
                media_id,
                location_id,
                available,
                reply,
            } => {
                let _ = reply.send(media::mark_location(
                    connection,
                    media_id,
                    location_id,
                    available,
                ));
            }
        }
    }
}

impl Database {
    pub fn remember_media(
        &self,
        asset: &MediaAsset,
        path: impl AsRef<Path>,
    ) -> Result<ContentHash, DatabaseError> {
        self.remember_media_with_lifecycle(asset, path.as_ref(), false)
    }

    pub fn remember_media_candidate(
        &self,
        asset: &MediaAsset,
        path: impl AsRef<Path>,
    ) -> Result<ContentHash, DatabaseError> {
        self.remember_media_with_lifecycle(asset, path.as_ref(), true)
    }

    pub fn commit_media_artifact(
        &self,
        asset: &MediaAsset,
        artifact_id: ArtifactId,
        job_id: JobId,
        candidate: bool,
    ) -> Result<ResolvedArtifact, DatabaseError> {
        self.request(|reply| MediaRequest::CommitMediaArtifact {
            asset: asset.clone(),
            artifact_id,
            job_id: Some(job_id),
            candidate,
            reply,
        })
    }

    pub(in crate::storage) fn commit_unclaimed_media_artifact(
        &self,
        asset: &MediaAsset,
        artifact_id: ArtifactId,
        candidate: bool,
    ) -> Result<ResolvedArtifact, DatabaseError> {
        self.request(|reply| MediaRequest::CommitMediaArtifact {
            asset: asset.clone(),
            artifact_id,
            job_id: None,
            candidate,
            reply,
        })
    }

    pub(in crate::storage) fn register_media_artifact(
        &self,
        draft: &ArtifactDraft,
        media_id: AssetId,
        job_id: JobId,
    ) -> Result<ArtifactRegistration, DatabaseError> {
        self.request(|reply| MediaRequest::RegisterMediaArtifact {
            draft: draft.clone(),
            media_id,
            job_id,
            reply,
        })
    }

    fn remember_media_with_lifecycle(
        &self,
        asset: &MediaAsset,
        path: &Path,
        candidate: bool,
    ) -> Result<ContentHash, DatabaseError> {
        let canonical_path =
            fs::canonicalize(path).map_err(|_| DatabaseError::InvalidMediaLocation)?;
        let published =
            media::publish_native_media_snapshot(self, asset.clone(), &canonical_path, candidate)?;
        Ok(published.content_hash())
    }

    pub fn promote_media_candidate(&self, id: AssetId) -> Result<bool, DatabaseError> {
        self.request(|reply| MediaRequest::PromoteMediaCandidate { id, reply })
    }

    pub fn discard_media_candidate(&self, id: AssetId) -> Result<bool, DatabaseError> {
        self.request(|reply| MediaRequest::DiscardMediaCandidate { id, reply })
    }

    pub fn resolve_media(&self, id: AssetId) -> Result<Option<ResolvedMedia>, DatabaseError> {
        self.resolve_media_with_policy(id, false, None)
    }

    pub fn resolve_project_media(
        &self,
        id: AssetId,
    ) -> Result<Option<ResolvedMedia>, DatabaseError> {
        self.resolve_media_with_policy(id, true, None)
    }

    pub fn resolve_project_media_revision(
        &self,
        project_id: ProjectId,
        expected_state_version: u64,
        id: AssetId,
    ) -> Result<Option<ResolvedMedia>, DatabaseError> {
        self.resolve_media_with_policy(id, true, Some((project_id, expected_state_version)))
    }

    pub fn project_media_is_current(
        &self,
        project_id: ProjectId,
        expected_state_version: u64,
        id: AssetId,
    ) -> Result<bool, DatabaseError> {
        self.request(|reply| MediaRequest::AuthorizeProjectMedia {
            project_id,
            expected_state_version,
            id,
            reply,
        })
    }

    fn resolve_media_with_policy(
        &self,
        id: AssetId,
        require_project_owner: bool,
        project_revision: Option<(ProjectId, u64)>,
    ) -> Result<Option<ResolvedMedia>, DatabaseError> {
        for _ in 0..MAX_MEDIA_RESOLUTION_BATCHES {
            let Some(plan) = self.request(|reply| MediaRequest::ResolveMedia {
                id,
                require_project_owner,
                project_revision,
                reply,
            })?
            else {
                return Ok(None);
            };
            let Some(expected_hash) = plan.content_hash else {
                return Ok(None);
            };
            for candidate in plan.candidates {
                let resolved = if candidate.managed_snapshot {
                    candidate.path.as_ref().and_then(|path| {
                        media::digest_media_file(path, plan.asset.size_bytes())
                            .ok()
                            .filter(|verified| verified.content_hash == expected_hash)
                            .map(|verified| (path.to_owned(), verified.file))
                    })
                } else if let Some(path) = candidate.path.as_ref() {
                    match media::publish_native_media_snapshot(
                        self,
                        plan.asset.clone(),
                        path,
                        plan.candidate_lifecycle,
                    ) {
                        Ok(published) if published.content_hash() == expected_hash => {
                            media::digest_media_file(published.path(), plan.asset.size_bytes())
                                .ok()
                                .filter(|verified| verified.content_hash == expected_hash)
                                .map(|verified| (published.path().to_owned(), verified.file))
                        }
                        Ok(_) | Err(DatabaseError::InvalidArtifactFile) => None,
                        Err(error) => return Err(error),
                    }
                } else {
                    None
                };
                if let Some(location_id) = candidate.id {
                    self.request(|reply| MediaRequest::MarkMediaLocation {
                        media_id: id,
                        location_id,
                        available: resolved.is_some(),
                        reply,
                    })?;
                }
                if let Some((path, file)) = resolved {
                    return Ok(Some(ResolvedMedia::new(
                        plan.asset.clone(),
                        path,
                        file,
                        expected_hash,
                    )));
                }
            }
            if !plan.has_more_candidates {
                return Ok(None);
            }
        }
        Err(DatabaseError::InvalidMediaLocation)
    }
}

fn discard_media_candidate(
    connection: &mut Connection,
    artifact_root: &artifacts::ArtifactRoot,
    media_id: AssetId,
) -> Result<bool, DatabaseError> {
    let transaction = connection.transaction()?;
    let Some(artifact_ids) = media::discard_candidate_in_transaction(&transaction, media_id)?
    else {
        transaction.commit()?;
        return Ok(false);
    };
    let mut removals = Vec::new();
    for artifact_id in artifact_ids {
        if !media::artifact_has_persistent_owner(&transaction, artifact_id)?
            && let Some(removal) =
                artifacts::remove_transactional(&transaction, artifact_root, artifact_id)?
        {
            removals.push(removal);
        }
    }
    transaction.commit()?;
    for removal in removals {
        removal.finalize();
    }
    Ok(true)
}
