//! ASR/speech engine packages: verified install, removal, status and runtime start/stop commands.

mod durable;
mod runtime;
mod types;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use osg_domain::{JobId, JobKind, JobSnapshot, JobUpdate};
use osg_engine_packages::{CancellationToken, EngineId, PackageError, RemovalOutcome};
use tauri::{State, ipc::Channel};

pub(crate) use self::types::EnginePackageRuntime;
use self::types::{
    DurableOperation, EnginePackageAction, EnginePackageEvent, EnginePackagesStatus,
    ExecutionFailure,
};
use crate::asr::package_to_asr;
use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

const OPERATION_SCOPE: &str = "engine-package-operations";
const OPERATION_SCHEMA_VERSION: u32 = 1;
const MAX_STALE_DELETES_PER_BATCH: usize = 256;

async fn start_operation(
    runtime: EnginePackageRuntime,
    engine: EngineId,
    action: EnginePackageAction,
    on_event: Channel<EnginePackageEvent>,
) -> CommandResult<JobSnapshot> {
    let mut reservation = runtime.reserve(engine)?;
    let jobs = Arc::clone(&runtime.0.jobs);
    let ticket = background::register_running(&jobs, JobKind::InstallEngine).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let package_cancellation = CancellationToken::default();
    if let Err(error) = runtime.activate(
        &mut reservation,
        DurableOperation::preparing(&initial, engine, action),
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
                engine,
                action,
                &package_cancellation,
                &worker_channel,
            )
        })
        .await;
        watcher.abort();
        let result = worker.unwrap_or(Err(ExecutionFailure::Internal));
        background_runtime.finish(job_id, engine, action, result, &on_event);
    });
    Ok(initial)
}

fn execute_operation(
    runtime: &EnginePackageRuntime,
    job_id: JobId,
    engine: EngineId,
    action: EnginePackageAction,
    cancellation: &CancellationToken,
    on_event: &Channel<EnginePackageEvent>,
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
        EnginePackageAction::Install | EnginePackageAction::Update => runtime
            .0
            .manager
            .install(engine, cancellation, &progress)
            .map(|_| ()),
        EnginePackageAction::Remove => runtime
            .0
            .manager
            .remove(engine, cancellation, &progress)
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

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn engine_packages_status(
    runtime: State<'_, EnginePackageRuntime>,
) -> CommandResult<EnginePackagesStatus> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.status())
        .await
        .map_err(|_| {
            CommandError::internal("the engine package status task stopped unexpectedly")
        })?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn engine_package_install(
    runtime: State<'_, EnginePackageRuntime>,
    engine: EngineId,
    on_event: Channel<EnginePackageEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    let manager = runtime.0.manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || manager.status(engine))
        .await
        .map_err(|_| CommandError::internal("the engine package check stopped unexpectedly"))?;
    if !status.delivery_available {
        return Err(PackageError::DeliveryUnavailable.into());
    }
    let action = if status.update_available {
        EnginePackageAction::Update
    } else {
        EnginePackageAction::Install
    };
    start_operation(runtime, engine, action, on_event).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn engine_package_remove(
    runtime: State<'_, EnginePackageRuntime>,
    engine: EngineId,
    on_event: Channel<EnginePackageEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    let manager = runtime.0.manager.clone();
    let status = tauri::async_runtime::spawn_blocking(move || manager.status(engine))
        .await
        .map_err(|_| CommandError::internal("the engine package check stopped unexpectedly"))?;
    if !status.delivery_available {
        return Err(PackageError::DeliveryUnavailable.into());
    }
    start_operation(runtime, engine, EnginePackageAction::Remove, on_event).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn engine_runtime_start(
    state: State<'_, DesktopState>,
    engine: EngineId,
) -> CommandResult<()> {
    let asr = state.asr.clone();
    tauri::async_runtime::spawn_blocking(move || asr.start(package_to_asr(engine)))
        .await
        .map_err(|_| CommandError::internal("the ASR runtime start task stopped unexpectedly"))??;
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn engine_runtime_stop(
    state: State<'_, DesktopState>,
    engine: EngineId,
) -> CommandResult<()> {
    let asr = state.asr.clone();
    tauri::async_runtime::spawn_blocking(move || asr.stop(package_to_asr(engine)))
        .await
        .map_err(|_| CommandError::internal("the ASR runtime stop task stopped unexpectedly"))??;
    Ok(())
}

#[cfg(test)]
mod tests;
