//! Batch synthesis: worker resolution, per-segment synthesis and progress.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::future::join_all;
use osg_domain::{JobId, JobProgress};
use osg_infrastructure::secrets::{CredentialId, CredentialPurpose};
use osg_infrastructure::storage::Database;
use osg_runtime_staging::OwnedStagingDirectory;
use osg_speech::{
    AudioAsset, AudioFormat, CancellationToken, ReferencePreparationPlan, RunControl, SecretValue,
    SpeechError, SpeechOutput, SpeechProgress, SynthesisRequest, TimeMicros,
};
use secrecy::ExposeSecret;

use super::artifacts::{SpeechArtifactMetadata, commit_completed_speech_source};
use super::jobs::{
    SpeechFailureCode, SpeechJobEvent, StoredSpeechResult, batch_terminal_failure,
    failure_marks_backend_unhealthy, speech_failure, synthesize_with_retry,
};
use super::lifecycle::{
    SpeechBatchContext, SpeechLifecycleOwnership, resolve_prepared_batch_workers,
    worker_join_result,
};
use super::requests::{SpeechBackendRequest, ValidatedSpeechStart};
use super::runtime::{ManagedSpeechWorker, SpeechRuntime};
use super::{MAX_F5_REFERENCE_MS, REFERENCE_PREPARE_TIMEOUT, SPEECH_TIMEOUT};
use crate::background;
use crate::diagnostics;

#[expect(
    clippy::too_many_lines,
    reason = "the batch coordinator keeps lifecycle checks, durable publication, and its one concurrency receipt in one auditable order"
)]
pub(super) async fn run_speech_batch(
    context: &SpeechBatchContext<'_>,
    mut validated: ValidatedSpeechStart,
    ownership: SpeechLifecycleOwnership,
) -> Result<Vec<StoredSpeechResult>, SpeechFailureCode> {
    ownership.ensure_owned(context.runtime, context.database)?;
    let work = context
        .runtime
        .work_directory()
        .map_err(|_| SpeechFailureCode::RuntimeUnavailable)?;
    let workers = match resolve_prepared_batch_workers(
        context,
        &mut validated,
        &work,
        &ownership.cancellation,
    )
    .await
    {
        Ok(worker) => worker,
        Err(code) => {
            if failure_marks_backend_unhealthy(code) {
                let _ = context
                    .runtime
                    .invalidate_backend_runtime(validated.backend, Some(validated.lifecycle_epoch));
            }
            return Err(code);
        }
    };
    ownership.ensure_owned(context.runtime, context.database)?;

    let total = validated.requests.len();
    let mut results = Vec::with_capacity(total);
    let requests = validated.requests;
    let concurrency = SynthesisConcurrencyProbe::default();
    for batch in requests.chunks(validated.max_concurrency) {
        ownership.ensure_owned(context.runtime, context.database)?;
        let batch_start = results.len();
        let prepared = join_all(batch.iter().cloned().enumerate().map(|(offset, request)| {
            let index = batch_start + offset + 1;
            let worker = &workers[(index - 1) % workers.len()];
            synthesize_segment(
                context,
                &work,
                worker,
                request,
                ownership.clone(),
                SegmentRun {
                    backend: validated.backend,
                    lifecycle_epoch: validated.lifecycle_epoch,
                    index,
                    total,
                },
                concurrency.clone(),
            )
        }))
        .await;
        for (offset, prepared) in prepared.into_iter().enumerate() {
            let index = batch_start + offset + 1;
            let prepared = prepared?;
            let (stored, invalidate_backend) = match prepared {
                PreparedSegmentResult::Completed(stored) => (stored, false),
                PreparedSegmentResult::Failed {
                    result,
                    invalidate_backend,
                } => {
                    commit_failed_segment(context, &ownership, result.clone(), index, total)
                        .await?;
                    (result, invalidate_backend)
                }
            };
            let terminal_failure = match &stored {
                StoredSpeechResult::Failed { code, .. } if batch_terminal_failure(*code) => {
                    Some(*code)
                }
                _ => None,
            };
            results.push(stored);
            if let Some(code) = terminal_failure {
                if invalidate_backend {
                    let _ = context.runtime.invalidate_backend_runtime(
                        validated.backend,
                        Some(validated.lifecycle_epoch),
                    );
                }
                record_speech_concurrency(
                    context.job_id,
                    validated.backend,
                    validated.max_concurrency,
                    workers.len(),
                    concurrency.peak(),
                );
                return Err(code);
            }
            report_batch_progress(
                context.runtime,
                &ownership,
                context.database,
                context.jobs,
                context.job_id,
                results.len(),
                total,
            )
            .await?;
        }
    }
    if results
        .iter()
        .all(|result| matches!(result, StoredSpeechResult::Failed { .. }))
    {
        record_speech_concurrency(
            context.job_id,
            validated.backend,
            validated.max_concurrency,
            workers.len(),
            concurrency.peak(),
        );
        Err(SpeechFailureCode::SynthesisFailed)
    } else {
        record_speech_concurrency(
            context.job_id,
            validated.backend,
            validated.max_concurrency,
            workers.len(),
            concurrency.peak(),
        );
        Ok(results)
    }
}

fn record_speech_concurrency(
    job_id: JobId,
    backend: SpeechBackendRequest,
    configured: usize,
    workers: usize,
    observed_peak: usize,
) {
    diagnostics::record(
        "speech.concurrency_observed",
        &[
            ("job", job_id.to_string()),
            ("backend", format!("{backend:?}")),
            ("configured", configured.to_string()),
            ("workers", workers.to_string()),
            ("observedPeak", observed_peak.to_string()),
        ],
    );
}

#[derive(Clone, Copy)]
pub(super) struct SegmentRun {
    pub(super) backend: SpeechBackendRequest,
    pub(super) lifecycle_epoch: u64,
    pub(super) index: usize,
    pub(super) total: usize,
}

#[derive(Clone, Default)]
pub(super) struct SynthesisConcurrencyProbe {
    pub(super) active: Arc<AtomicUsize>,
    pub(super) peak: Arc<AtomicUsize>,
}

impl SynthesisConcurrencyProbe {
    pub(super) fn enter(&self) -> ActiveSynthesisGuard {
        let active = self.active.fetch_add(1, Ordering::AcqRel) + 1;
        self.peak.fetch_max(active, Ordering::AcqRel);
        ActiveSynthesisGuard {
            active: Arc::clone(&self.active),
        }
    }

    pub(super) fn peak(&self) -> usize {
        self.peak.load(Ordering::Acquire)
    }
}

pub(super) struct ActiveSynthesisGuard {
    pub(super) active: Arc<AtomicUsize>,
}

impl Drop for ActiveSynthesisGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) enum PreparedSegmentResult {
    Completed(StoredSpeechResult),
    Failed {
        result: StoredSpeechResult,
        invalidate_backend: bool,
    },
}

pub(super) async fn resolve_batch_workers(
    context: &SpeechBatchContext<'_>,
    backend: SpeechBackendRequest,
    lifecycle_epoch: u64,
    credential_ids: &[CredentialId],
) -> Result<Vec<Arc<ManagedSpeechWorker>>, SpeechFailureCode> {
    if credential_ids.is_empty() {
        let runtime = context.runtime.clone();
        let joined = tauri::async_runtime::spawn_blocking(move || {
            runtime.enabled_worker_for_epoch(backend, lifecycle_epoch)
        })
        .await;
        let worker = worker_join_result(context.runtime, backend, lifecycle_epoch, joined)?
            .map_err(|error| speech_failure(&error).0)?;
        return Ok(vec![worker]);
    }

    let mut workers = Vec::with_capacity(credential_ids.len());
    for credential_id in credential_ids.iter().copied() {
        let credentials = context.credentials.clone();
        let joined = tauri::async_runtime::spawn_blocking(move || {
            credentials.resolve(credential_id, CredentialPurpose::GeminiApiKey)
        })
        .await;
        let secret = worker_join_result(context.runtime, backend, lifecycle_epoch, joined)?
            .map_err(|_| SpeechFailureCode::AuthenticationFailed)?;
        let secret = SecretValue::new(secret.expose_secret().to_owned())
            .map_err(|_| SpeechFailureCode::AuthenticationFailed)?;
        let runtime = context.runtime.clone();
        let joined = tauri::async_runtime::spawn_blocking(move || {
            runtime.provider_worker_for_epoch(backend, lifecycle_epoch, secret)
        })
        .await;
        workers.push(
            worker_join_result(context.runtime, backend, lifecycle_epoch, joined)?
                .map_err(|error| speech_failure(&error).0)?,
        );
    }
    Ok(workers)
}

pub(super) async fn prepare_f5_requests(
    worker: &Arc<ManagedSpeechWorker>,
    work: &OwnedStagingDirectory,
    requests: Vec<SynthesisRequest>,
    reference: AudioAsset,
    cancellation: CancellationToken,
) -> Result<Vec<SynthesisRequest>, SpeechFailureCode> {
    let plan = ReferencePreparationPlan::for_f5(reference)
        .with_segment(
            TimeMicros::ZERO,
            TimeMicros::from_millis(MAX_F5_REFERENCE_MS)
                .map_err(|error| speech_failure(&error).0)?,
        )
        .map_err(|error| speech_failure(&error).0)?;
    let output = SpeechOutput::within_root(
        work.path(),
        work.path(),
        "prepared-reference",
        AudioFormat::Wav,
    )
    .map_err(|error| speech_failure(&error).0)?;
    let prepare_worker = Arc::clone(worker);
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let control = RunControl::new(REFERENCE_PREPARE_TIMEOUT)?.with_cancellation(cancellation);
        prepare_worker.prepare_reference(&plan, &output, &control)
    })
    .await
    .map_err(|_| SpeechFailureCode::WorkerFailed)?
    .map_err(|error| speech_failure(&error).0)?;
    let prepared_asset = AudioAsset::from_native_file(prepared.native_path())
        .map_err(|error| speech_failure(&error).0)?;
    requests
        .into_iter()
        .map(|request| {
            SynthesisRequest::new(
                request.segment_id().clone(),
                request.text().clone(),
                request.settings().clone(),
                Some(prepared_asset.clone()),
            )
            .map_err(|error| speech_failure(&error).0)
        })
        .collect()
}

async fn synthesize_segment(
    context: &SpeechBatchContext<'_>,
    work: &OwnedStagingDirectory,
    worker: &Arc<ManagedSpeechWorker>,
    request: SynthesisRequest,
    ownership: SpeechLifecycleOwnership,
    run: SegmentRun,
    concurrency: SynthesisConcurrencyProbe,
) -> Result<PreparedSegmentResult, SpeechFailureCode> {
    let segment_id = request.segment_id().as_str().to_owned();
    let format = request.output_format();
    let output = SpeechOutput::within_root(
        work.path(),
        work.path(),
        &format!("segment-{}", run.index),
        format,
    )
    .map_err(|error| speech_failure(&error).0)?;
    let progress_channel = context.channel.clone();
    let progress_segment = segment_id.clone();
    let progress_worker = Arc::clone(worker);
    let job_id = context.job_id;
    let index = run.index;
    let total = run.total;
    let progress_runtime = context.runtime.clone();
    let progress_database = context.database.clone();
    let progress_ownership = ownership.clone();
    let worker_cancellation = ownership.cancellation.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let _active_synthesis = concurrency.enter();
        let control = RunControl::new(SPEECH_TIMEOUT)?
            .with_cancellation(worker_cancellation)
            .with_progress(move |progress: &SpeechProgress| {
                if progress_ownership
                    .ensure_owned(&progress_runtime, &progress_database)
                    .is_ok()
                {
                    let _ = progress_channel.send(SpeechJobEvent::Progress {
                        job_id,
                        segment_id: progress
                            .segment_id()
                            .map(|value| value.as_str().to_owned())
                            .or_else(|| Some(progress_segment.clone())),
                        index,
                        total,
                        phase: progress.phase().into(),
                        fraction_millionths: progress.fraction_millionths(),
                    });
                }
            });
        synthesize_with_retry(&progress_worker, &request, &output, &control)
    })
    .await;
    let operation = worker_join_result(context.runtime, run.backend, run.lifecycle_epoch, joined)?;
    match operation {
        Ok(artifact) => {
            ownership.ensure_owned(context.runtime, context.database)?;
            let database = context.database.clone();
            let runtime = context.runtime.clone();
            let commit_ownership = ownership.clone();
            let completion_channel = context.channel.clone();
            let project_id = context.project_id;
            let joined = tauri::async_runtime::spawn_blocking(move || {
                let metadata = SpeechArtifactMetadata::from_summary(artifact.summary());
                commit_completed_speech_source(
                    &runtime,
                    &commit_ownership,
                    &database,
                    artifact.native_path(),
                    metadata,
                    Some(project_id),
                    job_id,
                    segment_id,
                    "narrationOutput",
                    |result| {
                        let _ = completion_channel.send(SpeechJobEvent::SegmentCompleted {
                            job_id,
                            index,
                            total,
                            result: result.clone(),
                        });
                    },
                )
            })
            .await;
            let committed =
                worker_join_result(context.runtime, run.backend, run.lifecycle_epoch, joined)??;
            Ok(PreparedSegmentResult::Completed(committed))
        }
        Err(SpeechError::Cancelled) => Err(SpeechFailureCode::Cancelled),
        Err(error) => {
            let (code, retryable) = speech_failure(&error);
            Ok(PreparedSegmentResult::Failed {
                result: StoredSpeechResult::Failed {
                    segment_id,
                    code,
                    retryable,
                },
                invalidate_backend: failure_marks_backend_unhealthy(code),
            })
        }
    }
}

async fn commit_failed_segment(
    context: &SpeechBatchContext<'_>,
    ownership: &SpeechLifecycleOwnership,
    result: StoredSpeechResult,
    index: usize,
    total: usize,
) -> Result<(), SpeechFailureCode> {
    let manifest_runtime = context.runtime.clone();
    let manifest_ownership = ownership.clone();
    let database = context.database.clone();
    let channel = context.channel.clone();
    let job_id = context.job_id;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        manifest_ownership
            .commit_manifest_result(&manifest_runtime, &database, job_id, result.clone())
            .map(|()| {
                let _ = channel.send(SpeechJobEvent::SegmentFailed {
                    job_id,
                    index,
                    total,
                    result,
                });
            })
    })
    .await;
    worker_join_result(
        context.runtime,
        ownership.backend,
        ownership.lifecycle_epoch,
        joined,
    )?
}

async fn report_batch_progress(
    runtime: &SpeechRuntime,
    ownership: &SpeechLifecycleOwnership,
    database: &Database,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    completed: usize,
    total: usize,
) -> Result<(), SpeechFailureCode> {
    ownership.ensure_owned(runtime, database)?;
    if let Ok(progress) = JobProgress::from_units(
        u64::try_from(completed).unwrap_or(u64::MAX),
        u64::try_from(total).unwrap_or(u64::MAX),
    ) {
        let progress_runtime = runtime.clone();
        let progress_ownership = ownership.clone();
        let progress_jobs = Arc::clone(jobs);
        let joined = tauri::async_runtime::spawn_blocking(move || {
            progress_ownership.commit_job_progress(
                &progress_runtime,
                &progress_jobs,
                job_id,
                progress,
            )
        })
        .await;
        worker_join_result(
            runtime,
            ownership.backend,
            ownership.lifecycle_epoch,
            joined,
        )??;
    }
    Ok(())
}
