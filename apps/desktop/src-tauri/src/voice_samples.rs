use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, RwLock};

use osg_engine_packages::{
    AssetPackageManager, AssetPackageStatus, CancellationToken, InstalledAssetRuntime,
    OperationProgress, PackageError, PackageState, ProgressSink, RemovalOutcome,
};
use osg_media_server::{MediaServer, RegisteredMedia};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::error::{CommandError, CommandResult};

#[derive(Clone)]
pub(crate) struct VoiceSampleRuntime(Arc<RuntimeInner>);

struct RuntimeInner {
    manager: RwLock<Option<AssetPackageManager>>,
    media_server: MediaServer,
    active: Mutex<HashMap<String, ActiveSample>>,
    operation: Mutex<()>,
    cancellation: Mutex<Option<CancellationToken>>,
}

struct ActiveSample {
    _package: InstalledAssetRuntime,
    playback: RegisteredMedia,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceSampleProgress {
    phase: osg_engine_packages::OperationPhase,
    bytes_done: u64,
    total_bytes: u64,
    basis_points: u16,
}

struct ChannelProgress(Channel<VoiceSampleProgress>);

impl ProgressSink for ChannelProgress {
    fn on_progress(&self, progress: OperationProgress) {
        let _ = self.0.send(VoiceSampleProgress {
            phase: progress.phase,
            bytes_done: progress.bytes_done,
            total_bytes: progress.total_bytes,
            basis_points: overall_basis_points(progress),
        });
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
    pub(crate) fn new(
        root: &std::path::Path,
        media_server: MediaServer,
    ) -> Result<Self, PackageError> {
        let runtime = Self(Arc::new(RuntimeInner {
            manager: RwLock::new(None),
            media_server,
            active: Mutex::new(HashMap::new()),
            operation: Mutex::new(()),
            cancellation: Mutex::new(None),
        }));
        let weak = Arc::downgrade(&runtime.0);
        let manager = AssetPackageManager::new(
            root,
            Arc::new(move || {
                weak.upgrade()
                    .ok_or(PackageError::StoreUnavailable)?
                    .quiesce()
            }),
        )?;
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

    fn resolve(
        &self,
        voice: &str,
        on_event: Channel<VoiceSampleProgress>,
    ) -> CommandResult<RegisteredMedia> {
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
        let cancellation = CancellationToken::default();
        let progress = ChannelProgress(on_event);
        if !matches!(manager.status().state, PackageState::Installed) {
            manager.install(&cancellation, &progress)?;
        }
        let package = manager.resolve(&cancellation)?;
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

    fn install(&self, on_event: Channel<VoiceSampleProgress>) -> CommandResult<AssetPackageStatus> {
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?;
        let manager = self.manager()?;
        let cancellation = CancellationToken::default();
        *self
            .0
            .cancellation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)? = Some(cancellation.clone());
        let result = manager
            .install(&cancellation, &ChannelProgress(on_event))
            .map_err(CommandError::from);
        self.0
            .cancellation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?
            .take();
        result
    }

    fn remove(&self, on_event: Channel<VoiceSampleProgress>) -> CommandResult<AssetPackageStatus> {
        let _operation = self
            .0
            .operation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?;
        let manager = self.manager()?;
        let cancellation = CancellationToken::default();
        *self
            .0
            .cancellation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)? = Some(cancellation.clone());
        let result = manager.remove(&cancellation, &ChannelProgress(on_event));
        self.0
            .cancellation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?
            .take();
        let outcome = result?;
        if matches!(outcome, RemovalOutcome::PreservedModified) {
            return Err(PackageError::InvalidInstall.into());
        }
        Ok(manager.status())
    }

    fn cancel(&self) -> CommandResult<bool> {
        let cancellation = self
            .0
            .cancellation
            .lock()
            .map_err(|_| PackageError::StoreUnavailable)?
            .clone();
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
            return Ok(true);
        }
        Ok(false)
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
    voice_id: String,
    on_event: Channel<VoiceSampleProgress>,
) -> CommandResult<RegisteredMedia> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.resolve(&voice_id, on_event))
        .await
        .map_err(|_| CommandError::from(PackageError::StoreUnavailable))?
}

#[tauri::command]
pub(crate) async fn voice_samples_install(
    runtime: State<'_, VoiceSampleRuntime>,
    on_event: Channel<VoiceSampleProgress>,
) -> CommandResult<AssetPackageStatus> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.install(on_event))
        .await
        .map_err(|_| CommandError::from(PackageError::StoreUnavailable))?
}

#[tauri::command]
pub(crate) async fn voice_samples_remove(
    runtime: State<'_, VoiceSampleRuntime>,
    on_event: Channel<VoiceSampleProgress>,
) -> CommandResult<AssetPackageStatus> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.remove(on_event))
        .await
        .map_err(|_| CommandError::from(PackageError::StoreUnavailable))?
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri state is an IPC extractor and must be passed by value"
)]
pub(crate) fn voice_samples_cancel(runtime: State<'_, VoiceSampleRuntime>) -> CommandResult<bool> {
    runtime.cancel()
}

#[cfg(test)]
mod tests {
    use osg_engine_packages::{OperationPhase, OperationProgress};

    use super::overall_basis_points;

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
}
