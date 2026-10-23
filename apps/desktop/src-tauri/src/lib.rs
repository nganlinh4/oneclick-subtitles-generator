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
mod main_window;
mod media_blob;
mod media_export;
mod media_pipeline;
mod media_runtime;
mod native_drop;
mod native_tools;
mod project_render_scene;
mod providers;
mod render;
mod speech;
mod speech_packages;
mod startup;
mod state;
pub(crate) mod transcription;
mod ui_fonts;
mod updater;
mod voice_samples;
mod waveform_cache;
mod webview_bootstrap;

use std::collections::BTreeMap;
use std::{io, time::Duration};

use app_close::{
    AppCloseCheckpointState, app_close_checkpoint_commit, app_close_checkpoint_complete,
    app_close_checkpoint_failed, handle_close_requested,
};
use asr::{asr_start, asr_status};
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
use download::{download_cancel, download_inspect, download_start, download_status};
use engine_packages::{
    engine_package_install, engine_package_remove, engine_packages_status, engine_runtime_start,
    engine_runtime_stop,
};
use external_links::open_external_link;
use f5_models::{f5_model_cancel, f5_model_install, f5_model_remove, f5_models_status};
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
use legacy_import::{legacy_import_select, legacy_import_status};
use live_music::{
    LiveMusicRuntime, live_music_close, live_music_control, live_music_rollback_start,
    live_music_start, live_music_update,
};
use media_blob::{media_blob_import, media_blob_release};
use media_export::media_export_start;
use media_pipeline::{media_pipeline_cancel, media_pipeline_inspect, media_pipeline_start};
use native_drop::{
    NativeMediaDropState, handle_native_media_drop_event, media_drop_claim, media_drop_discard,
    media_drop_subscribe, media_drop_unsubscribe,
};
use native_tools::{
    native_tool_cancel, native_tool_install, native_tool_remove, native_tools_catalog,
    native_tools_status,
};
use project_render_scene::{project_render_scene_get, project_render_scene_put};
use providers::{
    genius_lyrics, youtube_oauth_authorize, youtube_oauth_cancel, youtube_oauth_clear,
    youtube_oauth_status, youtube_search, youtube_thumbnail, youtube_video_details,
};
use render::{render_playback_release, render_result, render_runtime_status, render_start};
use serde_json::Value;
use speech::{
    speech_alignment_result, speech_alignment_start, speech_artifact_edit, speech_artifact_export,
    speech_artifact_resolve, speech_job_results, speech_playback_release, speech_probe,
    speech_project_narration_get, speech_project_narration_put, speech_reference_clear,
    speech_reference_commit, speech_reference_extract, speech_reference_get,
    speech_reference_import, speech_reference_select, speech_runtime_stop, speech_start,
    speech_status, speech_voice_conversion_start, speech_voice_inventory,
};
use speech_packages::{speech_package_install, speech_package_remove, speech_packages_status};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewWindowBuilder, Window, WindowEvent};
#[cfg(not(feature = "e2e-automation"))]
use tauri_plugin_window_state::StateFlags;
use transcription::{cancel_transcription, start_word_native_transcription};
use updater::{
    AppUpdateRuntime, app_update_cancel, app_update_check, app_update_install, updater_plugin,
};
use voice_samples::{
    voice_sample_resolve, voice_samples_cancel, voice_samples_install, voice_samples_remove,
    voice_samples_status,
};

#[cfg(feature = "e2e-automation")]
use self::main_window::apply_automation_window_placement;
#[cfg(not(feature = "e2e-automation"))]
use self::main_window::has_saved_main_window_state;
use self::startup::setup_app;
use self::webview_bootstrap::window_initialization_script;

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
mod tests;
