// The automation server is not a production diagnostic switch. Put the refusal in the library root
// (not only the executable) so `cargo check --lib --features production,e2e-automation` cannot
// compile the loopback server or any test-only state seam either.
#[cfg(all(feature = "production", feature = "e2e-automation"))]
compile_error!("the production and e2e-automation channels are mutually exclusive");
#[cfg(all(feature = "unsigned-local-build", feature = "e2e-automation"))]
compile_error!("the unsigned-local-build and e2e-automation channels are mutually exclusive");
#[cfg(all(feature = "ci-updater-fixture", feature = "e2e-automation"))]
compile_error!("the ci-updater-fixture and e2e-automation channels are mutually exclusive");

mod app_close;
mod asr;
#[cfg(any(feature = "e2e-automation", test))]
mod automation_window;
mod background;
mod cache;
#[cfg(feature = "ci-updater-fixture")]
mod ci_updater_fixture;
mod commands;
mod diagnostics;
mod dialog_paths;
mod document_export;
mod download;
mod engine_packages;
mod error;
mod external_links;
mod f5_models;
mod font_readiness;
mod font_repair;
mod gemini;
mod gemini_image;
mod glyph_atlas;
mod image_blob;
mod job_results;
mod legacy_import;
mod live_music;
mod media_blob;
mod media_export;
mod media_pipeline;
mod native_drop;
mod native_tools;
mod project_render_scene;
mod providers;
mod render;
mod speech;
mod speech_packages;
mod state;
pub(crate) mod transcription;
mod ui_fonts;
mod updater;
mod voice_samples;
mod waveform_cache;

use std::collections::BTreeMap;
use std::{
    io,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

use app_close::{
    AppCloseCheckpointState, app_close_checkpoint_commit, app_close_checkpoint_complete,
    app_close_checkpoint_failed, handle_close_requested,
};
use asr::{AsrRuntimeManager, asr_start, asr_status};
use cache::{cache_clear, cache_info, cache_prune_expired};
use commands::{
    active_workspace_begin, active_workspace_clear, active_workspace_get, active_workspace_set,
    app_health, clear_media, credential_delete, credential_replace, credential_reveal,
    credential_set, credential_status, credential_upsert, discard_media_candidate,
    get_session_snapshot, job_cancel, job_get, job_recovery_abandon_transcribe, jobs_list,
    open_media_asset, project_commit, project_create, project_history_status, project_load,
    project_load_transcript, project_redo, project_track_commit, project_track_history_status,
    project_track_redo, project_track_undo, project_undo, select_media, setting_delete,
    setting_get, setting_set, settings_clear, settings_set_many, subtitle_project_alias_activate,
    subtitle_project_alias_remove, subtitle_project_index_get,
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
use f5_models::{
    F5ModelRuntime, f5_model_cancel, f5_model_install, f5_model_remove, f5_models_status,
};
use font_readiness::FontReadiness;
use font_repair::font_readiness_retry;
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
use job_results::{job_result_ack, job_result_claim, job_result_pending};
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
use osg_runtime_staging::RuntimeStagingAuthority;
use project_render_scene::{project_render_scene_get, project_render_scene_put};
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
    speech_probe, speech_project_narration_get, speech_project_narration_put,
    speech_reference_clear, speech_reference_commit, speech_reference_extract,
    speech_reference_get, speech_reference_import, speech_reference_select, speech_runtime_stop,
    speech_start, speech_status, speech_voice_conversion_start, speech_voice_inventory,
};
use speech_packages::{
    SpeechPackageRuntime, speech_package_install, speech_package_remove, speech_packages_status,
};
use state::DesktopState;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewWindowBuilder, Window, WindowEvent};
#[cfg(not(feature = "e2e-automation"))]
use tauri_plugin_window_state::StateFlags;
use transcription::{cancel_transcription, start_word_native_transcription};
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
    #[cfg(feature = "e2e-automation")]
    automation_window::require_harness_environment()
        .unwrap_or_else(|error| panic!("unsafe E2E automation launch: {error}"));
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
        .plugin(tauri_plugin_wdio_webdriver::init_with_window_guard(
            |window| {
                automation_window::isolate(window)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
        ))
        .plugin(tauri_plugin_wdio::init());
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(updater_plugin());
    // The window-state plugin resolves its file through the real Windows config directory rather
    // than the isolated E2E data root. Letting it run in automation restored the developer's live
    // maximized-window record and moved an otherwise off-screen run onto the interactive desktop.
    #[cfg(not(feature = "e2e-automation"))]
    let app = app.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
            .build(),
    );
    let app = app
        .manage(NativeMediaDropState::default())
        .manage(LiveMusicRuntime::default())
        .manage(ImageBlobStore::default())
        .manage(GlyphAtlasStore::new())
        .manage(GeneratedImageRuntime::default())
        .manage(AppUpdateRuntime::default())
        .manage(AppCloseCheckpointState::default())
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
                // Automation is intentionally isolated from the interactive desktop. A configured
                // off-screen position is not sufficient on Windows: the shell may recenter a new
                // native window before Tauri applies it. Move the already-created surface again,
                // but never focus it or move it on-screen in this channel. WebDriver may make the
                // compositor surface technically visible so video keeps advancing; a rectangle
                // beyond the complete virtual desktop is therefore the enforceable safety boundary,
                // not an inaccurate visibility claim.
                #[cfg(feature = "e2e-automation")]
                if automation_window::offscreen_requested() {
                    let placement = automation_window::isolate(&window)
                        .expect("the automation window must leave the interactive desktop");
                    diagnostics::record(
                        "automation.window_offscreen",
                        &[
                            ("x", placement.x.to_string()),
                            ("y", placement.y.to_string()),
                        ],
                    );
                    return;
                }
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
            app_close_checkpoint_complete,
            app_close_checkpoint_failed,
            app_close_checkpoint_commit,
            font_readiness_retry,
            get_session_snapshot,
            active_workspace_get,
            active_workspace_begin,
            active_workspace_set,
            active_workspace_clear,
            subtitle_project_index_get,
            subtitle_project_alias_activate,
            subtitle_project_alias_remove,
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
            project_load_transcript,
            project_history_status,
            project_track_history_status,
            project_commit,
            project_track_commit,
            project_undo,
            project_redo,
            project_track_undo,
            project_track_redo,
            project_render_scene_get,
            project_render_scene_put,
            jobs_list,
            job_get,
            job_cancel,
            job_recovery_abandon_transcribe,
            job_result_pending,
            job_result_claim,
            job_result_ack,
            credential_set,
            credential_upsert,
            credential_replace,
            credential_reveal,
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
            media_blob_import,
            media_blob_release,
            media_export_start,
            subtitle_document_export,
            subtitle_archive_export,
            generated_file_export,
            gemini_start,
            start_word_native_transcription,
            cancel_transcription,
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
            f5_models_status,
            f5_model_install,
            f5_model_cancel,
            f5_model_remove,
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
            speech_reference_get,
            speech_reference_commit,
            speech_reference_clear,
            speech_start,
            speech_voice_conversion_start,
            speech_artifact_edit,
            speech_project_narration_put,
            speech_project_narration_get,
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
    #[cfg(feature = "e2e-automation")]
    if window.label() == "main"
        && matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::Focused(true)
        )
    {
        automation_window::isolate(window)
            .expect("the automation window must remain outside the interactive desktop");
    }
    handle_native_media_drop_event(window, event);
    if let WindowEvent::CloseRequested { api, .. } = event
        && is_main_window_close_request(window.label(), true)
    {
        // OSG has no tray/background mode. Tauri's runtime destroys an unprevented closing window
        // only after the editor has drained its durable revision queue. Rust owns the native close
        // decision; JavaScript receives only a one-shot nonce with which to acknowledge that drain.
        diagnostics::record("app.close_requested", &[]);
        handle_close_requested(window, api, &window.state::<AppCloseCheckpointState>());
    }
}

fn is_main_window_close_request(window_label: &str, close_requested: bool) -> bool {
    window_label == "main" && close_requested
}

#[allow(
    clippy::too_many_lines,
    reason = "application setup keeps resource construction and Tauri state registration in one auditable order"
)]
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
    let (runtime_staging_authority, staging_report) = RuntimeStagingAuthority::prepare_with_report(
        &cache_dir.join("v1/runtime-staging-authority"),
    )?;
    diagnostics::record(
        "runtime-staging.reconciled",
        &[
            ("reclaimed", staging_report.reclaimed.to_string()),
            ("deferred", staging_report.deferred.to_string()),
            ("active", staging_report.active.to_string()),
        ],
    );
    let font_readiness =
        std::sync::Arc::new(FontReadiness::new(font_readiness::MANAGED_SUBTITLE_FAMILY));
    let font_bundle = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("ui-fonts"));
    let ui_font_runtime =
        prepare_ui_font_runtime(app, &local_data_dir, font_bundle.clone(), &font_readiness);
    let database_path = local_data_dir.join("db/osg.sqlite3");
    let database = Database::open(database_path)?;
    let SpeechSetup {
        runtime: speech_runtime,
        resource_dir,
    } = prepare_speech_runtime(
        app,
        &local_data_dir,
        &cache_dir,
        runtime_staging_authority.clone(),
    )?;
    let asr = AsrRuntimeManager::new_with_staging_authority(
        cache_dir.join("v1/asr"),
        resource_dir.clone(),
        runtime_staging_authority.clone(),
    )?;
    // Persistent stores under local data keep their staging-authority journals INSIDE the store
    // (the constructor prepares `<store>/.runtime-staging-authority`). Sharing the cache-rooted
    // authority split journal and store across two directories a customer can clear independently:
    // clearing the app cache after an interrupted install orphaned the store's `.staging` entry,
    // which the store then refused forever — an unbootable application.
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
    let media_blob_store = MediaBlobStore::new_with_staging_authority(
        &cache_dir.join("v1/ephemeral-audio"),
        &runtime_staging_authority,
    )?;
    let engine_package_runtime =
        EnginePackageRuntime::new(engine_package_manager, database.clone(), Arc::clone(&jobs))?;
    let speech_package_runtime =
        SpeechPackageRuntime::new(speech_runtime.package_manager()?, Arc::clone(&jobs));
    let f5_model_runtime =
        F5ModelRuntime::new(&local_data_dir.join("engines/speech/f5-models-v1"))?;
    let native_tool_runtime = NativeToolRuntime::new(
        &local_data_dir.join("native-tools/v1"),
        database.clone(),
        Arc::clone(&jobs),
    )?;
    let media_runtimes = prepare_media_runtimes(
        &cache_dir,
        &media_server,
        &native_tool_runtime,
        runtime_staging_authority.clone(),
    )?;
    let render_runtime = RenderRuntimeHost::new(
        &cache_dir,
        runtime_staging_authority.clone(),
        media_server.clone(),
    )?;
    attach_media_runtime_activator(&native_tool_runtime, &media_runtimes, &render_runtime)?;
    app.manage(media_runtimes.download);
    app.manage(media_runtimes.pipeline);
    app.manage(render_runtime);
    app.manage(engine_package_runtime);
    app.manage(speech_package_runtime);
    app.manage(f5_model_runtime);
    app.manage(native_tool_runtime);
    app.manage(voice_sample_runtime);
    app.manage(speech_runtime);
    app.manage(media_blob_store);
    app.manage(media_server.clone());
    app.manage(runtime_staging_authority);
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
        &font_readiness.snapshot(),
    )?;
    if let Some(runtime) = ui_font_runtime {
        app.manage(runtime);
    }
    app.manage(font_repair::FontRepairContext::new(
        local_data_dir.join("ui-fonts/v1"),
        font_bundle,
    ));
    app.manage(font_readiness);
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

/// Begin preparing the managed font and report every outcome through one authority.
///
/// Returns the runtime only when preparation finished quickly enough to inject the stylesheet with
/// the first document. When it did not, preparation continues and `late_font_ready` completes the
/// job against the live window — which is the case that used to leave the default subtitle font
/// permanently unavailable for the session.
fn prepare_ui_font_runtime(
    app: &tauri::App,
    local_data_dir: &std::path::Path,
    bundle: Option<std::path::PathBuf>,
    readiness: &std::sync::Arc<FontReadiness>,
) -> Option<UiFontRuntime> {
    diagnostics::record("ui-font.prepare", &[]);
    let handle = app.handle().clone();
    let late_readiness = std::sync::Arc::clone(readiness);
    let outcome = UiFontRuntime::prepare(
        &local_data_dir.join("ui-fonts/v1"),
        bundle,
        readiness,
        move |late| late_font_ready(&handle, &late_readiness, late),
    );
    match outcome {
        Ok(prepared) => {
            diagnostics::record("ui-font.ready", &[]);
            Some(prepared.runtime)
        }
        // The reason used to be discarded, so an installation that timed out and one that failed
        // outright produced the same silent `ui-font.unavailable` — which is how a startup timeout
        // went unnoticed while it disabled the default subtitle font on every clean install. The
        // typed reason is recorded; no message is, because a delivery message can name a path.
        Err(reason) => {
            diagnostics::record("ui-font.deferred", &[("reason", format!("{reason:?}"))]);
            None
        }
    }
}

/// Finish a preparation that outlived the startup wait, against the window that already exists.
///
/// Order matters and is the reason this is not two independent steps: the stylesheet is installed
/// first, and only then is readiness published. Announcing `Ready` before the faces exist would
/// invite the editor to resolve a font it cannot draw — the same class of lie the original boolean
/// told, in the opposite direction.
pub(crate) fn late_font_ready(
    handle: &tauri::AppHandle,
    readiness: &std::sync::Arc<FontReadiness>,
    outcome: Result<ui_fonts::PreparedUiFont, font_readiness::FontRefusal>,
) {
    use tauri::Manager as _;

    let record = match outcome {
        Ok(prepared) => {
            let installed = handle
                .get_webview_window("main")
                .map(|window| window.eval(ui_font_install_script(prepared.runtime.css()).as_str()));
            if matches!(installed, Some(Ok(()))) {
                diagnostics::record("ui-font.ready", &[("late", "true".to_owned())]);
                // The package lease must outlive the stylesheet the `WebView` is now using, so it
                // is held by the application exactly as the startup path holds it.
                handle.manage(prepared.runtime);
                readiness.mark_ready(prepared.version)
            } else {
                // No window, or the injection failed. The bytes are installed and the next launch
                // will use them, so this session reports a retryable state rather than success.
                diagnostics::record("ui-font.deferred", &[("reason", "not-injected".to_owned())]);
                readiness.mark_refused(font_readiness::FontRefusal::StoreUnavailable)
            }
        }
        Err(reason) => {
            diagnostics::record("ui-font.unavailable", &[("reason", format!("{reason:?}"))]);
            readiness.mark_refused(reason)
        }
    };
    // Delivered by evaluating a script in the window rather than by a Tauri event, because this
    // application denies `core:event:listen` to the `WebView` and that restriction is not worth
    // trading away for a capability notification. The frontend listens for the DOM event this
    // dispatches, which needs no additional privilege at all.
    if let (Some(window), Ok(script)) = (
        handle.get_webview_window("main"),
        font_readiness_publish_script(&record),
    ) {
        let _ = window.eval(&script);
    }
}

/// JavaScript that replaces the published readiness record and announces the change.
///
/// Assignment first, then the event: a listener that reacts by reading the record must see the new
/// one, so there is a single source of truth rather than an event payload racing a global.
fn font_readiness_publish_script(
    record: &font_readiness::FontReadinessRecord,
) -> Result<String, serde_json::Error> {
    let literal = serde_json::to_string(record)?;
    let event = font_readiness::FONT_READINESS_EVENT;
    Ok(format!(
        "(() => {{ const record = {literal}; window.__OSG_FONT_READINESS__ = record; window.dispatchEvent(new CustomEvent('{event}', {{ detail: record }})); }})();"
    ))
}

fn build_main_window(
    app: &mut tauri::App,
    settings: &BTreeMap<String, Value>,
    ui_font_css: Option<&str>,
    readiness: &font_readiness::FontReadinessRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| io::Error::other("the main window configuration is missing"))?;
    #[cfg(not(feature = "e2e-automation"))]
    if has_saved_main_window_state(app) {
        // Start neutral so a saved non-maximized window is not overridden by the
        // maximized first-launch default. The plugin restores the saved state when
        // this dynamically-created window becomes ready.
        window_config.maximized = false;
    }
    #[cfg(feature = "e2e-automation")]
    apply_automation_window_placement(&mut window_config, automation_window::offscreen_requested());
    let window_builder = WebviewWindowBuilder::from_config(app, &window_config)?;
    #[cfg(all(feature = "ci-updater-fixture", not(feature = "e2e-automation")))]
    let browser_arguments = ci_updater_fixture::configuration().browser_arguments();
    #[cfg(all(not(feature = "ci-updater-fixture"), not(feature = "e2e-automation")))]
    let browser_arguments: Option<String> = None;
    #[cfg(feature = "e2e-automation")]
    let browser_arguments = Some(automation_window::automation_browser_arguments());
    let window_builder = if let Some(arguments) = browser_arguments {
        window_builder.additional_browser_args(&arguments)
    } else {
        window_builder
    };
    #[cfg(feature = "e2e-automation")]
    let window_builder = window_builder
        .initialization_script(automation_window::AUTOMATION_INTERACTION_GUARD_SCRIPT);
    let window = window_builder
        .initialization_script(window_initialization_script(
            settings,
            ui_font_css,
            readiness,
        )?)
        .build()?;
    #[cfg(not(feature = "e2e-automation"))]
    let _ = &window;
    // Apply the native position only after creation as well as in the declarative config. Windows
    // can ignore an entirely off-screen initial coordinate and recenter it, but it accepts the same
    // coordinate once the HWND exists. The surface remains outside the interactive desktop for the
    // entire automation run even if WebDriver makes its compositor-visible HWND technically visible.
    #[cfg(feature = "e2e-automation")]
    if automation_window::offscreen_requested() {
        let native_window = window.as_ref().window();
        automation_window::isolate(&native_window)?;
    }
    Ok(())
}

/// Keep autonomous GUI journeys away from the interactive desktop without hiding or minimizing
/// the `WebView`. Windows may throttle a minimized surface, which would invalidate GPU preview and
/// video evidence; an off-screen, compositor-visible surface keeps those paths real. This call and
/// its environment input are compiled only into the guarded automation channel.
#[cfg(any(feature = "e2e-automation", test))]
fn apply_automation_window_placement(
    window: &mut tauri::utils::config::WindowConfig,
    offscreen: bool,
) {
    if !offscreen {
        return;
    }
    window.center = false;
    window.x = Some(-10_000.0);
    window.y = Some(0.0);
    window.prevent_overflow = Some(tauri::utils::config::PreventOverflowConfig::Enable(false));
    window.maximized = false;
    window.visible = false;
    window.focus = false;
    window.skip_taskbar = true;
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

#[cfg(any(not(feature = "e2e-automation"), test))]
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

#[cfg(any(not(feature = "e2e-automation"), test))]
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

struct SpeechSetup {
    runtime: SpeechRuntime,
    resource_dir: Option<std::path::PathBuf>,
}

fn prepare_speech_runtime(
    app: &tauri::App,
    local_data_dir: &std::path::Path,
    cache_dir: &std::path::Path,
    staging_authority: RuntimeStagingAuthority,
) -> io::Result<SpeechSetup> {
    let resource_dir = app.path().resource_dir().ok();
    let runtime = SpeechRuntime::new_with_staging_authority(
        local_data_dir.join("engines/speech"),
        cache_dir.join("v1/speech"),
        resource_dir.clone(),
        staging_authority,
    )?;
    Ok(SpeechSetup {
        runtime,
        resource_dir,
    })
}

// SQLite is the durable preference authority. The WebView mirrors it so legacy readers can keep
// using localStorage while they are migrated, but a crash between the native commit and that mirror
// update must not resurrect the stale browser value on the next launch.
//
// The marker remains only so upgraded installations can discard the old one-shot bootstrap state.
// Both bookkeeping keys are WebView-only because the `current_` prefix is excluded from settings.
const WEBVIEW_SETTINGS_BOOTSTRAP_MARKER: &str = "current_settings_bootstrap_v1";
const WEBVIEW_NATIVE_SETTINGS_KEY_INDEX: &str = "current_native_settings_keys_v1";

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
    let index_literal = serde_json::to_string(WEBVIEW_NATIVE_SETTINGS_KEY_INDEX)?;
    Ok(format!(
        "(() => {{ localStorage.removeItem('original_subtitles_map'); const marker = {marker_literal}; const indexKey = {index_literal}; const values = JSON.parse({string_literal}); let previousKeys = []; try {{ const parsed = JSON.parse(localStorage.getItem(indexKey) || '[]'); if (Array.isArray(parsed)) previousKeys = parsed.filter(key => typeof key === 'string' && /^[A-Za-z0-9._:-]{{1,128}}$/.test(key) && !key.startsWith('current_')); }} catch (_error) {{ previousKeys = []; }} const currentKeys = Object.keys(values); const currentKeySet = new Set(currentKeys); for (const key of previousKeys) {{ if (!currentKeySet.has(key)) localStorage.removeItem(key); }} for (const [key, value] of Object.entries(values)) {{ const stored = typeof value === 'string' ? value : JSON.stringify(value); if (stored !== undefined) localStorage.setItem(key, stored); }} localStorage.setItem(indexKey, JSON.stringify(currentKeys)); localStorage.removeItem(marker); }})();"
    ))
}

/// JavaScript that installs the managed font stylesheet, idempotently.
///
/// Shared by the first-document bootstrap and by a late repair that has to reach a window already
/// on screen. One implementation on purpose: two would drift, and the difference between them would
/// be invisible until a font failed to appear in exactly one of the two paths.
fn ui_font_install_script(css: &str) -> String {
    let css_literal = serde_json::to_string(css).unwrap_or_else(|_| "\"\"".to_owned());
    format!(
        "(() => {{ const css = {css_literal}; const install = () => {{ if (document.getElementById('osg-managed-ui-font')) return true; const target = document.head || document.documentElement; if (!target) return false; const style = document.createElement('style'); style.id = 'osg-managed-ui-font'; style.textContent = css; target.appendChild(style); return true; }}; if (!install()) {{ const retry = () => {{ if (install()) {{ document.removeEventListener('readystatechange', retry); document.removeEventListener('DOMContentLoaded', retry); }} }}; document.addEventListener('readystatechange', retry); document.addEventListener('DOMContentLoaded', retry); }} }})();"
    )
}

fn window_initialization_script(
    settings: &BTreeMap<String, Value>,
    ui_font_css: Option<&str>,
    readiness: &font_readiness::FontReadinessRecord,
) -> Result<String, serde_json::Error> {
    let settings_script = settings_initialization_script(settings)?;
    // A mutable property, not a frozen one. Readiness changes: a repair that finishes after startup
    // publishes a new record, and a value defined with `writable: false` could never carry it. That
    // is precisely how a font that finished installing seconds late stayed unavailable all session.
    let record_literal = serde_json::to_string(readiness)?;
    let readiness_script = format!("window.__OSG_FONT_READINESS__ = {record_literal};");
    let install_script = ui_font_css.map(ui_font_install_script).unwrap_or_default();
    Ok(format!(
        "{install_script}{readiness_script}{settings_script}"
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
/// This exists ONLY in the two test-only channels. There is no `cfg` in this function that a
/// production build compiles: `production` enables neither feature, no release workflow builds
/// either, and `scripts/check-release-readiness.js` asserts both. The path is required to be
/// absolute so a relative value cannot quietly resolve against whatever directory the harness
/// happened to start in, and creation failure is fatal rather than a silent fall back to the real
/// root — falling back is precisely the behaviour that would write test data into someone's live
/// database.
#[cfg(any(feature = "unsigned-local-build", feature = "e2e-automation"))]
pub(crate) fn harness_data_root() -> Option<std::path::PathBuf> {
    let raw = std::env::var_os("OSG_E2E_DATA_ROOT")?;
    let root = std::path::PathBuf::from(raw);
    assert!(
        root.is_absolute(),
        "OSG_E2E_DATA_ROOT must be an absolute path"
    );
    std::fs::create_dir_all(&root).expect("OSG_E2E_DATA_ROOT must be creatable");
    Some(root)
}

#[cfg(not(any(feature = "unsigned-local-build", feature = "e2e-automation")))]
pub(crate) const fn harness_data_root() -> Option<std::path::PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use osg_infrastructure::storage::Database;
    use serde_json::json;

    use super::{
        FontReadiness, apply_automation_window_placement, font_readiness,
        has_valid_main_window_state, is_main_window_close_request, is_safe_setting_key,
        is_webview_bootstrap_setting_key, media_server_allowed_origins,
        settings_initialization_script, window_initialization_script,
    };

    #[test]
    fn automation_window_stays_renderable_without_entering_the_interactive_desktop() {
        let mut window = tauri::utils::config::WindowConfig {
            center: true,
            maximized: true,
            focus: true,
            ..Default::default()
        };

        apply_automation_window_placement(&mut window, true);

        assert_eq!(window.x, Some(-10_000.0));
        assert_eq!(window.y, Some(0.0));
        assert!(!window.center);
        assert!(!window.maximized);
        assert!(!window.visible);
        assert!(!window.focus);
        assert!(window.skip_taskbar);
        assert_eq!(
            window.prevent_overflow,
            Some(tauri::utils::config::PreventOverflowConfig::Enable(false))
        );
    }

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
        let readiness = FontReadiness::new(font_readiness::MANAGED_SUBTITLE_FAMILY);
        let record = readiness.mark_ready("v22-ui4".to_owned());
        let script = window_initialization_script(
            &BTreeMap::new(),
            Some("@font-face{font-family:'Google Sans';src:url(data:font/woff2;base64,AA==)}"),
            &record,
        )
        .expect("valid script");
        assert!(script.contains("osg-managed-ui-font"));
        assert!(script.contains("data:font/woff2;base64,AA=="));
        assert!(script.contains("readystatechange"));
        assert!(script.contains("DOMContentLoaded"));
        assert!(script.contains(r#""state":"ready""#));
        assert!(script.contains(r#""version":"v22-ui4""#));
        assert!(!script.contains("(document.head || document.documentElement).appendChild"));
        assert!(!script.contains("file://"));
        assert!(!script.contains("C:\\\\"));
    }

    /// The record must be assignable, because a repair that lands after startup has to replace it.
    ///
    /// The previous bootstrap used `Object.defineProperty` with no writable flag, which is exactly
    /// what made a late-installed font permanently unavailable for the session.
    #[test]
    fn window_initialization_publishes_a_replaceable_readiness_record() {
        let readiness = FontReadiness::new(font_readiness::MANAGED_SUBTITLE_FAMILY);
        let script = window_initialization_script(&BTreeMap::new(), None, &readiness.snapshot())
            .expect("valid script");
        assert!(script.contains("window.__OSG_FONT_READINESS__ ="));
        assert!(!script.contains("defineProperty"));
        assert!(script.contains(r#""state":"resolving""#));
        // Nothing has installed, so no stylesheet may be claimed.
        assert!(!script.contains("osg-managed-ui-font"));
    }

    /// A late repair must be able to replace a record that was already published.
    ///
    /// Delivered by evaluating this script rather than by a Tauri event, because the `WebView` is
    /// denied `core:event:listen`. The assignment must come before the announcement, or a listener
    /// that reads the record on notification reads the previous one.
    #[test]
    fn a_late_readiness_publication_assigns_before_it_announces() {
        let readiness = FontReadiness::new(font_readiness::MANAGED_SUBTITLE_FAMILY);
        readiness.mark_refused(font_readiness::FontRefusal::TimedOut);
        let record = readiness.mark_ready("v22-ui4".to_owned());

        let script = super::font_readiness_publish_script(&record).expect("valid script");
        let assignment = script
            .find("window.__OSG_FONT_READINESS__ =")
            .expect("assigns");
        let announcement = script.find("dispatchEvent").expect("announces");
        assert!(
            assignment < announcement,
            "the record must be current before it is announced"
        );
        assert!(script.contains(font_readiness::FONT_READINESS_EVENT));
        assert!(script.contains(r#""state":"ready""#));
        assert!(
            script.contains(r#""epoch":2"#),
            "a late record must carry the advanced epoch"
        );
    }

    #[test]
    fn window_initialization_reports_a_refusal_with_its_typed_reason() {
        let readiness = FontReadiness::new(font_readiness::MANAGED_SUBTITLE_FAMILY);
        let record = readiness.mark_refused(font_readiness::FontRefusal::NoUsableSource);
        let script =
            window_initialization_script(&BTreeMap::new(), None, &record).expect("valid script");
        assert!(script.contains(r#""state":"refused""#));
        assert!(script.contains(r#""reason":"no-usable-source""#));
        assert!(script.contains(r#""retryable":true"#));
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
    fn initialization_script_makes_native_preferences_authoritative_after_a_crash() {
        let script = settings_initialization_script(&BTreeMap::from([(
            "theme".to_owned(),
            json!("committed-native-theme"),
        )]))
        .expect("valid script");

        assert!(script.contains("current_settings_bootstrap_v1"));
        assert!(script.contains("current_native_settings_keys_v1"));
        assert!(script.contains("committed-native-theme"));
        assert!(!script.contains("localStorage.getItem(key) === null"));
        assert_eq!(
            script.matches("localStorage.setItem(key, stored)").count(),
            1
        );
        assert!(script.contains("localStorage.removeItem(marker)"));
    }

    #[test]
    fn initialization_script_removes_only_valid_previously_native_keys() {
        let script = settings_initialization_script(&BTreeMap::new()).expect("valid script");

        assert!(script.contains("Array.isArray(parsed)"));
        assert!(script.contains("/^[A-Za-z0-9._:-]{1,128}$/"));
        assert!(script.contains("!key.startsWith('current_')"));
        assert!(script.contains("if (!currentKeySet.has(key)) localStorage.removeItem(key)"));
        assert!(script.contains("localStorage.setItem(indexKey, JSON.stringify(currentKeys))"));
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
        assert!(!is_safe_setting_key("current_native_settings_keys_v1"));
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
