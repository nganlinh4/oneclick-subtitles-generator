//! Application setup: data roots, durable state, runtimes, UI fonts and managed state.

use std::{io, sync::Arc};

use osg_application::JobRegistry;
use osg_engine_packages::EnginePackageManager;
use osg_infrastructure::storage::Database;
use osg_media_server::MediaServer;
use osg_runtime_staging::RuntimeStagingAuthority;
use tauri::Manager;

use crate::asr::AsrRuntimeManager;
use crate::diagnostics;
use crate::engine_packages::EnginePackageRuntime;
use crate::f5_models::F5ModelRuntime;
use crate::font_readiness;
use crate::font_readiness::FontReadiness;
use crate::font_repair;
use crate::media_blob::MediaBlobStore;
use crate::media_runtime::{
    attach_media_runtime_activator, media_server_allowed_origins, prepare_media_runtimes,
};
use crate::native_tools::NativeToolRuntime;
use crate::render::RenderRuntimeHost;
use crate::speech::SpeechRuntime;
use crate::speech_packages::SpeechPackageRuntime;
use crate::state::DesktopState;
use crate::ui_fonts;
use crate::ui_fonts::UiFontRuntime;
use crate::voice_samples::VoiceSampleRuntime;
use crate::webview_bootstrap::{is_safe_setting_key, ui_font_install_script};
use crate::{build_main_window, harness_data_root, record_application_environment};

#[allow(
    clippy::too_many_lines,
    reason = "application setup keeps resource construction and Tauri state registration in one auditable order"
)]
pub(crate) fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
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
pub(crate) fn font_readiness_publish_script(
    record: &font_readiness::FontReadinessRecord,
) -> Result<String, serde_json::Error> {
    let literal = serde_json::to_string(record)?;
    let event = font_readiness::FONT_READINESS_EVENT;
    Ok(format!(
        "(() => {{ const record = {literal}; window.__OSG_FONT_READINESS__ = record; window.dispatchEvent(new CustomEvent('{event}', {{ detail: record }})); }})();"
    ))
}

pub(crate) struct SpeechSetup {
    pub(crate) runtime: SpeechRuntime,
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
