//! The shared render state: the concurrency bound, the staging root and the playback registry.
//!
//! It also still holds the managed Remotion runtime — the package manager, the lease, the worker
//! candidates and the media tool it needed. **None of that is on the export path any more.**
//! `render_start` exports through `osg-export`; what is kept here is the readiness machinery
//! `crate::render_packages` drives from the settings surface, which is not this wave's to change.
//! Deleting it is the next step, and it is a smaller one now that nothing depends on it running.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};

use osg_domain::{AssetId, MediaAsset};
use osg_engine_packages::{
    CancellationToken as PackageCancellationToken, InstalledRenderRuntime, PackageError,
    RenderPackageId, RenderPackageManager, RenderRuntimeCoordinator,
};
use osg_media_server::{MediaServer, RegisteredMedia};
use osg_render::{RenderEngine, RenderRuntime};
use uuid::Uuid;

use crate::error::{CommandError, CommandResult};

/// The managed worker payload, kept so the readiness check still resolves a real runtime.
const WORKER_BYTES: &[u8] =
    include_bytes!("../../../../../video-renderer/worker/osg_render_worker.mjs");
/// How many renders may run at once. The `WebView` asserts this is one.
pub(super) const MAX_CONCURRENT_RENDERS: usize = 1;
/// How many finished renders keep a live playback capability.
const MAX_RENDER_PLAYBACKS: usize = 32;

#[derive(Clone)]
pub(crate) struct RenderRuntimeHost {
    inner: Arc<RenderRuntimeInner>,
}

struct RenderRuntimeInner {
    engine: RwLock<Option<LoadedRenderEngine>>,
    unavailable_reason: RwLock<Option<&'static str>>,
    package_manager: RwLock<Option<RenderPackageManager>>,
    worker_candidates: Vec<PathBuf>,
    ffmpeg: RwLock<Option<PathBuf>>,
    staging_root: PathBuf,
    media_server: MediaServer,
    slots: Arc<SlotLimiter>,
    playbacks: Mutex<PlaybackRegistry>,
}

struct LoadedRenderEngine {
    /// Loaded and leased by the readiness check, and never driven.
    #[allow(
        dead_code,
        reason = "the managed worker is off the export path; deleting it is a separate step"
    )]
    engine: RenderEngine,
    _lease: Option<InstalledRenderRuntime>,
}

#[derive(Clone)]
pub(crate) struct RenderPackageCoordinator(Weak<RenderRuntimeInner>);

impl RenderRuntimeCoordinator for RenderPackageCoordinator {
    fn quiesce(&self, _: RenderPackageId) -> osg_engine_packages::Result<()> {
        let inner = self.upgrade()?;
        if inner.slots.active.load(Ordering::Acquire) != 0 {
            return Err(PackageError::RuntimeBusy);
        }
        *inner
            .engine
            .write()
            .map_err(|_| PackageError::StoreUnavailable)? = None;
        *inner
            .unavailable_reason
            .write()
            .map_err(|_| PackageError::StoreUnavailable)? = Some("runtimePayloadUnavailable");
        Ok(())
    }
}

impl RenderPackageCoordinator {
    fn upgrade(&self) -> osg_engine_packages::Result<Arc<RenderRuntimeInner>> {
        self.0.upgrade().ok_or(PackageError::StoreUnavailable)
    }
}

impl RenderRuntimeHost {
    pub(crate) fn new(
        cache_root: impl AsRef<Path>,
        resource_root: Option<&Path>,
        ffmpeg: Option<PathBuf>,
        media_server: MediaServer,
    ) -> std::io::Result<Self> {
        let staging_root = cache_root.as_ref().join("v1/render");
        fs::create_dir_all(&staging_root)?;
        let worker_candidates = worker_candidates(resource_root);
        Ok(Self {
            inner: Arc::new(RenderRuntimeInner {
                engine: RwLock::new(None),
                unavailable_reason: RwLock::new(Some("runtimePayloadUnavailable")),
                package_manager: RwLock::new(None),
                worker_candidates,
                ffmpeg: RwLock::new(ffmpeg),
                staging_root,
                media_server,
                slots: SlotLimiter::new(MAX_CONCURRENT_RENDERS),
                playbacks: Mutex::new(PlaybackRegistry::default()),
            }),
        })
    }

    /// Where an export may create its own staging directory.
    pub(super) fn staging_root(&self) -> PathBuf {
        self.inner.staging_root.clone()
    }

    /// Takes the one render slot, or refuses.
    pub(super) fn acquire_slot(&self) -> Option<SlotPermit> {
        self.inner.slots.acquire()
    }

    pub(crate) fn package_coordinator(&self) -> RenderPackageCoordinator {
        RenderPackageCoordinator(Arc::downgrade(&self.inner))
    }

    pub(crate) fn refresh_media_tool(&self, ffmpeg: Option<PathBuf>) -> CommandResult<()> {
        let changed = {
            let mut current = self
                .inner
                .ffmpeg
                .write()
                .map_err(|_| CommandError::internal("The native media tool is unavailable."))?;
            if *current == ffmpeg {
                false
            } else {
                *current = ffmpeg;
                true
            }
        };
        if !changed {
            return Ok(());
        }
        if self
            .inner
            .package_manager
            .read()
            .map_err(|_| CommandError::internal("The render package manager is unavailable."))?
            .is_some()
        {
            self.refresh_managed()?;
        }
        Ok(())
    }

    pub(crate) fn is_idle(&self) -> bool {
        self.inner.slots.active.load(Ordering::Acquire) == 0
    }

    pub(crate) fn attach_package_manager(
        &self,
        manager: RenderPackageManager,
    ) -> CommandResult<()> {
        let mut slot =
            self.inner.package_manager.write().map_err(|_| {
                CommandError::internal("The render package manager is unavailable.")
            })?;
        if slot.is_some() {
            return Err(CommandError::internal(
                "The render package manager is already attached.",
            ));
        }
        *slot = Some(manager);
        *self
            .inner
            .unavailable_reason
            .write()
            .map_err(|_| CommandError::internal("The render runtime is unavailable."))? =
            Some("runtimePayloadVerifying");
        Ok(())
    }

    pub(crate) fn refresh_managed(&self) -> CommandResult<()> {
        let manager = self
            .inner
            .package_manager
            .read()
            .map_err(|_| CommandError::internal("The render package manager is unavailable."))?
            .clone()
            .ok_or_else(|| CommandError::internal("The render package manager is unavailable."))?;
        let installed =
            match manager.resolve_for_launch(&PackageCancellationToken::default()) {
                Ok(runtime) => runtime,
                Err(PackageError::InvalidInstall | PackageError::DeliveryUnavailable) => {
                    *self.inner.engine.write().map_err(|_| {
                        CommandError::internal("The render runtime is unavailable.")
                    })? = None;
                    *self.inner.unavailable_reason.write().map_err(|_| {
                        CommandError::internal("The render runtime is unavailable.")
                    })? = Some("runtimePayloadUnavailable");
                    return Ok(());
                }
                Err(error) => return Err(error.into()),
            };
        let root = installed.package_root().join("runtime");
        let runtime = self
            .inner
            .worker_candidates
            .iter()
            .find_map(|worker| {
                RenderRuntime::load(&root, worker, WORKER_BYTES, runtime_target()).ok()
            })
            .ok_or_else(CommandError::render_runtime_unavailable)?;
        let available = self
            .inner
            .ffmpeg
            .read()
            .map_err(|_| CommandError::internal("The native media tool is unavailable."))?
            .is_some();
        *self
            .inner
            .engine
            .write()
            .map_err(|_| CommandError::internal("The render runtime is unavailable."))? = available
            .then_some(LoadedRenderEngine {
                engine: RenderEngine::new(runtime),
                _lease: Some(installed),
            });
        *self
            .inner
            .unavailable_reason
            .write()
            .map_err(|_| CommandError::internal("The render runtime is unavailable."))? =
            (!available).then_some("mediaToolsUnavailable");
        Ok(())
    }

    pub(super) fn register_playback(
        &self,
        asset: &MediaAsset,
        path: &Path,
    ) -> CommandResult<RegisteredMedia> {
        let mut playbacks =
            self.inner.playbacks.lock().map_err(|_| {
                CommandError::internal("The render playback registry is unavailable.")
            })?;
        if let Some(existing) = playbacks.by_asset.get(&asset.id()) {
            return Ok(existing.clone());
        }
        while playbacks.by_asset.len() >= MAX_RENDER_PLAYBACKS {
            let Some(oldest) = playbacks.order.pop_front() else {
                return Err(CommandError::internal(
                    "The render playback registry is inconsistent.",
                ));
            };
            if let Some(previous) = playbacks.by_asset.remove(&oldest) {
                let _ = self.inner.media_server.unregister(previous.id);
            }
        }
        let playback = self
            .inner
            .media_server
            .register_with_extension(path, asset.extension())?;
        playbacks.order.push_back(asset.id());
        playbacks.by_asset.insert(asset.id(), playback.clone());
        Ok(playback)
    }

    pub(super) fn release_playback(&self, playback_id: Uuid) -> CommandResult<bool> {
        let mut playbacks =
            self.inner.playbacks.lock().map_err(|_| {
                CommandError::internal("The render playback registry is unavailable.")
            })?;
        let asset_id = playbacks
            .by_asset
            .iter()
            .find_map(|(asset_id, playback)| (playback.id == playback_id).then_some(*asset_id));
        let Some(asset_id) = asset_id else {
            return Ok(false);
        };
        playbacks.by_asset.remove(&asset_id);
        playbacks.order.retain(|candidate| *candidate != asset_id);
        self.inner
            .media_server
            .unregister(playback_id)
            .map_err(Into::into)
    }

    /// Whether a managed Remotion payload is currently resolved, for the host's own tests.
    #[cfg(test)]
    pub(super) fn has_managed_payload(&self) -> bool {
        self.inner
            .engine
            .read()
            .is_ok_and(|engine| engine.is_some())
    }

    /// The reason the managed payload is unavailable, for the host's own tests.
    #[cfg(test)]
    pub(super) fn managed_reason(&self) -> Option<&'static str> {
        self.inner
            .unavailable_reason
            .read()
            .ok()
            .and_then(|reason| *reason)
    }
}

impl std::fmt::Debug for RenderRuntimeHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RenderRuntimeHost")
            .field(
                "managedPayload",
                &self
                    .inner
                    .engine
                    .read()
                    .is_ok_and(|engine| engine.is_some()),
            )
            .field(
                "reason",
                &self
                    .inner
                    .unavailable_reason
                    .read()
                    .ok()
                    .and_then(|reason| *reason),
            )
            .field("paths", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Default)]
struct PlaybackRegistry {
    by_asset: HashMap<AssetId, RegisteredMedia>,
    order: VecDeque<AssetId>,
}

#[derive(Debug)]
struct SlotLimiter {
    active: AtomicUsize,
    maximum: usize,
}

impl SlotLimiter {
    fn new(maximum: usize) -> Arc<Self> {
        Arc::new(Self {
            active: AtomicUsize::new(0),
            maximum,
        })
    }

    fn acquire(self: &Arc<Self>) -> Option<SlotPermit> {
        let mut observed = self.active.load(Ordering::Acquire);
        loop {
            if observed >= self.maximum {
                return None;
            }
            match self.active.compare_exchange_weak(
                observed,
                observed + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(SlotPermit {
                        limiter: Arc::clone(self),
                    });
                }
                Err(actual) => observed = actual,
            }
        }
    }
}

/// One running render, counted for as long as it is held.
#[derive(Debug)]
pub(super) struct SlotPermit {
    limiter: Arc<SlotLimiter>,
}

impl Drop for SlotPermit {
    fn drop(&mut self) {
        self.limiter.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn worker_candidates(resource_root: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = resource_root {
        candidates.push(root.join("workers/osg_render_worker.mjs"));
    }
    candidates
}

const fn runtime_target() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use osg_media_server::MediaServer;

    use super::{RenderRuntimeHost, SlotLimiter};

    #[test]
    fn the_managed_payload_is_absent_until_a_package_resolves_it() {
        let root = tempfile::tempdir().expect("root");
        let media_server = MediaServer::start(["tauri://localhost".to_owned()]).expect("server");
        let runtime =
            RenderRuntimeHost::new(root.path(), None, None, media_server).expect("runtime host");

        assert!(!runtime.has_managed_payload());
        assert_eq!(runtime.managed_reason(), Some("runtimePayloadUnavailable"));
        assert!(format!("{runtime:?}").contains("<redacted>"));
        assert!(!format!("{runtime:?}").contains(root.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn the_staging_root_is_created_and_never_rendered_into_a_debug() {
        let root = tempfile::tempdir().expect("root");
        let media_server = MediaServer::start(["tauri://localhost".to_owned()]).expect("server");
        let runtime =
            RenderRuntimeHost::new(root.path(), None, None, media_server).expect("runtime host");

        let staging = runtime.staging_root();
        assert!(staging.is_dir(), "the export needs a staging root to exist");
        assert!(!format!("{runtime:?}").contains(staging.to_string_lossy().as_ref()));
    }

    #[test]
    fn slot_limiter_releases_capacity_on_drop() {
        let limiter = SlotLimiter::new(1);
        let permit = limiter.acquire().expect("first permit");
        assert!(limiter.acquire().is_none());
        drop(permit);
        assert!(limiter.acquire().is_some());
    }
}
