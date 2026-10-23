//! Download progress reporting, durable media publication and job completion.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use osg_domain::{
    AssetId, JobId, JobProgress, JobState, JobUpdate, MediaAsset, media_kind_for_extension,
};
use osg_download::{
    DownloadError, DownloadPhase, DownloadProgress, DownloadResult, DownloadSummary, ProgressSink,
};
use osg_infrastructure::storage::{
    ArtifactKind, ContentHash, Database, publish_durable_media_candidate as publish_media_artifact,
};
use tauri::{AppHandle, Manager, ipc::Channel};

use super::MAX_SUBTITLE_IPC_BYTES;
use super::errors::{
    map_download_error, record_download_command_failure, record_download_engine_failure,
};
use super::runtime::FinalizationRegistry;
use super::types::{DownloadJobEvent, DownloadProgressResponse, DownloadedSubtitleResponse};
use crate::background;
use crate::commands::MediaCandidateResponse;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

pub(super) struct DownloadProgressReporter {
    pub(super) jobs: background::DesktopJobs,
    pub(super) job_id: JobId,
    pub(super) channel: Channel<DownloadJobEvent>,
}

impl ProgressSink for DownloadProgressReporter {
    fn on_progress(&self, progress: &DownloadProgress) {
        let Ok(current) = self.jobs.get(self.job_id) else {
            return;
        };
        if current.snapshot().state().is_terminal() {
            return;
        }
        let snapshot = progress_for_job(progress)
            .filter(|candidate| {
                current.snapshot().state() == JobState::Running
                    && *candidate > current.snapshot().progress()
            })
            .and_then(|candidate| {
                self.jobs
                    .apply(self.job_id, JobUpdate::ReportProgress(candidate))
                    .ok()
            })
            .map_or_else(
                || current.snapshot().clone(),
                |ticket| ticket.snapshot().clone(),
            );
        let _ = self.channel.send(DownloadJobEvent::Progress {
            job: snapshot,
            progress: DownloadProgressResponse::from(progress),
        });
    }
}

fn progress_for_job(progress: &DownloadProgress) -> Option<JobProgress> {
    if matches!(
        progress.phase,
        DownloadPhase::DownloadFinished | DownloadPhase::PostProcessing
    ) {
        return JobProgress::from_basis_points(9_900).ok();
    }
    let (downloaded, total) = progress.downloaded_bytes.zip(progress.total_bytes)?;
    JobProgress::from_units(downloaded.min(total), total).ok()
}

pub(super) enum DownloadTaskError {
    Download(DownloadError),
    Command(CommandError),
}

pub(super) struct NativeDownloadOutput {
    pub(super) summary: DownloadSummary,
    media_path: PathBuf,
    subtitle_path: Option<PathBuf>,
    pub(super) subtitle: Option<DownloadedSubtitleResponse>,
}

impl NativeDownloadOutput {
    pub(super) fn from_result(result: &DownloadResult) -> Result<Self, DownloadError> {
        let summary = result.summary().clone();
        let subtitle_path = result.subtitle_path().map(Path::to_owned);
        let subtitle = match read_downloaded_subtitle(
            subtitle_path.as_deref(),
            summary.subtitle_filename.as_ref(),
            summary.subtitle_language.as_ref(),
        ) {
            Ok(subtitle) => subtitle,
            Err(error) => {
                remove_regular_file(result.media_path());
                if let Some(path) = result.subtitle_path() {
                    remove_regular_file(path);
                }
                if let Some(directory) = result.media_path().parent() {
                    let _ = fs::remove_dir(directory);
                }
                return Err(error);
            }
        };
        Ok(Self {
            summary,
            media_path: result.media_path().to_owned(),
            subtitle_path,
            subtitle,
        })
    }

    fn cleanup(&self) {
        remove_regular_file(&self.media_path);
        if let Some(path) = &self.subtitle_path {
            remove_regular_file(path);
        }
        if let Some(directory) = self.media_path.parent() {
            let _ = fs::remove_dir(directory);
        }
    }
}

pub(super) struct DurableMedia {
    pub(super) asset: MediaAsset,
    content_hash: ContentHash,
}

impl fmt::Debug for DurableMedia {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DurableMedia")
            .field("asset", &self.asset)
            .field("content_hash", &self.content_hash)
            .finish()
    }
}

pub(super) fn publish_durable_media(
    database: &Database,
    job_id: JobId,
    source_path: &Path,
    size_bytes: u64,
    media_filename: &str,
) -> CommandResult<DurableMedia> {
    let kind = ArtifactKind::new("downloadedMedia").map_err(|_| durable_storage_error())?;
    let asset = downloaded_media_asset(media_filename, size_bytes)?;
    let published = publish_media_artifact(
        database,
        job_id,
        kind,
        asset,
        source_path,
        serde_json::json!({
            "source": "urlDownload",
            "filename": media_filename,
        }),
    )
    .map_err(|_| durable_storage_error())?;
    Ok(DurableMedia {
        asset: published.asset().clone(),
        content_hash: published.content_hash(),
    })
}

fn durable_storage_error() -> CommandError {
    CommandError::internal("The downloaded media could not be stored durably.")
}

fn downloaded_media_asset(filename: &str, size_bytes: u64) -> CommandResult<MediaAsset> {
    let filename_path = Path::new(filename);
    if filename_path.file_name().and_then(|value| value.to_str()) != Some(filename) {
        return Err(durable_storage_error());
    }
    let extension = filename_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(durable_storage_error)?;
    let kind = media_kind_for_extension(&extension).ok_or_else(durable_storage_error)?;
    MediaAsset::new(filename, extension, size_bytes, kind).map_err(|_| durable_storage_error())
}

pub(super) fn prepare_durable_download_candidate(durable: DurableMedia) -> MediaCandidateResponse {
    MediaCandidateResponse::new(durable.asset, durable.content_hash)
}

pub(super) fn read_downloaded_subtitle(
    path: Option<&Path>,
    filename: Option<&String>,
    language: Option<&String>,
) -> Result<Option<DownloadedSubtitleResponse>, DownloadError> {
    match (path, filename, language) {
        (Some(path), Some(filename), Some(language)) => {
            let metadata =
                fs::symlink_metadata(path).map_err(|_| DownloadError::InvalidSubtitleArtifact)?;
            if !metadata.file_type().is_file() || metadata.len() == 0 {
                return Err(DownloadError::InvalidSubtitleArtifact);
            }
            if metadata.len() > MAX_SUBTITLE_IPC_BYTES {
                return Err(DownloadError::SubtitleArtifactTooLarge);
            }
            let content =
                fs::read_to_string(path).map_err(|_| DownloadError::InvalidSubtitleArtifact)?;
            Ok(Some(DownloadedSubtitleResponse {
                filename: filename.clone(),
                language: language.clone(),
                content,
            }))
        }
        (None, None, None) => Ok(None),
        _ => Err(DownloadError::InvalidSubtitleArtifact),
    }
}

impl fmt::Debug for NativeDownloadOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeDownloadOutput")
            .field("summary", &self.summary)
            .field("media_path", &"<redacted>")
            .field(
                "subtitle_path",
                &self.subtitle_path.as_ref().map(|_| "<redacted>"),
            )
            .field("subtitle", &self.subtitle)
            .finish()
    }
}

pub(super) async fn finish_download(
    app: &AppHandle,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    result: Result<NativeDownloadOutput, DownloadTaskError>,
    channel: &Channel<DownloadJobEvent>,
    finalizing: &Arc<FinalizationRegistry>,
) {
    match result {
        Ok(output) => {
            let _finalization = match finalizing.begin(job_id) {
                Ok(finalization) => finalization,
                Err(error) => {
                    output.cleanup();
                    fail_download(jobs, job_id, error, channel).await;
                    return;
                }
            };
            if background::snapshot(jobs, job_id)
                .await
                .is_some_and(|job| job.state() == JobState::Cancelling)
            {
                output.cleanup();
                cancel_download(jobs, job_id, channel).await;
                return;
            }
            let state = app.state::<DesktopState>();
            let database = state.database.clone();
            let publication_database = database.clone();
            let source_path = output.media_path.clone();
            let size_bytes = output.summary.media_bytes;
            let media_filename = output.summary.media_filename.clone();
            let durable = tauri::async_runtime::spawn_blocking(move || {
                publish_durable_media(
                    &publication_database,
                    job_id,
                    &source_path,
                    size_bytes,
                    &media_filename,
                )
            })
            .await
            .map_err(|_| durable_storage_error())
            .and_then(|result| result);
            let durable = match durable {
                Ok(durable) => durable,
                Err(error) => {
                    output.cleanup();
                    fail_download(jobs, job_id, error, channel).await;
                    return;
                }
            };
            let media = prepare_durable_download_candidate(durable);
            let candidate_id = media.asset().id();
            output.cleanup();
            match background::apply(jobs, job_id, JobUpdate::Succeed).await {
                Ok(job) => {
                    diagnostics::record("download.completed", &[("job", job_id.to_string())]);
                    if channel
                        .send(DownloadJobEvent::Completed {
                            job,
                            media: Box::new(media),
                            summary: output.summary,
                            subtitle: output.subtitle,
                        })
                        .is_err()
                    {
                        discard_unclaimed_download_candidate(database, job_id, candidate_id).await;
                    }
                }
                Err(error) => {
                    // The job has to reach its terminal state before the candidate is released.
                    // A candidate published under this job stays claimed while the job is still
                    // queued, running, or cancelling, so discarding first would silently keep the
                    // downloaded bytes on disk and report a non-terminal job to the WebView.
                    let job = background::finish_failure(jobs, job_id).await;
                    discard_unclaimed_download_candidate(database, job_id, candidate_id).await;
                    let _ = channel.send(DownloadJobEvent::Failed { job, error });
                }
            }
        }
        Err(DownloadTaskError::Download(DownloadError::Cancelled)) => {
            cancel_download(jobs, job_id, channel).await;
        }
        Err(DownloadTaskError::Download(error)) => {
            let cancelled = background::snapshot(jobs, job_id)
                .await
                .is_some_and(|job| job.state() == JobState::Cancelling);
            if cancelled {
                cancel_download(jobs, job_id, channel).await;
            } else {
                record_download_engine_failure(job_id, &error);
                fail_download(jobs, job_id, map_download_error(&error), channel).await;
            }
        }
        Err(DownloadTaskError::Command(error)) => {
            record_download_command_failure(job_id, &error);
            fail_download(jobs, job_id, error, channel).await;
        }
    }
}

/// Releases a downloaded candidate the `WebView` never took ownership of.
///
/// Callers must have driven the owning job to a terminal state first: the storage layer keeps a
/// candidate claimed while its job is still live. A discard that removes nothing therefore means
/// the downloaded bytes stay on disk until reconciliation reaps them, which is worth recording.
async fn discard_unclaimed_download_candidate(
    database: Database,
    job_id: JobId,
    candidate_id: AssetId,
) {
    let discarded = tauri::async_runtime::spawn_blocking(move || {
        database.discard_media_candidate(candidate_id)
    })
    .await;
    if !matches!(discarded, Ok(Ok(true))) {
        diagnostics::record(
            "download.candidate-retained",
            &[("job", job_id.to_string())],
        );
    }
}

pub(super) fn remove_regular_file(path: &Path) {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file()) {
        let _ = fs::remove_file(path);
    }
}

async fn cancel_download(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    channel: &Channel<DownloadJobEvent>,
) {
    match background::finish_cancellation(jobs, job_id).await {
        Ok(job) => {
            diagnostics::record("download.cancelled", &[("job", job_id.to_string())]);
            let _ = channel.send(DownloadJobEvent::Cancelled { job });
        }
        Err(error) => {
            let job = background::snapshot(jobs, job_id).await;
            let _ = channel.send(DownloadJobEvent::Failed { job, error });
        }
    }
}

async fn fail_download(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    error: CommandError,
    channel: &Channel<DownloadJobEvent>,
) {
    diagnostics::record(
        "download.failed",
        &[
            ("job", job_id.to_string()),
            ("code", error.code().to_owned()),
        ],
    );
    let job = background::finish_failure(jobs, job_id).await;
    let _ = channel.send(DownloadJobEvent::Failed { job, error });
}
