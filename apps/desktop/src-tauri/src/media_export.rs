use std::ffi::OsString;
use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use osg_application::JobRegistry;
use osg_domain::{AssetId, JobKind, JobProgress, JobSnapshot, JobUpdate};
use osg_infrastructure::storage::Database;
use same_file::Handle;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;

use crate::background;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const PROGRESS_STEP_BASIS_POINTS: u16 = 25;
const PROGRESS_MAX_BASIS_POINTS: u16 = 9_999;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaExportRequest {
    asset_id: AssetId,
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum MediaExportEvent {
    Progress {
        job: JobSnapshot,
    },
    Completed {
        job: JobSnapshot,
        bytes_written: u64,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExportCopyError {
    Cancelled,
    ChannelClosed,
    JobUpdate,
    SourceChanged,
    UnsafeDestination,
    Io,
}

struct ValidatedSource {
    file: File,
    identity: Handle,
    modified: SystemTime,
}

struct DestinationPlan {
    directory: PathBuf,
    directory_identity: Handle,
    destination: PathBuf,
    existing_identity: Option<Handle>,
}

struct ProgressReporter {
    jobs: Arc<JobRegistry<Database>>,
    cancellation: CancellationToken,
    channel: Channel<MediaExportEvent>,
    job_id: osg_domain::JobId,
    last_basis_points: u16,
}

impl ProgressReporter {
    fn report(&mut self, completed: u64, total: u64) -> Result<(), ExportCopyError> {
        if self.cancellation.is_cancelled() {
            return Err(ExportCopyError::Cancelled);
        }
        let basis_points = progress_basis_points(completed, total);
        if basis_points
            < self
                .last_basis_points
                .saturating_add(PROGRESS_STEP_BASIS_POINTS)
            && basis_points != PROGRESS_MAX_BASIS_POINTS
        {
            return Ok(());
        }
        let progress =
            JobProgress::from_basis_points(basis_points).map_err(|_| ExportCopyError::JobUpdate)?;
        let ticket = self
            .jobs
            .apply(self.job_id, JobUpdate::ReportProgress(progress))
            .map_err(|_| {
                if self.cancellation.is_cancelled() {
                    ExportCopyError::Cancelled
                } else {
                    ExportCopyError::JobUpdate
                }
            })?;
        self.last_basis_points = basis_points;
        self.channel
            .send(MediaExportEvent::Progress {
                job: ticket.snapshot().clone(),
            })
            .map_err(|_| ExportCopyError::ChannelClosed)
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle, State, and Channel as owned command extractors"
)]
pub(crate) async fn media_export_start(
    app: AppHandle,
    state: State<'_, DesktopState>,
    request: MediaExportRequest,
    on_event: Channel<MediaExportEvent>,
) -> CommandResult<Option<JobSnapshot>> {
    let database = state.database.clone();
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        database
            .resolve_media(request.asset_id)?
            .ok_or_else(CommandError::media_unavailable)
    })
    .await
    .map_err(|_| CommandError::internal("The media export lookup stopped unexpectedly."))??;

    diagnostics::record(
        "media-export.dialog-opened",
        &[("asset", request.asset_id.to_string())],
    );

    let selected = app
        .dialog()
        .file()
        .set_title("Export media")
        .set_file_name(resolved.asset().display_name())
        .add_filter("Media", &[resolved.asset().extension()])
        .blocking_save_file();
    let Some(selected) = selected else {
        diagnostics::record(
            "media-export.dialog-cancelled",
            &[("asset", request.asset_id.to_string())],
        );
        return Ok(None);
    };
    let destination = selected
        .into_path()
        .map_err(|_| CommandError::media_export_unsafe())?;

    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::ExportMedia).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    diagnostics::record("media-export.started", &[("job", job_id.to_string())]);
    let cancellation = ticket.cancellation().clone();
    let source = resolved.path().to_owned();
    let expected_bytes = resolved.asset().size_bytes();

    tauri::async_runtime::spawn(async move {
        let worker_jobs = Arc::clone(&jobs);
        let worker_channel = on_event.clone();
        let worker_cancellation = cancellation.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut reporter = ProgressReporter {
                jobs: worker_jobs,
                cancellation: worker_cancellation.clone(),
                channel: worker_channel,
                job_id,
                last_basis_points: 0,
            };
            copy_export(
                &source,
                &destination,
                expected_bytes,
                || worker_cancellation.is_cancelled(),
                |completed, total| reporter.report(completed, total),
            )
        })
        .await
        .unwrap_or(Err(ExportCopyError::Io));
        finish_export(&jobs, job_id, expected_bytes, result, &on_event).await;
    });

    Ok(Some(initial))
}

async fn finish_export(
    jobs: &Arc<JobRegistry<Database>>,
    job_id: osg_domain::JobId,
    expected_bytes: u64,
    result: Result<(), ExportCopyError>,
    channel: &Channel<MediaExportEvent>,
) {
    if let Err(error) = result {
        match error {
            ExportCopyError::Cancelled => {
                if let Ok(job) = background::finish_cancellation(jobs, job_id).await {
                    diagnostics::record("media-export.cancelled", &[("job", job_id.to_string())]);
                    let _ = channel.send(MediaExportEvent::Cancelled { job });
                }
            }
            error => {
                let job = background::finish_failure(jobs, job_id).await;
                diagnostics::record(
                    "media-export.failed",
                    &[
                        ("job", job_id.to_string()),
                        ("code", command_error(error).code().to_owned()),
                    ],
                );
                if error != ExportCopyError::ChannelClosed {
                    let _ = channel.send(MediaExportEvent::Failed {
                        job,
                        error: command_error(error),
                    });
                }
            }
        }
        return;
    }

    if let Ok(job) = background::apply(jobs, job_id, JobUpdate::Succeed).await {
        diagnostics::record("media-export.completed", &[("job", job_id.to_string())]);
        let _ = channel.send(MediaExportEvent::Completed {
            job,
            bytes_written: expected_bytes,
        });
    } else {
        let job = background::finish_failure(jobs, job_id).await;
        diagnostics::record(
            "media-export.failed",
            &[
                ("job", job_id.to_string()),
                ("code", "mediaExportFailed".to_owned()),
            ],
        );
        let _ = channel.send(MediaExportEvent::Failed {
            job,
            error: CommandError::media_export_failed(),
        });
    }
}

fn command_error(error: ExportCopyError) -> CommandError {
    match error {
        ExportCopyError::SourceChanged => CommandError::media_export_source_changed(),
        ExportCopyError::UnsafeDestination => CommandError::media_export_unsafe(),
        ExportCopyError::Cancelled
        | ExportCopyError::ChannelClosed
        | ExportCopyError::JobUpdate
        | ExportCopyError::Io => CommandError::media_export_failed(),
    }
}

pub(crate) fn copy_export(
    source_path: &Path,
    destination_path: &Path,
    expected_bytes: u64,
    is_cancelled: impl Fn() -> bool,
    mut report_progress: impl FnMut(u64, u64) -> Result<(), ExportCopyError>,
) -> Result<(), ExportCopyError> {
    check_cancellation(&is_cancelled)?;
    let mut source = open_source(source_path, expected_bytes)?;
    let destination = DestinationPlan::new(destination_path, &source.identity)?;
    let mut staged = tempfile::Builder::new()
        .prefix(".osg-export-")
        .suffix(".part")
        .tempfile_in(&destination.directory)
        .map_err(|_| ExportCopyError::Io)?;
    reject_unsafe_metadata(
        &fs::symlink_metadata(staged.path()).map_err(|_| ExportCopyError::Io)?,
        false,
    )
    .map_err(|_| ExportCopyError::UnsafeDestination)?;

    let total_work = expected_bytes
        .checked_mul(2)
        .ok_or(ExportCopyError::SourceChanged)?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES].into_boxed_slice();
    let mut copied = 0_u64;
    let mut copied_hash = blake3::Hasher::new();
    loop {
        check_cancellation(&is_cancelled)?;
        let count = source
            .file
            .read(&mut buffer)
            .map_err(|_| failure_or_cancelled(&is_cancelled, ExportCopyError::Io))?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(u64::try_from(count).map_err(|_| ExportCopyError::SourceChanged)?)
            .filter(|value| *value <= expected_bytes)
            .ok_or(ExportCopyError::SourceChanged)?;
        staged
            .as_file_mut()
            .write_all(&buffer[..count])
            .map_err(|_| failure_or_cancelled(&is_cancelled, ExportCopyError::Io))?;
        copied_hash.update(&buffer[..count]);
        report_progress(copied, total_work)?;
    }
    if copied != expected_bytes {
        return Err(ExportCopyError::SourceChanged);
    }
    staged
        .as_file()
        .sync_all()
        .map_err(|_| failure_or_cancelled(&is_cancelled, ExportCopyError::Io))?;
    verify_source(source_path, &source, expected_bytes)?;
    source
        .file
        .seek(SeekFrom::Start(0))
        .map_err(|_| ExportCopyError::SourceChanged)?;

    let mut verified = 0_u64;
    let mut verified_hash = blake3::Hasher::new();
    loop {
        check_cancellation(&is_cancelled)?;
        let count = source
            .file
            .read(&mut buffer)
            .map_err(|_| failure_or_cancelled(&is_cancelled, ExportCopyError::SourceChanged))?;
        if count == 0 {
            break;
        }
        verified = verified
            .checked_add(u64::try_from(count).map_err(|_| ExportCopyError::SourceChanged)?)
            .filter(|value| *value <= expected_bytes)
            .ok_or(ExportCopyError::SourceChanged)?;
        verified_hash.update(&buffer[..count]);
        report_progress(expected_bytes + verified, total_work)?;
    }
    if verified != expected_bytes
        || copied_hash.finalize().as_bytes() != verified_hash.finalize().as_bytes()
    {
        return Err(ExportCopyError::SourceChanged);
    }
    verify_source(source_path, &source, expected_bytes)?;
    check_cancellation(&is_cancelled)?;
    let destination_path = destination.into_verified_destination(&source.identity)?;

    let staged_path = staged.into_temp_path();
    atomicwrites::replace_atomic(staged_path.as_ref(), &destination_path)
        .map_err(|_| failure_or_cancelled(&is_cancelled, ExportCopyError::Io))?;
    Ok(())
}

fn open_source(path: &Path, expected_bytes: u64) -> Result<ValidatedSource, ExportCopyError> {
    validate_path_chain(path.parent().ok_or(ExportCopyError::SourceChanged)?)
        .map_err(|_| ExportCopyError::SourceChanged)?;
    let path_metadata = fs::symlink_metadata(path).map_err(|_| ExportCopyError::SourceChanged)?;
    reject_unsafe_metadata(&path_metadata, false).map_err(|_| ExportCopyError::SourceChanged)?;
    if path_metadata.len() != expected_bytes {
        return Err(ExportCopyError::SourceChanged);
    }
    let file = File::open(path).map_err(|_| ExportCopyError::SourceChanged)?;
    let metadata = file
        .metadata()
        .map_err(|_| ExportCopyError::SourceChanged)?;
    reject_unsafe_metadata(&metadata, false).map_err(|_| ExportCopyError::SourceChanged)?;
    if metadata.len() != expected_bytes {
        return Err(ExportCopyError::SourceChanged);
    }
    let identity = Handle::from_file(
        file.try_clone()
            .map_err(|_| ExportCopyError::SourceChanged)?,
    )
    .map_err(|_| ExportCopyError::SourceChanged)?;
    if Handle::from_path(path).map_err(|_| ExportCopyError::SourceChanged)? != identity {
        return Err(ExportCopyError::SourceChanged);
    }
    let modified = metadata
        .modified()
        .map_err(|_| ExportCopyError::SourceChanged)?;
    Ok(ValidatedSource {
        file,
        identity,
        modified,
    })
}

fn verify_source(
    path: &Path,
    source: &ValidatedSource,
    expected_bytes: u64,
) -> Result<(), ExportCopyError> {
    let path_metadata = fs::symlink_metadata(path).map_err(|_| ExportCopyError::SourceChanged)?;
    reject_unsafe_metadata(&path_metadata, false).map_err(|_| ExportCopyError::SourceChanged)?;
    let file_metadata = source
        .file
        .metadata()
        .map_err(|_| ExportCopyError::SourceChanged)?;
    if path_metadata.len() != expected_bytes
        || file_metadata.len() != expected_bytes
        || file_metadata.modified().ok() != Some(source.modified)
        || Handle::from_path(path).map_err(|_| ExportCopyError::SourceChanged)? != source.identity
        || Handle::from_file(
            source
                .file
                .try_clone()
                .map_err(|_| ExportCopyError::SourceChanged)?,
        )
        .map_err(|_| ExportCopyError::SourceChanged)?
            != source.identity
    {
        return Err(ExportCopyError::SourceChanged);
    }
    Ok(())
}

impl DestinationPlan {
    fn new(path: &Path, source_identity: &Handle) -> Result<Self, ExportCopyError> {
        if !path.is_absolute() {
            return Err(ExportCopyError::UnsafeDestination);
        }
        let parent = path
            .parent()
            .filter(|value| !value.as_os_str().is_empty())
            .ok_or(ExportCopyError::UnsafeDestination)?;
        let file_name: OsString = path
            .file_name()
            .filter(|value| !value.is_empty())
            .ok_or(ExportCopyError::UnsafeDestination)?
            .to_owned();
        validate_path_chain(parent)?;
        let directory = fs::canonicalize(parent).map_err(|_| ExportCopyError::UnsafeDestination)?;
        validate_path_chain(&directory)?;
        let directory_identity =
            Handle::from_path(&directory).map_err(|_| ExportCopyError::UnsafeDestination)?;
        let destination = directory.join(file_name);
        let existing_identity = existing_destination_identity(&destination, source_identity)?;
        Ok(Self {
            directory,
            directory_identity,
            destination,
            existing_identity,
        })
    }

    fn verify(&self, source_identity: &Handle) -> Result<(), ExportCopyError> {
        validate_path_chain(&self.directory)?;
        if Handle::from_path(&self.directory).map_err(|_| ExportCopyError::UnsafeDestination)?
            != self.directory_identity
        {
            return Err(ExportCopyError::UnsafeDestination);
        }
        let actual = existing_destination_identity(&self.destination, source_identity)?;
        if actual != self.existing_identity {
            return Err(ExportCopyError::UnsafeDestination);
        }
        Ok(())
    }

    fn into_verified_destination(
        self,
        source_identity: &Handle,
    ) -> Result<PathBuf, ExportCopyError> {
        self.verify(source_identity)?;
        let Self {
            directory,
            directory_identity,
            destination,
            existing_identity,
        } = self;
        drop(directory);
        drop(directory_identity);
        drop(existing_identity);
        Ok(destination)
    }
}

fn existing_destination_identity(
    path: &Path,
    source_identity: &Handle,
) -> Result<Option<Handle>, ExportCopyError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            reject_unsafe_metadata(&metadata, false)?;
            let identity =
                Handle::from_path(path).map_err(|_| ExportCopyError::UnsafeDestination)?;
            if identity == *source_identity {
                return Err(ExportCopyError::UnsafeDestination);
            }
            Ok(Some(identity))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(ExportCopyError::UnsafeDestination),
    }
}

fn validate_path_chain(path: &Path) -> Result<(), ExportCopyError> {
    if !path.is_absolute() {
        return Err(ExportCopyError::UnsafeDestination);
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        let validate_component = !matches!(component, Component::Prefix(_));
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                current.push(component.as_os_str());
            }
            Component::CurDir | Component::ParentDir => {
                return Err(ExportCopyError::UnsafeDestination);
            }
        }
        if validate_component && current.has_root() {
            let metadata =
                fs::symlink_metadata(&current).map_err(|_| ExportCopyError::UnsafeDestination)?;
            if !metadata.is_dir() || is_link_or_reparse(&metadata) {
                return Err(ExportCopyError::UnsafeDestination);
            }
        }
    }
    Ok(())
}

fn reject_unsafe_metadata(metadata: &Metadata, directory: bool) -> Result<(), ExportCopyError> {
    if metadata.file_type().is_symlink()
        || is_link_or_reparse(metadata)
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        Err(ExportCopyError::UnsafeDestination)
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn check_cancellation(is_cancelled: &impl Fn() -> bool) -> Result<(), ExportCopyError> {
    if is_cancelled() {
        Err(ExportCopyError::Cancelled)
    } else {
        Ok(())
    }
}

fn failure_or_cancelled(
    is_cancelled: &impl Fn() -> bool,
    failure: ExportCopyError,
) -> ExportCopyError {
    if is_cancelled() {
        ExportCopyError::Cancelled
    } else {
        failure
    }
}

fn progress_basis_points(completed: u64, total: u64) -> u16 {
    let scaled =
        u128::from(completed) * u128::from(PROGRESS_MAX_BASIS_POINTS) / u128::from(total.max(1));
    u16::try_from(scaled.min(u128::from(PROGRESS_MAX_BASIS_POINTS)))
        .expect("bounded export progress fits in u16")
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    fn write_bytes(path: &Path, byte: u8, count: usize) {
        fs::write(path, vec![byte; count]).expect("write fixture");
    }

    #[test]
    fn staged_copy_atomically_replaces_an_existing_regular_file() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("source.mp4");
        let destination = root.path().join("export.mp4");
        write_bytes(&source, 7, COPY_BUFFER_BYTES + 31);
        write_bytes(&destination, 2, 8);
        let mut progress = Vec::new();

        copy_export(
            &source,
            &destination,
            COPY_BUFFER_BYTES as u64 + 31,
            || false,
            |completed, total| {
                progress.push((completed, total));
                Ok(())
            },
        )
        .expect("export");

        assert_eq!(
            fs::read(&destination).expect("read export"),
            vec![7; COPY_BUFFER_BYTES + 31]
        );
        assert!(progress.windows(2).all(|pair| pair[0].0 <= pair[1].0));
        assert_eq!(
            progress.last(),
            Some(&(
                2 * (COPY_BUFFER_BYTES as u64 + 31),
                2 * (COPY_BUFFER_BYTES as u64 + 31)
            ))
        );
    }

    #[test]
    fn cancellation_preserves_the_previous_destination() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("source.mp4");
        let destination = root.path().join("export.mp4");
        write_bytes(&source, 7, COPY_BUFFER_BYTES * 2);
        write_bytes(&destination, 2, 8);
        let cancelled = Cell::new(false);

        let result = copy_export(
            &source,
            &destination,
            (COPY_BUFFER_BYTES * 2) as u64,
            || cancelled.get(),
            |_, _| {
                cancelled.set(true);
                Ok(())
            },
        );

        assert_eq!(result, Err(ExportCopyError::Cancelled));
        assert_eq!(fs::read(&destination).expect("read original"), vec![2; 8]);
    }

    #[test]
    fn same_size_source_mutation_is_detected_before_commit() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("source.mp4");
        let destination = root.path().join("export.mp4");
        write_bytes(&source, 7, COPY_BUFFER_BYTES * 2);
        let mutated = Cell::new(false);

        let result = copy_export(
            &source,
            &destination,
            (COPY_BUFFER_BYTES * 2) as u64,
            || false,
            |completed, total| {
                if !mutated.replace(true) && completed < total {
                    write_bytes(&source, 9, COPY_BUFFER_BYTES * 2);
                }
                Ok(())
            },
        );

        assert_eq!(result, Err(ExportCopyError::SourceChanged));
        assert!(!destination.exists());
    }

    #[test]
    fn source_and_destination_must_be_distinct_files() {
        let root = tempfile::tempdir().expect("tempdir");
        let source = root.path().join("source.mp4");
        write_bytes(&source, 7, 32);

        assert_eq!(
            copy_export(&source, &source, 32, || false, |_, _| Ok(())),
            Err(ExportCopyError::UnsafeDestination)
        );
        assert_eq!(fs::read(&source).expect("source"), vec![7; 32]);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_sources_and_destinations_are_rejected() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("tempdir");
        let real_source = root.path().join("real.mp4");
        let source_link = root.path().join("source.mp4");
        let real_destination = root.path().join("real-export.mp4");
        let destination_link = root.path().join("export.mp4");
        write_bytes(&real_source, 7, 32);
        write_bytes(&real_destination, 2, 8);
        symlink(&real_source, &source_link).expect("source symlink");
        symlink(&real_destination, &destination_link).expect("destination symlink");

        assert_eq!(
            copy_export(
                &source_link,
                &root.path().join("fresh.mp4"),
                32,
                || false,
                |_, _| Ok(())
            ),
            Err(ExportCopyError::SourceChanged)
        );
        assert_eq!(
            copy_export(&real_source, &destination_link, 32, || false, |_, _| Ok(())),
            Err(ExportCopyError::UnsafeDestination)
        );
    }

    #[test]
    fn progress_never_claims_completion_before_the_job_succeeds() {
        assert_eq!(progress_basis_points(0, 20), 0);
        assert_eq!(progress_basis_points(10, 20), 4_999);
        assert_eq!(progress_basis_points(20, 20), 9_999);
    }
}
