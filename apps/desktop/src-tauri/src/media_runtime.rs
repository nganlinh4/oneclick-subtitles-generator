//! Media runtime wiring: toolchain resolution, the loopback media server and native-tool activation.

use std::{
    io,
    sync::{Arc, Mutex, RwLock},
};

use osg_download::{FfmpegDirectory, JsRuntimeSearch, YtDlpSearch};
use osg_media::{BinarySearch, MediaEngine, ToolchainResolver};
use osg_media_server::MediaServer;
use osg_native_tools::{ExecutableRole, NativeToolId};
use osg_runtime_staging::RuntimeStagingAuthority;

use crate::download::{DownloadRuntime, DownloadRuntimeHandle};
use crate::error::{CommandError, CommandResult};
use crate::media_pipeline::MediaPipelineRuntime;
use crate::native_tools::{NativeToolActivator, NativeToolRuntime};
use crate::render::RenderRuntimeHost;

pub(crate) fn attach_media_runtime_activator(
    native_tools: &NativeToolRuntime,
    media: &MediaRuntimes,
    render: &RenderRuntimeHost,
) -> io::Result<()> {
    native_tools
        .attach_activator(Arc::new(MediaRuntimeActivator {
            download: media.download.activation_handle(),
            pipeline: media.pipeline.clone(),
            media_engine: Arc::clone(&media.engine),
            render: render.clone(),
            refresh_gate: Mutex::new(()),
        }))
        .map_err(|_| io::Error::other("the native tool activator could not be initialized"))
}

pub(crate) fn media_server_allowed_origins(include_development_origins: bool) -> Vec<String> {
    let mut origins = vec![
        "https://tauri.localhost".to_owned(),
        "tauri://localhost".to_owned(),
    ];
    if include_development_origins {
        origins.extend([
            "http://localhost:3030".to_owned(),
            "http://127.0.0.1:3030".to_owned(),
        ]);
    }
    origins
}

#[derive(Debug)]
pub(crate) struct MediaRuntimes {
    pub(crate) engine: Arc<RwLock<Option<MediaEngine>>>,
    pub(crate) pipeline: MediaPipelineRuntime,
    pub(crate) download: DownloadRuntime,
}

pub(crate) struct MediaRuntimeActivator {
    pub(crate) download: DownloadRuntimeHandle,
    pub(crate) pipeline: MediaPipelineRuntime,
    media_engine: Arc<RwLock<Option<MediaEngine>>>,
    pub(crate) render: RenderRuntimeHost,
    refresh_gate: Mutex<()>,
}

impl NativeToolActivator for MediaRuntimeActivator {
    fn refresh(&self, native_tools: &NativeToolRuntime) -> CommandResult<()> {
        let _refresh = self
            .refresh_gate
            .lock()
            .map_err(|_| CommandError::internal("the native media activator is unavailable"))?;
        let ffmpeg = native_tools.executable(NativeToolId::MediaTools, ExecutableRole::Ffmpeg);
        let ffprobe = native_tools.executable(NativeToolId::MediaTools, ExecutableRole::Ffprobe);
        let yt_dlp = native_tools.executable(NativeToolId::YtDlp, ExecutableRole::YtDlp);
        let deno = native_tools.executable(NativeToolId::Deno, ExecutableRole::Deno);

        let media_engine = match (ffmpeg.as_ref(), ffprobe.as_ref()) {
            (Some(ffmpeg), Some(ffprobe)) => ToolchainResolver::new(
                BinarySearch::default()
                    .configured_ffmpeg(ffmpeg)
                    .configured_ffprobe(ffprobe),
            )
            .resolve()
            .ok()
            .map(MediaEngine::new),
            _ => None,
        };
        let ffmpeg_directory = ffmpeg
            .as_deref()
            .and_then(|path| FfmpegDirectory::from_executable(path).ok());
        let download_search = yt_dlp.map_or_else(YtDlpSearch::default, |path| {
            YtDlpSearch::default().configured(path)
        });
        let js_runtime_search = deno.map_or_else(JsRuntimeSearch::default, |path| {
            JsRuntimeSearch::default().configured(path)
        });

        self.download
            .refresh(download_search, js_runtime_search, ffmpeg_directory)?;
        self.pipeline.refresh(media_engine.clone())?;
        *self
            .media_engine
            .write()
            .map_err(|_| CommandError::internal("the native media runtime is unavailable"))? =
            media_engine;
        Ok(())
    }

    fn consumers_idle(&self, tool: NativeToolId) -> CommandResult<bool> {
        let download_idle = self.download.is_idle();
        Ok(match tool {
            NativeToolId::YtDlp | NativeToolId::Deno => download_idle,
            NativeToolId::MediaTools => {
                download_idle && self.pipeline.is_idle() && self.render.is_idle()
            }
        })
    }
}

pub(crate) fn prepare_media_runtimes(
    cache_dir: &std::path::Path,
    media_server: &MediaServer,
    native_tools: &NativeToolRuntime,
    staging_authority: RuntimeStagingAuthority,
) -> Result<MediaRuntimes, osg_media_pipeline::PipelineError> {
    let mut media_search = BinarySearch::default();
    let mut download_search = YtDlpSearch::default();
    let mut js_runtime_search = JsRuntimeSearch::default();
    if let Some(executable) =
        native_tools.executable(NativeToolId::MediaTools, ExecutableRole::Ffmpeg)
    {
        media_search = media_search.configured_ffmpeg(executable);
    }
    if let Some(executable) =
        native_tools.executable(NativeToolId::MediaTools, ExecutableRole::Ffprobe)
    {
        media_search = media_search.configured_ffprobe(executable);
    }
    if let Some(executable) = native_tools.executable(NativeToolId::YtDlp, ExecutableRole::YtDlp) {
        download_search = download_search.configured(executable);
    }
    if let Some(executable) = native_tools.executable(NativeToolId::Deno, ExecutableRole::Deno) {
        js_runtime_search = js_runtime_search.configured(executable);
    }
    let media_toolchain = ToolchainResolver::new(media_search).resolve().ok();
    let ffmpeg_directory = media_toolchain
        .as_ref()
        .and_then(|toolchain| FfmpegDirectory::from_executable(toolchain.ffmpeg_executable()).ok());
    let media_engine = media_toolchain.map(MediaEngine::new);
    let media_pipeline_runtime = MediaPipelineRuntime::new(
        media_engine.clone(),
        cache_dir.join("v1/media-pipeline"),
        staging_authority.clone(),
        media_server.clone(),
    )?;
    let download_runtime = DownloadRuntime::resolve(
        cache_dir,
        staging_authority,
        download_search,
        js_runtime_search,
        ffmpeg_directory,
    );
    Ok(MediaRuntimes {
        engine: Arc::new(RwLock::new(media_engine)),
        pipeline: media_pipeline_runtime,
        download: download_runtime,
    })
}
