//! From a finished file to a durable artifact, and from a running job to a terminal one.
//!
//! The order here is the whole of the contract, and it has not changed with the engine underneath
//! it: the export's own output is copied into the artifact store under its content hash, the copy is
//! verified byte for byte before it is marked ready, the manifest is committed only after that, and
//! only then does the job become `Succeeded`. Every failure between those steps un-does the step
//! before it, so there is no state in which a half-published render is reported as a finished one.
//!
//! Cancellation is asked about between every step rather than once at the end, because a user who
//! cancels during publication has cancelled: the artifact is marked failed, the manifest stays
//! empty, and the exported file is dropped with the staging directory that holds it.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Instant;

use osg_domain::{
    AssetId, JobId, JobProgress, JobState, JobUpdate, MediaAsset, MediaKind, ProjectId,
};
use osg_infrastructure::storage::{
    ArtifactDraft, ArtifactFailureCode, ArtifactId, ArtifactKind, ArtifactRegistration,
    ContentHash, Database,
};
use tauri::ipc::Channel;

use crate::background;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};

use super::events::{RenderCompletedResult, RenderEvent, RenderPhaseResponse};
use super::export::{ExportControl, NativeExport};
use super::host::RenderRuntimeHost;
use super::manifest::{self, RenderManifestResult};
use super::progress::{
    PUBLISHING_BASIS_POINTS, RenderProgressReport, elapsed_millis, record_progress,
};
use super::refusal;

/// How much of the exported file is copied at a time.
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

/// Everything a render's terminal transition needs.
pub(super) struct Publication<'render> {
    pub(super) runtime: &'render RenderRuntimeHost,
    pub(super) database: &'render Database,
    pub(super) jobs: &'render background::DesktopJobs,
    pub(super) job_id: JobId,
    pub(super) source_asset_id: AssetId,
    pub(super) project_id: ProjectId,
    pub(super) control: &'render ExportControl,
    pub(super) channel: &'render Channel<RenderEvent>,
    pub(super) started: Instant,
}

/// Takes one finished or failed export to a terminal job state and a terminal event.
pub(super) async fn finish(publication: Publication<'_>, export: CommandResult<NativeExport>) {
    let export = match export {
        Ok(export) => export,
        Err(error) => {
            if publication.stopped_by_user().await {
                cancel(&publication).await;
            } else {
                fail(&publication, error).await;
            }
            return;
        }
    };
    if publication.stopped_by_user().await {
        export.discard();
        cancel(&publication).await;
        return;
    }
    let duration_in_frames = export.duration_in_frames();
    if let Err(error) = publication.report_publishing(duration_in_frames).await {
        export.discard();
        fail(&publication, error).await;
        return;
    }

    let manifest = match publish_artifact(&publication, export).await {
        Ok(manifest) => manifest,
        Err(error) => {
            if publication.control.is_user_cancelled() {
                cancel(&publication).await;
            } else {
                fail(&publication, error).await;
            }
            return;
        }
    };
    commit(&publication, manifest).await;
}

/// Copies the exported file into the artifact store and registers it, off the async runtime.
async fn publish_artifact(
    publication: &Publication<'_>,
    export: NativeExport,
) -> CommandResult<RenderManifestResult> {
    tauri::async_runtime::spawn_blocking({
        let database = publication.database.clone();
        let control = publication.control.clone();
        let job_id = publication.job_id;
        let source_asset_id = publication.source_asset_id;
        let project_id = publication.project_id;
        move || {
            let manifest = store(
                &database,
                job_id,
                source_asset_id,
                project_id,
                &export,
                &control,
            );
            // The exported file has either been copied or is not going to be. Either way the
            // staging directory goes now rather than at the end of the job's task, so a large
            // render does not keep two copies on disk for longer than the copy itself.
            export.discard();
            manifest
        }
    })
    .await
    .map_err(|_| CommandError::internal("The render publication task stopped unexpectedly."))
    .and_then(|result| result)
}

/// Commits the manifest, finishes the job, and hands back a playable capability.
///
/// The order is what makes a half-published render impossible: content identity and a usable
/// playback are established before the manifest is written; the manifest and playback are both
/// rolled back if finishing the job fails. A `Succeeded` job therefore always has a recoverable
/// result, and a job that is not `Succeeded` owns neither a manifest nor an unpublished playback.
async fn commit(publication: &Publication<'_>, manifest: RenderManifestResult) {
    if publication.stopped_by_user().await {
        cancel(publication).await;
        return;
    }
    let resolved =
        match manifest::validate_result(publication.database, publication.job_id, &manifest) {
            Ok(resolved) => resolved,
            Err(error) => {
                fail(publication, error).await;
                return;
            }
        };
    let playback = match publication.runtime.register_playback(&resolved) {
        Ok(playback) => playback,
        Err(error) => {
            fail(publication, error).await;
            return;
        }
    };
    if let Err(error) =
        manifest::store_result(publication.database, publication.job_id, manifest.clone())
    {
        let _ = publication.runtime.release_playback(playback.id);
        fail(publication, error).await;
        return;
    }
    let job =
        match background::apply(publication.jobs, publication.job_id, JobUpdate::Succeed).await {
            Ok(job) => job,
            Err(error) => {
                let _ = manifest::clear_result(publication.database, publication.job_id);
                let _ = publication.runtime.release_playback(playback.id);
                if publication.stopped_by_user().await {
                    cancel(publication).await;
                } else {
                    fail(publication, error).await;
                }
                return;
            }
        };
    diagnostics::record(
        "render.completed",
        &[
            ("job", publication.job_id.to_string()),
            ("elapsedMs", elapsed_millis(publication.started)),
            ("durationFrames", manifest.duration_in_frames.to_string()),
        ],
    );
    let _ = publication.channel.send(RenderEvent::Completed {
        job,
        result: RenderCompletedResult::new(manifest, playback),
    });
}

impl Publication<'_> {
    /// Whether a user, rather than the time limit or a failure, stopped this render.
    async fn stopped_by_user(&self) -> bool {
        self.control.is_user_cancelled()
            || background::snapshot(self.jobs, self.job_id)
                .await
                .is_some_and(|job| job.state() == JobState::Cancelling)
    }

    /// Moves the job to the publication step and says so once.
    async fn report_publishing(&self, duration_in_frames: u32) -> CommandResult<()> {
        let job = background::apply(
            self.jobs,
            self.job_id,
            JobUpdate::ReportProgress(
                JobProgress::from_basis_points(PUBLISHING_BASIS_POINTS)
                    .expect("publishing progress is bounded"),
            ),
        )
        .await?;
        let report = RenderProgressReport {
            phase: RenderPhaseResponse::Publishing,
            fraction_millionths: 1_000_000,
            rendered_frames: duration_in_frames,
            encoded_frames: duration_in_frames,
            duration_in_frames,
        };
        let _ = self.channel.send(RenderEvent::Progress {
            job,
            phase: report.phase,
            fraction_millionths: report.fraction_millionths,
            rendered_frames: report.rendered_frames,
            encoded_frames: report.encoded_frames,
            duration_in_frames: report.duration_in_frames,
        });
        record_progress(self.job_id, report, PUBLISHING_BASIS_POINTS, self.started);
        Ok(())
    }
}

/// Registers the exported file as a durable artifact and remembers it as media.
fn store(
    database: &Database,
    job_id: JobId,
    source_asset_id: AssetId,
    project_id: ProjectId,
    export: &NativeExport,
    control: &ExportControl,
) -> CommandResult<RenderManifestResult> {
    if control.is_cancelled() {
        return Err(refusal::cancelled());
    }
    let asset = MediaAsset::new(
        "rendered-video.mp4",
        "mp4",
        export.size_bytes(),
        MediaKind::Video,
    )
    .map_err(|_| CommandError::internal("The rendered media metadata is invalid."))?;
    let metadata = manifest::artifact_metadata(
        source_asset_id,
        project_id,
        export.width(),
        export.height(),
        export.fps(),
        export.duration_in_frames(),
    );
    let draft = ArtifactDraft::new(
        ArtifactKind::new("renderedVideo")?,
        ContentHash::from_bytes(*export.content_hash()),
        export.size_bytes(),
        metadata,
    )?
    .with_project(project_id)
    .with_job(job_id);
    let artifact_id = match database.register_artifact(&draft)? {
        ArtifactRegistration::Existing(record) => record.id(),
        ArtifactRegistration::Pending(record) => {
            return Err(
                osg_infrastructure::storage::DatabaseError::ArtifactPublicationInProgress(
                    record.id(),
                )
                .into(),
            );
        }
        ArtifactRegistration::Staging(staging) => {
            let artifact_id = staging.record().id();
            if let Err(error) = copy_artifact(
                export.path(),
                staging.path(),
                export.size_bytes(),
                export.content_hash(),
                control,
            ) {
                fail_artifact_publication(database, artifact_id);
                return Err(error);
            }
            if control.is_cancelled() {
                fail_artifact_publication(database, artifact_id);
                return Err(refusal::cancelled());
            }
            if database.mark_artifact_ready(artifact_id).is_err() {
                fail_artifact_publication(database, artifact_id);
                return Err(CommandError::render_publication_failed());
            }
            artifact_id
        }
    };
    if control.is_cancelled() {
        return Err(refusal::cancelled());
    }
    let resolved = database
        .resolve_artifact(artifact_id)?
        .ok_or_else(CommandError::render_publication_failed)?;
    if resolved.record().kind().as_str() != "renderedVideo"
        || resolved.record().job_id() != Some(job_id)
        || resolved.record().project_id() != Some(project_id)
        || resolved.record().size_bytes() != export.size_bytes()
        || resolved.record().content_hash() != ContentHash::from_bytes(*export.content_hash())
    {
        return Err(CommandError::render_publication_failed());
    }
    database.remember_media(&asset, resolved.path())?;
    Ok(RenderManifestResult {
        artifact_id: artifact_id.to_string(),
        asset,
        source_asset_id,
        project_id,
        width: export.width(),
        height: export.height(),
        fps: export.fps(),
        duration_in_frames: export.duration_in_frames(),
    })
}

/// Copies the exported file into the artifact store, proving as it goes that it is what it claims.
fn copy_artifact(
    source_path: &Path,
    destination_path: &Path,
    expected_bytes: u64,
    expected_hash: &[u8; 32],
    control: &ExportControl,
) -> CommandResult<()> {
    let mut source =
        File::open(source_path).map_err(|_| CommandError::render_publication_failed())?;
    let source_metadata = source
        .metadata()
        .map_err(|_| CommandError::render_publication_failed())?;
    if !source_metadata.is_file() || source_metadata.len() != expected_bytes {
        return Err(CommandError::render_publication_failed());
    }
    let mut destination = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(destination_path)
        .map_err(|_| CommandError::render_publication_failed())?;
    let mut copied = 0_u64;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES].into_boxed_slice();
    loop {
        if control.is_cancelled() {
            return Err(refusal::cancelled());
        }
        let count = source
            .read(&mut buffer)
            .map_err(|_| CommandError::render_publication_failed())?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(
                u64::try_from(count).map_err(|_| CommandError::render_publication_failed())?,
            )
            .filter(|copied| *copied <= expected_bytes)
            .ok_or_else(CommandError::render_publication_failed)?;
        hasher.update(&buffer[..count]);
        destination
            .write_all(&buffer[..count])
            .map_err(|_| CommandError::render_publication_failed())?;
    }
    if copied != expected_bytes || hasher.finalize().as_bytes() != expected_hash {
        return Err(CommandError::render_publication_failed());
    }
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| CommandError::render_publication_failed())?;
    destination
        .flush()
        .and_then(|()| destination.sync_all())
        .map_err(|_| CommandError::render_publication_failed())?;
    Ok(())
}

fn fail_artifact_publication(database: &Database, artifact_id: ArtifactId) {
    if let Ok(code) = ArtifactFailureCode::new("renderPublish") {
        let _ = database.mark_artifact_failed(artifact_id, &code);
    }
}

async fn cancel(publication: &Publication<'_>) {
    match background::finish_cancellation(publication.jobs, publication.job_id).await {
        Ok(job) => {
            diagnostics::record(
                "render.cancelled",
                &[
                    ("job", publication.job_id.to_string()),
                    ("elapsedMs", elapsed_millis(publication.started)),
                ],
            );
            let _ = publication.channel.send(RenderEvent::Cancelled { job });
        }
        Err(error) => {
            record_failure(publication.job_id, &error, publication.started);
            let job = background::snapshot(publication.jobs, publication.job_id).await;
            let _ = publication.channel.send(RenderEvent::Failed { job, error });
        }
    }
}

async fn fail(publication: &Publication<'_>, error: CommandError) {
    record_failure(publication.job_id, &error, publication.started);
    let job = background::finish_failure(publication.jobs, publication.job_id).await;
    let _ = publication.channel.send(RenderEvent::Failed { job, error });
}

/// One `render.failed` diagnostic: the job, how long it ran, and the refusal's code.
///
/// The code and never the message, because a code is a fixed token and this is a log.
pub(super) fn record_failure(job_id: JobId, error: &CommandError, started: Instant) {
    diagnostics::record(
        "render.failed",
        &[
            ("job", job_id.to_string()),
            ("elapsedMs", elapsed_millis(started)),
            ("code", error.code().to_owned()),
        ],
    );
}
