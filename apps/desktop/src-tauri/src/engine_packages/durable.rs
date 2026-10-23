//! Durable operation persistence, phase ordering, progress mapping and cancellation.

use osg_engine_packages::{OperationPhase, OperationProgress};
use osg_infrastructure::storage::{Database, DatabaseError};

use super::types::{DurableOperation, EnginePackageAction, EnginePackagePhase, ExecutionFailure};
use super::{MAX_STALE_DELETES_PER_BATCH, OPERATION_SCOPE};
use crate::error::{CommandError, CommandResult};

pub(super) fn phase_allowed(action: EnginePackageAction, phase: EnginePackagePhase) -> bool {
    match action {
        EnginePackageAction::Install | EnginePackageAction::Update => matches!(
            phase,
            EnginePackagePhase::Queued
                | EnginePackagePhase::Preparing
                | EnginePackagePhase::Downloading
                | EnginePackagePhase::Verifying
                | EnginePackagePhase::Extracting
                | EnginePackagePhase::Publishing
        ),
        EnginePackageAction::Remove => matches!(
            phase,
            EnginePackagePhase::Queued
                | EnginePackagePhase::Preparing
                | EnginePackagePhase::Removing
        ),
    }
}

pub(super) fn phase_rank(action: EnginePackageAction, phase: EnginePackagePhase) -> u8 {
    match (action, phase) {
        (_, EnginePackagePhase::Queued) => 0,
        (_, EnginePackagePhase::Preparing) => 1,
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            EnginePackagePhase::Downloading,
        )
        | (EnginePackageAction::Remove, EnginePackagePhase::Removing) => 2,
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            EnginePackagePhase::Verifying,
        ) => 3,
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            EnginePackagePhase::Extracting,
        ) => 4,
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            EnginePackagePhase::Publishing,
        ) => 5,
        _ => u8::MAX,
    }
}

pub(super) fn map_progress(
    action: EnginePackageAction,
    progress: OperationProgress,
) -> CommandResult<(EnginePackagePhase, u16)> {
    let local = u32::from(progress.basis_points.min(10_000));
    let (phase, start, width) = match (action, progress.phase) {
        (EnginePackageAction::Install | EnginePackageAction::Update, OperationPhase::Preparing) => {
            (EnginePackagePhase::Preparing, 0_u32, 0_u32)
        }
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            OperationPhase::Downloading,
        ) => (EnginePackagePhase::Downloading, 0, 5_000),
        (EnginePackageAction::Install | EnginePackageAction::Update, OperationPhase::Verifying) => {
            (EnginePackagePhase::Verifying, 5_000, 1_000)
        }
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            OperationPhase::Extracting,
        ) => (EnginePackagePhase::Extracting, 6_000, 3_000),
        (
            EnginePackageAction::Install | EnginePackageAction::Update,
            OperationPhase::Publishing,
        ) => (EnginePackagePhase::Publishing, 9_000, 900),
        (EnginePackageAction::Remove, OperationPhase::Removing) => {
            (EnginePackagePhase::Removing, 0, 9_900)
        }
        _ => {
            return Err(CommandError::internal(
                "the engine package progress phase is invalid",
            ));
        }
    };
    let basis_points = start.saturating_add(local.saturating_mul(width) / 10_000);
    Ok((
        phase,
        u16::try_from(basis_points.min(9_900))
            .map_err(|_| CommandError::internal("the engine package progress is invalid"))?,
    ))
}

pub(super) fn persist_operation(
    database: &Database,
    record: &DurableOperation,
) -> CommandResult<()> {
    let value = serde_json::to_value(record)
        .map_err(|_| CommandError::internal("the engine package metadata is invalid"))?;
    database
        .put_setting(OPERATION_SCOPE, &record.job_id.to_string(), &value)
        .map_err(Into::into)
}

pub(super) fn delete_operation_keys(
    database: &Database,
    keys: &[String],
) -> Result<(), DatabaseError> {
    for batch in keys.chunks(MAX_STALE_DELETES_PER_BATCH) {
        database.delete_settings(OPERATION_SCOPE, batch)?;
    }
    Ok(())
}

pub(super) fn execution_error(failure: ExecutionFailure) -> CommandError {
    match failure {
        ExecutionFailure::Package(error) => error.into(),
        ExecutionFailure::Internal => {
            CommandError::internal("the engine package operation could not be recorded safely")
        }
    }
}
