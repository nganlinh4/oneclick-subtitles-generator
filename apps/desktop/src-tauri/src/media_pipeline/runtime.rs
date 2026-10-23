//! Media pipeline runtime: playback registry, admission slots and job finalization.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use osg_domain::{AssetId, JobId, MediaAsset};
use osg_media_pipeline::{MediaPipeline, PipelineError};
use osg_media_server::{MediaServer, RegisteredMedia};
use osg_runtime_staging::RuntimeStagingAuthority;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::{MAX_CONCURRENT_OPERATIONS, MAX_PIPELINE_PLAYBACKS};
use crate::error::{CommandError, CommandResult};

#[derive(Clone)]
pub(crate) struct MediaPipelineRuntime {
    pub(super) pipeline: Arc<RwLock<Option<MediaPipeline>>>,
    staging_root: PathBuf,
    staging_authority: RuntimeStagingAuthority,
    media_server: MediaServer,
    pub(super) slots: Arc<SlotLimiter>,
    pub(super) jobs: Arc<RuntimeJobs>,
    playbacks: Arc<Mutex<PlaybackRegistry>>,
}

impl MediaPipelineRuntime {
    pub(crate) fn new(
        engine: Option<osg_media::MediaEngine>,
        staging_root: impl AsRef<Path>,
        staging_authority: RuntimeStagingAuthority,
        media_server: MediaServer,
    ) -> Result<Self, PipelineError> {
        let staging_root = staging_root.as_ref().to_owned();
        let pipeline = engine
            .map(|engine| {
                MediaPipeline::with_staging_authority(
                    engine,
                    &staging_root,
                    staging_authority.clone(),
                )
            })
            .transpose()?;
        Ok(Self {
            pipeline: Arc::new(RwLock::new(pipeline)),
            staging_root,
            staging_authority,
            media_server,
            slots: SlotLimiter::new(MAX_CONCURRENT_OPERATIONS),
            jobs: Arc::new(RuntimeJobs::default()),
            playbacks: Arc::new(Mutex::new(PlaybackRegistry::default())),
        })
    }

    pub(super) fn pipeline(&self) -> CommandResult<MediaPipeline> {
        self.pipeline
            .read()
            .map_err(|_| CommandError::internal("The media pipeline runtime is unavailable."))?
            .clone()
            .ok_or_else(CommandError::media_tools_unavailable)
    }

    pub(crate) fn refresh(&self, engine: Option<osg_media::MediaEngine>) -> CommandResult<()> {
        let pipeline = engine
            .map(|engine| {
                MediaPipeline::with_staging_authority(
                    engine,
                    &self.staging_root,
                    self.staging_authority.clone(),
                )
            })
            .transpose()?;
        *self
            .pipeline
            .write()
            .map_err(|_| CommandError::internal("The media pipeline runtime is unavailable."))? =
            pipeline;
        Ok(())
    }

    pub(crate) fn is_idle(&self) -> bool {
        self.slots.active.load(Ordering::Acquire) == 0
    }

    pub(super) fn register_playback(
        &self,
        asset: &MediaAsset,
        path: &Path,
    ) -> CommandResult<RegisteredMedia> {
        let mut playbacks = self
            .playbacks
            .lock()
            .map_err(|_| CommandError::internal("The media playback registry is unavailable."))?;
        if let Some(existing) = playbacks.by_asset.get(&asset.id()) {
            return Ok(existing.clone());
        }
        while playbacks.by_asset.len() >= MAX_PIPELINE_PLAYBACKS {
            let Some(oldest) = playbacks.order.pop_front() else {
                return Err(CommandError::internal(
                    "The media playback registry is inconsistent.",
                ));
            };
            if let Some(previous) = playbacks.by_asset.remove(&oldest) {
                let _ = self.media_server.unregister(previous.id);
            }
        }
        let registered = self
            .media_server
            .register_with_extension(path, asset.extension())?;
        playbacks.order.push_back(asset.id());
        playbacks.by_asset.insert(asset.id(), registered.clone());
        Ok(registered)
    }
}

impl fmt::Debug for MediaPipelineRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaPipelineRuntime")
            .field(
                "available",
                &self
                    .pipeline
                    .read()
                    .is_ok_and(|pipeline| pipeline.is_some()),
            )
            .field("slots", &self.slots)
            .field("jobs", &self.jobs)
            .field("media_server", &self.media_server)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Default)]
pub(super) struct PlaybackRegistry {
    by_asset: HashMap<AssetId, RegisteredMedia>,
    order: VecDeque<AssetId>,
}

#[derive(Debug)]
pub(super) struct SlotLimiter {
    active: AtomicUsize,
    semaphore: Arc<Semaphore>,
}

impl SlotLimiter {
    pub(super) fn new(maximum: usize) -> Arc<Self> {
        Arc::new(Self {
            active: AtomicUsize::new(0),
            semaphore: Arc::new(Semaphore::new(maximum)),
        })
    }

    pub(super) async fn acquire(self: &Arc<Self>) -> Option<SlotPermit> {
        let permit = Arc::clone(&self.semaphore).acquire_owned().await.ok()?;
        self.active.fetch_add(1, Ordering::AcqRel);
        Some(SlotPermit {
            limiter: Arc::clone(self),
            _permit: permit,
        })
    }
}

#[derive(Debug)]
pub(super) struct SlotPermit {
    limiter: Arc<SlotLimiter>,
    pub(super) _permit: OwnedSemaphorePermit,
}

impl Drop for SlotPermit {
    fn drop(&mut self) {
        self.limiter.active.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Debug, Default)]
pub(super) struct RuntimeJobs {
    pub(super) state: Mutex<RuntimeJobState>,
}

#[derive(Debug, Default)]
pub(super) struct RuntimeJobState {
    pub(super) owned: HashSet<JobId>,
    finalizing: HashSet<JobId>,
}

impl RuntimeJobs {
    pub(super) fn remember(&self, job_id: JobId) -> CommandResult<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| CommandError::internal("The media job registry is unavailable."))?;
        if !state.owned.insert(job_id) {
            return Err(CommandError::internal(
                "The media job was registered more than once.",
            ));
        }
        Ok(())
    }

    pub(super) fn begin_finalization(
        self: &Arc<Self>,
        job_id: JobId,
    ) -> CommandResult<FinalizationPermit> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| CommandError::internal("The media job registry is unavailable."))?;
        if !state.owned.contains(&job_id) || !state.finalizing.insert(job_id) {
            return Err(CommandError::internal(
                "The media operation cannot enter finalization.",
            ));
        }
        Ok(FinalizationPermit {
            jobs: Arc::clone(self),
            job_id,
        })
    }

    pub(super) fn run_if_cancellable<T>(
        &self,
        job_id: JobId,
        operation: impl FnOnce() -> CommandResult<T>,
    ) -> CommandResult<T> {
        let state = self
            .state
            .lock()
            .map_err(|_| CommandError::internal("The media job registry is unavailable."))?;
        if !state.owned.contains(&job_id) {
            return Err(CommandError::invalid_input(
                "The job is not owned by the native media pipeline.",
            ));
        }
        if state.finalizing.contains(&job_id) {
            return Err(CommandError::invalid_input(
                "The media operation is already being finalized.",
            ));
        }
        let result = operation();
        drop(state);
        result
    }
}

pub(super) struct FinalizationPermit {
    pub(super) jobs: Arc<RuntimeJobs>,
    pub(super) job_id: JobId,
}

impl Drop for FinalizationPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.jobs.state.lock() {
            state.finalizing.remove(&self.job_id);
        }
    }
}
