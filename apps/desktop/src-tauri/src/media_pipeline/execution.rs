//! Operation execution, progress reporting, artifact publication and terminal outcomes.

use osg_domain::{
    AssetId, JobId, JobProgress, JobState, JobUpdate, MediaAsset, media_kind_for_extension,
};
use osg_infrastructure::storage::{ArtifactKind, Database, publish_durable_media};
use osg_media::{
    CompatibilityDecision, FfmpegProgress, MediaInput, ProgressSink, RunControl, WaveformPyramid,
};
use osg_media_pipeline::{MediaInspection, MediaPipeline, PreparationOutcome, PreparedMedia};
use tauri::ipc::Channel;

use super::request::{
    MediaDescriptor, MediaInspectionResponse, MediaPipelineEvent, MediaPipelineOperation,
    MediaPipelinePhase, MediaPipelineResult, ValidatedOperation,
};
use super::runtime::MediaPipelineRuntime;
use super::{PROCESSING_END_BASIS_POINTS, PROCESSING_START_BASIS_POINTS, PUBLISHING_BASIS_POINTS};
use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::waveform_cache::{self, WaveformCacheSpec};

pub(super) enum NativeOperationResult {
    Direct(MediaInspection),
    Prepared(PreparedMedia),
    Waveform {
        waveform: WaveformPyramid,
        cache_hit: bool,
        cache_spec: WaveformCacheSpec,
    },
}

pub(super) struct PublicationContext {
    pub(super) job_id: JobId,
    pub(super) operation: MediaPipelineOperation,
    pub(super) source_asset_id: AssetId,
    pub(super) metadata: serde_json::Value,
}

pub(super) fn execute_operation(
    pipeline: &MediaPipeline,
    input: MediaInput,
    operation: &ValidatedOperation,
    control: &RunControl,
    database: &Database,
    source_content_hash: osg_infrastructure::storage::ContentHash,
) -> CommandResult<NativeOperationResult> {
    match operation {
        ValidatedOperation::PreparePlayback => pipeline
            .prepare_playback(input, control)
            .map(|outcome| match outcome {
                PreparationOutcome::Direct(inspection) => NativeOperationResult::Direct(inspection),
                PreparationOutcome::Prepared(prepared) => NativeOperationResult::Prepared(prepared),
            })
            .map_err(Into::into),
        ValidatedOperation::AnalysisClip { range } => pipeline
            .clip_for_analysis(input, *range, control)
            .map(NativeOperationResult::Prepared)
            .map_err(Into::into),
        ValidatedOperation::ExtractAudio { format, range } => pipeline
            .extract_audio(input, *format, *range, control)
            .map(NativeOperationResult::Prepared)
            .map_err(Into::into),
        ValidatedOperation::GenerateWaveform {
            points_per_second,
            max_points,
            range,
        } => {
            let spec = WaveformCacheSpec::new(
                source_content_hash,
                *points_per_second,
                *max_points,
                *range,
            );
            if let Some(hit) = waveform_cache::lookup(database, spec)? {
                return Ok(NativeOperationResult::Waveform {
                    waveform: hit.waveform,
                    cache_hit: hit.cache_hit,
                    cache_spec: spec,
                });
            }
            let generated = pipeline.generate_waveform(
                input,
                *points_per_second,
                *max_points,
                *range,
                control,
            )?;
            Ok(NativeOperationResult::Waveform {
                waveform: generated.waveform,
                cache_hit: false,
                cache_spec: spec,
            })
        }
    }
}

pub(super) fn progress_sink(
    jobs: background::DesktopJobs,
    job_id: JobId,
    operation: MediaPipelineOperation,
    channel: Channel<MediaPipelineEvent>,
) -> ProgressSink {
    ProgressSink::new(move |progress| {
        report_processing_progress(&jobs, job_id, operation, &channel, &progress);
    })
}

fn report_processing_progress(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    operation: MediaPipelineOperation,
    channel: &Channel<MediaPipelineEvent>,
    progress: &FfmpegProgress,
) {
    let Ok(current) = jobs.get(job_id) else {
        return;
    };
    if current.snapshot().state() != JobState::Running {
        return;
    }
    let fraction = progress
        .fraction
        .filter(|fraction| fraction.is_finite())
        .map(|fraction| fraction.clamp(0.0, 1.0));
    let snapshot = fraction
        .and_then(processing_job_progress)
        .filter(|candidate| *candidate > current.snapshot().progress())
        .and_then(|candidate| {
            jobs.apply(job_id, JobUpdate::ReportProgress(candidate))
                .ok()
        })
        .map_or_else(
            || current.snapshot().clone(),
            |ticket| ticket.snapshot().clone(),
        );
    let _ = channel.send(MediaPipelineEvent::Progress {
        job: snapshot,
        operation,
        phase: MediaPipelinePhase::Processing,
        fraction,
    });
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the finite fraction is clamped to 0..=1 before conversion"
)]
pub(super) fn processing_job_progress(fraction: f64) -> Option<JobProgress> {
    let processing_span = PROCESSING_END_BASIS_POINTS - PROCESSING_START_BASIS_POINTS;
    let scaled = (fraction * f64::from(processing_span)).round() as u16;
    JobProgress::from_basis_points(PROCESSING_START_BASIS_POINTS + scaled).ok()
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn finish_operation(
    runtime: &MediaPipelineRuntime,
    database: &Database,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    operation: MediaPipelineOperation,
    source_asset_id: AssetId,
    source: osg_infrastructure::storage::ResolvedMedia,
    publication_metadata: serde_json::Value,
    result: CommandResult<NativeOperationResult>,
    channel: &Channel<MediaPipelineEvent>,
) {
    let native = match result {
        Ok(native) => native,
        Err(error) => {
            if background::snapshot(jobs, job_id)
                .await
                .is_some_and(|job| job.state() == JobState::Cancelling)
            {
                cancel_operation(jobs, job_id, operation, channel).await;
            } else {
                fail_operation(jobs, job_id, operation, error, channel).await;
            }
            return;
        }
    };
    let _finalization = match runtime.jobs.begin_finalization(job_id) {
        Ok(finalization) => finalization,
        Err(error) => {
            fail_operation(jobs, job_id, operation, error, channel).await;
            return;
        }
    };
    if background::snapshot(jobs, job_id)
        .await
        .is_some_and(|job| job.state() == JobState::Cancelling)
    {
        cancel_operation(jobs, job_id, operation, channel).await;
        return;
    }
    let publishing = match background::apply(
        jobs,
        job_id,
        JobUpdate::ReportProgress(
            JobProgress::from_basis_points(PUBLISHING_BASIS_POINTS)
                .expect("publishing progress is bounded"),
        ),
    )
    .await
    {
        Ok(job) => job,
        Err(error) => {
            fail_operation(jobs, job_id, operation, error, channel).await;
            return;
        }
    };
    let _ = channel.send(MediaPipelineEvent::Progress {
        job: publishing,
        operation,
        phase: MediaPipelinePhase::Publishing,
        fraction: None,
    });
    let runtime = runtime.clone();
    let database = database.clone();
    let context = PublicationContext {
        job_id,
        operation,
        source_asset_id,
        metadata: publication_metadata,
    };
    let finalized = tauri::async_runtime::spawn_blocking(move || {
        finalize_native_result(&runtime, &database, context, &source, native)
    })
    .await
    .map_err(|_| CommandError::internal("The media publication task stopped unexpectedly."))
    .and_then(|result| result);
    match finalized {
        Ok(result) => match background::apply(jobs, job_id, JobUpdate::Succeed).await {
            Ok(job) => {
                let _ = channel.send(MediaPipelineEvent::Completed {
                    job,
                    operation,
                    result: Box::new(result),
                });
            }
            Err(error) => {
                let job = background::snapshot(jobs, job_id).await;
                let _ = channel.send(MediaPipelineEvent::Failed {
                    job,
                    operation,
                    error,
                });
            }
        },
        Err(error) => fail_operation(jobs, job_id, operation, error, channel).await,
    }
}

fn finalize_native_result(
    runtime: &MediaPipelineRuntime,
    database: &Database,
    context: PublicationContext,
    source: &osg_infrastructure::storage::ResolvedMedia,
    native: NativeOperationResult,
) -> CommandResult<MediaPipelineResult> {
    let PublicationContext {
        job_id,
        operation,
        source_asset_id,
        metadata,
    } = context;
    match native {
        NativeOperationResult::Direct(inspection) => {
            let asset = source.asset().clone();
            let playback = runtime.register_playback(&asset, source.path())?;
            Ok(MediaPipelineResult::Media {
                inspection: Box::new(MediaInspectionResponse::from_inspection(
                    asset.id(),
                    &inspection,
                )),
                media: Box::new(MediaDescriptor { asset, playback }),
            })
        }
        NativeOperationResult::Prepared(prepared) => {
            let extension = prepared.extension();
            let kind = media_kind_for_extension(extension).ok_or_else(|| {
                CommandError::internal("The prepared media extension is unsupported.")
            })?;
            let display_name = prepared_display_name(operation, extension);
            let size_bytes = prepared.report().output_bytes;
            let asset = MediaAsset::new(display_name, extension, size_bytes, kind)
                .map_err(|_| CommandError::internal("The prepared media metadata is invalid."))?;
            if matches!(
                operation,
                MediaPipelineOperation::AnalysisClip | MediaPipelineOperation::ExtractAudio
            ) && asset.id() == source_asset_id
            {
                return Err(CommandError::internal(
                    "The derived media did not receive a fresh identity.",
                ));
            }
            let artifact_kind = ArtifactKind::new(artifact_kind(operation))?;
            let published = publish_durable_media(
                database,
                job_id,
                artifact_kind,
                asset,
                prepared.path(),
                metadata,
            )?;
            let playback = runtime.register_playback(published.asset(), published.path())?;
            let inspection = MediaInspection {
                metadata: prepared.metadata().clone(),
                compatibility: CompatibilityDecision::analyze(
                    prepared.metadata(),
                    osg_media::CompatibilityProfile::PortableWebView,
                ),
            };
            Ok(MediaPipelineResult::Media {
                inspection: Box::new(MediaInspectionResponse::from_inspection(
                    published.asset().id(),
                    &inspection,
                )),
                media: Box::new(MediaDescriptor {
                    asset: published.asset().clone(),
                    playback,
                }),
            })
        }
        NativeOperationResult::Waveform {
            waveform,
            cache_hit,
            cache_spec,
        } => {
            // The cache key was derived from the verified source handle before FFmpeg or the cache
            // reader ran. Revalidate that same handle at publication so an in-place source change
            // cannot store or return pixels under the prior content identity.
            source.revalidate_verified_file()?;
            finalize_waveform_result(
                source_asset_id,
                job_id,
                waveform,
                cache_hit,
                cache_spec,
                |waveform| waveform_cache::publish(database, cache_spec, waveform),
            )
        }
    }
}

pub(super) fn finalize_waveform_result(
    source_asset_id: AssetId,
    job_id: JobId,
    waveform: WaveformPyramid,
    cache_hit: bool,
    cache_spec: WaveformCacheSpec,
    publish_cache: impl FnOnce(&WaveformPyramid) -> CommandResult<()>,
) -> CommandResult<MediaPipelineResult> {
    // IPC validity is not optional: only a storage failure after semantic validation may degrade
    // to an uncached result. This keeps a full or read-only cache from breaking the editor without
    // ever allowing malformed generated data to cross the native boundary.
    waveform_cache::validate_for_ipc(&waveform, cache_spec)?;
    if !cache_hit && let Err(error) = publish_cache(&waveform) {
        crate::diagnostics::record(
            "waveform.cache_publish_failed",
            &[
                ("job", job_id.to_string()),
                ("reason", error.code().to_owned()),
            ],
        );
    }
    Ok(MediaPipelineResult::Waveform {
        asset_id: source_asset_id,
        cache_hit,
        waveform: Box::new(waveform),
    })
}

fn prepared_display_name(operation: MediaPipelineOperation, extension: &str) -> String {
    let stem = match operation {
        MediaPipelineOperation::PreparePlayback => "prepared-media",
        MediaPipelineOperation::AnalysisClip => "analysis-clip",
        MediaPipelineOperation::ExtractAudio => "extracted-audio",
        MediaPipelineOperation::GenerateWaveform => "waveform",
    };
    format!("{stem}.{extension}")
}

const fn artifact_kind(operation: MediaPipelineOperation) -> &'static str {
    match operation {
        MediaPipelineOperation::PreparePlayback => "preparedMedia",
        MediaPipelineOperation::AnalysisClip => "analysisClip",
        MediaPipelineOperation::ExtractAudio => "extractedAudio",
        MediaPipelineOperation::GenerateWaveform => "waveform",
    }
}

async fn cancel_operation(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    operation: MediaPipelineOperation,
    channel: &Channel<MediaPipelineEvent>,
) {
    match background::finish_cancellation(jobs, job_id).await {
        Ok(job) => {
            let _ = channel.send(MediaPipelineEvent::Cancelled { job, operation });
        }
        Err(error) => {
            let job = background::snapshot(jobs, job_id).await;
            let _ = channel.send(MediaPipelineEvent::Failed {
                job,
                operation,
                error,
            });
        }
    }
}

pub(super) async fn fail_operation(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    operation: MediaPipelineOperation,
    error: CommandError,
    channel: &Channel<MediaPipelineEvent>,
) {
    let job = background::finish_failure(jobs, job_id).await;
    let _ = channel.send(MediaPipelineEvent::Failed {
        job,
        operation,
        error,
    });
}
