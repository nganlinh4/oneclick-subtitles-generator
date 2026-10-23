//! Native-tool catalog, status, install, remove and cancel commands.

use std::sync::Arc;

use osg_domain::{JobId, JobKind, JobSnapshot, JobState, JobUpdate};
use osg_native_tools::{CancellationToken, NativeToolError, NativeToolId};
use tauri::{State, ipc::Channel};

use super::types::{
    DurableOperation, ExecutionFailure, NativeToolAction, NativeToolEvent, NativeToolRuntime,
    NativeToolsCatalog, NativeToolsStatus, OperationSlot,
};
use crate::background;
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};

async fn start_operation(
    runtime: NativeToolRuntime,
    tool: NativeToolId,
    action: NativeToolAction,
    on_event: Channel<NativeToolEvent>,
) -> CommandResult<JobSnapshot> {
    let mut reservation = runtime.reserve(tool)?;
    let jobs = Arc::clone(&runtime.0.jobs);
    let ticket = background::register_running(&jobs, JobKind::InstallEngine).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let cancellation = CancellationToken::default();
    if let Err(error) = runtime.activate(
        &mut reservation,
        DurableOperation::preparing(&initial, tool, action),
        cancellation.clone(),
    ) {
        let _ = jobs.apply(job_id, JobUpdate::Fail);
        return Err(error);
    }
    diagnostics::record(
        "native-tool.started",
        &[
            ("action", action.as_str().to_owned()),
            ("job", job_id.to_string()),
            ("tool", tool.as_str().to_owned()),
        ],
    );
    let job_cancellation = ticket.cancellation().clone();
    let watcher_cancellation = cancellation.clone();
    let background_runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        let watcher = tauri::async_runtime::spawn(async move {
            job_cancellation.cancelled().await;
            watcher_cancellation.cancel();
        });
        let worker_runtime = background_runtime.clone();
        let worker_channel = on_event.clone();
        let worker = tauri::async_runtime::spawn_blocking(move || {
            worker_runtime.execute(job_id, tool, action, &cancellation, &worker_channel)
        })
        .await;
        watcher.abort();
        let result = worker.unwrap_or(Err(ExecutionFailure::Internal));
        background_runtime.finish(job_id, tool, action, result, &on_event);
    });
    Ok(initial)
}

#[tauri::command]
pub(crate) fn native_tools_catalog() -> NativeToolsCatalog {
    NativeToolRuntime::catalog()
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn native_tools_status(
    runtime: State<'_, NativeToolRuntime>,
) -> CommandResult<NativeToolsStatus> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.status())
        .await
        .map_err(|_| CommandError::internal("the native tool status task stopped unexpectedly"))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn native_tool_install(
    runtime: State<'_, NativeToolRuntime>,
    tool: NativeToolId,
    on_event: Channel<NativeToolEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    diagnostics::record(
        "native-tool.requested",
        &[
            ("action", NativeToolAction::Install.as_str().to_owned()),
            ("tool", tool.as_str().to_owned()),
        ],
    );
    if !runtime.0.manager.delivery_available(tool) {
        return Err(NativeToolError::DeliveryUnavailable.into());
    }
    start_operation(runtime, tool, NativeToolAction::Install, on_event).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn native_tool_remove(
    runtime: State<'_, NativeToolRuntime>,
    tool: NativeToolId,
    on_event: Channel<NativeToolEvent>,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    diagnostics::record(
        "native-tool.requested",
        &[
            ("action", NativeToolAction::Remove.as_str().to_owned()),
            ("tool", tool.as_str().to_owned()),
        ],
    );
    if !runtime.0.manager.delivery_available(tool) {
        return Err(NativeToolError::DeliveryUnavailable.into());
    }
    start_operation(runtime, tool, NativeToolAction::Remove, on_event).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn native_tool_cancel(
    runtime: State<'_, NativeToolRuntime>,
    job_id: JobId,
) -> CommandResult<JobSnapshot> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cancellation = {
            let operations = runtime.0.operations.lock().map_err(|_| {
                CommandError::internal("the native tool coordinator is unavailable")
            })?;
            let Some((_, OperationSlot::Active { record, cancellation })) = operations
                .iter()
                .find(|(_, slot)| matches!(slot, OperationSlot::Active { record, .. } if record.job_id == job_id))
            else {
                return Err(CommandError::invalid_input(
                    "The native tool operation is not active.",
                ));
            };
            if record.job_id != job_id {
                return Err(CommandError::invalid_input(
                    "The job is not the active native tool operation.",
                ));
            }
            cancellation.clone()
        };
        let current = runtime.0.jobs.get(job_id)?;
        if current.snapshot().kind() != JobKind::InstallEngine {
            return Err(CommandError::invalid_input(
                "The job is not a native tool operation.",
            ));
        }
        if current.snapshot().state().is_terminal() {
            return Ok(current.snapshot().clone());
        }
        let ticket = if current.snapshot().state() == JobState::Cancelling {
            current
        } else {
            runtime
                .0
                .jobs
                .apply(job_id, JobUpdate::RequestCancellation)?
        };
        cancellation.cancel();
        Ok(ticket.snapshot().clone())
    })
    .await
    .map_err(|_| CommandError::internal("the native tool cancellation task stopped unexpectedly"))?
}
