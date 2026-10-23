//! Alignment job execution: leaf rendering, mixing and completion.

use std::path::Path;
use std::sync::Arc;

use osg_domain::{JobId, JobProgress, JobState, JobUpdate};
use osg_infrastructure::storage::{Database, DatabaseError};
use osg_media::{
    AudioBitrate, AudioOutput, AudioSampleRate, CancellationToken as MediaCancellationToken,
    ChannelCount, FfmpegProgress, MAX_NARRATION_MIX_INPUTS, MediaError, MediaInput, MediaOperation,
    MediaOutput, NarrationMixClip as MediaMixClip, NarrationMixPlan as MediaMixPlan, ProgressSink,
    RunControl as MediaRunControl,
};
use tauri::ipc::Channel;

use super::ALIGNMENT_TIMEOUT;
use super::alignment::{
    AlignmentRenderClip, SpeechAlignmentEvent, SpeechAlignmentFailureCode, SpeechAlignmentPhase,
    SpeechAlignmentResult, ValidatedAlignmentStart, store_alignment_result,
};
use super::artifact_types::SpeechArtifactFormatResponse;
use super::artifacts::{
    SpeechArtifactMetadata, publish_project_durable_artifact, rollback_published_speech_artifact,
};
use super::lifecycle::SpeechProjectAuthority;
use super::runtime::SpeechRuntime;
use crate::background;

#[allow(clippy::too_many_arguments)]
pub(super) fn execute_alignment_job(
    runtime: &SpeechRuntime,
    engine: &osg_media::MediaEngine,
    database: &Database,
    jobs: &background::DesktopJobs,
    job_id: JobId,
    validated: &ValidatedAlignmentStart,
    cancellation: &MediaCancellationToken,
    channel: &Channel<SpeechAlignmentEvent>,
) -> Result<SpeechAlignmentResult, SpeechAlignmentFailureCode> {
    let authority = SpeechProjectAuthority {
        project_id: validated.project_id,
        expected_state_version: validated.expected_project_state_version,
    };
    ensure_alignment_project_current(database, authority)?;
    if cancellation.is_cancelled() {
        return Err(SpeechAlignmentFailureCode::Cancelled);
    }
    let work = runtime
        .work_directory()
        .map_err(|_| SpeechAlignmentFailureCode::RuntimeUnavailable)?;
    let started = std::time::Instant::now();
    let leaf_count = validated.clips.len().div_ceil(MAX_NARRATION_MIX_INPUTS);
    let total_steps = if leaf_count == 1 { 1 } else { leaf_count + 1 };
    let final_path = work.path().join("aligned-narration.m4a");
    let (final_inputs, completed_steps) = if leaf_count == 1 {
        (validated.clips.clone(), 0)
    } else {
        (
            render_alignment_leaves(
                engine,
                work.path(),
                &validated.clips,
                total_steps,
                started,
                cancellation,
                jobs,
                database,
                authority,
                job_id,
                channel,
            )?,
            leaf_count,
        )
    };
    execute_alignment_mix(
        engine,
        work.path(),
        &final_inputs,
        &final_path,
        alignment_m4a_output()?,
        validated.stats.rendered_duration_micros,
        completed_steps,
        total_steps,
        started,
        cancellation.clone(),
        jobs,
        database,
        authority,
        job_id,
        channel,
    )?;

    if cancellation.is_cancelled() {
        return Err(SpeechAlignmentFailureCode::Cancelled);
    }
    ensure_alignment_project_current(database, authority)?;
    report_alignment_progress(
        jobs,
        job_id,
        SpeechAlignmentPhase::Publishing,
        950_000,
        channel,
    );
    let published = publish_project_durable_artifact(
        runtime,
        database,
        validated.project_id,
        Some(job_id),
        "alignedNarration",
        &final_path,
        SpeechArtifactMetadata {
            format: SpeechArtifactFormatResponse::M4a,
            duration_micros: Some(validated.stats.rendered_duration_micros),
            sample_rate_hz: Some(48_000),
            channels: Some(2),
            source: "nativeNarrationAlignment",
        },
    )
    .map_err(|_| SpeechAlignmentFailureCode::ArtifactStorage)?;
    let result = SpeechAlignmentResult {
        artifact: published.descriptor.clone(),
        clip_count: validated.stats.clip_count,
        adjusted_count: validated.stats.adjusted_count,
        requested_duration_micros: validated.stats.requested_duration_micros,
        natural_duration_micros: validated.stats.natural_duration_micros,
        rendered_duration_micros: validated.stats.rendered_duration_micros,
        maximum_shift_micros: validated.stats.maximum_shift_micros,
    };
    if let Err(code) = ensure_alignment_project_current(database, authority) {
        rollback_published_speech_artifact(database, &published)
            .map_err(|_| SpeechAlignmentFailureCode::ArtifactStorage)?;
        return Err(code);
    }
    if let Err(code) = store_alignment_result(database, job_id, authority, result.clone()) {
        rollback_published_speech_artifact(database, &published)
            .map_err(|_| SpeechAlignmentFailureCode::ArtifactStorage)?;
        return Err(code);
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn render_alignment_leaves(
    engine: &osg_media::MediaEngine,
    work_root: &Path,
    clips: &[AlignmentRenderClip],
    total_steps: usize,
    started: std::time::Instant,
    cancellation: &MediaCancellationToken,
    jobs: &background::DesktopJobs,
    database: &Database,
    authority: SpeechProjectAuthority,
    job_id: JobId,
    channel: &Channel<SpeechAlignmentEvent>,
) -> Result<Vec<AlignmentRenderClip>, SpeechAlignmentFailureCode> {
    let mut leaf_inputs = Vec::with_capacity(clips.len().div_ceil(MAX_NARRATION_MIX_INPUTS));
    for (leaf_index, clips) in clips.chunks(MAX_NARRATION_MIX_INPUTS).enumerate() {
        ensure_alignment_project_current(database, authority)?;
        if cancellation.is_cancelled() {
            return Err(SpeechAlignmentFailureCode::Cancelled);
        }
        let origin = clips
            .first()
            .map(|clip| clip.start_micros)
            .ok_or(SpeechAlignmentFailureCode::InvalidRequest)?;
        let end = clips
            .iter()
            .map(|clip| clip.end_micros)
            .max()
            .ok_or(SpeechAlignmentFailureCode::InvalidRequest)?;
        let duration = end
            .checked_sub(origin)
            .filter(|duration| *duration > 0)
            .ok_or(SpeechAlignmentFailureCode::InvalidRequest)?;
        let relative = clips
            .iter()
            .map(|clip| AlignmentRenderClip {
                input: clip.input.clone(),
                start_micros: clip.start_micros.saturating_sub(origin),
                end_micros: clip.end_micros.saturating_sub(origin),
            })
            .collect::<Vec<_>>();
        let leaf_path = work_root.join(format!("alignment-leaf-{leaf_index}.flac"));
        execute_alignment_mix(
            engine,
            work_root,
            &relative,
            &leaf_path,
            alignment_flac_output()?,
            duration,
            leaf_index,
            total_steps,
            started,
            cancellation.clone(),
            jobs,
            database,
            authority,
            job_id,
            channel,
        )?;
        let input = MediaInput::from_native_selection(&leaf_path)
            .map_err(|_| SpeechAlignmentFailureCode::MediaFailed)?;
        leaf_inputs.push(AlignmentRenderClip {
            input,
            start_micros: origin,
            end_micros: end,
        });
    }
    Ok(leaf_inputs)
}

#[allow(clippy::too_many_arguments)]
fn execute_alignment_mix(
    engine: &osg_media::MediaEngine,
    work_root: &Path,
    clips: &[AlignmentRenderClip],
    output_path: &Path,
    output_format: AudioOutput,
    duration_micros: u64,
    completed_steps: usize,
    total_steps: usize,
    started: std::time::Instant,
    cancellation: MediaCancellationToken,
    jobs: &background::DesktopJobs,
    database: &Database,
    authority: SpeechProjectAuthority,
    job_id: JobId,
    channel: &Channel<SpeechAlignmentEvent>,
) -> Result<(), SpeechAlignmentFailureCode> {
    ensure_alignment_project_current(database, authority)?;
    if cancellation.is_cancelled() {
        return Err(SpeechAlignmentFailureCode::Cancelled);
    }
    let remaining = ALIGNMENT_TIMEOUT
        .checked_sub(started.elapsed())
        .filter(|duration| !duration.is_zero())
        .ok_or(SpeechAlignmentFailureCode::TimedOut)?;
    let mix_clips = clips
        .iter()
        .map(|clip| MediaMixClip::new(clip.input.clone(), clip.start_micros))
        .collect::<Vec<_>>();
    let output = MediaOutput::within_root(output_path, work_root)
        .map_err(|_| SpeechAlignmentFailureCode::MediaFailed)?;
    let operation = MediaOperation::NarrationMix(
        MediaMixPlan::new(mix_clips, output, output_format, duration_micros)
            .map_err(|_| SpeechAlignmentFailureCode::InvalidRequest)?,
    );
    let progress_jobs = Arc::clone(jobs);
    let progress_channel = channel.clone();
    let progress_database = database.clone();
    let progress_cancellation = cancellation.clone();
    let progress = ProgressSink::new(move |progress: FfmpegProgress| {
        let fraction = progress
            .fraction
            .filter(|fraction| fraction.is_finite())
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        report_alignment_mix_fraction(
            &progress_jobs,
            &progress_database,
            authority,
            job_id,
            completed_steps,
            total_steps,
            fraction,
            &progress_channel,
        )
        .unwrap_or_else(|_| progress_cancellation.cancel());
    });
    let control = MediaRunControl::new(remaining)
        .map_err(|_| SpeechAlignmentFailureCode::MediaFailed)?
        .with_cancellation(cancellation)
        .with_progress(progress);
    engine
        .execute(&operation, &control)
        .map_err(|error| alignment_media_failure(&error))?;
    ensure_alignment_project_current(database, authority)
}

fn alignment_m4a_output() -> Result<AudioOutput, SpeechAlignmentFailureCode> {
    Ok(AudioOutput::M4aAac {
        bitrate: AudioBitrate::new(192).map_err(|_| SpeechAlignmentFailureCode::InvalidRequest)?,
    })
}

fn alignment_flac_output() -> Result<AudioOutput, SpeechAlignmentFailureCode> {
    Ok(AudioOutput::Flac {
        sample_rate: AudioSampleRate::new(48_000)
            .map_err(|_| SpeechAlignmentFailureCode::InvalidRequest)?,
        channels: ChannelCount::new(2).map_err(|_| SpeechAlignmentFailureCode::InvalidRequest)?,
    })
}

const fn alignment_media_failure(error: &MediaError) -> SpeechAlignmentFailureCode {
    match error {
        MediaError::Cancelled(_) => SpeechAlignmentFailureCode::Cancelled,
        MediaError::TimedOut { .. } => SpeechAlignmentFailureCode::TimedOut,
        MediaError::BinaryNotFound(_) | MediaError::InvalidBinary { .. } => {
            SpeechAlignmentFailureCode::RuntimeUnavailable
        }
        MediaError::InvalidOption(_) | MediaError::UnsupportedConversion => {
            SpeechAlignmentFailureCode::InvalidRequest
        }
        MediaError::InvalidPath { .. }
        | MediaError::Spawn { .. }
        | MediaError::ProcessIo { .. }
        | MediaError::ProcessFailed { .. }
        | MediaError::OutputLimit { .. }
        | MediaError::InvalidProbe(_)
        | MediaError::ProbeJson(_)
        | MediaError::OutputExists
        | MediaError::MissingArtifact
        | MediaError::Finalize(_)
        | MediaError::InvalidWaveform(_) => SpeechAlignmentFailureCode::MediaFailed,
    }
}

pub(super) fn ensure_alignment_project_current(
    database: &Database,
    authority: SpeechProjectAuthority,
) -> Result<(), SpeechAlignmentFailureCode> {
    let project = database
        .load_project(authority.project_id)
        .map_err(|_| SpeechAlignmentFailureCode::ArtifactStorage)?
        .ok_or(SpeechAlignmentFailureCode::ProjectChanged)?;
    if project.state_version() != authority.expected_state_version {
        return Err(SpeechAlignmentFailureCode::ProjectChanged);
    }
    Ok(())
}

pub(super) const fn alignment_project_write_failure(
    error: &DatabaseError,
) -> SpeechAlignmentFailureCode {
    match error {
        DatabaseError::ProjectNotFound(_) | DatabaseError::StaleProjectVersion { .. } => {
            SpeechAlignmentFailureCode::ProjectChanged
        }
        _ => SpeechAlignmentFailureCode::ArtifactStorage,
    }
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the finite alignment fraction is clamped to 0..=1 before conversion"
)]
#[allow(clippy::too_many_arguments)]
fn report_alignment_mix_fraction(
    jobs: &background::DesktopJobs,
    database: &Database,
    authority: SpeechProjectAuthority,
    job_id: JobId,
    completed_steps: usize,
    total_steps: usize,
    local_fraction: f64,
    channel: &Channel<SpeechAlignmentEvent>,
) -> Result<(), SpeechAlignmentFailureCode> {
    ensure_alignment_project_current(database, authority)?;
    let local_millionths = (local_fraction * 1_000_000.0).round() as u64;
    let completed_steps = u64::try_from(completed_steps).unwrap_or(u64::MAX);
    let total_steps = u64::try_from(total_steps).unwrap_or(u64::MAX).max(1);
    let overall_millionths = completed_steps
        .saturating_mul(1_000_000)
        .saturating_add(local_millionths)
        .checked_div(total_steps)
        .unwrap_or_default()
        .min(1_000_000);
    let millionths =
        u32::try_from(overall_millionths.saturating_mul(900_000) / 1_000_000).unwrap_or(900_000);
    report_alignment_progress(
        jobs,
        job_id,
        SpeechAlignmentPhase::Mixing,
        millionths,
        channel,
    );
    Ok(())
}

pub(super) fn report_alignment_progress(
    jobs: &background::DesktopJobs,
    job_id: JobId,
    phase: SpeechAlignmentPhase,
    fraction_millionths: u32,
    channel: &Channel<SpeechAlignmentEvent>,
) {
    let fraction_millionths = fraction_millionths.min(950_000);
    if let Ok(current) = jobs.get(job_id)
        && current.snapshot().state() == JobState::Running
    {
        let basis_points = 100_u32
            .saturating_add(fraction_millionths.saturating_mul(9_400) / 1_000_000)
            .min(9_500);
        if let Ok(progress) = JobProgress::from_basis_points(
            u16::try_from(basis_points).expect("basis points are bounded"),
        ) && progress > current.snapshot().progress()
        {
            let _ = jobs.apply(job_id, JobUpdate::ReportProgress(progress));
        }
        let _ = channel.send(SpeechAlignmentEvent::Progress {
            job_id,
            phase,
            fraction_millionths,
        });
    }
}

pub(super) async fn finish_alignment_job(
    jobs: &background::DesktopJobs,
    database: &Database,
    authority: SpeechProjectAuthority,
    job_id: JobId,
    outcome: Result<SpeechAlignmentResult, SpeechAlignmentFailureCode>,
    channel: &Channel<SpeechAlignmentEvent>,
) {
    match outcome {
        Ok(result) => {
            let completion_jobs = Arc::clone(jobs);
            let completion_database = database.clone();
            let completed = tauri::async_runtime::spawn_blocking(move || {
                completion_jobs.apply_with_store(
                    job_id,
                    JobUpdate::Succeed,
                    |store, sequence, snapshot| {
                        store.complete_project_job(
                            sequence,
                            snapshot,
                            authority.project_id,
                            authority.expected_state_version,
                        )
                    },
                )
            })
            .await
            .ok()
            .and_then(Result::ok)
            .map(|ticket| ticket.snapshot().clone());
            if let Some(job) = completed {
                let _ = channel.send(SpeechAlignmentEvent::Completed {
                    job,
                    project_id: authority.project_id,
                    expected_project_state_version: authority.expected_state_version,
                    result,
                });
            } else {
                let code = ensure_alignment_project_current(&completion_database, authority)
                    .err()
                    .unwrap_or(SpeechAlignmentFailureCode::ArtifactStorage);
                let job = background::finish_failure(jobs, job_id).await;
                let _ = channel.send(SpeechAlignmentEvent::Failed { job, code });
            }
        }
        Err(SpeechAlignmentFailureCode::Cancelled) => {
            if let Ok(job) = background::finish_cancellation(jobs, job_id).await {
                let _ = channel.send(SpeechAlignmentEvent::Cancelled { job });
            } else {
                let job = background::snapshot(jobs, job_id).await;
                let _ = channel.send(SpeechAlignmentEvent::Failed {
                    job,
                    code: SpeechAlignmentFailureCode::MediaFailed,
                });
            }
        }
        Err(code) => {
            let job = background::finish_failure(jobs, job_id).await;
            let _ = channel.send(SpeechAlignmentEvent::Failed { job, code });
        }
    }
}
