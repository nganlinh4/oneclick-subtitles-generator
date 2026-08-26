use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use tauri::{Manager, Runtime};

use crate::server::response::{WebDriverErrorResponse, WebDriverResponse, WebDriverResult};
use crate::server::AppState;

#[derive(Debug, Deserialize)]
pub struct SwitchWindowRequest {
    pub handle: String,
}

#[derive(Debug, Deserialize)]
pub struct NewWindowRequest {
    #[allow(dead_code)] // Part of W3C protocol but not used in current implementation
    #[serde(rename = "type", default)]
    pub window_type: Option<String>,
}

// The guarded handler deserializes this shape only to return a typed refusal;
// none of the requested native-window values may be observed or applied.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct WindowRectRequest {
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

/// GET `/session/{session_id}/window` - Get current window handle
pub async fn get_window_handle<R: Runtime>(
    State(state): State<Arc<AppState<R>>>,
    Path(session_id): Path<String>,
) -> WebDriverResult {
    let sessions = state.sessions.read().await;
    let session = sessions.get(&session_id)?;
    let current_window = session.current_window.clone();
    drop(sessions);

    // Return the session's current window handle
    Ok(WebDriverResponse::success(current_window))
}

/// GET `/session/{session_id}/window/handles` - Get all window handles
pub async fn get_window_handles<R: Runtime>(
    State(state): State<Arc<AppState<R>>>,
    Path(session_id): Path<String>,
) -> WebDriverResult {
    let sessions = state.sessions.read().await;
    let _session = sessions.get(&session_id)?;
    drop(sessions);

    // Return all window labels as handles
    let handles: Vec<String> = state.app.webview_windows().keys().cloned().collect();

    Ok(WebDriverResponse::success(handles))
}

/// DELETE `/session/{session_id}/window` - Close current window
pub async fn close_window<R: Runtime>(
    State(state): State<Arc<AppState<R>>>,
    Path(session_id): Path<String>,
) -> WebDriverResult {
    // Window closing is not supported on mobile platforms
    #[cfg(mobile)]
    {
        let _ = (state, session_id);
        Err(WebDriverErrorResponse::unsupported_operation(
            "Closing windows is not supported on mobile platforms",
        ))
    }

    #[cfg(desktop)]
    {
        let sessions = state.sessions.read().await;
        let session = sessions.get(&session_id)?;
        let current_window = session.current_window.clone();
        drop(sessions);

        // Close the current window
        if let Some(window) = state.app.webview_windows().get(&current_window).cloned() {
            window
                .destroy()
                .map_err(|e| WebDriverErrorResponse::unknown_error(&e.to_string()))?;

            // Return remaining window handles
            let handles: Vec<String> = state.app.webview_windows().keys().cloned().collect();

            Ok(WebDriverResponse::success(handles))
        } else {
            Err(WebDriverErrorResponse::no_such_window())
        }
    }
}

/// POST `/session/{session_id}/window` - Switch to window
pub async fn switch_to_window<R: Runtime>(
    State(state): State<Arc<AppState<R>>>,
    Path(session_id): Path<String>,
    Json(request): Json<SwitchWindowRequest>,
) -> WebDriverResult {
    let mut sessions = state.sessions.write().await;
    let session = sessions.get_mut(&session_id)?;

    // Verify the window exists
    if !state.app.webview_windows().contains_key(&request.handle) {
        return Err(WebDriverErrorResponse::no_such_window());
    }

    session.switch_to_window(request.handle).map_err(|_| {
        WebDriverErrorResponse::unknown_error("Browsing context generation overflowed")
    })?;

    Ok(WebDriverResponse::null())
}

/// POST `/session/{session_id}/window/new` - Create new window
pub async fn new_window<R: Runtime + 'static>(
    State(state): State<Arc<AppState<R>>>,
    Path(session_id): Path<String>,
    Json(_request): Json<NewWindowRequest>,
) -> WebDriverResult {
    let sessions = state.sessions.read().await;
    let _session = sessions.get(&session_id)?;
    drop(sessions);

    // Note: Creating new windows in Tauri requires app-specific logic
    // This is a stub that returns an error - apps should handle this via commands
    Err(WebDriverErrorResponse::unsupported_operation(
        "Creating new windows is not supported in this context",
    ))
}

/// GET `/session/{session_id}/window/rect` - Get window rect
pub async fn get_rect<R: Runtime + 'static>(
    State(state): State<Arc<AppState<R>>>,
    Path(session_id): Path<String>,
) -> WebDriverResult {
    let sessions = state.sessions.read().await;
    let session = sessions.get(&session_id)?;
    let current_window = session.current_window.clone();
    let timeouts = session.timeouts.clone();
    let frame_context = session.frame_context.clone();
    drop(sessions);

    let executor = state.get_executor_for_window(&current_window, timeouts, frame_context)?;
    let rect = executor.get_window_rect().await?;

    Ok(WebDriverResponse::success(json!({
        "x": rect.x,
        "y": rect.y,
        "width": rect.width,
        "height": rect.height
    })))
}

/// POST `/session/{session_id}/window/rect` - Set window rect
pub async fn set_rect<R: Runtime + 'static>(
    State(_state): State<Arc<AppState<R>>>,
    Path(_session_id): Path<String>,
    Json(_request): Json<WindowRectRequest>,
) -> WebDriverResult {
    Err(WebDriverErrorResponse::unsupported_operation(
        "the guarded automation server refuses native-window position and size changes",
    ))
}

/// POST `/session/{session_id}/window/maximize` - Maximize window
pub async fn maximize<R: Runtime + 'static>(
    State(_state): State<Arc<AppState<R>>>,
    Path(_session_id): Path<String>,
) -> WebDriverResult {
    Err(WebDriverErrorResponse::unsupported_operation(
        "the guarded automation server refuses native-window maximization",
    ))
}

/// POST `/session/{session_id}/window/minimize` - Minimize window
pub async fn minimize<R: Runtime + 'static>(
    State(_state): State<Arc<AppState<R>>>,
    Path(_session_id): Path<String>,
) -> WebDriverResult {
    Err(WebDriverErrorResponse::unsupported_operation(
        "the guarded automation server refuses native-window minimization",
    ))
}

/// POST `/session/{session_id}/window/fullscreen` - Fullscreen window
pub async fn fullscreen<R: Runtime + 'static>(
    State(_state): State<Arc<AppState<R>>>,
    Path(_session_id): Path<String>,
) -> WebDriverResult {
    Err(WebDriverErrorResponse::unsupported_operation(
        "the guarded automation server refuses native-window fullscreen",
    ))
}
