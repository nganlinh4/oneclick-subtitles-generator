//! Durable operation records, pending removals, progress mapping and terminal diagnostics.

use std::collections::HashSet;

use osg_domain::JobId;
use osg_infrastructure::storage::{Database, DatabaseError};
use osg_native_tools::{
    CancellationToken, NativeToolError, NativeToolId, NativeToolManager, OperationPhase,
    OperationProgress, RemovalOutcome,
};
use serde_json::json;

use super::types::{
    DurableOperation, ExecutionFailure, NativeToolAction, NativeToolPhase, NativeToolRuntimeError,
};
use super::{OPERATION_SCOPE, PENDING_REMOVAL_SCOPE, PENDING_REMOVAL_VALUE};
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};

pub(super) fn clear_recovered_operations(database: &Database) -> Result<(), DatabaseError> {
    let keys = database
        .list_settings(OPERATION_SCOPE)?
        .into_keys()
        .collect::<Vec<_>>();
    for batch in keys.chunks(256) {
        database.delete_settings(OPERATION_SCOPE, batch)?;
    }
    Ok(())
}

pub(super) fn read_pending_removals(
    database: &Database,
) -> Result<HashSet<NativeToolId>, DatabaseError> {
    let mut pending = HashSet::new();
    let mut stale = Vec::new();
    for (key, value) in database.list_settings(PENDING_REMOVAL_SCOPE)? {
        let Ok(tool) = NativeToolId::try_from(key.as_str()) else {
            stale.push(key);
            continue;
        };
        if value == json!({ "schemaVersion": PENDING_REMOVAL_VALUE }) {
            pending.insert(tool);
        } else {
            stale.push(key);
        }
    }
    for batch in stale.chunks(256) {
        database.delete_settings(PENDING_REMOVAL_SCOPE, batch)?;
    }
    Ok(pending)
}

pub(super) fn apply_pending_removals(
    manager: &NativeToolManager,
    database: &Database,
) -> Result<(), NativeToolRuntimeError> {
    let pending = read_pending_removals(database)?;
    for tool in pending {
        let outcome = manager.remove(tool, &CancellationToken::default(), &|_| {});
        match outcome {
            Ok(
                RemovalOutcome::Missing
                | RemovalOutcome::Removed
                | RemovalOutcome::PreservedModified,
            )
            | Err(NativeToolError::DeliveryUnavailable) => {
                database.delete_setting(PENDING_REMOVAL_SCOPE, tool.as_str())?;
            }
            Err(_) => {}
        }
    }
    Ok(())
}

pub(super) fn persist_operation(
    database: &Database,
    record: &DurableOperation,
) -> CommandResult<()> {
    let value = serde_json::to_value(record)
        .map_err(|_| CommandError::internal("the native tool metadata is invalid"))?;
    database
        .put_setting(OPERATION_SCOPE, &record.job_id.to_string(), &value)
        .map_err(Into::into)
}

pub(super) fn map_progress(
    action: NativeToolAction,
    progress: OperationProgress,
) -> CommandResult<(NativeToolPhase, u16)> {
    let local = u32::from(progress.basis_points.min(10_000));
    let (phase, start, width) = match (action, progress.phase) {
        (NativeToolAction::Install, OperationPhase::Preparing) => {
            (NativeToolPhase::Preparing, 0_u32, 0_u32)
        }
        (NativeToolAction::Install, OperationPhase::Downloading | OperationPhase::Verifying) => {
            (NativeToolPhase::Downloading, 0, 6_000)
        }
        (NativeToolAction::Install, OperationPhase::Extracting) => {
            (NativeToolPhase::Extracting, 6_000, 3_000)
        }
        (NativeToolAction::Install, OperationPhase::Publishing) => {
            (NativeToolPhase::Publishing, 9_000, 900)
        }
        (NativeToolAction::Remove, OperationPhase::Removing) => {
            (NativeToolPhase::Removing, 0, 9_900)
        }
        _ => {
            return Err(CommandError::internal(
                "the native tool progress phase is invalid",
            ));
        }
    };
    let basis_points = start.saturating_add(local.saturating_mul(width) / 10_000);
    Ok((
        phase,
        u16::try_from(basis_points.min(9_900))
            .map_err(|_| CommandError::internal("the native tool progress is invalid"))?,
    ))
}

pub(super) fn record_native_tool_terminal(
    event: &'static str,
    action: NativeToolAction,
    job_id: JobId,
    tool: NativeToolId,
    code: Option<&str>,
) {
    let mut fields = vec![("action", action.as_str().to_owned())];
    if let Some(code) = code {
        fields.push(("code", code.to_owned()));
    }
    fields.extend([
        ("job", job_id.to_string()),
        ("tool", tool.as_str().to_owned()),
    ]);
    diagnostics::record(event, &fields);
}

pub(super) const fn phase_rank(action: NativeToolAction, phase: NativeToolPhase) -> u8 {
    match (action, phase) {
        (_, NativeToolPhase::Preparing) => 0,
        (NativeToolAction::Install, NativeToolPhase::Downloading)
        | (NativeToolAction::Remove, NativeToolPhase::Removing) => 1,
        (NativeToolAction::Install, NativeToolPhase::Extracting) => 2,
        (NativeToolAction::Install, NativeToolPhase::Publishing) => 3,
        _ => u8::MAX,
    }
}

pub(super) fn execution_error(failure: ExecutionFailure) -> CommandError {
    match failure {
        ExecutionFailure::Tool(error) => error.into(),
        ExecutionFailure::Database(error) => error.into(),
        ExecutionFailure::Internal => {
            CommandError::internal("the native tool operation could not be recorded safely")
        }
    }
}
