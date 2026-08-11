use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::config::DbConfig;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use osg_application::{
    JobStore, JobWrite, ProjectHistoryStatus, ProjectRepository, ProjectSnapshot,
    ProjectTrackHistoryMutation, ProjectTrackHistoryStatus, ProjectTrackSelector, RevisionCommit,
};
use osg_domain::{
    AssetId, JobId, JobSnapshot, MediaAsset, ProjectId, ProjectMetadata, RevisionReason,
    SubtitleTrack,
};

use super::error::DatabaseError;
use super::media::ResolvedMedia;
use super::migrations::migrations;
use super::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactRecord, ArtifactRegistration,
    CacheCategory, CacheClearOutcome, CacheClearResult, CacheInfo, CacheKey, CacheLeaseId,
    CacheWrite, ContentHash, LeasedArtifact, LegacyImportCandidate, LegacyImportId,
    LegacyImportItemOutcome, LegacyImportItemState, LegacyImportSourceKind, LegacyImportSummary,
    ReconciliationReport, ResolvedArtifact,
};
use crate::secrets::{CredentialId, CredentialPurpose, CredentialState, CredentialStatus};

const ACTOR_CAPACITY: usize = 64;
const MAX_SETTING_BYTES: usize = 1024 * 1024;
const MAX_SETTINGS_BATCH_BYTES: usize = 8 * 1024 * 1024;
const MAX_SETTINGS_BATCH_ENTRIES: usize = 4_096;
const MAX_SETTING_DELETE_KEYS: usize = 256;
const APPLICATION_ID: i64 = 0x4f53_4732;
const SCHEMA_VERSION: u32 = 5;
const MINIMUM_SQLITE_VERSION: &str = "3.51.3";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseHealth {
    pub schema_version: u32,
    pub sqlite_version: String,
    pub application_id: i64,
    pub journal_mode: String,
    pub integrity: String,
    pub previous_shutdown_clean: bool,
}

#[derive(Debug, Clone)]
pub struct Database {
    inner: Arc<ActorInner>,
}

#[derive(Debug)]
struct ActorInner {
    sender: SyncSender<Request>,
    thread: std::sync::Mutex<Option<JoinHandle<()>>>,
}

enum Request {
    Health {
        reply: SyncSender<Result<DatabaseHealth, DatabaseError>>,
    },
    GetSetting {
        scope: String,
        key: String,
        reply: SyncSender<Result<Option<Value>, DatabaseError>>,
    },
    ListSettings {
        scope: String,
        reply: SyncSender<Result<BTreeMap<String, Value>, DatabaseError>>,
    },
    PutSetting {
        scope: String,
        key: String,
        value_json: String,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    PutSettings {
        scope: String,
        entries: Vec<(String, String)>,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    DeleteSetting {
        scope: String,
        key: String,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
    DeleteSettings {
        scope: String,
        keys: Vec<String>,
        reply: SyncSender<Result<u64, DatabaseError>>,
    },
    ClearSettings {
        scope: String,
        reply: SyncSender<Result<u64, DatabaseError>>,
    },
    CredentialInsertPending {
        id: CredentialId,
        purpose: CredentialPurpose,
        reply: SyncSender<Result<CredentialStatus, DatabaseError>>,
    },
    CredentialMarkReady {
        id: CredentialId,
        last4: String,
        reply: SyncSender<Result<CredentialStatus, DatabaseError>>,
    },
    CredentialMarkUnavailable {
        id: CredentialId,
        reply: SyncSender<Result<CredentialStatus, DatabaseError>>,
    },
    CredentialList {
        purpose: Option<CredentialPurpose>,
        reply: SyncSender<Result<Vec<CredentialStatus>, DatabaseError>>,
    },
    CredentialGet {
        id: CredentialId,
        reply: SyncSender<Result<CredentialStatus, DatabaseError>>,
    },
    CredentialDelete {
        id: CredentialId,
        reply: SyncSender<Result<bool, DatabaseError>>,
    },
    RememberMedia {
        asset: MediaAsset,
        canonical_path: PathBuf,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    ResolveMedia {
        id: AssetId,
        reply: SyncSender<Result<Option<ResolvedMedia>, DatabaseError>>,
    },
    RegisterArtifact {
        draft: ArtifactDraft,
        reply: SyncSender<Result<ArtifactRegistration, DatabaseError>>,
    },
    GetArtifact {
        id: ArtifactId,
        reply: SyncSender<Result<Option<ArtifactRecord>, DatabaseError>>,
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
    LookupCache {
        key: CacheKey,
        reply: SyncSender<Result<Option<ResolvedArtifact>, DatabaseError>>,
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
    CreateJob {
        snapshot: JobSnapshot,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    GetJob {
        id: JobId,
        reply: SyncSender<Result<Option<JobSnapshot>, DatabaseError>>,
    },
    ListJobs {
        reply: SyncSender<Result<Vec<JobSnapshot>, DatabaseError>>,
    },
    CompareAndSwapJob {
        expected_sequence: u64,
        snapshot: JobSnapshot,
        reply: SyncSender<Result<JobWrite, DatabaseError>>,
    },
    CreateProject {
        metadata: ProjectMetadata,
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
    PrepareLegacyImport {
        source_kind: LegacyImportSourceKind,
        fingerprint: ContentHash,
        candidates: Vec<LegacyImportCandidate>,
        reply: SyncSender<Result<LegacyImportSummary, DatabaseError>>,
    },
    LegacyImportItemState {
        source_id: LegacyImportId,
        candidate: LegacyImportCandidate,
        reply: SyncSender<Result<Option<LegacyImportItemState>, DatabaseError>>,
    },
    RecordLegacyImportItem {
        source_id: LegacyImportId,
        candidate: LegacyImportCandidate,
        outcome: LegacyImportItemOutcome,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    FinishLegacyImport {
        source_id: LegacyImportId,
        reply: SyncSender<Result<LegacyImportSummary, DatabaseError>>,
    },
    ListLegacyImports {
        reply: SyncSender<Result<Vec<LegacyImportSummary>, DatabaseError>>,
    },
    Backup {
        destination: PathBuf,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    Shutdown,
}

impl std::fmt::Debug for Request {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Health { .. } => "Health",
            Self::GetSetting { .. } => "GetSetting",
            Self::ListSettings { .. } => "ListSettings",
            Self::PutSetting { .. } => "PutSetting",
            Self::PutSettings { .. } => "PutSettings",
            Self::DeleteSetting { .. } => "DeleteSetting",
            Self::DeleteSettings { .. } => "DeleteSettings",
            Self::ClearSettings { .. } => "ClearSettings",
            Self::CredentialInsertPending { .. } => "CredentialInsertPending",
            Self::CredentialMarkReady { .. } => "CredentialMarkReady",
            Self::CredentialMarkUnavailable { .. } => "CredentialMarkUnavailable",
            Self::CredentialList { .. } => "CredentialList",
            Self::CredentialGet { .. } => "CredentialGet",
            Self::CredentialDelete { .. } => "CredentialDelete",
            Self::RememberMedia { .. } => "RememberMedia",
            Self::ResolveMedia { .. } => "ResolveMedia",
            Self::RegisterArtifact { .. } => "RegisterArtifact",
            Self::GetArtifact { .. } => "GetArtifact",
            Self::MarkArtifactReady { .. } => "MarkArtifactReady",
            Self::MarkArtifactFailed { .. } => "MarkArtifactFailed",
            Self::ResolveArtifact { .. } => "ResolveArtifact",
            Self::RemoveArtifact { .. } => "RemoveArtifact",
            Self::PutCache { .. } => "PutCache",
            Self::LookupCache { .. } => "LookupCache",
            Self::LeaseCache { .. } => "LeaseCache",
            Self::ReleaseCacheLease { .. } => "ReleaseCacheLease",
            Self::CacheInfo { .. } => "CacheInfo",
            Self::ClearCache { .. } => "ClearCache",
            Self::ClearCacheWithInfo { .. } => "ClearCacheWithInfo",
            Self::ReconcileArtifacts { .. } => "ReconcileArtifacts",
            Self::CreateJob { .. } => "CreateJob",
            Self::GetJob { .. } => "GetJob",
            Self::ListJobs { .. } => "ListJobs",
            Self::CompareAndSwapJob { .. } => "CompareAndSwapJob",
            Self::CreateProject { .. } => "CreateProject",
            Self::LoadProject { .. } => "LoadProject",
            Self::ProjectHistoryStatus { .. } => "ProjectHistoryStatus",
            Self::ProjectTrackHistoryStatus { .. } => "ProjectTrackHistoryStatus",
            Self::CommitProjectTrack { .. } => "CommitProjectTrack",
            Self::UndoProjectTrack { .. } => "UndoProjectTrack",
            Self::RedoProjectTrack { .. } => "RedoProjectTrack",
            Self::CommitProject { .. } => "CommitProject",
            Self::UndoProject { .. } => "UndoProject",
            Self::RedoProject { .. } => "RedoProject",
            Self::PrepareLegacyImport { .. } => "PrepareLegacyImport",
            Self::LegacyImportItemState { .. } => "LegacyImportItemState",
            Self::RecordLegacyImportItem { .. } => "RecordLegacyImportItem",
            Self::FinishLegacyImport { .. } => "FinishLegacyImport",
            Self::ListLegacyImports { .. } => "ListLegacyImports",
            Self::Backup { .. } => "Backup",
            Self::Shutdown => "Shutdown",
        })
    }
}

impl Database {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, DatabaseError> {
        let path = path.into();
        let database_directory = path.parent().unwrap_or_else(|| Path::new("."));
        let storage_directory = if database_directory
            .file_name()
            .is_some_and(|name| name == "db")
        {
            database_directory.parent().unwrap_or(database_directory)
        } else {
            database_directory
        };
        let artifact_root = storage_directory.join("artifacts");
        Self::open_with_artifact_root(path, artifact_root)
    }

    pub fn open_with_artifact_root(
        path: impl Into<PathBuf>,
        artifact_root: impl Into<PathBuf>,
    ) -> Result<Self, DatabaseError> {
        let path = path.into();
        let artifact_root = artifact_root.into();
        let (sender, receiver) = sync_channel(ACTOR_CAPACITY);
        let (startup_sender, startup_receiver) = sync_channel(1);
        let thread = thread::Builder::new()
            .name("osg-database".to_owned())
            .spawn(move || run_actor(&path, &artifact_root, &receiver, &startup_sender))
            .map_err(|_| DatabaseError::ActorStart)?;

        startup_receiver
            .recv()
            .map_err(|_| DatabaseError::ActorResponseDropped)??;

        Ok(Self {
            inner: Arc::new(ActorInner {
                sender,
                thread: std::sync::Mutex::new(Some(thread)),
            }),
        })
    }

    pub fn health(&self) -> Result<DatabaseHealth, DatabaseError> {
        self.request(|reply| Request::Health { reply })
    }

    pub fn get_setting(&self, scope: &str, key: &str) -> Result<Option<Value>, DatabaseError> {
        validate_setting_key(scope, key)?;
        self.request(|reply| Request::GetSetting {
            scope: scope.to_owned(),
            key: key.to_owned(),
            reply,
        })
    }

    pub fn list_settings(&self, scope: &str) -> Result<BTreeMap<String, Value>, DatabaseError> {
        validate_setting_part(scope)?;
        self.request(|reply| Request::ListSettings {
            scope: scope.to_owned(),
            reply,
        })
    }

    pub fn put_setting(&self, scope: &str, key: &str, value: &Value) -> Result<(), DatabaseError> {
        validate_setting_key(scope, key)?;
        let value_json = serde_json::to_string(value)?;
        if value_json.len() > MAX_SETTING_BYTES {
            return Err(DatabaseError::SettingTooLarge);
        }
        self.request(|reply| Request::PutSetting {
            scope: scope.to_owned(),
            key: key.to_owned(),
            value_json,
            reply,
        })
    }

    pub fn put_settings(
        &self,
        scope: &str,
        values: &BTreeMap<String, Value>,
    ) -> Result<(), DatabaseError> {
        validate_setting_part(scope)?;
        if values.len() > MAX_SETTINGS_BATCH_ENTRIES {
            return Err(DatabaseError::SettingTooLarge);
        }
        let mut entries = Vec::with_capacity(values.len());
        let mut total_bytes = 0_usize;
        for (key, value) in values {
            validate_setting_key(scope, key)?;
            let value_json = serde_json::to_string(value)?;
            if value_json.len() > MAX_SETTING_BYTES {
                return Err(DatabaseError::SettingTooLarge);
            }
            total_bytes = total_bytes
                .checked_add(key.len())
                .and_then(|size| size.checked_add(value_json.len()))
                .ok_or(DatabaseError::SettingTooLarge)?;
            if total_bytes > MAX_SETTINGS_BATCH_BYTES {
                return Err(DatabaseError::SettingTooLarge);
            }
            entries.push((key.clone(), value_json));
        }
        self.request(|reply| Request::PutSettings {
            scope: scope.to_owned(),
            entries,
            reply,
        })
    }

    pub fn delete_setting(&self, scope: &str, key: &str) -> Result<bool, DatabaseError> {
        validate_setting_part(scope)?;
        validate_setting_part(key)?;
        self.request(|reply| Request::DeleteSetting {
            scope: scope.to_owned(),
            key: key.to_owned(),
            reply,
        })
    }

    pub fn delete_settings(&self, scope: &str, keys: &[String]) -> Result<u64, DatabaseError> {
        validate_setting_part(scope)?;
        if keys.len() > MAX_SETTING_DELETE_KEYS {
            return Err(DatabaseError::InvalidSettingKey);
        }
        for key in keys {
            validate_setting_part(key)?;
        }
        self.request(|reply| Request::DeleteSettings {
            scope: scope.to_owned(),
            keys: keys.to_vec(),
            reply,
        })
    }

    pub fn clear_settings(&self, scope: &str) -> Result<u64, DatabaseError> {
        validate_setting_part(scope)?;
        self.request(|reply| Request::ClearSettings {
            scope: scope.to_owned(),
            reply,
        })
    }

    pub fn credential_insert_pending(
        &self,
        id: CredentialId,
        purpose: CredentialPurpose,
    ) -> Result<CredentialStatus, DatabaseError> {
        self.request(|reply| Request::CredentialInsertPending { id, purpose, reply })
    }

    pub fn credential_mark_ready(
        &self,
        id: CredentialId,
        last4: &str,
    ) -> Result<CredentialStatus, DatabaseError> {
        validate_last4(last4)?;
        self.request(|reply| Request::CredentialMarkReady {
            id,
            last4: last4.to_owned(),
            reply,
        })
    }

    pub fn credential_mark_unavailable(
        &self,
        id: CredentialId,
    ) -> Result<CredentialStatus, DatabaseError> {
        self.request(|reply| Request::CredentialMarkUnavailable { id, reply })
    }

    pub fn credential_list(
        &self,
        purpose: Option<CredentialPurpose>,
    ) -> Result<Vec<CredentialStatus>, DatabaseError> {
        self.request(|reply| Request::CredentialList { purpose, reply })
    }

    pub fn credential_get(&self, id: CredentialId) -> Result<CredentialStatus, DatabaseError> {
        self.request(|reply| Request::CredentialGet { id, reply })
    }

    pub fn credential_delete(&self, id: CredentialId) -> Result<bool, DatabaseError> {
        self.request(|reply| Request::CredentialDelete { id, reply })
    }

    pub fn remember_media(
        &self,
        asset: &MediaAsset,
        path: impl AsRef<Path>,
    ) -> Result<(), DatabaseError> {
        let canonical_path =
            fs::canonicalize(path).map_err(|_| DatabaseError::InvalidMediaLocation)?;
        self.request(|reply| Request::RememberMedia {
            asset: asset.clone(),
            canonical_path,
            reply,
        })
    }

    pub fn resolve_media(&self, id: AssetId) -> Result<Option<ResolvedMedia>, DatabaseError> {
        self.request(|reply| Request::ResolveMedia { id, reply })
    }

    pub fn register_artifact(
        &self,
        draft: &ArtifactDraft,
    ) -> Result<ArtifactRegistration, DatabaseError> {
        self.request(|reply| Request::RegisterArtifact {
            draft: draft.clone(),
            reply,
        })
    }

    pub fn get_artifact(&self, id: ArtifactId) -> Result<Option<ArtifactRecord>, DatabaseError> {
        self.request(|reply| Request::GetArtifact { id, reply })
    }

    pub fn mark_artifact_ready(&self, id: ArtifactId) -> Result<ArtifactRecord, DatabaseError> {
        self.request(|reply| Request::MarkArtifactReady { id, reply })
    }

    pub fn mark_artifact_failed(
        &self,
        id: ArtifactId,
        failure_code: &ArtifactFailureCode,
    ) -> Result<ArtifactRecord, DatabaseError> {
        self.request(|reply| Request::MarkArtifactFailed {
            id,
            failure_code: failure_code.clone(),
            reply,
        })
    }

    pub fn resolve_artifact(
        &self,
        id: ArtifactId,
    ) -> Result<Option<ResolvedArtifact>, DatabaseError> {
        self.request(|reply| Request::ResolveArtifact { id, reply })
    }

    pub fn remove_artifact(&self, id: ArtifactId) -> Result<Option<ArtifactRecord>, DatabaseError> {
        self.request(|reply| Request::RemoveArtifact { id, reply })
    }

    pub fn put_cache_entry(&self, write: &CacheWrite) -> Result<(), DatabaseError> {
        self.request(|reply| Request::PutCache {
            write: write.clone(),
            reply,
        })
    }

    pub fn lookup_cache(&self, key: CacheKey) -> Result<Option<ResolvedArtifact>, DatabaseError> {
        self.request(|reply| Request::LookupCache { key, reply })
    }

    pub fn lease_cache(
        &self,
        key: CacheKey,
        owner: &str,
        ttl_ms: u64,
    ) -> Result<Option<LeasedArtifact>, DatabaseError> {
        self.request(|reply| Request::LeaseCache {
            key,
            owner: owner.to_owned(),
            ttl_ms,
            reply,
        })
    }

    pub fn release_cache_lease(&self, id: CacheLeaseId) -> Result<bool, DatabaseError> {
        self.request(|reply| Request::ReleaseCacheLease { id, reply })
    }

    pub fn cache_info(&self) -> Result<CacheInfo, DatabaseError> {
        self.request(|reply| Request::CacheInfo { reply })
    }

    pub fn clear_cache_category(
        &self,
        category: &CacheCategory,
    ) -> Result<CacheClearResult, DatabaseError> {
        self.request(|reply| Request::ClearCache {
            category: Some(category.clone()),
            reply,
        })
    }

    pub fn clear_all_cache(&self) -> Result<CacheClearResult, DatabaseError> {
        self.request(|reply| Request::ClearCache {
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
        self.request(|reply| Request::ClearCacheWithInfo {
            category: category.cloned(),
            reply,
        })
    }

    pub fn reconcile_artifacts(&self) -> Result<ReconciliationReport, DatabaseError> {
        self.request(|reply| Request::ReconcileArtifacts { reply })
    }

    pub fn create_job(&self, snapshot: &JobSnapshot) -> Result<(), DatabaseError> {
        self.request(|reply| Request::CreateJob {
            snapshot: snapshot.clone(),
            reply,
        })
    }

    pub fn get_job(&self, id: JobId) -> Result<Option<JobSnapshot>, DatabaseError> {
        self.request(|reply| Request::GetJob { id, reply })
    }

    pub fn list_jobs(&self) -> Result<Vec<JobSnapshot>, DatabaseError> {
        self.request(|reply| Request::ListJobs { reply })
    }

    pub fn compare_and_swap_job(
        &self,
        expected_sequence: u64,
        snapshot: &JobSnapshot,
    ) -> Result<JobWrite, DatabaseError> {
        self.request(|reply| Request::CompareAndSwapJob {
            expected_sequence,
            snapshot: snapshot.clone(),
            reply,
        })
    }

    pub fn create_project(
        &self,
        metadata: &ProjectMetadata,
    ) -> Result<ProjectSnapshot, DatabaseError> {
        self.request(|reply| Request::CreateProject {
            metadata: metadata.clone(),
            reply,
        })
    }

    pub fn load_project(&self, id: ProjectId) -> Result<Option<ProjectSnapshot>, DatabaseError> {
        self.request(|reply| Request::LoadProject { id, reply })
    }

    pub fn project_history_status(
        &self,
        id: ProjectId,
    ) -> Result<ProjectHistoryStatus, DatabaseError> {
        self.request(|reply| Request::ProjectHistoryStatus { id, reply })
    }

    pub fn project_track_history_status(
        &self,
        id: ProjectId,
        selector: &ProjectTrackSelector,
    ) -> Result<ProjectTrackHistoryStatus, DatabaseError> {
        self.request(|reply| Request::ProjectTrackHistoryStatus {
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
        self.request(|reply| Request::CommitProjectTrack {
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
        self.request(|reply| Request::UndoProjectTrack {
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
        self.request(|reply| Request::RedoProjectTrack {
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
        self.request(|reply| Request::CommitProject {
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
        self.request(|reply| Request::UndoProject {
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
        self.request(|reply| Request::UndoProject {
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
        self.request(|reply| Request::RedoProject {
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
        self.request(|reply| Request::RedoProject {
            id,
            expected_version,
            expected_reason: Some(expected_reason.clone()),
            reply,
        })
    }

    pub fn prepare_legacy_import(
        &self,
        source_kind: LegacyImportSourceKind,
        fingerprint: ContentHash,
        candidates: &[LegacyImportCandidate],
    ) -> Result<LegacyImportSummary, DatabaseError> {
        self.request(|reply| Request::PrepareLegacyImport {
            source_kind,
            fingerprint,
            candidates: candidates.to_vec(),
            reply,
        })
    }

    pub fn legacy_import_item_state(
        &self,
        source_id: LegacyImportId,
        candidate: &LegacyImportCandidate,
    ) -> Result<Option<LegacyImportItemState>, DatabaseError> {
        self.request(|reply| Request::LegacyImportItemState {
            source_id,
            candidate: candidate.clone(),
            reply,
        })
    }

    pub fn record_legacy_import_item(
        &self,
        source_id: LegacyImportId,
        candidate: &LegacyImportCandidate,
        outcome: &LegacyImportItemOutcome,
    ) -> Result<(), DatabaseError> {
        self.request(|reply| Request::RecordLegacyImportItem {
            source_id,
            candidate: candidate.clone(),
            outcome: outcome.clone(),
            reply,
        })
    }

    pub fn finish_legacy_import(
        &self,
        source_id: LegacyImportId,
    ) -> Result<LegacyImportSummary, DatabaseError> {
        self.request(|reply| Request::FinishLegacyImport { source_id, reply })
    }

    pub fn list_legacy_imports(&self) -> Result<Vec<LegacyImportSummary>, DatabaseError> {
        self.request(|reply| Request::ListLegacyImports { reply })
    }

    pub fn backup_to(&self, destination: impl Into<PathBuf>) -> Result<(), DatabaseError> {
        self.request(|reply| Request::Backup {
            destination: destination.into(),
            reply,
        })
    }

    fn request<T>(
        &self,
        make_request: impl FnOnce(SyncSender<Result<T, DatabaseError>>) -> Request,
    ) -> Result<T, DatabaseError> {
        let (reply, response) = sync_channel(1);
        self.inner
            .sender
            .send(make_request(reply))
            .map_err(|_| DatabaseError::ActorUnavailable)?;
        response
            .recv()
            .map_err(|_| DatabaseError::ActorResponseDropped)?
    }
}

impl ProjectRepository for Database {
    type Error = DatabaseError;

    fn create(&self, metadata: &ProjectMetadata) -> Result<ProjectSnapshot, Self::Error> {
        self.create_project(metadata)
    }

    fn load(&self, id: ProjectId) -> Result<Option<ProjectSnapshot>, Self::Error> {
        self.load_project(id)
    }

    fn commit(
        &self,
        snapshot: &ProjectSnapshot,
        reason: &RevisionReason,
    ) -> Result<RevisionCommit, Self::Error> {
        self.commit_project(snapshot, reason)
    }
}

impl JobStore for Database {
    type Error = DatabaseError;

    fn create(&self, snapshot: &JobSnapshot) -> Result<(), Self::Error> {
        self.create_job(snapshot)
    }

    fn get(&self, id: JobId) -> Result<Option<JobSnapshot>, Self::Error> {
        self.get_job(id)
    }

    fn list(&self) -> Result<Vec<JobSnapshot>, Self::Error> {
        self.list_jobs()
    }

    fn compare_and_swap(
        &self,
        expected_sequence: u64,
        snapshot: &JobSnapshot,
    ) -> Result<JobWrite, Self::Error> {
        self.compare_and_swap_job(expected_sequence, snapshot)
    }
}

impl Drop for ActorInner {
    fn drop(&mut self) {
        let _ = self.sender.send(Request::Shutdown);
        if let Ok(mut guard) = self.thread.lock()
            && let Some(thread) = guard.take()
        {
            let _ = thread.join();
        }
    }
}

#[allow(clippy::too_many_lines)]
fn run_actor(
    path: &Path,
    artifact_root: &Path,
    receiver: &Receiver<Request>,
    startup: &SyncSender<Result<(), DatabaseError>>,
) {
    let (mut connection, artifact_root) = match open_connection(path, artifact_root) {
        Ok(result) => result,
        Err(error) => {
            let _ = startup.send(Err(error));
            return;
        }
    };
    if startup.send(Ok(())).is_err() {
        return;
    }

    while let Ok(request) = receiver.recv() {
        match request {
            Request::Health { reply } => {
                let _ = reply.send(database_health(&connection));
            }
            Request::GetSetting { scope, key, reply } => {
                let _ = reply.send(get_setting(&connection, &scope, &key));
            }
            Request::ListSettings { scope, reply } => {
                let _ = reply.send(list_settings(&connection, &scope));
            }
            Request::PutSetting {
                scope,
                key,
                value_json,
                reply,
            } => {
                let _ = reply.send(put_setting(&mut connection, &scope, &key, &value_json));
            }
            Request::PutSettings {
                scope,
                entries,
                reply,
            } => {
                let _ = reply.send(put_settings(&mut connection, &scope, &entries));
            }
            Request::DeleteSetting { scope, key, reply } => {
                let _ = reply.send(delete_setting(&connection, &scope, &key));
            }
            Request::DeleteSettings { scope, keys, reply } => {
                let _ = reply.send(delete_settings(&mut connection, &scope, &keys));
            }
            Request::ClearSettings { scope, reply } => {
                let _ = reply.send(clear_settings(&connection, &scope));
            }
            Request::CredentialInsertPending { id, purpose, reply } => {
                let _ = reply.send(credential_insert_pending(&connection, id, purpose));
            }
            Request::CredentialMarkReady { id, last4, reply } => {
                let _ = reply.send(credential_mark_ready(&connection, id, &last4));
            }
            Request::CredentialMarkUnavailable { id, reply } => {
                let _ = reply.send(credential_mark_unavailable(&connection, id));
            }
            Request::CredentialList { purpose, reply } => {
                let _ = reply.send(credential_list(&connection, purpose));
            }
            Request::CredentialGet { id, reply } => {
                let _ = reply.send(credential_get(&connection, id));
            }
            Request::CredentialDelete { id, reply } => {
                let _ = reply.send(credential_delete(&connection, id));
            }
            Request::RememberMedia {
                asset,
                canonical_path,
                reply,
            } => {
                let _ = reply.send(super::media::remember(
                    &mut connection,
                    &asset,
                    &canonical_path,
                ));
            }
            Request::ResolveMedia { id, reply } => {
                let _ = reply.send(super::media::resolve(&mut connection, id));
            }
            Request::RegisterArtifact { draft, reply } => {
                let _ = reply.send(super::artifacts::register(
                    &connection,
                    &artifact_root,
                    &draft,
                ));
            }
            Request::GetArtifact { id, reply } => {
                let _ = reply.send(super::artifacts::get(&connection, id));
            }
            Request::MarkArtifactReady { id, reply } => {
                let _ = reply.send(super::artifacts::ready(&connection, &artifact_root, id));
            }
            Request::MarkArtifactFailed {
                id,
                failure_code,
                reply,
            } => {
                let _ = reply.send(super::artifacts::fail(
                    &connection,
                    &artifact_root,
                    id,
                    &failure_code,
                ));
            }
            Request::ResolveArtifact { id, reply } => {
                let _ = reply.send(super::artifacts::resolve(&connection, &artifact_root, id));
            }
            Request::RemoveArtifact { id, reply } => {
                let _ = reply.send(super::artifacts::remove(&connection, &artifact_root, id));
            }
            Request::PutCache { write, reply } => {
                let _ = reply.send(super::artifacts::put_cache(&connection, &write));
            }
            Request::LookupCache { key, reply } => {
                let _ = reply.send(super::artifacts::lookup_cache(
                    &connection,
                    &artifact_root,
                    key,
                ));
            }
            Request::LeaseCache {
                key,
                owner,
                ttl_ms,
                reply,
            } => {
                let _ = reply.send(super::artifacts::lease_cache(
                    &connection,
                    &artifact_root,
                    key,
                    &owner,
                    ttl_ms,
                ));
            }
            Request::ReleaseCacheLease { id, reply } => {
                let _ = reply.send(super::artifacts::release_cache_lease(&connection, id));
            }
            Request::CacheInfo { reply } => {
                let _ = reply.send(super::artifacts::cache_info(&connection, &artifact_root));
            }
            Request::ClearCache { category, reply } => {
                let _ = reply.send(super::artifacts::clear_cache(
                    &mut connection,
                    &artifact_root,
                    category.as_ref(),
                ));
            }
            Request::ClearCacheWithInfo { category, reply } => {
                let _ = reply.send(super::artifacts::clear_cache_with_info(
                    &mut connection,
                    &artifact_root,
                    category.as_ref(),
                ));
            }
            Request::ReconcileArtifacts { reply } => {
                let _ = reply.send(super::artifacts::reconcile(&connection, &artifact_root));
            }
            Request::CreateJob { snapshot, reply } => {
                let _ = reply.send(super::jobs::create(&connection, &snapshot));
            }
            Request::GetJob { id, reply } => {
                let _ = reply.send(super::jobs::get(&connection, id));
            }
            Request::ListJobs { reply } => {
                let _ = reply.send(super::jobs::list(&connection));
            }
            Request::CompareAndSwapJob {
                expected_sequence,
                snapshot,
                reply,
            } => {
                let _ = reply.send(super::jobs::compare_and_swap(
                    &mut connection,
                    expected_sequence,
                    &snapshot,
                ));
            }
            Request::CreateProject { metadata, reply } => {
                let _ = reply.send(super::projects::create_project(&mut connection, &metadata));
            }
            Request::LoadProject { id, reply } => {
                let _ = reply.send(super::projects::load_project(&connection, id));
            }
            Request::ProjectHistoryStatus { id, reply } => {
                let _ = reply.send(super::projects::project_history_status(&connection, id));
            }
            Request::ProjectTrackHistoryStatus {
                id,
                selector,
                reply,
            } => {
                let _ = reply.send(super::track_history::status(&connection, id, &selector));
            }
            Request::CommitProjectTrack {
                id,
                selector,
                expected_history_version,
                before,
                after,
                reason,
                reply,
            } => {
                let _ = reply.send(super::track_history::commit(
                    &mut connection,
                    id,
                    &selector,
                    expected_history_version,
                    before.as_ref(),
                    after.as_ref(),
                    &reason,
                ));
            }
            Request::UndoProjectTrack {
                id,
                selector,
                expected_history_version,
                expected_reason,
                reply,
            } => {
                let _ = reply.send(super::track_history::undo(
                    &mut connection,
                    id,
                    &selector,
                    expected_history_version,
                    &expected_reason,
                ));
            }
            Request::RedoProjectTrack {
                id,
                selector,
                expected_history_version,
                expected_reason,
                reply,
            } => {
                let _ = reply.send(super::track_history::redo(
                    &mut connection,
                    id,
                    &selector,
                    expected_history_version,
                    &expected_reason,
                ));
            }
            Request::CommitProject {
                snapshot,
                reason,
                reply,
            } => {
                let _ = reply.send(super::projects::commit_project(
                    &mut connection,
                    &snapshot,
                    &reason,
                ));
            }
            Request::UndoProject {
                id,
                expected_version,
                expected_reason,
                reply,
            } => {
                let _ = reply.send(super::projects::undo_project(
                    &mut connection,
                    id,
                    expected_version,
                    expected_reason.as_ref(),
                ));
            }
            Request::RedoProject {
                id,
                expected_version,
                expected_reason,
                reply,
            } => {
                let _ = reply.send(super::projects::redo_project(
                    &mut connection,
                    id,
                    expected_version,
                    expected_reason.as_ref(),
                ));
            }
            Request::PrepareLegacyImport {
                source_kind,
                fingerprint,
                candidates,
                reply,
            } => {
                let _ = reply.send(super::legacy::prepare(
                    &mut connection,
                    source_kind,
                    fingerprint,
                    &candidates,
                ));
            }
            Request::LegacyImportItemState {
                source_id,
                candidate,
                reply,
            } => {
                let _ = reply.send(super::legacy::item_state(
                    &connection,
                    source_id,
                    &candidate,
                ));
            }
            Request::RecordLegacyImportItem {
                source_id,
                candidate,
                outcome,
                reply,
            } => {
                let _ = reply.send(super::legacy::record_item(
                    &connection,
                    source_id,
                    &candidate,
                    &outcome,
                ));
            }
            Request::FinishLegacyImport { source_id, reply } => {
                let _ = reply.send(super::legacy::finish(&connection, source_id));
            }
            Request::ListLegacyImports { reply } => {
                let _ = reply.send(super::legacy::list(&connection));
            }
            Request::Backup { destination, reply } => {
                let _ = reply.send(backup_database(&connection, &destination));
            }
            Request::Shutdown => break,
        }
    }
    let _ = mark_clean_shutdown(&connection);
}

fn open_connection(
    path: &Path,
    artifact_root: &Path,
) -> Result<(Connection, super::artifacts::ArtifactRoot), DatabaseError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_secs(5))?;
    validate_database_identity(&connection)?;
    validate_sqlite_version(&connection)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "trusted_schema", "OFF")?;
    if !connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)? {
        return Err(DatabaseError::Integrity(
            "SQLite defensive mode could not be enabled".to_owned(),
        ));
    }
    if connection.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)? {
        return Err(DatabaseError::Integrity(
            "SQLite trusted-schema mode could not be disabled".to_owned(),
        ));
    }
    if connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?
        || connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?
    {
        return Err(DatabaseError::Integrity(
            "SQLite double-quoted string compatibility could not be disabled".to_owned(),
        ));
    }
    let journal_mode: String =
        connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        let requested: String =
            connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        if !requested.eq_ignore_ascii_case("wal") {
            return Err(DatabaseError::WalUnavailable(requested));
        }
    }
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "journal_size_limit", 64 * 1024 * 1024_i64)?;
    migrations().to_latest(&mut connection)?;
    super::projects::reconcile_revision_retention(&mut connection)?;
    connection.pragma_update(None, "application_id", APPLICATION_ID)?;
    initialize_runtime_state(&mut connection)?;
    super::legacy::interrupt_running(&connection)?;
    let artifact_root = super::artifacts::ArtifactRoot::prepare(artifact_root)?;
    super::artifacts::reconcile(&connection, &artifact_root)?;
    let integrity = quick_check(&connection)?;
    if integrity != "ok" {
        return Err(DatabaseError::Integrity(integrity));
    }
    let mut foreign_key_check = connection.prepare("PRAGMA foreign_key_check")?;
    if foreign_key_check.exists([])? {
        return Err(DatabaseError::Integrity(
            "foreign key validation failed".to_owned(),
        ));
    }
    drop(foreign_key_check);
    Ok((connection, artifact_root))
}

fn database_health(connection: &Connection) -> Result<DatabaseHealth, DatabaseError> {
    let schema_version = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let sqlite_version = connection.query_row("SELECT sqlite_version()", [], |row| row.get(0))?;
    let application_id = connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    let journal_mode = connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
    let previous_shutdown_clean = connection.query_row(
        "SELECT previous_shutdown_clean FROM app_meta WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?;
    Ok(DatabaseHealth {
        schema_version,
        sqlite_version,
        application_id,
        journal_mode,
        integrity: quick_check(connection)?,
        previous_shutdown_clean,
    })
}

fn validate_database_identity(connection: &Connection) -> Result<(), DatabaseError> {
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application_id != 0 && application_id != APPLICATION_ID {
        return Err(DatabaseError::WrongApplicationId(application_id));
    }
    let schema_version: u32 =
        connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if schema_version > SCHEMA_VERSION {
        return Err(DatabaseError::FutureSchema {
            found: schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    Ok(())
}

fn validate_sqlite_version(connection: &Connection) -> Result<(), DatabaseError> {
    let version: String = connection.query_row("SELECT sqlite_version()", [], |row| row.get(0))?;
    let parse = |value: &str| {
        let mut parts = value.split('.').map(str::parse::<u32>);
        Some((
            parts.next()?.ok()?,
            parts.next()?.ok()?,
            parts.next()?.ok()?,
        ))
    };
    if parse(&version) < parse(MINIMUM_SQLITE_VERSION) {
        return Err(DatabaseError::SqliteTooOld {
            found: version,
            required: MINIMUM_SQLITE_VERSION,
        });
    }
    Ok(())
}

fn initialize_runtime_state(connection: &mut Connection) -> Result<(), DatabaseError> {
    let transaction = connection.transaction()?;
    let timestamp = now_ms();
    transaction.execute(
        "INSERT OR IGNORE INTO app_meta(
           singleton, install_id, clean_shutdown, previous_shutdown_clean,
           last_writer_version, created_at_ms, updated_at_ms
         ) VALUES (1, ?1, 1, 1, ?2, ?3, ?3)",
        params![Uuid::now_v7(), env!("CARGO_PKG_VERSION"), timestamp],
    )?;
    transaction.execute(
        "UPDATE app_meta
         SET previous_shutdown_clean = clean_shutdown,
             clean_shutdown = 0, last_writer_version = ?1, updated_at_ms = ?2
         WHERE singleton = 1",
        params![env!("CARGO_PKG_VERSION"), timestamp],
    )?;
    super::jobs::interrupt_in_flight(&transaction, timestamp)?;
    transaction.commit()?;
    Ok(())
}

fn mark_clean_shutdown(connection: &Connection) -> Result<(), DatabaseError> {
    connection.execute(
        "UPDATE app_meta SET clean_shutdown = 1, updated_at_ms = ?1 WHERE singleton = 1",
        [now_ms()],
    )?;
    Ok(())
}

fn backup_database(connection: &Connection, destination: &Path) -> Result<(), DatabaseError> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or(DatabaseError::InvalidBackupPath)?;
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or(DatabaseError::InvalidBackupPath)?;
    if destination.exists() {
        return Err(DatabaseError::BackupDestinationExists);
    }
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{file_name}.{}.part", Uuid::now_v7()));
    let result = (|| {
        let mut backup_connection = Connection::open_with_flags(
            &temporary,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        {
            let backup = rusqlite::backup::Backup::new(connection, &mut backup_connection)?;
            backup.run_to_completion(128, Duration::from_millis(5), None)?;
        }
        let integrity = quick_check(&backup_connection)?;
        if integrity != "ok" {
            return Err(DatabaseError::Integrity(integrity));
        }
        let application_id: i64 =
            backup_connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
        if application_id != APPLICATION_ID {
            return Err(DatabaseError::WrongApplicationId(application_id));
        }
        drop(backup_connection);
        fs::hard_link(&temporary, destination)?;
        let _ = fs::remove_file(&temporary);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn quick_check(connection: &Connection) -> Result<String, DatabaseError> {
    connection
        .pragma_query_value(None, "quick_check", |row| row.get(0))
        .map_err(Into::into)
}

fn get_setting(
    connection: &Connection,
    scope: &str,
    key: &str,
) -> Result<Option<Value>, DatabaseError> {
    let value_json: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE scope = ?1 AND key = ?2",
            params![scope, key],
            |row| row.get(0),
        )
        .optional()?;
    value_json
        .map(|value| serde_json::from_str(&value).map_err(Into::into))
        .transpose()
}

fn list_settings(
    connection: &Connection,
    scope: &str,
) -> Result<BTreeMap<String, Value>, DatabaseError> {
    let mut statement = connection
        .prepare("SELECT key, value_json FROM app_settings WHERE scope = ?1 ORDER BY key")?;
    let rows = statement.query_map([scope], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut values = BTreeMap::new();
    for row in rows {
        let (key, value_json) = row?;
        values.insert(key, serde_json::from_str(&value_json)?);
    }
    Ok(values)
}

fn put_setting(
    connection: &mut Connection,
    scope: &str,
    key: &str,
    value_json: &str,
) -> Result<(), DatabaseError> {
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(scope, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_ms = excluded.updated_at_ms",
        params![scope, key, value_json, now_ms()],
    )?;
    transaction.commit()?;
    Ok(())
}

fn put_settings(
    connection: &mut Connection,
    scope: &str,
    entries: &[(String, String)],
) -> Result<(), DatabaseError> {
    let transaction = connection.transaction()?;
    {
        let mut statement = transaction.prepare(
            "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(scope, key) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at_ms = excluded.updated_at_ms",
        )?;
        let updated_at_ms = now_ms();
        for (key, value_json) in entries {
            statement.execute(params![scope, key, value_json, updated_at_ms])?;
        }
    }
    transaction.commit()?;
    Ok(())
}

fn delete_setting(connection: &Connection, scope: &str, key: &str) -> Result<bool, DatabaseError> {
    let changed = connection.execute(
        "DELETE FROM app_settings WHERE scope = ?1 AND key = ?2",
        params![scope, key],
    )?;
    Ok(changed != 0)
}

fn delete_settings(
    connection: &mut Connection,
    scope: &str,
    keys: &[String],
) -> Result<u64, DatabaseError> {
    let transaction = connection.transaction()?;
    let mut removed = 0_u64;
    {
        let mut statement =
            transaction.prepare("DELETE FROM app_settings WHERE scope = ?1 AND key = ?2")?;
        for key in keys {
            let changed = statement.execute(params![scope, key])?;
            removed = removed
                .checked_add(u64::try_from(changed).unwrap_or(u64::MAX))
                .ok_or(DatabaseError::InvalidSettingKey)?;
        }
    }
    transaction.commit()?;
    Ok(removed)
}

fn clear_settings(connection: &Connection, scope: &str) -> Result<u64, DatabaseError> {
    let removed = connection.execute("DELETE FROM app_settings WHERE scope = ?1", [scope])?;
    u64::try_from(removed).map_err(|_| DatabaseError::InvalidSettingKey)
}

fn credential_insert_pending(
    connection: &Connection,
    id: CredentialId,
    purpose: CredentialPurpose,
) -> Result<CredentialStatus, DatabaseError> {
    if !purpose.allows_multiple()
        && connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM credential_refs WHERE purpose = ?1)",
            [purpose.as_str()],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Err(DatabaseError::CredentialPurposeAlreadyExists(purpose));
    }
    let timestamp = now_ms();
    connection.execute(
        "INSERT INTO credential_refs(
           id, purpose, status, last_four, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, 'pending', NULL, ?3, ?3)",
        params![id.as_uuid(), purpose.as_str(), timestamp],
    )?;
    Ok(CredentialStatus::pending(id, purpose))
}

fn credential_mark_ready(
    connection: &Connection,
    id: CredentialId,
    last4: &str,
) -> Result<CredentialStatus, DatabaseError> {
    validate_last4(last4)?;
    let changed = connection.execute(
        "UPDATE credential_refs
         SET status = 'ready', last_four = ?1, updated_at_ms = ?2
         WHERE id = ?3",
        params![last4, now_ms(), id.as_uuid()],
    )?;
    if changed == 0 {
        return Err(DatabaseError::CredentialNotFound);
    }
    credential_get(connection, id)
}

fn credential_mark_unavailable(
    connection: &Connection,
    id: CredentialId,
) -> Result<CredentialStatus, DatabaseError> {
    let changed = connection.execute(
        "UPDATE credential_refs
         SET status = 'unavailable', updated_at_ms = ?1
         WHERE id = ?2",
        params![now_ms(), id.as_uuid()],
    )?;
    if changed == 0 {
        return Err(DatabaseError::CredentialNotFound);
    }
    credential_get(connection, id)
}

fn credential_get(
    connection: &Connection,
    id: CredentialId,
) -> Result<CredentialStatus, DatabaseError> {
    let row = connection
        .query_row(
            "SELECT id, purpose, status, last_four
             FROM credential_refs WHERE id = ?1",
            [id.as_uuid()],
            |row| {
                Ok((
                    row.get::<_, Uuid>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or(DatabaseError::CredentialNotFound)?;
    credential_status_from_row(row)
}

fn credential_list(
    connection: &Connection,
    purpose: Option<CredentialPurpose>,
) -> Result<Vec<CredentialStatus>, DatabaseError> {
    let mut statement = connection.prepare(
        "SELECT id, purpose, status, last_four
         FROM credential_refs
         WHERE ?1 IS NULL OR purpose = ?1
         ORDER BY created_at_ms, id",
    )?;
    let purpose = purpose.map(CredentialPurpose::as_str);
    let rows = statement.query_map([purpose], |row| {
        Ok((
            row.get::<_, Uuid>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;
    let mut credentials = Vec::new();
    for row in rows {
        credentials.push(credential_status_from_row(row?)?);
    }
    Ok(credentials)
}

fn credential_status_from_row(
    (id, purpose, state, last4): (Uuid, String, String, Option<String>),
) -> Result<CredentialStatus, DatabaseError> {
    let purpose = purpose
        .parse()
        .map_err(|_| DatabaseError::InvalidCredentialMetadata)?;
    let state = state
        .parse()
        .map_err(|_| DatabaseError::InvalidCredentialMetadata)?;
    if let Some(value) = &last4 {
        validate_last4(value).map_err(|_| DatabaseError::InvalidCredentialMetadata)?;
    }
    if state == CredentialState::Ready && last4.is_none() {
        return Err(DatabaseError::InvalidCredentialMetadata);
    }
    Ok(CredentialStatus::from_parts(
        CredentialId::from_uuid(id).map_err(|_| DatabaseError::InvalidCredentialMetadata)?,
        purpose,
        state,
        last4,
    ))
}

fn credential_delete(connection: &Connection, id: CredentialId) -> Result<bool, DatabaseError> {
    let changed =
        connection.execute("DELETE FROM credential_refs WHERE id = ?1", [id.as_uuid()])?;
    Ok(changed != 0)
}

fn validate_last4(value: &str) -> Result<(), DatabaseError> {
    if (1..=4).contains(&value.chars().count()) {
        Ok(())
    } else {
        Err(DatabaseError::InvalidCredentialMetadata)
    }
}

fn validate_setting_key(scope: &str, key: &str) -> Result<(), DatabaseError> {
    validate_setting_part(scope)?;
    validate_setting_part(key)?;
    if is_secret_setting_key(key) {
        return Err(DatabaseError::SecretSetting);
    }
    Ok(())
}

fn validate_setting_part(value: &str) -> Result<(), DatabaseError> {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        Ok(())
    } else {
        Err(DatabaseError::InvalidSettingKey)
    }
}

#[must_use]
pub fn is_secret_setting_key(key: &str) -> bool {
    let normalized = canonicalize_setting_key(key);
    normalized.contains("api_key")
        || normalized.contains("apikey")
        || normalized.contains("password")
        || normalized.contains("passwd")
        || normalized.contains("passphrase")
        || normalized.contains("credential")
        || normalized.contains("client_secret")
        || normalized.contains("private_key")
        || normalized.contains("authorization")
        || matches!(
            normalized.as_str(),
            "access_key"
                | "access_tokens"
                | "auth"
                | "auth_tokens"
                | "bearer"
                | "client_id"
                | "cookie"
                | "cookies"
                | "gemini_blacklisted_keys"
                | "jwt"
                | "oauth_tokens"
                | "refresh_tokens"
                | "secret"
                | "secret_key"
                | "secrets"
                | "session_id"
                | "session_key"
                | "token"
        )
        || normalized.ends_with("_access_key")
        || normalized.ends_with("_access_tokens")
        || normalized.ends_with("_auth")
        || normalized.ends_with("_auth_tokens")
        || normalized.ends_with("_bearer")
        || normalized.ends_with("_client_id")
        || normalized.ends_with("_cookie")
        || normalized.ends_with("_cookies")
        || normalized.ends_with("_jwt")
        || normalized.ends_with("_oauth_tokens")
        || normalized.ends_with("_refresh_tokens")
        || normalized.ends_with("_session_id")
        || normalized.ends_with("_session_key")
        || normalized.ends_with("_secret")
        || normalized.ends_with("_secret_key")
        || normalized.ends_with("_secrets")
        || normalized.ends_with("_token")
        || normalized.ends_with("_access_token")
        || normalized.ends_with("_refresh_token")
        || normalized.ends_with("_auth_token")
}

fn canonicalize_setting_key(key: &str) -> String {
    let mut canonical = String::with_capacity(key.len());
    let mut characters = key.chars().peekable();
    let mut previous = None;

    while let Some(character) = characters.next() {
        if matches!(character, '.' | ':' | '-' | '_') {
            if !canonical.ends_with('_') {
                canonical.push('_');
            }
        } else {
            let split_before_uppercase = character.is_ascii_uppercase()
                && (previous.is_some_and(|previous: char| {
                    previous.is_ascii_lowercase() || previous.is_ascii_digit()
                }) || (previous.is_some_and(|previous: char| previous.is_ascii_uppercase())
                    && characters.peek().is_some_and(char::is_ascii_lowercase)));
            if split_before_uppercase && !canonical.ends_with('_') {
                canonical.push('_');
            }
            canonical.push(character.to_ascii_lowercase());
        }
        previous = Some(character);
    }

    canonical
}

pub(super) fn now_ms() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::sync::mpsc::sync_channel;

    use rusqlite::params;
    use serde_json::json;
    use tempfile::TempDir;
    use uuid::Uuid;

    use super::{APPLICATION_ID, Database, Request};
    use crate::secrets::{CredentialId, CredentialPurpose, CredentialState};
    use crate::storage::{
        ArtifactDraft, ArtifactId, ArtifactKind, ArtifactRegistration, CacheCategory, CacheKey,
        CacheWrite, ContentHash, DatabaseError,
    };

    fn database() -> (TempDir, Database) {
        let directory = TempDir::new().expect("temporary directory");
        let database = Database::open(directory.path().join("db/osg.sqlite3"))
            .expect("open migrated database");
        (directory, database)
    }

    fn publish_durable_artifact(database: &Database, bytes: &[u8]) -> ArtifactId {
        let draft = ArtifactDraft::new(
            ArtifactKind::new("testArtifact").expect("artifact kind"),
            ContentHash::digest(bytes),
            bytes.len() as u64,
            json!({"fixture": true}),
        )
        .expect("artifact draft");
        let ArtifactRegistration::Staging(staging) = database
            .register_artifact(&draft)
            .expect("register artifact")
        else {
            panic!("test content must create a new artifact");
        };
        fs::write(staging.path(), bytes).expect("write staged artifact");
        let id = staging.record().id();
        database.mark_artifact_ready(id).expect("publish artifact");
        id
    }

    #[test]
    fn initializes_a_wal_database_with_a_valid_schema() {
        let (_directory, database) = database();

        let health = database.health().expect("database health");

        assert_eq!(health.schema_version, 5);
        assert_eq!(health.application_id, APPLICATION_ID);
        assert!(health.sqlite_version.starts_with("3."));
        assert_eq!(health.journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(health.integrity, "ok");
        assert!(health.previous_shutdown_clean);
    }

    #[test]
    fn migrates_v1_credentials_and_cooldowns_before_accepting_oauth_tokens() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("db/osg.sqlite3");
        fs::create_dir_all(path.parent().expect("database parent"))
            .expect("create database directory");
        let legacy_id = CredentialId::new();
        let connection = rusqlite::Connection::open(&path).expect("create v1 database");
        connection
            .execute_batch(include_str!("sql/0001_initial.sql"))
            .expect("install v1 schema");
        connection
            .pragma_update(None, "user_version", 1_u32)
            .expect("mark v1 schema");
        connection
            .pragma_update(None, "application_id", APPLICATION_ID)
            .expect("set application id");
        connection
            .execute(
                "INSERT INTO credential_refs(
                   id, purpose, status, last_four, created_at_ms, updated_at_ms
                 ) VALUES (?1, 'youtube_oauth_client', 'ready', 'ient', 10, 20)",
                [legacy_id.as_uuid()],
            )
            .expect("insert v1 credential");
        connection
            .execute(
                "INSERT INTO credential_cooldowns(credential_id, resource, until_ms, reason)
                 VALUES (?1, ?2, ?3, ?4)",
                params![legacy_id.as_uuid(), "youtube", 9_999_i64, "fixture"],
            )
            .expect("insert v1 cooldown");
        drop(connection);

        let database = Database::open(&path).expect("upgrade v1 database");
        assert_eq!(
            database.health().expect("database health").schema_version,
            5
        );
        let clients = database
            .credential_list(Some(CredentialPurpose::YouTubeOauthClient))
            .expect("list migrated client");
        assert_eq!(clients.len(), 1);
        assert_eq!(clients[0].id, legacy_id);
        assert_eq!(clients[0].state, CredentialState::Ready);
        database
            .credential_insert_pending(CredentialId::new(), CredentialPurpose::YouTubeOauthToken)
            .expect("new OAuth token purpose works after migration");
        drop(database);

        let upgraded = rusqlite::Connection::open(path).expect("inspect upgraded database");
        let cooldown_count: i64 = upgraded
            .query_row(
                "SELECT COUNT(*) FROM credential_cooldowns
                 WHERE credential_id = ?1 AND resource = 'youtube' AND reason = 'fixture'",
                [legacy_id.as_uuid()],
                |row| row.get(0),
            )
            .expect("read migrated cooldown");
        assert_eq!(cooldown_count, 1);
        let restore_index_count: i64 = upgraded
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema
                 WHERE type = 'index' AND name = 'jobs_state_updated_idx'",
                [],
                |row| row.get(0),
            )
            .expect("read bounded job restore index");
        assert_eq!(restore_index_count, 1);
    }

    #[test]
    fn records_a_clean_actor_shutdown_for_the_next_start() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("db/osg.sqlite3");
        let database = Database::open(&path).expect("first open");
        drop(database);

        let reopened = Database::open(&path).expect("reopen after clean shutdown");

        assert!(
            reopened
                .health()
                .expect("database health")
                .previous_shutdown_clean
        );
    }

    #[test]
    fn refuses_a_database_owned_by_another_application() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("foreign.sqlite3");
        let connection = rusqlite::Connection::open(&path).expect("create foreign database");
        connection
            .pragma_update(None, "application_id", 123_i64)
            .expect("set foreign application id");
        drop(connection);

        assert!(matches!(
            Database::open(path),
            Err(DatabaseError::WrongApplicationId(123))
        ));
    }

    #[test]
    fn refuses_a_schema_created_by_a_newer_application() {
        let directory = TempDir::new().expect("temporary directory");
        let path = directory.path().join("future.sqlite3");
        let connection = rusqlite::Connection::open(&path).expect("create future database");
        connection
            .pragma_update(None, "user_version", 99_u32)
            .expect("set future schema version");
        drop(connection);

        assert!(matches!(
            Database::open(path),
            Err(DatabaseError::FutureSchema {
                found: 99,
                supported: 5
            })
        ));
    }

    #[test]
    fn settings_round_trip_as_typed_json() {
        let (_directory, database) = database();
        let expected = json!({"model": "gemini-2.5-flash", "temperature": 0.2});

        database
            .put_setting("app", "gemini.defaults", &expected)
            .expect("save setting");

        assert_eq!(
            database
                .get_setting("app", "gemini.defaults")
                .expect("load setting"),
            Some(expected)
        );
        assert!(
            database
                .delete_setting("app", "gemini.defaults")
                .expect("delete setting")
        );
        assert_eq!(
            database
                .get_setting("app", "gemini.defaults")
                .expect("load missing setting"),
            None
        );
    }

    #[test]
    fn batch_settings_are_atomic_and_sorted() {
        let (_directory, database) = database();
        let values = BTreeMap::from([
            ("theme".to_owned(), json!("dark")),
            ("locale".to_owned(), json!("vi")),
        ]);

        database
            .put_settings("app", &values)
            .expect("save settings batch");

        assert_eq!(
            database.list_settings("app").expect("list settings"),
            values
        );
    }

    #[test]
    fn batch_settings_reject_excessive_entry_count_and_aggregate_bytes() {
        let (_directory, database) = database();
        let too_many = (0..=super::MAX_SETTINGS_BATCH_ENTRIES)
            .map(|index| (format!("setting.{index}"), json!(true)))
            .collect::<BTreeMap<_, _>>();
        assert!(matches!(
            database.put_settings("app", &too_many),
            Err(super::DatabaseError::SettingTooLarge)
        ));

        let value = "x".repeat(super::MAX_SETTING_BYTES - 2);
        let oversized = (0..9)
            .map(|index| (format!("large.{index}"), json!(value.clone())))
            .collect::<BTreeMap<_, _>>();
        assert!(matches!(
            database.put_settings("app", &oversized),
            Err(super::DatabaseError::SettingTooLarge)
        ));
        assert!(
            database
                .list_settings("app")
                .expect("empty scope")
                .is_empty()
        );
    }

    #[test]
    fn batch_setting_delete_is_exact_bounded_and_never_reads_values() {
        let (_directory, database) = database();
        database
            .put_setting(
                "legacy",
                "provider.cache.first",
                &json!("opaque-capability"),
            )
            .expect("first transient");
        database
            .put_setting("legacy", "provider.cache.second", &json!("provider-uri"))
            .expect("second transient");
        database
            .put_setting("legacy", "keep", &json!(true))
            .expect("durable setting");

        assert_eq!(
            database
                .delete_settings(
                    "legacy",
                    &[
                        "provider.cache.first".to_owned(),
                        "provider.cache.second".to_owned(),
                        "provider.cache.first".to_owned(),
                    ],
                )
                .expect("delete exact transient keys"),
            2
        );
        assert_eq!(
            database.list_settings("legacy").expect("remaining"),
            BTreeMap::from([("keep".to_owned(), json!(true))])
        );
        assert!(
            database
                .delete_settings("legacy", &["provider.cache.%".to_owned()])
                .is_err()
        );
        assert!(
            database
                .delete_settings(
                    "legacy",
                    &vec!["key".to_owned(); super::MAX_SETTING_DELETE_KEYS + 1]
                )
                .is_err()
        );
    }

    #[test]
    fn clearing_one_setting_scope_is_atomic_and_does_not_touch_another_scope() {
        let (_directory, database) = database();
        database
            .put_settings(
                "app",
                &BTreeMap::from([
                    ("language".to_owned(), json!("ko")),
                    ("theme".to_owned(), json!("dark")),
                ]),
            )
            .expect("app settings");
        database
            .put_setting("project", "theme", &json!("light"))
            .expect("other scope");

        assert_eq!(database.clear_settings("app").expect("clear app scope"), 2);
        assert!(database.list_settings("app").expect("empty app").is_empty());
        assert_eq!(
            database
                .get_setting("project", "theme")
                .expect("other scope retained"),
            Some(json!("light"))
        );
        assert_eq!(database.clear_settings("app").expect("idempotent clear"), 0);
        assert!(database.clear_settings("").is_err());
    }

    #[test]
    fn rejects_unbounded_or_ambiguous_setting_keys() {
        let (_directory, database) = database();

        assert!(database.put_setting("", "key", &json!(true)).is_err());
        assert!(
            database
                .put_setting("app", "../../secret", &json!(true))
                .is_err()
        );
        for safe_key in [
            "gemini_model",
            "gemini_max_tokens",
            "maxTokens",
            "tokenCount",
            "theme",
            "keyboard_shortcuts",
        ] {
            database
                .put_setting("app", safe_key, &json!("keep"))
                .expect("non-secret setting");
        }
        for secret_key in [
            "gemini_api_key",
            "gemini_blacklisted_keys",
            "provider_refresh_token",
            "provider_credentials_v2",
            "provider_token",
            "clientSecret",
            "client.secret",
            "client:secret",
            "client..::--secret",
            "accessToken",
            "refreshToken",
            "privateKey",
            "apiKey",
            "APIKey",
            "oauthToken",
            "providerClientId",
            "providerAuthorization",
            "accountPassword",
            "accountPasswd",
            "accountPassphrase",
            "providerCredential",
            "sessionCookie",
            "browserCookies",
            "oauthJwt",
            "serviceAccessKey",
            "providerBearer",
            "accountSessionId",
            "accountSessionKey",
            "providerAuth",
            "providerAccessTokens",
            "providerRefreshTokens",
            "providerOauthTokens",
            "providerAuthTokens",
            "providerSecrets",
            "clientId",
            "accessKey",
            "bearer",
            "sessionId",
            "sessionKey",
            "auth",
            "token",
            "secret",
            "secretKey",
            "secrets",
            "cookie",
            "cookies",
            "jwt",
        ] {
            assert!(matches!(
                database.put_setting("app", secret_key, &json!("never-store")),
                Err(DatabaseError::SecretSetting)
            ));
        }
    }

    #[test]
    fn cloned_handles_share_one_actor_owned_connection() {
        let (_directory, database) = database();
        let clone = database.clone();
        database
            .put_setting("app", "locale", &json!("ko"))
            .expect("save through original");

        assert_eq!(
            clone
                .get_setting("app", "locale")
                .expect("load through clone"),
            Some(json!("ko"))
        );
    }

    #[test]
    fn clear_with_info_is_ordered_before_a_queued_cache_writer() {
        let (_directory, database) = database();
        let cleared_category = CacheCategory::new("videos").expect("cleared category");
        let later_category = CacheCategory::new("videoTemp").expect("later category");
        let cleared_artifact = publish_durable_artifact(&database, b"before clear");
        let later_artifact = publish_durable_artifact(&database, b"after clear");
        let cleared_key = CacheKey::derive(&cleared_category, 1, &[b"first"]).expect("cleared key");
        let later_key = CacheKey::derive(&later_category, 1, &[b"second"]).expect("later key");
        database
            .put_cache_entry(
                &CacheWrite::new(cleared_key, cleared_artifact, cleared_category, 1, None)
                    .expect("initial cache write"),
            )
            .expect("put initial cache entry");
        let later_write = CacheWrite::new(later_key, later_artifact, later_category, 1, None)
            .expect("later cache write");

        // Queue both operations without waiting for either reply. FIFO processing guarantees the
        // writer runs after the complete before/clear/after actor operation, not between snapshots.
        let (clear_reply, clear_response) = sync_channel(1);
        database
            .inner
            .sender
            .send(Request::ClearCacheWithInfo {
                category: None,
                reply: clear_reply,
            })
            .expect("queue aggregate clear");
        let (write_reply, write_response) = sync_channel(1);
        database
            .inner
            .sender
            .send(Request::PutCache {
                write: later_write,
                reply: write_reply,
            })
            .expect("queue later writer");

        let outcome = clear_response
            .recv()
            .expect("receive aggregate clear")
            .expect("aggregate clear succeeds");
        write_response
            .recv()
            .expect("receive later writer")
            .expect("later writer succeeds");

        assert_eq!(outcome.before.total_count, 1);
        assert_eq!(outcome.after.total_count, 0);
        assert_eq!(outcome.clear.category, None);
        let final_info = database.cache_info().expect("final cache info");
        assert_eq!(final_info.total_count, 1);
        assert_eq!(final_info.categories.len(), 1);
        assert_eq!(final_info.categories[0].category, "videoTemp");
    }

    #[test]
    fn online_backup_contains_committed_state_without_wal_copying() {
        let (directory, database) = database();
        database
            .put_setting("app", "locale", &json!("ko"))
            .expect("save setting");
        let backup_path = directory.path().join("backups/pre-upgrade.sqlite3");

        database.backup_to(&backup_path).expect("online backup");

        let backup = rusqlite::Connection::open(backup_path).expect("open backup");
        let value_json: String = backup
            .query_row(
                "SELECT value_json FROM app_settings WHERE scope = 'app' AND key = 'locale'",
                [],
                |row| row.get(0),
            )
            .expect("read backup setting");
        assert_eq!(value_json, "\"ko\"");
        assert_eq!(
            backup
                .pragma_query_value(None, "application_id", |row| row.get::<_, i64>(0))
                .expect("backup application id"),
            APPLICATION_ID
        );
    }

    #[test]
    fn credential_metadata_transitions_without_storing_secret_values() {
        let (directory, database) = database();
        let id = CredentialId::new();

        let pending = database
            .credential_insert_pending(id, CredentialPurpose::GeminiApiKey)
            .expect("insert pending credential metadata");
        assert_eq!(pending.state, CredentialState::Pending);
        assert_eq!(pending.last4, None);

        let ready = database
            .credential_mark_ready(id, "🔑끝")
            .expect("mark credential ready");
        assert_eq!(ready.state, CredentialState::Ready);
        assert_eq!(ready.last4.as_deref(), Some("🔑끝"));
        assert_eq!(
            database
                .credential_list(Some(CredentialPurpose::GeminiApiKey))
                .expect("list purpose credentials"),
            vec![ready.clone()]
        );

        drop(database);
        let raw =
            std::fs::read(directory.path().join("db/osg.sqlite3")).expect("read database bytes");
        assert!(
            !raw.windows(b"super-secret-value".len())
                .any(|window| { window == b"super-secret-value" })
        );
    }

    #[test]
    fn supports_multiple_gemini_keys_and_idempotent_deletion() {
        let (_directory, database) = database();
        let first = CredentialId::new();
        let second = CredentialId::new();
        database
            .credential_insert_pending(first, CredentialPurpose::GeminiApiKey)
            .expect("insert first Gemini key");
        database
            .credential_insert_pending(second, CredentialPurpose::GeminiApiKey)
            .expect("insert second Gemini key");

        let credentials = database
            .credential_list(Some(CredentialPurpose::GeminiApiKey))
            .expect("list Gemini keys");
        assert_eq!(credentials.len(), 2);
        assert!(database.credential_delete(first).expect("delete first"));
        assert!(!database.credential_delete(first).expect("repeat delete"));
        assert_eq!(
            database
                .credential_list(Some(CredentialPurpose::GeminiApiKey))
                .expect("list remaining keys")
                .len(),
            1
        );
    }

    #[test]
    fn singleton_credential_purposes_are_enforced_independently() {
        let (_directory, database) = database();
        database
            .credential_insert_pending(CredentialId::new(), CredentialPurpose::GeniusAccessToken)
            .expect("insert Genius token");

        assert!(matches!(
            database.credential_insert_pending(
                CredentialId::new(),
                CredentialPurpose::GeniusAccessToken
            ),
            Err(DatabaseError::CredentialPurposeAlreadyExists(
                CredentialPurpose::GeniusAccessToken
            ))
        ));
        database
            .credential_insert_pending(CredentialId::new(), CredentialPurpose::YouTubeApiKey)
            .expect("YouTube API key is a separate singleton");
        database
            .credential_insert_pending(CredentialId::new(), CredentialPurpose::YouTubeOauthClient)
            .expect("YouTube OAuth client is a separate singleton");
        database
            .credential_insert_pending(CredentialId::new(), CredentialPurpose::YouTubeOauthToken)
            .expect("YouTube OAuth token is a separate singleton");
    }

    #[test]
    fn schema_rejects_unknown_credential_purposes() {
        let (directory, database) = database();
        drop(database);
        let connection = rusqlite::Connection::open(directory.path().join("db/osg.sqlite3"))
            .expect("open database directly");

        assert!(
            connection
                .execute(
                    "INSERT INTO credential_refs(
                       id, purpose, status, created_at_ms, updated_at_ms
                     ) VALUES (?1, 'gemini', 'pending', 1, 1)",
                    [Uuid::now_v7()],
                )
                .is_err()
        );
    }

    #[test]
    fn rejects_invalid_last_four_metadata() {
        let (_directory, database) = database();
        let id = CredentialId::new();
        database
            .credential_insert_pending(id, CredentialPurpose::YouTubeApiKey)
            .expect("insert pending credential");

        assert!(matches!(
            database.credential_mark_ready(id, "12345"),
            Err(DatabaseError::InvalidCredentialMetadata)
        ));
        assert!(matches!(
            database.credential_mark_ready(CredentialId::new(), "1234"),
            Err(DatabaseError::CredentialNotFound)
        ));
    }
}
