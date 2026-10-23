//! Tauri commands for the F5-TTS language checkpoints. Delivery, verification, publication,
//! and removal belong to `osg_engine_packages::F5ModelManager`; this adapter owns only the one
//! active operation's progress, cancellation, and the worker reload after a change.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use osg_engine_packages::{
    CancellationToken, F5ModelInfo, F5ModelManager, OperationPhase, OperationProgress,
    PackageError, ProgressSink, RemovalOutcome, f5_model_catalog,
};
use serde::Serialize;
use tauri::{State, ipc::Channel};

use crate::background::run_blocking;
use crate::error::{CommandError, CommandResult};
use crate::speech::SpeechRuntime;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(400);

struct Operation {
    id: String,
    model: String,
    bytes: Arc<AtomicU64>,
    total: u64,
    cancellation: CancellationToken,
}

pub(crate) struct F5ModelRuntime {
    manager: F5ModelManager,
    operation: Mutex<Option<Operation>>,
}

impl F5ModelRuntime {
    pub(crate) fn new(root: &Path) -> Result<Self, PackageError> {
        Ok(Self {
            manager: F5ModelManager::new(root)?,
            operation: Mutex::new(None),
        })
    }

    fn operation(&self) -> CommandResult<MutexGuard<'_, Option<Operation>>> {
        self.operation
            .lock()
            .map_err(|_| CommandError::internal("model state unavailable"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelStatus {
    #[serde(flatten)]
    info: &'static F5ModelInfo,
    installed: bool,
    operation: Option<OperationStatus>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationStatus {
    id: String,
    model: String,
    bytes_done: u64,
    total_bytes: u64,
    basis_points: u64,
}

#[derive(Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum ModelEvent {
    Progress { operation: OperationStatus },
    Completed { model: String },
    Cancelled { model: String },
}

impl Operation {
    fn status(&self) -> OperationStatus {
        progress_status(&self.id, &self.model, &self.bytes, self.total)
    }
}

fn progress_status(id: &str, model: &str, bytes: &AtomicU64, total: u64) -> OperationStatus {
    let done = bytes.load(Ordering::Relaxed).min(total);
    OperationStatus {
        id: id.to_owned(),
        model: model.to_owned(),
        bytes_done: done,
        total_bytes: total,
        basis_points: done.saturating_mul(10_000) / total.max(1),
    }
}

/// Records the overall downloaded bytes the manager reports for both model files.
struct ByteProgress {
    bytes: Arc<AtomicU64>,
    total: u64,
}

impl ProgressSink for ByteProgress {
    fn on_progress(&self, progress: OperationProgress) {
        let done = match progress.phase {
            OperationPhase::Publishing => self.total,
            _ => progress.bytes_done.min(self.total),
        };
        self.bytes.store(done, Ordering::Relaxed);
    }
}

fn catalog_entry(model: &str) -> CommandResult<&'static F5ModelInfo> {
    f5_model_catalog()?
        .iter()
        .find(|entry| entry.id == model)
        .ok_or_else(|| CommandError::invalid_input("unsupported narration model"))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors are owned"
)]
pub(crate) fn f5_models_status(
    runtime: State<'_, F5ModelRuntime>,
) -> CommandResult<Vec<ModelStatus>> {
    let operation = runtime.operation()?;
    Ok(f5_model_catalog()?
        .iter()
        .map(|info| ModelStatus {
            info,
            installed: runtime.manager.is_installed(&info.id),
            operation: operation
                .as_ref()
                .filter(|active| active.model == info.id)
                .map(Operation::status),
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn f5_model_install(
    model: String,
    on_event: Channel<ModelEvent>,
    runtime: State<'_, F5ModelRuntime>,
    speech: State<'_, SpeechRuntime>,
) -> CommandResult<()> {
    let total = catalog_entry(&model)?.download_bytes;
    if runtime.manager.is_installed(&model) {
        return Ok(());
    }
    let id = uuid::Uuid::now_v7().to_string();
    let bytes = Arc::new(AtomicU64::new(0));
    let cancellation = CancellationToken::default();
    {
        let mut slot = runtime.operation()?;
        if slot.is_some() {
            return Err(CommandError::invalid_input(
                "another model operation is running",
            ));
        }
        *slot = Some(Operation {
            id: id.clone(),
            model: model.clone(),
            bytes: Arc::clone(&bytes),
            total,
            cancellation: cancellation.clone(),
        });
    }
    let reporter = {
        let (bytes, model, channel) = (Arc::clone(&bytes), model.clone(), on_event.clone());
        tokio::spawn(async move {
            loop {
                let operation = progress_status(&id, &model, &bytes, total);
                let _ = channel.send(ModelEvent::Progress { operation });
                tokio::time::sleep(PROGRESS_INTERVAL).await;
            }
        })
    };
    let manager = runtime.manager.clone();
    let (work_model, work_cancellation) = (model.clone(), cancellation.clone());
    let result = run_blocking("F5 model install", move || {
        manager.install(
            &work_model,
            &work_cancellation,
            &ByteProgress { bytes, total },
        )
    })
    .await;
    reporter.abort();
    runtime.operation()?.take();
    match result {
        Err(_) if cancellation.is_cancelled() => {
            let _ = on_event.send(ModelEvent::Cancelled { model });
            Ok(())
        }
        Err(error) => Err(error),
        Ok(()) => {
            speech.reload_f5_models()?;
            let _ = on_event.send(ModelEvent::Completed { model });
            Ok(())
        }
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command extractors are owned"
)]
pub(crate) fn f5_model_cancel(
    model: String,
    runtime: State<'_, F5ModelRuntime>,
) -> CommandResult<()> {
    let slot = runtime.operation()?;
    let operation = slot
        .as_ref()
        .filter(|operation| operation.model == model)
        .ok_or_else(|| CommandError::invalid_input("model operation not found"))?;
    operation.cancellation.cancel();
    Ok(())
}

#[tauri::command]
pub(crate) async fn f5_model_remove(
    model: String,
    runtime: State<'_, F5ModelRuntime>,
    speech: State<'_, SpeechRuntime>,
) -> CommandResult<()> {
    catalog_entry(&model)?;
    if runtime.operation()?.is_some() {
        return Err(CommandError::invalid_input(
            "another model operation is running",
        ));
    }
    let manager = runtime.manager.clone();
    let outcome = run_blocking("F5 model removal", move || {
        manager.remove(&model, &CancellationToken::default())
    })
    .await?;
    if outcome == RemovalOutcome::PreservedModified {
        return Err(PackageError::InvalidInstall.into());
    }
    speech.reload_f5_models()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech::F5_MODEL_IDS;

    #[test]
    fn the_reviewed_catalog_matches_the_worker_and_request_validation() {
        let catalog = f5_model_catalog().unwrap();
        assert_eq!(catalog.len(), 8);
        let worker = std::str::from_utf8(crate::speech::WORKER_BYTES).unwrap();
        for model in catalog {
            assert!(F5_MODEL_IDS.contains(&model.id.as_str()), "{}", model.id);
            assert!(worker.contains(&model.id), "{}", model.id);
        }
    }

    #[test]
    fn status_rows_keep_the_frontend_contract() {
        let info = &f5_model_catalog().unwrap()[0];
        let row = serde_json::to_value(ModelStatus {
            info,
            installed: false,
            operation: None,
        })
        .unwrap();
        let mut keys = row.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            [
                "architecture",
                "author",
                "downloadBytes",
                "id",
                "installed",
                "language",
                "license",
                "name",
                "operation",
                "revision"
            ]
        );
    }
}
