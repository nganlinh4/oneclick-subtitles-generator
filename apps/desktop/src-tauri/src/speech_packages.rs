//! Speech/TTS runtime packages: verified install, removal and status commands.

mod runtime;
mod types;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use osg_domain::{JobId, JobKind, JobSnapshot, JobUpdate};
use osg_engine_packages::{
    CancellationToken, OperationPhase, OperationProgress, PackageError, RemovalOutcome,
    SpeechPackageId,
};
use tauri::{State, ipc::Channel};

pub(crate) use self::types::SpeechPackageRuntime;
use self::types::{
    ExecutionFailure, SpeechPackageAction, SpeechPackageEvent, SpeechPackagePhase,
    SpeechPackagesStatus,
};
use crate::background;
use crate::error::{CommandError, CommandResult};

const SCHEMA_VERSION: u32 = 1;

async fn start_operation(
    runtime: SpeechPackageRuntime,
    backend: SpeechPackageId,
    action: SpeechPackageAction,
    on_event: Channel<SpeechPackageEvent>,
) -> CommandResult<JobSnapshot> {
    let mut reservation = runtime.reserve(backend)?;
    let jobs = Arc::clone(&runtime.0.jobs);
    let ticket = background::register_running(&jobs, JobKind::InstallEngine).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let package_cancellation = CancellationToken::default();
    if let Err(error) = runtime.activate(
        &mut reservation,
        &initial,
        action,
        package_cancellation.clone(),
    ) {
        let _ = jobs.apply(job_id, JobUpdate::Fail);
        return Err(error);
    }
    let job_cancellation = ticket.cancellation().clone();
    let watcher_cancellation = package_cancellation.clone();
    let background_runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        let watcher = tauri::async_runtime::spawn(async move {
            job_cancellation.cancelled().await;
            watcher_cancellation.cancel();
        });
        let worker_runtime = background_runtime.clone();
        let worker_channel = on_event.clone();
        let worker = tauri::async_runtime::spawn_blocking(move || {
            execute_operation(
                &worker_runtime,
                job_id,
                backend,
                action,
                &package_cancellation,
                &worker_channel,
            )
        })
        .await;
        watcher.abort();
        let result = worker.unwrap_or(Err(ExecutionFailure::Internal));
        background_runtime.finish(job_id, backend, action, result, &on_event);
    });
    Ok(initial)
}

fn execute_operation(
    runtime: &SpeechPackageRuntime,
    job_id: JobId,
    backend: SpeechPackageId,
    action: SpeechPackageAction,
    cancellation: &CancellationToken,
    on_event: &Channel<SpeechPackageEvent>,
) -> Result<(), ExecutionFailure> {
    let progress_failed = Arc::new(AtomicBool::new(false));
    let progress_runtime = runtime.clone();
    let progress_channel = on_event.clone();
    let progress_cancellation = cancellation.clone();
    let progress_failure = Arc::clone(&progress_failed);
    let progress = move |value| {
        if progress_runtime
            .report_progress(job_id, action, value, &progress_channel)
            .is_err()
        {
            progress_failure.store(true, Ordering::Release);
            progress_cancellation.cancel();
        }
    };
    let result = match action {
        SpeechPackageAction::Install | SpeechPackageAction::Update => runtime
            .0
            .manager
            .install(backend, cancellation, &progress)
            .map(|_| ()),
        SpeechPackageAction::Remove => runtime
            .0
            .manager
            .remove(backend, cancellation, &progress)
            .and_then(|outcome| match outcome {
                RemovalOutcome::Missing | RemovalOutcome::Removed => Ok(()),
                RemovalOutcome::PreservedModified => Err(PackageError::InvalidInstall),
            }),
    };
    if progress_failed.load(Ordering::Acquire) {
        Err(ExecutionFailure::Internal)
    } else {
        result.map_err(ExecutionFailure::Package)
    }
}

fn map_progress(
    action: SpeechPackageAction,
    progress: OperationProgress,
) -> CommandResult<(SpeechPackagePhase, u16)> {
    let local = u32::from(progress.basis_points.min(10_000));
    let (phase, start, width) = match (action, progress.phase) {
        (SpeechPackageAction::Install | SpeechPackageAction::Update, OperationPhase::Preparing) => {
            (SpeechPackagePhase::Preparing, 0_u32, 0_u32)
        }
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            OperationPhase::Downloading,
        ) => (SpeechPackagePhase::Downloading, 0, 5_000),
        (SpeechPackageAction::Install | SpeechPackageAction::Update, OperationPhase::Verifying) => {
            (SpeechPackagePhase::Verifying, 5_000, 1_000)
        }
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            OperationPhase::Extracting,
        ) => (SpeechPackagePhase::Extracting, 6_000, 3_000),
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            OperationPhase::Publishing,
        ) => (SpeechPackagePhase::Publishing, 9_000, 900),
        (SpeechPackageAction::Remove, OperationPhase::Removing) => {
            (SpeechPackagePhase::Removing, 0, 9_900)
        }
        _ => {
            return Err(CommandError::internal(
                "the speech package progress phase is invalid",
            ));
        }
    };
    let basis_points = start.saturating_add(local.saturating_mul(width) / 10_000);
    Ok((
        phase,
        u16::try_from(basis_points.min(9_900))
            .map_err(|_| CommandError::internal("the speech package progress is invalid"))?,
    ))
}

const fn phase_rank(action: SpeechPackageAction, phase: SpeechPackagePhase) -> u8 {
    match (action, phase) {
        (_, SpeechPackagePhase::Preparing) => 0,
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            SpeechPackagePhase::Downloading,
        )
        | (SpeechPackageAction::Remove, SpeechPackagePhase::Removing) => 1,
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            SpeechPackagePhase::Verifying,
        ) => 2,
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            SpeechPackagePhase::Extracting,
        ) => 3,
        (
            SpeechPackageAction::Install | SpeechPackageAction::Update,
            SpeechPackagePhase::Publishing,
        ) => 4,
        _ => u8::MAX,
    }
}

fn execution_error(failure: ExecutionFailure) -> CommandError {
    match failure {
        ExecutionFailure::Package(error) => error.into(),
        ExecutionFailure::Internal => {
            CommandError::internal("the speech package operation could not be recorded safely")
        }
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn speech_packages_status(
    runtime: State<'_, SpeechPackageRuntime>,
) -> CommandResult<SpeechPackagesStatus> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.status())
        .await
        .map_err(|_| {
            CommandError::internal("the speech package status task stopped unexpectedly")
        })?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn speech_package_install(
    runtime: State<'_, SpeechPackageRuntime>,
    backend: SpeechPackageId,
    on_event: Channel<SpeechPackageEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    let manager = runtime.0.manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || manager.status(backend))
        .await
        .map_err(|_| CommandError::internal("the speech package check stopped unexpectedly"))?;
    if !status.delivery_available {
        return Err(PackageError::DeliveryUnavailable.into());
    }
    let action = if status.update_available {
        SpeechPackageAction::Update
    } else {
        SpeechPackageAction::Install
    };
    start_operation(runtime, backend, action, on_event).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn speech_package_remove(
    runtime: State<'_, SpeechPackageRuntime>,
    backend: SpeechPackageId,
    on_event: Channel<SpeechPackageEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    let manager = runtime.0.manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || manager.status(backend))
        .await
        .map_err(|_| CommandError::internal("the speech package check stopped unexpectedly"))?;
    if !status.delivery_available {
        return Err(PackageError::DeliveryUnavailable.into());
    }
    start_operation(runtime, backend, SpeechPackageAction::Remove, on_event).await
}

#[cfg(test)]
mod tests;
