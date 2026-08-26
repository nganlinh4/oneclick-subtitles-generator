use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, RwLock};

use osg_engine_packages::{
    AssetPackageManager, AssetPackageStatus, CancellationToken, InstalledAssetRuntime,
    OperationProgress, PackageError, PackageState, ProgressSink, RemovalOutcome,
};
use osg_media_server::{MediaServer, RegisteredMedia};
use osg_runtime_staging::RuntimeStagingAuthority;
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;
use uuid::{Uuid, Version};

use crate::error::{CommandError, CommandResult};

#[derive(Clone)]
pub(crate) struct VoiceSampleRuntime(Arc<RuntimeInner>);

struct RuntimeInner {
    manager: RwLock<Option<AssetPackageManager>>,
    media_server: MediaServer,
    active: Mutex<HashMap<String, ActiveSample>>,
    operation: Mutex<()>,
    cancellation: Mutex<CancellationState>,
}

#[derive(Default)]
struct CancellationState {
    next_generation: u64,
    active: Option<ActiveCancellation>,
}

struct ActiveCancellation {
    generation: u64,
    operation_id: Uuid,
    token: CancellationToken,
}

struct CancellationLease {
    owner: Arc<RuntimeInner>,
    generation: u64,
    token: CancellationToken,
}

impl CancellationState {
    fn begin(&mut self, operation_id: Uuid) -> Result<(u64, CancellationToken), PackageError> {
        let operation_id = require_operation_id(operation_id)?;
        let generation = self
            .next_generation
            .checked_add(1)
            .ok_or(PackageError::StoreUnavailable)?;
        self.next_generation = generation;
        let token = CancellationToken::default();
        self.active = Some(ActiveCancellation {
            generation,
            operation_id,
            token: token.clone(),
        });
        Ok((generation, token))
    }

    fn clear_if_current(&mut self, generation: u64) {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.generation == generation)
        {
            self.active = None;
        }
    }

    fn cancel_owned(&self, operation_id: Uuid) -> bool {
        let Some(active) = self
            .active
            .as_ref()
            .filter(|active| active.operation_id == operation_id)
        else {
            return false;
        };
        active.token.cancel();
        true
    }
}

impl CancellationLease {
    fn token(&self) -> &CancellationToken {
        &self.token
    }
}

impl Drop for CancellationLease {
    fn drop(&mut self) {
        if let Ok(mut cancellation) = self.owner.cancellation.lock() {
            cancellation.clear_if_current(self.generation);
        }
    }
}

struct ActiveSample {
    _package: InstalledAssetRuntime,
    playback: RegisteredMedia,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceSampleProgress {
    operation_id: Uuid,
    phase: osg_engine_packages::OperationPhase,
    bytes_done: u64,
    total_bytes: u64,
    basis_points: u16,
}

struct ChannelProgress {
    operation_id: Uuid,
    channel: Channel<VoiceSampleProgress>,
}

impl ProgressSink for ChannelProgress {
    fn on_progress(&self, progress: OperationProgress) {
        let _ = self.channel.send(VoiceSampleProgress {
            operation_id: self.operation_id,
            phase: progress.phase,
            bytes_done: progress.bytes_done,
            total_bytes: progress.total_bytes,
            basis_points: overall_basis_points(progress),
        });
    }
}

fn require_operation_id(operation_id: Uuid) -> Result<Uuid, PackageError> {
    if operation_id.get_version() == Some(Version::SortRand) {
        Ok(operation_id)
    } else {
        Err(PackageError::InvalidRequest)
    }
}

fn overall_basis_points(progress: OperationProgress) -> u16 {
    use osg_engine_packages::OperationPhase;

    let (start, width) = match progress.phase {
        OperationPhase::Preparing => (0_u32, 500_u32),
        OperationPhase::Downloading => (500, 6_000),
        OperationPhase::Verifying => (6_500, 1_000),
        OperationPhase::Extracting => (7_500, 2_000),
        OperationPhase::Publishing => (9_500, 500),
        OperationPhase::Removing => (0, 10_000),
    };
    u16::try_from(start + u32::from(progress.basis_points) * width / 10_000).unwrap_or(10_000)
}

impl VoiceSampleRuntime {
    /// The manager prepares its staging authority inside the store root, so an interrupted
    /// install's journal can never be separated from the `.staging` entry it owns.
    pub(crate) fn new(
        root: &std::path::Path,
        media_server: MediaServer,
    ) -> Result<Self, PackageError> {
        Self::new_inner(root, media_server, None)
    }

    fn new_inner(
        root: &std::path::Path,
        media_server: MediaServer,
        staging_authority: Option<RuntimeStagingAuthority>,
    ) -> Result<Self, PackageError> {
        let runtime = Self(Arc::new(RuntimeInner {
            manager: RwLock::new(None),
            media_server,
            active: Mutex::new(HashMap::new()),
            operation: Mutex::new(()),
            cancellation: Mutex::new(CancellationState::default()),
        }));
        let weak = Arc::downgrade(&runtime.0);
        let quiesce: Arc<dyn Fn() -> Result<(), PackageError> + Send + Sync> =
            Arc::new(move || {
                weak.upgrade()
                    .ok_or(PackageError::StoreUnavailable)?
                    .quiesce()
            });
        let manager = match staging_authority {
            Some(authority) => {
                AssetPackageManager::new_with_staging_authority(root, quiesce, authority)?
            }
            None => AssetPackageManager::new(root, quiesce)?,
        };
        *runtime
            .0
            .manager
            .write()
            .map_err(|_| PackageError::StoreUnavailable)? = Some(manager);
        Ok(runtime)
    }

    fn manager(&self) -> Result<AssetPackageManager, PackageError> {
        self.0
            .manager
            .read()
            .map_err(|_| PackageError::StoreUnavailable)?
            .clone()
            .ok_or(PackageError::StoreUnavailable)
    }

    fn status(&self) -> CommandResult<AssetPackageStatus> {
        Ok(self.manager()?.status())
    }

    fn begin_cancellation(&self, operation_id: Uuid) -> Result<CancellationLease, PackageError> {
        let (generation, token) = self
            .0
            .cancellation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?
            .begin(operation_id)?;
        Ok(CancellationLease {
            owner: Arc::clone(&self.0),
            generation,
            token,
        })
    }

    fn resolve(
        &self,
        operation_id: Uuid,
        voice: &str,
        on_event: Channel<VoiceSampleProgress>,
    ) -> CommandResult<RegisteredMedia> {
        let operation_id = require_operation_id(operation_id)?;
        let voice = voice.to_ascii_lowercase();
        if voice.len() > 32 || !osg_engine_packages::VOICE_SAMPLE_IDS.contains(&voice.as_str()) {
            return Err(PackageError::InvalidRequest.into());
        }
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?;
        if let Some(sample) = self
            .0
            .active
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?
            .get(&voice)
        {
            return Ok(sample.playback.clone());
        }

        let manager = self.manager()?;
        let cancellation = self.begin_cancellation(operation_id)?;
        let progress = ChannelProgress {
            operation_id,
            channel: on_event,
        };
        if !matches!(manager.status().state, PackageState::Installed) {
            manager.install(cancellation.token(), &progress)?;
        }
        let package = manager.resolve(cancellation.token())?;
        let path = package.voice_sample(&voice)?;
        let playback = self
            .0
            .media_server
            .register_with_mime_type(&path, "audio/wav")?;
        self.0
            .active
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?
            .insert(
                voice,
                ActiveSample {
                    _package: package,
                    playback: playback.clone(),
                },
            );
        Ok(playback)
    }

    fn install(
        &self,
        operation_id: Uuid,
        on_event: Channel<VoiceSampleProgress>,
    ) -> CommandResult<AssetPackageStatus> {
        let operation_id = require_operation_id(operation_id)?;
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?;
        let manager = self.manager()?;
        let cancellation = self.begin_cancellation(operation_id)?;
        manager
            .install(
                cancellation.token(),
                &ChannelProgress {
                    operation_id,
                    channel: on_event,
                },
            )
            .map_err(CommandError::from)
    }

    fn remove(
        &self,
        operation_id: Uuid,
        on_event: Channel<VoiceSampleProgress>,
    ) -> CommandResult<AssetPackageStatus> {
        let operation_id = require_operation_id(operation_id)?;
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?;
        let manager = self.manager()?;
        let cancellation = self.begin_cancellation(operation_id)?;
        let result = manager.remove(
            cancellation.token(),
            &ChannelProgress {
                operation_id,
                channel: on_event,
            },
        );
        let outcome = result?;
        if matches!(outcome, RemovalOutcome::PreservedModified) {
            return Err(PackageError::InvalidInstall.into());
        }
        Ok(manager.status())
    }

    fn cancel(&self, operation_id: Uuid) -> CommandResult<bool> {
        let operation_id = require_operation_id(operation_id)?;
        let cancellation = self
            .0
            .cancellation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?;
        Ok(cancellation.cancel_owned(operation_id))
    }
}

impl RuntimeInner {
    fn quiesce(&self) -> Result<(), PackageError> {
        let active = std::mem::take(
            &mut *self
                .active
                .lock()
                .map_err(|_| PackageError::StoreUnavailable)?,
        );
        for sample in active.into_values() {
            let _ = self.media_server.unregister(sample.playback.id);
        }
        Ok(())
    }
}

impl fmt::Debug for VoiceSampleRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VoiceSampleRuntime")
            .finish_non_exhaustive()
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri state is an IPC extractor and must be passed by value"
)]
pub(crate) fn voice_samples_status(
    runtime: State<'_, VoiceSampleRuntime>,
) -> CommandResult<AssetPackageStatus> {
    runtime.status()
}

#[tauri::command]
pub(crate) async fn voice_sample_resolve(
    runtime: State<'_, VoiceSampleRuntime>,
    operation_id: Uuid,
    voice_id: String,
    on_event: Channel<VoiceSampleProgress>,
) -> CommandResult<RegisteredMedia> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.resolve(operation_id, &voice_id, on_event))
        .await
        .map_err(|_| CommandError::from(PackageError::StoreUnavailable))?
}

#[tauri::command]
pub(crate) async fn voice_samples_install(
    runtime: State<'_, VoiceSampleRuntime>,
    operation_id: Uuid,
    on_event: Channel<VoiceSampleProgress>,
) -> CommandResult<AssetPackageStatus> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.install(operation_id, on_event))
        .await
        .map_err(|_| CommandError::from(PackageError::StoreUnavailable))?
}

#[tauri::command]
pub(crate) async fn voice_samples_remove(
    runtime: State<'_, VoiceSampleRuntime>,
    operation_id: Uuid,
    on_event: Channel<VoiceSampleProgress>,
) -> CommandResult<AssetPackageStatus> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.remove(operation_id, on_event))
        .await
        .map_err(|_| CommandError::from(PackageError::StoreUnavailable))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri state is an IPC extractor and must be passed by value"
)]
pub(crate) fn voice_samples_cancel(
    runtime: State<'_, VoiceSampleRuntime>,
    operation_id: Uuid,
) -> CommandResult<bool> {
    runtime.cancel(operation_id)
}

#[cfg(test)]
mod tests {
    use osg_engine_packages::{OperationPhase, OperationProgress};
    use osg_media_server::MediaServer;

    use super::{CancellationState, VoiceSampleProgress, VoiceSampleRuntime, overall_basis_points};

    #[test]
    fn package_phase_progress_is_monotonic_for_the_webview() {
        let phases = [
            OperationPhase::Preparing,
            OperationPhase::Downloading,
            OperationPhase::Verifying,
            OperationPhase::Extracting,
            OperationPhase::Publishing,
        ];
        let values = phases
            .into_iter()
            .flat_map(|phase| {
                [0_u16, 5_000, 10_000].map(move |basis_points| {
                    overall_basis_points(OperationProgress {
                        phase,
                        basis_points,
                        bytes_done: u64::from(basis_points),
                        total_bytes: 10_000,
                    })
                })
            })
            .collect::<Vec<_>>();
        assert!(values.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(values.first(), Some(&0));
        assert_eq!(values.last(), Some(&10_000));
    }

    #[test]
    fn progress_wire_shape_carries_the_exact_operation_owner() {
        let operation_id = uuid::Uuid::now_v7();
        let wire = serde_json::to_value(VoiceSampleProgress {
            operation_id,
            phase: OperationPhase::Downloading,
            bytes_done: 5,
            total_bytes: 10,
            basis_points: 5_000,
        })
        .expect("serialize progress");

        assert_eq!(
            wire.get("operationId").and_then(serde_json::Value::as_str),
            Some(operation_id.to_string().as_str())
        );
        assert!(wire.get("operation_id").is_none());
    }

    #[test]
    fn stale_cancellation_cleanup_cannot_clear_or_cancel_a_replacement() {
        let mut state = CancellationState::default();
        let first_operation_id = uuid::Uuid::now_v7();
        let second_operation_id = uuid::Uuid::now_v7();
        let (first_generation, first) =
            state.begin(first_operation_id).expect("first cancellation");
        let (second_generation, second) = state
            .begin(second_operation_id)
            .expect("replacement cancellation");

        state.clear_if_current(first_generation);
        assert!(!state.cancel_owned(first_operation_id));
        assert!(!first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(state.cancel_owned(second_operation_id));
        assert!(second.is_cancelled());

        state.clear_if_current(second_generation);
        assert!(!state.cancel_owned(second_operation_id));
    }

    #[test]
    fn cancellation_command_reaches_and_releases_the_runtime_lease() {
        let temporary = tempfile::tempdir().expect("voice sample root");
        let media_server =
            MediaServer::start(std::iter::empty()).expect("voice sample media server");
        let runtime =
            VoiceSampleRuntime::new(temporary.path(), media_server).expect("voice sample runtime");
        let operation_id = uuid::Uuid::now_v7();
        let cancellation = runtime
            .begin_cancellation(operation_id)
            .expect("resolve cancellation lease");

        assert!(
            runtime
                .cancel(operation_id)
                .expect("cancel resolve operation")
        );
        assert!(cancellation.token().is_cancelled());
        drop(cancellation);
        assert!(
            !runtime
                .cancel(operation_id)
                .expect("released resolve operation")
        );
    }
}
