//! Download runtime: cache root, admission slots, finalization registry and engine resolution.

use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use osg_domain::JobId;
use osg_download::{
    DownloadDestination, DownloadEngine, DownloadError, FfmpegDirectory, InventoryRegistry,
    JsRuntimeResolver, JsRuntimeSearch, UrlPolicy, YtDlpSearch,
};
use osg_runtime_staging::{OwnedStagingDirectory, RuntimeStagingAuthority, StagingKind};
use uuid::Uuid;

#[cfg(feature = "e2e-automation")]
use super::EXACT_AUTOMATION_DOWNLOAD_URLS_ENV;
use super::{MAX_CONCURRENT_DOWNLOADS, MAX_CONCURRENT_INSPECTIONS};
use crate::diagnostics;
use crate::error::{CommandError, CommandResult};

#[derive(Clone)]
pub(super) struct DownloadCacheRoot {
    pub(super) path: PathBuf,
    authority: RuntimeStagingAuthority,
}

impl DownloadCacheRoot {
    fn prepare(cache_directory: &Path, authority: RuntimeStagingAuthority) -> Option<Self> {
        let root = cache_directory.join("downloads").join("v1");
        fs::create_dir_all(&root).ok()?;
        let root = fs::canonicalize(root).ok()?;
        if !root.is_dir() || authority.reconcile_all().is_err() {
            return None;
        }
        Some(Self {
            path: root,
            authority,
        })
    }

    pub(super) fn destination(
        &self,
        output_id: Uuid,
        suggested_name: &str,
    ) -> Result<(DownloadDestination, OutputDirectory), DownloadError> {
        let directory =
            OwnedStagingDirectory::begin(&self.authority, &self.path, StagingKind::Download)
                .map_err(|_| {
                    DownloadError::InvalidDestination("output directory could not be created")
                })?;
        // The externally supplied inventory title controls only the eventual leaf name. The
        // attempt directory itself is a locked, journaled capability whose random identifier is
        // independent of both the title and the WebView-provided inventory id.
        let _ = output_id;
        let destination =
            DownloadDestination::within_root(directory.path(), &self.path, suggested_name)?;
        Ok((
            destination,
            OutputDirectory {
                _directory: directory,
            },
        ))
    }
}

impl fmt::Debug for DownloadCacheRoot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("DownloadCacheRoot")
            .field(&"<redacted>")
            .finish()
    }
}

pub(super) struct OutputDirectory {
    _directory: OwnedStagingDirectory,
}

impl fmt::Debug for OutputDirectory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("OutputDirectory")
            .field(&"<redacted>")
            .finish()
    }
}

#[derive(Debug)]
pub(super) struct SlotLimiter {
    pub(super) active: AtomicUsize,
    maximum: usize,
}

impl SlotLimiter {
    pub(super) fn new(maximum: usize) -> Arc<Self> {
        Arc::new(Self {
            active: AtomicUsize::new(0),
            maximum,
        })
    }

    pub(super) fn acquire(self: &Arc<Self>) -> Option<SlotPermit> {
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

    fn is_idle(&self) -> bool {
        self.active.load(Ordering::Acquire) == 0
    }
}

#[derive(Debug)]
pub(super) struct SlotPermit {
    pub(super) limiter: Arc<SlotLimiter>,
}

#[derive(Debug, Default)]
pub(super) struct FinalizationRegistry {
    pub(super) jobs: Mutex<HashSet<JobId>>,
}

impl FinalizationRegistry {
    pub(super) fn begin(self: &Arc<Self>, job_id: JobId) -> CommandResult<FinalizationPermit> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| CommandError::internal("The download finalizer is unavailable."))?;
        if !jobs.insert(job_id) {
            return Err(CommandError::internal(
                "The media download is already being finalized.",
            ));
        }
        Ok(FinalizationPermit {
            registry: Arc::clone(self),
            job_id,
        })
    }

    pub(super) fn run_if_cancellable<T>(
        &self,
        job_id: JobId,
        operation: impl FnOnce() -> CommandResult<T>,
    ) -> CommandResult<T> {
        let jobs = self
            .jobs
            .lock()
            .map_err(|_| CommandError::internal("The download finalizer is unavailable."))?;
        if jobs.contains(&job_id) {
            return Err(CommandError::invalid_input(
                "The media download is already being finalized.",
            ));
        }
        let result = operation();
        drop(jobs);
        result
    }
}

pub(super) struct FinalizationPermit {
    pub(super) registry: Arc<FinalizationRegistry>,
    pub(super) job_id: JobId,
}

impl Drop for FinalizationPermit {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.registry.jobs.lock() {
            jobs.remove(&self.job_id);
        }
    }
}

impl Drop for SlotPermit {
    fn drop(&mut self) {
        self.limiter.active.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Clone)]
pub(super) struct DownloadTools {
    pub(super) engine: Option<DownloadEngine>,
    pub(super) ffmpeg_available: bool,
    pub(super) js_runtime_available: bool,
}

#[derive(Clone)]
pub(crate) struct DownloadRuntimeHandle {
    pub(super) tools: Arc<RwLock<DownloadTools>>,
    pub(super) inspection_slots: Arc<SlotLimiter>,
    pub(super) download_slots: Arc<SlotLimiter>,
}

impl DownloadRuntimeHandle {
    pub(crate) fn refresh(
        &self,
        search: YtDlpSearch,
        js_search: JsRuntimeSearch,
        ffmpeg: Option<FfmpegDirectory>,
    ) -> CommandResult<()> {
        let tools = DownloadRuntime::resolve_tools(search, js_search, ffmpeg);
        diagnostics::record(
            "download.runtime_refreshed",
            &[
                ("downloader", tools.engine.is_some().to_string()),
                ("javascriptRuntime", tools.js_runtime_available.to_string()),
                ("mediaTools", tools.ffmpeg_available.to_string()),
            ],
        );
        *self
            .tools
            .write()
            .map_err(|_| CommandError::internal("The native download runtime is unavailable."))? =
            tools;
        Ok(())
    }

    pub(crate) fn is_idle(&self) -> bool {
        self.inspection_slots.is_idle() && self.download_slots.is_idle()
    }
}

pub(crate) struct DownloadRuntime {
    pub(super) tools: Arc<RwLock<DownloadTools>>,
    pub(super) cache_root: Option<DownloadCacheRoot>,
    pub(super) inventories: InventoryRegistry,
    pub(super) inspection_slots: Arc<SlotLimiter>,
    pub(super) download_slots: Arc<SlotLimiter>,
    pub(super) finalizing: Arc<FinalizationRegistry>,
}

impl DownloadRuntime {
    #[must_use]
    pub(crate) fn resolve(
        cache_directory: &Path,
        staging_authority: RuntimeStagingAuthority,
        search: YtDlpSearch,
        js_search: JsRuntimeSearch,
        ffmpeg: Option<FfmpegDirectory>,
    ) -> Self {
        let tools = Self::resolve_tools(search, js_search, ffmpeg);
        Self {
            tools: Arc::new(RwLock::new(tools)),
            cache_root: DownloadCacheRoot::prepare(cache_directory, staging_authority),
            inventories: InventoryRegistry::new(),
            inspection_slots: SlotLimiter::new(MAX_CONCURRENT_INSPECTIONS),
            download_slots: SlotLimiter::new(MAX_CONCURRENT_DOWNLOADS),
            finalizing: Arc::new(FinalizationRegistry::default()),
        }
    }

    fn resolve_tools(
        search: YtDlpSearch,
        js_search: JsRuntimeSearch,
        ffmpeg: Option<FfmpegDirectory>,
    ) -> DownloadTools {
        let ffmpeg_available = ffmpeg.is_some();
        let js_runtime = JsRuntimeResolver::new(js_search).resolve().ok();
        let js_runtime_available = js_runtime.is_some();
        let engine = resolve_download_engine(search).ok().map(|mut engine| {
            if let Some(ffmpeg) = ffmpeg {
                engine = engine.with_ffmpeg(ffmpeg);
            }
            if let Some(js_runtime) = js_runtime {
                engine = engine.with_js_runtime(js_runtime);
            }
            engine
        });
        DownloadTools {
            engine,
            ffmpeg_available,
            js_runtime_available,
        }
    }

    #[must_use]
    pub(crate) fn activation_handle(&self) -> DownloadRuntimeHandle {
        DownloadRuntimeHandle {
            tools: Arc::clone(&self.tools),
            inspection_slots: Arc::clone(&self.inspection_slots),
            download_slots: Arc::clone(&self.download_slots),
        }
    }

    pub(super) fn tools(&self) -> CommandResult<DownloadTools> {
        self.tools
            .read()
            .map(|tools| tools.clone())
            .map_err(|_| CommandError::internal("The native download runtime is unavailable."))
    }

    pub(super) fn engine(&self) -> CommandResult<DownloadEngine> {
        let tools = self.tools()?;
        if !tools.js_runtime_available {
            return Err(CommandError::media_tools_unavailable());
        }
        tools
            .engine
            .clone()
            .ok_or_else(CommandError::media_tools_unavailable)
    }

    pub(super) fn download_parts(&self) -> CommandResult<(DownloadEngine, DownloadCacheRoot)> {
        let tools = self.tools()?;
        if !tools.ffmpeg_available {
            return Err(CommandError::media_tools_unavailable());
        }
        if !tools.js_runtime_available {
            return Err(CommandError::media_tools_unavailable());
        }
        let engine = tools
            .engine
            .ok_or_else(CommandError::media_tools_unavailable)?;
        let root = self
            .cache_root
            .clone()
            .ok_or_else(|| CommandError::internal("The native download cache is unavailable."))?;
        Ok((engine, root))
    }
}

#[cfg(not(feature = "e2e-automation"))]
fn resolve_download_engine(search: YtDlpSearch) -> Result<DownloadEngine, DownloadError> {
    DownloadEngine::resolve(search, UrlPolicy::SupportedSitesOnly)
}

#[cfg(feature = "e2e-automation")]
fn resolve_download_engine(search: YtDlpSearch) -> Result<DownloadEngine, DownloadError> {
    let Some(value) = std::env::var_os(EXACT_AUTOMATION_DOWNLOAD_URLS_ENV) else {
        return DownloadEngine::resolve(search, UrlPolicy::SupportedSitesOnly);
    };
    let value = value.to_str().ok_or(DownloadError::InvalidUrl(
        "the automation URL allow-list is invalid",
    ))?;
    let urls = parse_exact_automation_download_urls(value)?;
    DownloadEngine::resolve_with_exact_automation_urls(search, UrlPolicy::SupportedSitesOnly, &urls)
}

#[cfg(feature = "e2e-automation")]
pub(super) fn parse_exact_automation_download_urls(
    value: &str,
) -> Result<Vec<String>, DownloadError> {
    if value.len() > 70_000 {
        return Err(DownloadError::InvalidUrl(
            "the automation URL allow-list is invalid",
        ));
    }
    let urls = serde_json::from_str::<Vec<String>>(value)
        .map_err(|_| DownloadError::InvalidUrl("the automation URL allow-list is invalid"))?;
    if urls.is_empty() || urls.len() > 8 {
        return Err(DownloadError::InvalidUrl(
            "the automation URL allow-list is invalid",
        ));
    }
    Ok(urls)
}

impl fmt::Debug for DownloadRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DownloadRuntime")
            .field(
                "tools_available",
                &self.tools.read().map_or((false, false, false), |tools| {
                    (
                        tools.engine.is_some(),
                        tools.ffmpeg_available,
                        tools.js_runtime_available,
                    )
                }),
            )
            .field("cache_available", &self.cache_root.is_some())
            .field("inventories", &self.inventories)
            .finish_non_exhaustive()
    }
}
