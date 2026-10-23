use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use osg_application::{JobStore, JobWrite, ProjectRepository, ProjectSnapshot, RevisionCommit};
use osg_domain::{JobId, JobSnapshot, ProjectId, ProjectMetadata, RevisionReason};
use serde::Serialize;

use super::error::DatabaseError;
use artifact_requests::ArtifactRequest;
use connection::{backup_database, database_health, mark_clean_shutdown, open_connection};
use credentials::CredentialRequest;
use job_requests::JobRequest;
use legacy_import_requests::LegacyImportRequest;
use media_requests::MediaRequest;
use project_requests::ProjectRequest;
use settings::SettingsRequest;
use transcript_requests::TranscriptRequest;
use workspace_requests::WorkspaceRequest;

const ACTOR_CAPACITY: usize = 64;
const MAX_SETTING_BYTES: usize = 1024 * 1024;
const MAX_SETTINGS_BATCH_BYTES: usize = 8 * 1024 * 1024;
const MAX_SETTINGS_BATCH_ENTRIES: usize = 4_096;
const MAX_SETTING_DELETE_KEYS: usize = 256;
const APPLICATION_ID: i64 = 0x4f53_4732;
const SCHEMA_VERSION: u32 = 17;
const MINIMUM_SQLITE_VERSION: &str = "3.51.3";
const MAX_MEDIA_RESOLUTION_BATCHES: usize = 64;
const MAX_ARTIFACT_LIST_ITEMS: usize = 4_096;

mod artifact_requests;
mod connection;
mod credentials;
mod job_requests;
mod legacy_import_requests;
mod media_requests;
mod project_requests;
mod settings;
mod transcript_requests;
mod workspace_requests;

pub use settings::is_secret_setting_key;

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
    Settings(SettingsRequest),
    Workspace(WorkspaceRequest),
    Credentials(CredentialRequest),
    Media(MediaRequest),
    Artifacts(ArtifactRequest),
    Jobs(JobRequest),
    Projects(ProjectRequest),
    Transcripts(TranscriptRequest),
    LegacyImport(LegacyImportRequest),
    Backup {
        destination: PathBuf,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    Shutdown,
}

impl std::fmt::Debug for Request {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Health { .. } => formatter.write_str("Health"),
            Self::Settings(request) => request.fmt(formatter),
            Self::Workspace(request) => request.fmt(formatter),
            Self::Credentials(request) => request.fmt(formatter),
            Self::Media(request) => request.fmt(formatter),
            Self::Artifacts(request) => request.fmt(formatter),
            Self::Jobs(request) => request.fmt(formatter),
            Self::Projects(request) => request.fmt(formatter),
            Self::Transcripts(request) => request.fmt(formatter),
            Self::LegacyImport(request) => request.fmt(formatter),
            Self::Backup { .. } => formatter.write_str("Backup"),
            Self::Shutdown => formatter.write_str("Shutdown"),
        }
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

    pub fn backup_to(&self, destination: impl Into<PathBuf>) -> Result<(), DatabaseError> {
        self.request(|reply| Request::Backup {
            destination: destination.into(),
            reply,
        })
    }

    fn request<T, R: Into<Request>>(
        &self,
        make_request: impl FnOnce(SyncSender<Result<T, DatabaseError>>) -> R,
    ) -> Result<T, DatabaseError> {
        let (reply, response) = sync_channel(1);
        self.inner
            .sender
            .send(make_request(reply).into())
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

fn run_actor(
    path: &Path,
    artifact_root: &Path,
    receiver: &Receiver<Request>,
    startup: &SyncSender<Result<(), DatabaseError>>,
) {
    let (mut connection, artifact_root, writer_lease) = match open_connection(path, artifact_root) {
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
            Request::Settings(request) => request.handle(&mut connection),
            Request::Workspace(request) => request.handle(&mut connection),
            Request::Credentials(request) => request.handle(&mut connection),
            Request::Media(request) => request.handle(&mut connection, &artifact_root),
            Request::Artifacts(request) => request.handle(&mut connection, &artifact_root),
            Request::Jobs(request) => request.handle(&mut connection),
            Request::Projects(request) => request.handle(&mut connection),
            Request::Transcripts(request) => request.handle(&mut connection),
            Request::LegacyImport(request) => request.handle(&mut connection),
            Request::Backup { destination, reply } => {
                let _ = reply.send(backup_database(&connection, &destination));
            }
            Request::Shutdown => break,
        }
    }
    let _ = mark_clean_shutdown(&connection);
    drop(connection);
    drop(writer_lease);
}

pub(super) fn now_ms() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests;
