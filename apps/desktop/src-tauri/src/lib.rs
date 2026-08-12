mod asr;
mod background;
mod cache;
mod commands;
mod diagnostics;
mod download;
mod engine_packages;
mod error;
mod external_links;
mod gemini;
mod gemini_image;
mod image_blob;
mod legacy_import;
mod live_music;
mod media_blob;
mod media_export;
mod media_pipeline;
mod native_drop;
mod native_tools;
mod providers;
mod render;
mod render_packages;
mod speech;
mod speech_packages;
mod state;
mod ui_fonts;
mod updater;
mod voice_samples;

use std::collections::BTreeMap;
use std::{
    io,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use asr::{AsrRuntimeManager, asr_start, asr_status};
use cache::{cache_clear, cache_info, cache_prune_expired};
use commands::{
    app_health, clear_media, credential_delete, credential_set, credential_status,
    credential_upsert, get_session_snapshot, job_cancel, job_get, jobs_list, open_media_asset,
    project_commit, project_create, project_history_status, project_load, project_redo,
    project_track_commit, project_track_history_status, project_track_redo, project_track_undo,
    project_undo, select_media, setting_delete, setting_get, setting_set, settings_clear,
    settings_set_many,
};
use download::{
    DownloadRuntime, DownloadRuntimeHandle, download_cancel, download_inspect, download_start,
    download_status,
};
use engine_packages::{
    EnginePackageRuntime, engine_package_install, engine_package_remove, engine_packages_status,
    engine_runtime_start, engine_runtime_stop,
};
use error::{CommandError, CommandResult};
use external_links::open_external_link;
use gemini::gemini_start;
use gemini_image::gemini_image_start;
use image_blob::{ImageBlobStore, image_blob_import, image_blob_release};
use legacy_import::{
    is_project_scoped_setting_key, is_transient_setting_key, legacy_import_select,
    legacy_import_status,
};
use live_music::{
    LiveMusicRuntime, live_music_close, live_music_control, live_music_start, live_music_update,
};
use media_blob::{MediaBlobStore, media_blob_import, media_blob_release};
use media_export::media_export_start;
use media_pipeline::{
    MediaPipelineRuntime, media_pipeline_cancel, media_pipeline_inspect, media_pipeline_start,
};
use native_drop::{
    NativeMediaDropState, handle_native_media_drop_event, media_drop_claim, media_drop_discard,
    media_drop_subscribe, media_drop_unsubscribe,
};
use native_tools::{
    NativeToolActivator, NativeToolRuntime, native_tool_cancel, native_tool_install,
    native_tool_remove, native_tools_catalog, native_tools_status,
};
use osg_application::JobRegistry;
use osg_download::{FfmpegDirectory, JsRuntimeSearch, YtDlpSearch};
use osg_engine_packages::{EnginePackageManager, RenderPackageManager};
use osg_infrastructure::storage::{Database, is_secret_setting_key};
use osg_media::{BinarySearch, MediaEngine, ToolchainResolver};
use osg_media_server::MediaServer;
use osg_native_tools::{ExecutableRole, NativeToolId};
use providers::{
    genius_lyrics, youtube_oauth_authorize, youtube_oauth_cancel, youtube_oauth_clear,
    youtube_oauth_status, youtube_search, youtube_thumbnail, youtube_video_details,
};
use render::{
    RenderRuntimeHost, render_playback_release, render_result, render_runtime_status, render_start,
};
use render_packages::{
    RenderPackageRuntime, render_package_install, render_package_remove, render_package_status,
};
use serde_json::Value;
use speech::{
    SpeechRuntime, speech_alignment_result, speech_alignment_start, speech_artifact_edit,
    speech_artifact_export, speech_artifact_resolve, speech_job_results, speech_playback_release,
    speech_probe, speech_reference_extract, speech_reference_import, speech_reference_select,
    speech_runtime_stop, speech_start, speech_status, speech_voice_conversion_start,
};
use speech_packages::{
    SpeechPackageRuntime, speech_package_install, speech_package_remove, speech_packages_status,
};
use state::DesktopState;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;
use ui_fonts::UiFontRuntime;
use updater::{
    AppUpdateRuntime, app_update_cancel, app_update_check, app_update_install, updater_plugin,
};
use voice_samples::{
    VoiceSampleRuntime, voice_sample_resolve, voice_samples_cancel, voice_samples_install,
    voice_samples_remove, voice_samples_status,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(
    clippy::too_many_lines,
    reason = "the complete Tauri command allowlist is intentionally visible in one audited handler"
)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(updater_plugin())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .manage(NativeMediaDropState::default())
        .manage(LiveMusicRuntime::default())
        .manage(ImageBlobStore::default())
        .manage(AppUpdateRuntime::default())
        .setup(setup_app)
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Started) {
                webview
                    .state::<NativeMediaDropState>()
                    .clear_webview(webview.label());
            }
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Finished) {
                let window = webview.window().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    if !window.is_visible().unwrap_or(true)
                        && let Err(error) = window.show()
                    {
                        eprintln!("could not show the main window after the font timeout: {error}");
                    }
                });
            }
        })
        .on_window_event(handle_native_media_drop_event)
        .invoke_handler(tauri::generate_handler![
            app_health,
            get_session_snapshot,
            select_media,
            clear_media,
            open_media_asset,
            setting_get,
            setting_set,
            settings_set_many,
            setting_delete,
            settings_clear,
            cache_info,
            cache_clear,
            cache_prune_expired,
            download_status,
            download_inspect,
            download_start,
            download_cancel,
            project_create,
            project_load,
            project_history_status,
            project_track_history_status,
            project_commit,
            project_track_commit,
            project_undo,
            project_redo,
            project_track_undo,
            project_track_redo,
            jobs_list,
            job_get,
            job_cancel,
            credential_set,
            credential_upsert,
            credential_delete,
            credential_status,
            genius_lyrics,
            youtube_search,
            youtube_video_details,
            youtube_thumbnail,
            youtube_oauth_authorize,
            youtube_oauth_cancel,
            youtube_oauth_status,
            youtube_oauth_clear,
            legacy_import_select,
            legacy_import_status,
            live_music_start,
            live_music_update,
            live_music_control,
            live_music_close,
            media_blob_import,
            media_blob_release,
            media_export_start,
            gemini_start,
            image_blob_import,
            image_blob_release,
            gemini_image_start,
            native_tools_catalog,
            native_tools_status,
            native_tool_install,
            native_tool_remove,
            native_tool_cancel,
            media_pipeline_inspect,
            media_pipeline_start,
            media_pipeline_cancel,
            render_runtime_status,
            render_start,
            render_result,
            render_playback_release,
            render_package_status,
            render_package_install,
            render_package_remove,
            asr_status,
            asr_start,
            engine_packages_status,
            engine_package_install,
            engine_package_remove,
            engine_runtime_start,
            engine_runtime_stop,
            speech_packages_status,
            speech_package_install,
            speech_package_remove,
            media_drop_subscribe,
            media_drop_unsubscribe,
            media_drop_discard,
            media_drop_claim,
            speech_status,
            speech_probe,
            speech_runtime_stop,
            speech_reference_select,
            speech_reference_extract,
            speech_reference_import,
            speech_start,
            speech_voice_conversion_start,
            speech_artifact_edit,
            speech_artifact_export,
            speech_job_results,
            speech_alignment_start,
            speech_alignment_result,
            speech_artifact_resolve,
            speech_playback_release,
            app_update_check,
            app_update_install,
            app_update_cancel,
            open_external_link,
            voice_samples_status,
            voice_samples_install,
            voice_samples_cancel,
            voice_sample_resolve,
            voice_samples_remove,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri runtime failed");
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let local_data_dir = app.path().app_local_data_dir()?;
    let cache_dir = app.path().app_cache_dir()?;
    diagnostics::initialize(&app.path().app_log_dir()?)?;
    let ui_font_runtime = prepare_ui_font_runtime(&local_data_dir);
    let database_path = local_data_dir.join("db/osg.sqlite3");
    let database = Database::open(database_path)?;
    let SpeechSetup {
        runtime: speech_runtime,
        resource_dir,
    } = prepare_speech_runtime(app, &local_data_dir, &cache_dir)?;
    let asr = AsrRuntimeManager::new(cache_dir.join("v1/asr"), resource_dir.clone())?;
    let engine_package_manager = EnginePackageManager::new(
        local_data_dir.join("engine-packages/v1"),
        Arc::new(asr.package_coordinator()),
    )?;
    asr.attach_package_manager(engine_package_manager.clone())?;
    let media_server = MediaServer::start(media_server_allowed_origins(cfg!(debug_assertions)))?;
    let voice_sample_runtime = VoiceSampleRuntime::new(
        &local_data_dir.join("asset-packages/v1"),
        media_server.clone(),
    )?;
    let mut settings = database.list_settings("app")?;
    let disallowed_settings = settings
        .keys()
        .filter(|key| !is_safe_setting_key(key))
        .cloned()
        .collect::<Vec<_>>();
    for keys in disallowed_settings.chunks(256) {
        database.delete_settings("app", keys)?;
        for key in keys {
            settings.remove(key);
        }
    }
    let jobs = Arc::new(JobRegistry::restore(Arc::new(database.clone()))?);
    let media_blob_store = MediaBlobStore::new(&cache_dir.join("v1/ephemeral-audio"))?;
    let engine_package_runtime =
        EnginePackageRuntime::new(engine_package_manager, database.clone(), Arc::clone(&jobs))?;
    let speech_package_runtime =
        SpeechPackageRuntime::new(speech_runtime.package_manager()?, Arc::clone(&jobs));
    let native_tool_runtime = NativeToolRuntime::new(
        &local_data_dir.join("native-tools/v1"),
        database.clone(),
        Arc::clone(&jobs),
    )?;
    let media_runtimes = prepare_media_runtimes(&cache_dir, &media_server, &native_tool_runtime)?;
    let render_runtime = RenderRuntimeHost::new(
        &cache_dir,
        resource_dir.as_deref(),
        media_runtimes.ffmpeg.clone(),
        media_server.clone(),
    )?;
    let render_package_manager = RenderPackageManager::new(
        local_data_dir.join("render-packages/v1"),
        Arc::new(render_runtime.package_coordinator()),
    )?;
    render_runtime
        .attach_package_manager(render_package_manager.clone())
        .map_err(|_| io::Error::other("the managed render runtime could not be initialized"))?;
    let render_runtime_verifier = render_runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = render_runtime_verifier.refresh_managed();
    });
    let render_package_runtime = RenderPackageRuntime::new(
        render_package_manager,
        render_runtime.clone(),
        Arc::clone(&jobs),
    );
    attach_media_runtime_activator(&native_tool_runtime, &media_runtimes, &render_runtime)?;
    app.manage(media_runtimes.download);
    app.manage(media_runtimes.pipeline);
    app.manage(render_runtime);
    app.manage(render_package_runtime);
    app.manage(engine_package_runtime);
    app.manage(speech_package_runtime);
    app.manage(native_tool_runtime);
    app.manage(voice_sample_runtime);
    app.manage(speech_runtime);
    app.manage(media_blob_store);
    app.manage(DesktopState::new(
        asr,
        database,
        jobs,
        media_runtimes.engine,
        media_server,
    ));
    build_main_window(
        app,
        &settings,
        ui_font_runtime.as_ref().map(UiFontRuntime::css),
    )?;
    if let Some(runtime) = ui_font_runtime {
        app.manage(runtime);
    }
    diagnostics::record("app.ready", &[]);
    Ok(())
}

fn prepare_ui_font_runtime(local_data_dir: &std::path::Path) -> Option<UiFontRuntime> {
    diagnostics::record("ui-font.prepare", &[]);
    if let Ok(runtime) = UiFontRuntime::prepare(&local_data_dir.join("ui-fonts/v1")) {
        diagnostics::record("ui-font.ready", &[]);
        Some(runtime)
    } else {
        diagnostics::record("ui-font.unavailable", &[]);
        None
    }
}

fn build_main_window(
    app: &mut tauri::App,
    settings: &BTreeMap<String, Value>,
    ui_font_css: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| io::Error::other("the main window configuration is missing"))?;
    if has_saved_main_window_state(app) {
        // Start neutral so a saved non-maximized window is not overridden by the
        // maximized first-launch default. The plugin restores the saved state when
        // this dynamically-created window becomes ready.
        window_config.maximized = false;
    }
    WebviewWindowBuilder::from_config(app, &window_config)?
        .initialization_script(window_initialization_script(settings, ui_font_css)?)
        .build()?;
    Ok(())
}

fn attach_media_runtime_activator(
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

fn has_saved_main_window_state(app: &tauri::App) -> bool {
    let Ok(config_dir) = app.path().app_config_dir() else {
        return false;
    };
    let state_path = config_dir.join(tauri_plugin_window_state::DEFAULT_FILENAME);
    let Ok(bytes) = std::fs::read(state_path) else {
        return false;
    };
    let Ok(saved_states) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };

    has_valid_main_window_state(&saved_states)
}

fn has_valid_main_window_state(saved_states: &Value) -> bool {
    saved_states.get("main").is_some_and(|state| {
        state
            .get("width")
            .and_then(Value::as_u64)
            .is_some_and(|width| width > 0)
            && state
                .get("height")
                .and_then(Value::as_u64)
                .is_some_and(|height| height > 0)
            && state.get("maximized").and_then(Value::as_bool).is_some()
    })
}

fn media_server_allowed_origins(include_development_origins: bool) -> Vec<String> {
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
struct MediaRuntimes {
    engine: Arc<RwLock<Option<MediaEngine>>>,
    ffmpeg: Option<std::path::PathBuf>,
    pipeline: MediaPipelineRuntime,
    download: DownloadRuntime,
}

struct MediaRuntimeActivator {
    download: DownloadRuntimeHandle,
    pipeline: MediaPipelineRuntime,
    media_engine: Arc<RwLock<Option<MediaEngine>>>,
    render: RenderRuntimeHost,
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
        self.render.refresh_media_tool(ffmpeg)?;
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

fn prepare_media_runtimes(
    cache_dir: &std::path::Path,
    media_server: &MediaServer,
    native_tools: &NativeToolRuntime,
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
    let ffmpeg = media_toolchain
        .as_ref()
        .map(|toolchain| toolchain.ffmpeg_executable().to_owned());
    let media_engine = media_toolchain.map(MediaEngine::new);
    let media_pipeline_runtime = MediaPipelineRuntime::new(
        media_engine.clone(),
        cache_dir.join("v1/media-pipeline"),
        media_server.clone(),
    )?;
    let download_runtime = DownloadRuntime::resolve(
        cache_dir,
        download_search,
        js_runtime_search,
        ffmpeg_directory,
    );
    Ok(MediaRuntimes {
        engine: Arc::new(RwLock::new(media_engine)),
        ffmpeg,
        pipeline: media_pipeline_runtime,
        download: download_runtime,
    })
}

struct SpeechSetup {
    runtime: SpeechRuntime,
    resource_dir: Option<std::path::PathBuf>,
}

fn prepare_speech_runtime(
    app: &tauri::App,
    local_data_dir: &std::path::Path,
    cache_dir: &std::path::Path,
) -> io::Result<SpeechSetup> {
    let resource_dir = app.path().resource_dir().ok();
    let runtime = SpeechRuntime::new(
        local_data_dir.join("engines/speech"),
        cache_dir.join("v1/speech"),
        resource_dir.clone(),
    )?;
    Ok(SpeechSetup {
        runtime,
        resource_dir,
    })
}

fn settings_initialization_script(
    settings: &BTreeMap<String, Value>,
) -> Result<String, serde_json::Error> {
    let safe_settings: BTreeMap<&str, &Value> = settings
        .iter()
        .filter(|(key, _)| is_safe_setting_key(key))
        .map(|(key, value)| (key.as_str(), value))
        .collect();
    let serialized = serde_json::to_string(&safe_settings)?;
    let string_literal = serde_json::to_string(&serialized)?;
    Ok(format!(
        "(() => {{ localStorage.removeItem('original_subtitles_map'); const values = JSON.parse({string_literal}); for (const [key, value] of Object.entries(values)) {{ const stored = typeof value === 'string' ? value : JSON.stringify(value); if (stored !== undefined) localStorage.setItem(key, stored); }} }})();"
    ))
}

fn window_initialization_script(
    settings: &BTreeMap<String, Value>,
    ui_font_css: Option<&str>,
) -> Result<String, serde_json::Error> {
    let settings_script = settings_initialization_script(settings)?;
    let Some(css) = ui_font_css else {
        return Ok(format!(
            "Object.defineProperty(window, '__OSG_MANAGED_UI_FONT__', {{ value: false }});Object.defineProperty(window, '__OSG_MANAGED_UI_FONT_READY__', {{ value: Promise.resolve(false) }});{settings_script}"
        ));
    };
    let css_literal = serde_json::to_string(css)?;
    Ok(format!(
        "(() => {{ const css = {css_literal}; let finish; const ready = new Promise((resolve) => {{ finish = resolve; }}); const install = () => {{ if (document.getElementById('osg-managed-ui-font')) {{ finish(true); return true; }} const target = document.head || document.documentElement; if (!target) return false; const style = document.createElement('style'); style.id = 'osg-managed-ui-font'; style.textContent = css; target.appendChild(style); finish(true); return true; }}; if (!install()) {{ const retry = () => {{ if (install()) {{ document.removeEventListener('readystatechange', retry); document.removeEventListener('DOMContentLoaded', retry); }} }}; document.addEventListener('readystatechange', retry); document.addEventListener('DOMContentLoaded', retry); }} Object.defineProperty(window, '__OSG_MANAGED_UI_FONT__', {{ value: true }}); Object.defineProperty(window, '__OSG_MANAGED_UI_FONT_READY__', {{ value: ready }}); }})();{settings_script}"
    ))
}

fn is_safe_setting_key(key: &str) -> bool {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return false;
    }
    !(is_project_scoped_setting_key(key)
        || is_transient_setting_key(key)
        || is_secret_setting_key(key))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::{
        has_valid_main_window_state, is_safe_setting_key, media_server_allowed_origins,
        settings_initialization_script, window_initialization_script,
    };

    #[test]
    fn recognizes_a_persisted_main_window_state() {
        assert!(has_valid_main_window_state(&json!({
            "main": {
                "width": 1400,
                "height": 900,
                "maximized": false
            }
        })));
        assert!(has_valid_main_window_state(&json!({
            "main": {
                "width": 1920,
                "height": 1080,
                "maximized": true
            }
        })));
    }

    #[test]
    fn rejects_missing_or_incomplete_window_state() {
        for state in [
            json!({}),
            json!({ "main": {} }),
            json!({ "main": { "width": 0, "height": 900, "maximized": false } }),
            json!({ "main": { "width": 1400, "height": 0, "maximized": false } }),
            json!({ "main": { "width": 1400, "height": 900 } }),
        ] {
            assert!(!has_valid_main_window_state(&state));
        }
    }

    #[test]
    fn release_media_origins_exclude_development_servers() {
        assert_eq!(
            media_server_allowed_origins(false),
            ["https://tauri.localhost", "tauri://localhost"]
        );
    }

    #[test]
    fn development_media_origins_include_both_vite_hosts() {
        assert_eq!(
            media_server_allowed_origins(true),
            [
                "https://tauri.localhost",
                "tauri://localhost",
                "http://localhost:3030",
                "http://127.0.0.1:3030",
            ]
        );
    }

    #[test]
    fn window_initialization_injects_only_in_memory_managed_font_css() {
        let script = window_initialization_script(
            &BTreeMap::new(),
            Some("@font-face{font-family:'Google Sans';src:url(data:font/woff2;base64,AA==)}"),
        )
        .expect("valid script");
        assert!(script.contains("osg-managed-ui-font"));
        assert!(script.contains("data:font/woff2;base64,AA=="));
        assert!(script.contains("__OSG_MANAGED_UI_FONT__"));
        assert!(script.contains("__OSG_MANAGED_UI_FONT_READY__"));
        assert!(script.contains("value: true"));
        assert!(script.contains("readystatechange"));
        assert!(script.contains("DOMContentLoaded"));
        assert!(!script.contains("(document.head || document.documentElement).appendChild"));
        assert!(!script.contains("file://"));
        assert!(!script.contains("C:\\\\"));
    }

    #[test]
    fn window_initialization_marks_managed_font_unavailable_without_css() {
        let script = window_initialization_script(&BTreeMap::new(), None).expect("valid script");
        assert!(script.contains("__OSG_MANAGED_UI_FONT__"));
        assert!(script.contains("__OSG_MANAGED_UI_FONT_READY__"));
        assert!(script.contains("value: false"));
        assert!(script.contains("Promise.resolve(false)"));
        assert!(!script.contains("osg-managed-ui-font"));
    }

    #[test]
    fn initialization_script_hydrates_only_non_secret_legacy_settings() {
        let settings = BTreeMap::from([
            ("theme".to_owned(), json!("dark")),
            ("gemini_api_key".to_owned(), json!("never-injected")),
            ("gemini_max_tokens".to_owned(), json!(8192)),
            ("maxTokens".to_owned(), json!(4096)),
            ("tokenCount".to_owned(), json!(1024)),
            (
                "clientSecret".to_owned(),
                json!("never-injected-client-secret"),
            ),
            (
                "client.secret".to_owned(),
                json!("never-injected-dotted-secret"),
            ),
            (
                "client:secret".to_owned(),
                json!("never-injected-colon-secret"),
            ),
            (
                "accessToken".to_owned(),
                json!("never-injected-access-token"),
            ),
            (
                "refreshToken".to_owned(),
                json!("never-injected-refresh-token"),
            ),
            ("privateKey".to_owned(), json!("never-injected-private-key")),
            ("apiKey".to_owned(), json!("never-injected-api-key")),
            ("APIKey".to_owned(), json!("never-injected-acronym-api-key")),
            ("oauthToken".to_owned(), json!("never-injected-oauth-token")),
            (
                "current_file_url".to_owned(),
                json!("http://127.0.0.1:49152/asset/id?token=never-injected"),
            ),
            (
                "gemini_file_clip".to_owned(),
                json!({ "uri": "provider-private" }),
            ),
            (
                "osg.nativeNarrationAlignment.v1".to_owned(),
                json!({ "jobId": "stale-alignment", "request": { "private": true } }),
            ),
            (
                "osg.nativeNarrationJob.v1".to_owned(),
                json!({ "jobId": "stale-narration", "subtitles": ["private"] }),
            ),
            (
                "osg.nativeJobIds.v1".to_owned(),
                json!(["0198a8d7-dbf7-7ee0-a949-f13427fdd78a"]),
            ),
            (
                "user_provided_subtitles".to_owned(),
                json!("project-private"),
            ),
            (
                "original_subtitles_map".to_owned(),
                json!({ "1": { "text": "stale-project-subtitle-map" } }),
            ),
            ("invalid key".to_owned(), json!(true)),
        ]);

        let script = settings_initialization_script(&settings).expect("valid script");

        assert!(script.contains("theme"));
        assert!(script.contains("gemini_max_tokens"));
        assert!(script.contains("maxTokens"));
        assert!(script.contains("tokenCount"));
        assert!(!script.contains("gemini_api_key"));
        assert!(!script.contains("never-injected"));
        for secret_key in [
            "clientSecret",
            "client.secret",
            "client:secret",
            "accessToken",
            "refreshToken",
            "privateKey",
            "apiKey",
            "APIKey",
            "oauthToken",
        ] {
            assert!(!script.contains(secret_key));
        }
        assert!(!script.contains("current_file_url"));
        assert!(!script.contains("gemini_file_clip"));
        assert!(!script.contains("provider-private"));
        assert!(!script.contains("osg.nativeNarrationAlignment.v1"));
        assert!(!script.contains("osg.nativeNarrationJob.v1"));
        assert!(!script.contains("osg.nativeJobIds.v1"));
        assert!(!script.contains("stale-alignment"));
        assert!(!script.contains("stale-narration"));
        assert!(!script.contains("user_provided_subtitles"));
        assert!(!script.contains("project-private"));
        assert!(script.contains("localStorage.removeItem('original_subtitles_map')"));
        assert_eq!(script.matches("original_subtitles_map").count(), 1);
        assert!(!script.contains("stale-project-subtitle-map"));
        assert!(!script.contains("invalid key"));
    }

    #[test]
    fn safe_key_detection_matches_the_database_boundary() {
        assert!(is_safe_setting_key("subtitle.editor:zoom-v2"));
        for safe_key in ["gemini_max_tokens", "maxTokens", "tokenCount"] {
            assert!(is_safe_setting_key(safe_key));
        }
        assert!(!is_safe_setting_key("../../secret"));
        assert!(!is_safe_setting_key("youtube_refresh_token"));
        for secret_key in [
            "clientSecret",
            "client.secret",
            "client:secret",
            "accessToken",
            "refreshToken",
            "privateKey",
            "apiKey",
            "APIKey",
            "oauthToken",
        ] {
            assert!(!is_safe_setting_key(secret_key));
        }
        assert!(!is_safe_setting_key("gemini_active_key_index"));
        assert!(!is_safe_setting_key("osg.nativeNarrationJob.v1"));
        assert!(!is_safe_setting_key("osg.nativeJobIds.v1"));
        assert!(!is_safe_setting_key("user_provided_subtitles"));
        assert!(!is_safe_setting_key("original_subtitles_map"));
    }
}
