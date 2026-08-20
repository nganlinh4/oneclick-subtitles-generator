//! The shared render state: the concurrency bound, the staging root and the playback registry.
//!
//! Everything an export needs that outlives a single command lives here, and nothing else does.
//! `render_start` exports through `osg-export`, so there is no managed payload to resolve, no
//! package-manager slot to fill and no worker to supervise.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use osg_domain::AssetId;
use osg_infrastructure::storage::ResolvedMedia;
use osg_media_server::{MediaServer, RegisteredMedia};
use uuid::Uuid;

use crate::error::{CommandError, CommandResult};

/// How many renders may run at once. The `WebView` asserts this is one.
pub(super) const MAX_CONCURRENT_RENDERS: usize = 1;
/// How many finished renders keep a live playback capability.
const MAX_RENDER_PLAYBACKS: usize = 32;

#[derive(Clone)]
pub(crate) struct RenderRuntimeHost {
    inner: Arc<RenderRuntimeInner>,
}

struct RenderRuntimeInner {
    staging_root: PathBuf,
    media_server: MediaServer,
    slots: Arc<SlotLimiter>,
    playbacks: Mutex<PlaybackRegistry>,
}

impl RenderRuntimeHost {
    pub(crate) fn new(
        cache_root: impl AsRef<Path>,
        media_server: MediaServer,
    ) -> std::io::Result<Self> {
        let staging_root = cache_root.as_ref().join("v1/render");
        fs::create_dir_all(&staging_root)?;
        Ok(Self {
            inner: Arc::new(RenderRuntimeInner {
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

    pub(crate) fn is_idle(&self) -> bool {
        self.inner.slots.active.load(Ordering::Acquire) == 0
    }

    pub(super) fn register_playback(
        &self,
        media: &ResolvedMedia,
    ) -> CommandResult<RegisteredMedia> {
        media.revalidate_verified_file()?;
        let asset = media.asset();
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
            .register_verified_file_with_extension(
                media.verified_file(),
                asset.extension(),
                asset.size_bytes(),
            )?;
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
}

impl std::fmt::Debug for RenderRuntimeHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RenderRuntimeHost")
            .field("idle", &self.is_idle())
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

#[cfg(test)]
mod tests {
    use osg_media_server::MediaServer;

    use super::{RenderRuntimeHost, SlotLimiter};

    #[test]
    fn the_staging_root_is_created_and_never_rendered_into_a_debug() {
        let root = tempfile::tempdir().expect("root");
        let media_server = MediaServer::start(["tauri://localhost".to_owned()]).expect("server");
        let runtime = RenderRuntimeHost::new(root.path(), media_server).expect("runtime host");

        let staging = runtime.staging_root();
        assert!(staging.is_dir(), "the export needs a staging root to exist");
        assert!(format!("{runtime:?}").contains("<redacted>"));
        assert!(!format!("{runtime:?}").contains(staging.to_string_lossy().as_ref()));
        assert!(!format!("{runtime:?}").contains(root.path().to_string_lossy().as_ref()));
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
