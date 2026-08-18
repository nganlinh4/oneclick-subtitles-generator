mod asr;
mod background;
mod cache;
#[cfg(feature = "ci-updater-fixture")]
mod ci_updater_fixture;
mod commands;
mod diagnostics;
mod document_export;
mod download;
mod engine_packages;
mod error;
mod external_links;
mod gemini;
mod gemini_image;
mod glyph_atlas;
mod image_blob;
mod legacy_import;
mod live_music;
mod media_blob;
mod media_export;
mod media_pipeline;
mod native_drop;
mod native_tools;
mod preview;
mod providers;
mod render;
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
    credential_upsert, discard_media_candidate, get_session_snapshot, job_cancel, job_get,
    jobs_list, open_media_asset, project_commit, project_create, project_history_status,
    project_load, project_redo, project_track_commit, project_track_history_status,
    project_track_redo, project_track_undo, project_undo, select_media, setting_delete,
    setting_get, setting_set, settings_clear, settings_set_many,
};
use document_export::{generated_file_export, subtitle_archive_export, subtitle_document_export};
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
use gemini_image::{
    GeneratedImageRuntime, gemini_image_complete, gemini_image_start, generated_image_clear,
    generated_image_delete, generated_image_export, generated_image_list,
    generated_image_playback_release, generated_image_resolve,
};
use glyph_atlas::command::glyph_atlas_stage;
use glyph_atlas::registry::GlyphAtlasStore;
use image_blob::{
    ImageBlobStore, image_blob_import_playback, image_blob_release, image_reference_export,
    image_reference_playback_release, image_reference_select,
};
use legacy_import::{
    is_project_scoped_setting_key, is_transient_setting_key, legacy_import_select,
    legacy_import_status,
};
use live_music::{
    LiveMusicRuntime, live_music_close, live_music_control, live_music_rollback_start,
    live_music_start, live_music_update,
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
use osg_engine_packages::EnginePackageManager;
use osg_infrastructure::storage::{Database, is_secret_setting_key};
use osg_media::{BinarySearch, MediaEngine, ToolchainResolver};
use osg_media_server::MediaServer;
use osg_native_tools::{ExecutableRole, NativeToolId};
use preview::command::preview_frame_render;
use preview::host::PreviewHost;
use providers::{
    genius_lyrics, youtube_oauth_authorize, youtube_oauth_cancel, youtube_oauth_clear,
    youtube_oauth_status, youtube_search, youtube_thumbnail, youtube_video_details,
};
use render::{
    RenderRuntimeHost, render_playback_release, render_result, render_runtime_status, render_start,
};
use serde_json::Value;
use speech::{
    SpeechRuntime, speech_alignment_result, speech_alignment_start, speech_artifact_edit,
    speech_artifact_export, speech_artifact_resolve, speech_job_results, speech_playback_release,
    speech_probe, speech_reference_extract, speech_reference_import, speech_reference_select,
    speech_runtime_stop, speech_start, speech_status, speech_voice_conversion_start,
    speech_voice_inventory,
};
use speech_packages::{
    SpeechPackageRuntime, speech_package_install, speech_package_remove, speech_packages_status,
};
use state::DesktopState;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewWindowBuilder, Window, WindowEvent};
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
    #[cfg(feature = "ci-updater-fixture")]
    ci_updater_fixture::initialize_from_process_arguments()
        .unwrap_or_else(|error| panic!("invalid CI updater fixture arguments: {error}"));
    let builder = tauri::Builder::default();
    // The embedded WebDriver server, registered before anything else so a test attaches to the same
    // application every other plugin then configures. It is what removes the ambiguity the first
    // harness ran into: with the server inside the binary there is no external driver choosing which
    // WebView target to bind. Compiled only into the automation channel, which no workflow builds
    // and which every release artifact is asserted not to contain.
    #[cfg(feature = "e2e-automation")]
    let builder = builder
        .plugin(tauri_plugin_wdio_webdriver::init())
        .plugin(tauri_plugin_wdio::init());
    let app = builder
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
        .manage(GlyphAtlasStore::new())
        .manage(PreviewHost::default())
        .manage(GeneratedImageRuntime::default())
        .manage(AppUpdateRuntime::default())
        .setup(setup_app)
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Started) {
                webview
                    .state::<NativeMediaDropState>()
                    .clear_webview(webview.label());
            }
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Finished) {
                diagnostics::record("app.page_load_finished", &[]);
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
        .on_window_event(handle_application_window_event)
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
            discard_media_candidate,
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
            live_music_rollback_start,
            live_music_update,
            live_music_control,
            live_music_close,
            glyph_atlas_stage,
            preview_frame_render,
            media_blob_import,
            media_blob_release,
            media_export_start,
            subtitle_document_export,
            subtitle_archive_export,
            generated_file_export,
            gemini_start,
            image_blob_import_playback,
            image_blob_release,
            image_reference_select,
            image_reference_playback_release,
            image_reference_export,
            gemini_image_start,
            gemini_image_complete,
            generated_image_list,
            generated_image_resolve,
            generated_image_export,
            generated_image_delete,
            generated_image_clear,
            generated_image_playback_release,
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
            speech_voice_inventory,
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
        .build(tauri::generate_context!())
        .expect("Tauri runtime failed");
    app.run(|app, event| handle_application_run_event(app, &event));
}

fn handle_application_run_event(_app: &tauri::AppHandle, event: &tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { .. } => diagnostics::record("app.exit_requested", &[]),
        tauri::RunEvent::Exit => diagnostics::record("app.exit", &[]),
        _ => {}
    }
}

fn handle_application_window_event(window: &Window, event: &WindowEvent) {
    handle_native_media_drop_event(window, event);
    if is_main_window_close_request(
        window.label(),
        matches!(event, WindowEvent::CloseRequested { .. }),
    ) {
        // OSG has no tray/background mode. Tauri's runtime destroys an unprevented closing window
        // and requests application exit when its window store becomes empty. Requesting exit here
        // as well would emit a second ExitRequested event during the same native close.
        diagnostics::record("app.close_requested", &[]);
    }
}

fn is_main_window_close_request(window_label: &str, close_requested: bool) -> bool {
    window_label == "main" && close_requested
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let harness_root = harness_data_root();
    let local_data_dir = match &harness_root {
        Some(root) => root.join("data"),
        None => app.path().app_local_data_dir()?,
    };
    let cache_dir = match &harness_root {
        Some(root) => root.join("cache"),
        None => app.path().app_cache_dir()?,
    };
    let log_dir = match &harness_root {
        Some(root) => root.join("logs"),
        None => app.path().app_log_dir()?,
    };
    diagnostics::initialize(&log_dir)?;
    record_application_environment(app);
    let ui_font_runtime = prepare_ui_font_runtime(
        &local_data_dir,
        app.path()
            .resource_dir()
            .ok()
            .map(|dir| dir.join("ui-fonts")),
    );
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
    let render_runtime = RenderRuntimeHost::new(&cache_dir, media_server.clone())?;
    attach_media_runtime_activator(&native_tool_runtime, &media_runtimes, &render_runtime)?;
    app.manage(media_runtimes.download);
    app.manage(media_runtimes.pipeline);
    app.manage(render_runtime);
    app.manage(engine_package_runtime);
    app.manage(speech_package_runtime);
    app.manage(native_tool_runtime);
    app.manage(voice_sample_runtime);
    app.manage(speech_runtime);
    app.manage(media_blob_store);
    app.manage(media_server.clone());
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

fn record_application_environment(app: &tauri::App) {
    let webview_debug = std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
        .is_some_and(|value| !value.is_empty());
    #[cfg(feature = "ci-updater-fixture")]
    let webview_debug =
        webview_debug || ci_updater_fixture::configuration().enables_webview_debugging();
    diagnostics::record(
        "app.environment",
        &[
            ("version", app.package_info().version.to_string()),
            (
                "webviewDebug",
                if webview_debug { "present" } else { "absent" }.to_owned(),
            ),
            // Which update channel this binary was compiled as. Recorded because an installed build
            // that never checks for updates is indistinguishable from one that is up to date, and
            // the difference should be readable from the application's own log rather than inferred
            // from which command someone remembers running.
            (
                "updateChannel",
                format!("{:?}", crate::updater::update_channel_state()).to_lowercase(),
            ),
        ],
    );
}

fn prepare_ui_font_runtime(
    local_data_dir: &std::path::Path,
    bundle: Option<std::path::PathBuf>,
) -> Option<UiFontRuntime> {
    diagnostics::record("ui-font.prepare", &[]);
    match UiFontRuntime::prepare(&local_data_dir.join("ui-fonts/v1"), bundle) {
        Ok(runtime) => {
            diagnostics::record("ui-font.ready", &[]);
            Some(runtime)
        }
        // The reason used to be discarded, so an installation that timed out and one that failed
        // outright produced the same silent `ui-font.unavailable` — which is how a startup timeout
        // went unnoticed while it disabled the default subtitle font on every clean install. The
        // kind is recorded; the message is not, because it can name a path.
        Err(error) => {
            diagnostics::record(
                "ui-font.unavailable",
                &[("reason", format!("{:?}", error.kind()))],
            );
            None
        }
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
    let window_builder = WebviewWindowBuilder::from_config(app, &window_config)?;
    #[cfg(feature = "ci-updater-fixture")]
    let window_builder =
        if let Some(arguments) = ci_updater_fixture::configuration().browser_arguments() {
            window_builder.additional_browser_args(&arguments)
        } else {
            window_builder
        };
    window_builder
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

// WebView localStorage is the live preference store. SQLite is a recovery/migration seed for a
// fresh WebView profile, not permission to overwrite changes made since the previous native sync.
// The marker remains WebView-only because the `current_` prefix is excluded from native settings.
const WEBVIEW_SETTINGS_BOOTSTRAP_MARKER: &str = "current_settings_bootstrap_v1";

fn settings_initialization_script(
    settings: &BTreeMap<String, Value>,
) -> Result<String, serde_json::Error> {
    let safe_settings: BTreeMap<&str, &Value> = settings
        .iter()
        .filter(|(key, _)| is_webview_bootstrap_setting_key(key))
        .map(|(key, value)| (key.as_str(), value))
        .collect();
    let serialized = serde_json::to_string(&safe_settings)?;
    let string_literal = serde_json::to_string(&serialized)?;
    let marker_literal = serde_json::to_string(WEBVIEW_SETTINGS_BOOTSTRAP_MARKER)?;
    Ok(format!(
        "(() => {{ localStorage.removeItem('original_subtitles_map'); const marker = {marker_literal}; const shouldRestore = localStorage.getItem(marker) !== 'complete'; const values = JSON.parse({string_literal}); if (shouldRestore) {{ for (const [key, value] of Object.entries(values)) {{ const stored = typeof value === 'string' ? value : JSON.stringify(value); if (stored !== undefined && localStorage.getItem(key) === null) localStorage.setItem(key, stored); }} localStorage.setItem(marker, 'complete'); }} }})();"
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

fn is_native_owned_setting_key(key: &str) -> bool {
    matches!(
        key,
        "gemini.keySelection.v1" | "project.subtitleCacheIndex.v1"
    ) || key.starts_with("project.legacyAux.v1.")
}

fn is_webview_bootstrap_setting_key(key: &str) -> bool {
    is_safe_setting_key(key) && !is_native_owned_setting_key(key)
}

/// An isolated data root for the real-binary test harness, or `None` in every shipped build.
///
/// Windows resolves the application data directory through `SHGetKnownFolderPath`, which ignores
/// `%LOCALAPPDATA%` — measured, after an attempt to isolate a test run that way silently used the
/// real directory instead. So a harness that must not touch a developer's projects needs the
/// application to accept a root, and there is no way to provide one from outside the process.
///
/// This exists ONLY in the `unsigned-local-build` channel. There is no `cfg` in this function that
/// a release build compiles: `production` does not enable that feature, no workflow builds it, and
/// `scripts/check-release-readiness.js` asserts both. The path is required to be absolute so a
/// relative value cannot quietly resolve against whatever directory the harness happened to start
/// in, and creation failure is fatal rather than a silent fall back to the real root — falling back
/// is precisely the behaviour that would write test data into someone's live database.
#[cfg(feature = "unsigned-local-build")]
fn harness_data_root() -> Option<std::path::PathBuf> {
    let raw = std::env::var_os("OSG_E2E_DATA_ROOT")?;
    let root = std::path::PathBuf::from(raw);
    assert!(
        root.is_absolute(),
        "OSG_E2E_DATA_ROOT must be an absolute path"
    );
    std::fs::create_dir_all(&root).expect("OSG_E2E_DATA_ROOT must be creatable");
    Some(root)
}

#[cfg(not(feature = "unsigned-local-build"))]
const fn harness_data_root() -> Option<std::path::PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use osg_infrastructure::storage::Database;
    use serde_json::json;

    use super::{
        has_valid_main_window_state, is_main_window_close_request, is_safe_setting_key,
        is_webview_bootstrap_setting_key, media_server_allowed_origins,
        settings_initialization_script, window_initialization_script,
    };

    #[test]
    fn records_only_native_close_requests_for_the_main_window() {
        assert!(is_main_window_close_request("main", true));
        assert!(!is_main_window_close_request("main", false));
        assert!(!is_main_window_close_request("secondary", true));
        assert!(!is_main_window_close_request("", true));
    }

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

    fn legacy_bootstrap_settings_fixture() -> BTreeMap<String, serde_json::Value> {
        BTreeMap::from([
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
            (
                "gemini.keySelection.v1".to_owned(),
                json!({ "marker": "native-credential-selection" }),
            ),
            (
                "project.subtitleCacheIndex.v1".to_owned(),
                json!({ "marker": "native-project-index" }),
            ),
            (
                "project.legacyAux.v1.019ffbea-26d5-7800-8e3b-69de8bff2d7d".to_owned(),
                json!({ "marker": "native-project-auxiliary" }),
            ),
            ("invalid key".to_owned(), json!(true)),
        ])
    }

    #[test]
    fn initialization_script_hydrates_only_non_secret_legacy_settings() {
        let settings = legacy_bootstrap_settings_fixture();

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
        assert!(!script.contains("gemini.keySelection.v1"));
        assert!(!script.contains("native-credential-selection"));
        assert!(!script.contains("project.subtitleCacheIndex.v1"));
        assert!(!script.contains("native-project-index"));
        assert!(!script.contains("project.legacyAux.v1."));
        assert!(!script.contains("native-project-auxiliary"));
        assert!(!script.contains("invalid key"));
    }

    #[test]
    fn initialization_script_never_overwrites_a_newer_webview_preference() {
        let script = settings_initialization_script(&BTreeMap::from([(
            "theme".to_owned(),
            json!("stale-native-theme"),
        )]))
        .expect("valid script");

        assert!(script.contains("current_settings_bootstrap_v1"));
        assert!(script.contains("localStorage.getItem(marker) !== 'complete'"));
        assert!(script.contains("if (shouldRestore)"));
        assert!(script.contains("localStorage.getItem(key) === null"));
        assert!(script.contains("localStorage.setItem(marker, 'complete')"));
        assert_eq!(
            script.matches("localStorage.setItem(key, stored)").count(),
            1
        );
    }

    #[test]
    fn safe_key_detection_matches_the_database_boundary() {
        assert!(is_safe_setting_key("subtitle.editor:zoom-v2"));
        for safe_key in [
            "gemini_max_tokens",
            "maxTokens",
            "tokenCount",
            "use_cookies_for_download",
            "download_cookie_source",
        ] {
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
        assert!(!is_safe_setting_key("current_settings_bootstrap_v1"));
        assert!(!is_safe_setting_key("user_provided_subtitles"));
        assert!(!is_safe_setting_key("original_subtitles_map"));
        for native_owned_key in [
            "gemini.keySelection.v1",
            "project.subtitleCacheIndex.v1",
            "project.legacyAux.v1.019ffbea-26d5-7800-8e3b-69de8bff2d7d",
        ] {
            assert!(is_safe_setting_key(native_owned_key));
            assert!(!is_webview_bootstrap_setting_key(native_owned_key));
        }
        assert!(is_webview_bootstrap_setting_key("subtitle.editor:zoom-v2"));
    }

    #[test]
    fn saved_preferences_survive_relaunch_and_reach_the_fresh_webview_bootstrap() {
        let directory = tempfile::tempdir().expect("temporary application data");
        let database_path = directory.path().join("db/osg.sqlite3");
        {
            let database = Database::open(&database_path).expect("open settings database");
            database
                .put_settings(
                    "app",
                    &BTreeMap::from([
                        ("theme".to_owned(), json!("dark")),
                        ("use_cookies_for_download".to_owned(), json!("true")),
                        ("download_cookie_source".to_owned(), json!("firefox")),
                    ]),
                )
                .expect("save the settings snapshot");
        }

        let reopened = Database::open(&database_path).expect("reopen settings database");
        let settings = reopened
            .list_settings("app")
            .expect("load settings after relaunch");
        let script = settings_initialization_script(&settings).expect("fresh bootstrap script");

        assert!(script.contains("use_cookies_for_download"));
        assert!(script.contains("download_cookie_source"));
        assert!(script.contains("firefox"));
        assert!(script.contains("theme"));
        assert!(script.contains("dark"));
    }
}
