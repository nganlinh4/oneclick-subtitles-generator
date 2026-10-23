//! Main-window placement and saved window-state validation.

#[cfg(any(not(feature = "e2e-automation"), test))]
use serde_json::Value;
#[cfg(not(feature = "e2e-automation"))]
use tauri::Manager;

/// Keep autonomous GUI journeys away from the interactive desktop without hiding or minimizing
/// the `WebView`. Windows may throttle a minimized surface, which would invalidate GPU preview and
/// video evidence; an off-screen, compositor-visible surface keeps those paths real. This call and
/// its environment input are compiled only into the guarded automation channel.
#[cfg(any(feature = "e2e-automation", test))]
pub(crate) fn apply_automation_window_placement(
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

#[cfg(not(feature = "e2e-automation"))]
pub(crate) fn has_saved_main_window_state(app: &tauri::App) -> bool {
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
pub(crate) fn has_valid_main_window_state(saved_states: &Value) -> bool {
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
