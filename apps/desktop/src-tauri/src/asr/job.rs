//! ASR job execution: media range extraction, worker run and result publication.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use osg_asr::{
    CancellationToken as AsrCancellationToken, RunControl as AsrRunControl, Transcription,
    TranscriptionOptions, TranscriptionRequest,
};
use osg_domain::{JobId, JobState};
use osg_infrastructure::storage::{JobResultDeliveryDraft, JobResultKind};
use osg_media::{
    AudioExtractionPlan, CancellationToken as MediaCancellationToken, MediaEngine, MediaInput,
    MediaOperation, MediaOutput, MediaTimeRange, ProgressSink as MediaProgressSink,
    RunControl as MediaRunControl,
};
use serde_json::json;
use tauri::ipc::Channel;

use super::request::{AsrJobEvent, AsrJobPhase, RequestedRange};
use super::runtime::{AsrRuntimeManager, ManagedAsrService};
use super::{ASR_TIMEOUT, MAX_TRANSCRIPTION_RANGE_MS, MEDIA_TIMEOUT, RANGE_DURATION_TOLERANCE_US};
use crate::background;
use crate::error::{CommandError, CommandResult};

pub(super) struct AsrExecution {
    pub(super) manager: AsrRuntimeManager,
    pub(super) media_engine: MediaEngine,
    pub(super) input: MediaInput,
    pub(super) service: ManagedAsrService,
    pub(super) options: TranscriptionOptions,
    pub(super) requested_range: Option<RequestedRange>,
    pub(super) media_cancellation: MediaCancellationToken,
    pub(super) asr_cancellation: AsrCancellationToken,
    pub(super) channel: Channel<AsrJobEvent>,
    pub(super) channel_closed: Arc<AtomicBool>,
    pub(super) job_id: JobId,
}

pub(super) async fn run_asr_job(execution: AsrExecution) -> CommandResult<Transcription> {
    tauri::async_runtime::spawn_blocking(move || run_asr_job_blocking(execution))
        .await
        .map_err(|_| CommandError::internal("the ASR task stopped unexpectedly"))?
}

fn run_asr_job_blocking(execution: AsrExecution) -> CommandResult<Transcription> {
    let AsrExecution {
        manager,
        media_engine,
        input,
        service,
        options,
        requested_range,
        media_cancellation,
        asr_cancellation,
        channel,
        channel_closed,
        job_id,
    } = execution;
    send_progress(
        &channel,
        &channel_closed,
        &media_cancellation,
        &asr_cancellation,
        job_id,
        AsrJobPhase::PreparingAudio,
        None,
    );
    let work = manager
        .work_directory()
        .map_err(|_| CommandError::internal("the private ASR working directory is unavailable"))?;
    let metadata = media_engine.probe(
        &input,
        &MediaRunControl::new(Duration::from_secs(30))?
            .with_cancellation(media_cancellation.clone()),
    )?;
    let range = resolve_media_range(metadata.duration_us(), requested_range)?;
    let output_path = work.path().join("normalized.wav");
    let output = MediaOutput::within_root(&output_path, work.path())?;
    let operation =
        MediaOperation::AudioExtraction(AudioExtractionPlan::asr_wav(input, output, range)?);
    let media_channel = channel.clone();
    let media_closed = Arc::clone(&channel_closed);
    let media_cancel_on_close = media_cancellation.clone();
    let asr_cancel_on_close = asr_cancellation.clone();
    let progress = MediaProgressSink::new(move |progress| {
        send_progress(
            &media_channel,
            &media_closed,
            &media_cancel_on_close,
            &asr_cancel_on_close,
            job_id,
            AsrJobPhase::PreparingAudio,
            progress.fraction,
        );
    });
    let media_control = MediaRunControl::new(MEDIA_TIMEOUT)?
        .with_cancellation(media_cancellation)
        .with_progress(progress);
    media_engine.execute(&operation, &media_control)?;
    let audio = osg_asr::NormalizedAudio::open(&output_path)?;
    let asr_channel = channel.clone();
    let asr_closed = Arc::clone(&channel_closed);
    let asr_cancel_on_close = asr_cancellation.clone();
    let media_cancel_on_close = media_control.cancellation();
    let asr_control = AsrRunControl::new(ASR_TIMEOUT)?
        .with_cancellation(asr_cancellation)
        .with_progress(move |progress: &osg_asr::AsrProgress| {
            send_progress(
                &asr_channel,
                &asr_closed,
                &media_cancel_on_close,
                &asr_cancel_on_close,
                job_id,
                progress.phase.into(),
                None,
            );
        });
    service
        .transcribe(&TranscriptionRequest::new(audio, options), &asr_control)
        .map_err(Into::into)
}

pub(super) fn send_progress(
    channel: &Channel<AsrJobEvent>,
    channel_closed: &AtomicBool,
    _media_cancellation: &MediaCancellationToken,
    _asr_cancellation: &AsrCancellationToken,
    job_id: JobId,
    phase: AsrJobPhase,
    fraction: Option<f64>,
) {
    if channel_closed.load(Ordering::Acquire) {
        return;
    }
    if channel
        .send(AsrJobEvent::Progress {
            job_id,
            phase,
            fraction,
        })
        .is_err()
    {
        channel_closed.store(true, Ordering::Release);
    }
}

pub(super) fn resolve_media_range(
    media_duration_us: Option<u64>,
    requested: Option<RequestedRange>,
) -> CommandResult<MediaTimeRange> {
    let media_duration_us = media_duration_us
        .filter(|duration| *duration > 0)
        .ok_or_else(|| {
            CommandError::invalid_input("The selected media duration could not be determined.")
        })?;
    let (start_us, end_us) = if let Some(requested) = requested {
        if requested.start_us >= media_duration_us
            || requested.end_us > media_duration_us.saturating_add(RANGE_DURATION_TOLERANCE_US)
        {
            return Err(CommandError::invalid_input(
                "The requested ASR range is outside the selected media.",
            ));
        }
        (requested.start_us, requested.end_us.min(media_duration_us))
    } else {
        (0, media_duration_us)
    };
    let duration_us = end_us
        .checked_sub(start_us)
        .filter(|value| *value > 0)
        .ok_or_else(|| CommandError::invalid_input("The requested ASR range is empty."))?;
    if duration_us > MAX_TRANSCRIPTION_RANGE_MS * 1_000 {
        return Err(CommandError::invalid_input(
            "The ASR time range cannot exceed 24 hours.",
        ));
    }
    MediaTimeRange::new(start_us, Some(duration_us)).map_err(Into::into)
}

pub(super) async fn finish_asr(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    result: CommandResult<Transcription>,
    timeline_offset_ms: u64,
    asset_id: osg_domain::AssetId,
    channel: &Channel<AsrJobEvent>,
) {
    let runtime_cancelled = result
        .as_ref()
        .is_err_and(|error| error.code() == "asrCancelled");
    match result {
        Ok(transcription) => {
            let delivery = JobResultDeliveryDraft::new(
                job_id,
                JobResultKind::AsrTranscription,
                None,
                Some(asset_id),
                &json!({
                    "schemaVersion": 1,
                    "transcription": &transcription,
                    "timelineOffsetMs": timeline_offset_ms,
                }),
            );
            let delivery = match delivery {
                Ok(delivery) => delivery,
                Err(error) => {
                    let error = CommandError::from(error);
                    let job = background::finish_failure(jobs, job_id).await;
                    let _ = channel.send(AsrJobEvent::Failed { job, error });
                    return;
                }
            };
            let delivery_id = delivery.delivery_id();
            match background::succeed_with_result(jobs, job_id, delivery).await {
                Ok(job) => {
                    let _ = channel.send(AsrJobEvent::Completed {
                        job,
                        delivery_id,
                        transcription,
                        timeline_offset_ms,
                    });
                }
                Err(error) => {
                    let job = background::snapshot(jobs, job_id).await;
                    let _ = channel.send(AsrJobEvent::Failed { job, error });
                }
            }
        }
        result => {
            let cancelled = runtime_cancelled
                || background::snapshot(jobs, job_id)
                    .await
                    .is_some_and(|job| matches!(job.state(), JobState::Cancelling));
            if cancelled {
                match background::finish_cancellation(jobs, job_id).await {
                    Ok(job) => {
                        let _ = channel.send(AsrJobEvent::Cancelled { job });
                    }
                    Err(error) => {
                        let job = background::snapshot(jobs, job_id).await;
                        let _ = channel.send(AsrJobEvent::Failed { job, error });
                    }
                }
            } else {
                let error = result
                    .err()
                    .unwrap_or_else(|| CommandError::internal("the ASR job produced no result"));
                let job = background::finish_failure(jobs, job_id).await;
                let _ = channel.send(AsrJobEvent::Failed { job, error });
            }
        }
    }
}
