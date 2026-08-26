use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Runtime;

use crate::server::response::{WebDriverErrorResponse, WebDriverResponse, WebDriverResult};
use crate::server::AppState;
use crate::webdriver::Timeouts;

/// Wait for a window to become available, polling with timeout
async fn wait_for_window<R: Runtime>(
    state: &AppState<R>,
    timeout_ms: u64,
    target_label: Option<&str>,
) -> Result<String, WebDriverErrorResponse> {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);
    let poll_interval = std::time::Duration::from_millis(100);

    loop {
        let window_labels = state.get_window_labels();

        // If a specific label was requested, check for it
        if let Some(label) = target_label {
            if window_labels.contains(&label.to_string()) {
                return Ok(label.to_string());
            }
        } else if let Some(label) = window_labels.first().cloned() {
            // No specific label requested, use first available
            return Ok(label);
        }

        if start.elapsed() >= timeout {
            return Err(WebDriverErrorResponse::no_such_window());
        }

        tokio::time::sleep(poll_interval).await;
    }
}

/// Extract window label from WDIO capabilities
fn extract_window_label(capabilities: &serde_json::Value) -> Option<String> {
    // Check alwaysMatch first (WDIO typically uses this)
    if let Some(window_label) = capabilities
        .get("alwaysMatch")
        .and_then(|v| v.get("wdio:tauriServiceOptions"))
        .and_then(|v| v.get("windowLabel"))
        .and_then(|v| v.as_str())
    {
        return Some(window_label.to_string());
    }

    // Check firstMatch - it's an array per W3C spec, iterate to find the first match
    if let Some(arr) = capabilities.get("firstMatch").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(window_label) = item
                .get("wdio:tauriServiceOptions")
                .and_then(|v| v.get("windowLabel"))
                .and_then(|v| v.as_str())
            {
                return Some(window_label.to_string());
            }
        }
    }

    None
}

fn extract_authorization(capabilities: &serde_json::Value) -> Option<&str> {
    capabilities
        .get("alwaysMatch")
        .and_then(|value| value.get("osg:e2eAuthorization"))
        .and_then(Value::as_str)
        .or_else(|| {
            capabilities
                .get("firstMatch")
                .and_then(Value::as_array)
                .and_then(|values| {
                    values
                        .iter()
                        .find_map(|value| value.get("osg:e2eAuthorization").and_then(Value::as_str))
                })
        })
}

/// W3C `WebDriver` session request (capabilities are accepted but not processed)
#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    #[allow(dead_code)] // Accepted for protocol compliance but not processed
    pub capabilities: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    pub session_id: String,
    pub capabilities: Value,
}

/// Parse user agent to extract browser name and version
fn parse_user_agent(user_agent: &str) -> (String, String) {
    // Windows WebView2: "... Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
    if user_agent.contains("Edg/") {
        let version = user_agent
            .split("Edg/")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .unwrap_or("unknown");
        return ("msedge".to_string(), version.to_string());
    }

    // Android WebView: "... (Linux; Android 14; ...) AppleWebKit/... Chrome/120.0.0.0 ..."
    // Must check before Linux since Android UA contains "Linux"
    if user_agent.contains("Android") {
        let version = user_agent
            .split("Chrome/")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .unwrap_or("unknown");
        return ("chrome".to_string(), version.to_string());
    }

    // Linux WebKitGTK: "... (X11; Linux ...) AppleWebKit/... Version/2.44..."
    if user_agent.contains("Linux") || user_agent.contains("X11") {
        let version = user_agent
            .split("AppleWebKit/")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .unwrap_or("unknown");
        return ("WebKitGTK".to_string(), version.to_string());
    }

    // iOS WKWebView: "... (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ..."
    // Also handles iPad and iPod
    if (user_agent.contains("iPhone") || user_agent.contains("iPad") || user_agent.contains("iPod"))
        && user_agent.contains("AppleWebKit/")
    {
        let version = user_agent
            .split("AppleWebKit/")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.split('(').next()) // Remove trailing (KHTML if present
            .unwrap_or("unknown");
        return ("webkit".to_string(), version.to_string());
    }

    // macOS WebKit/WKWebView: "... (Macintosh; ...) AppleWebKit/605.1.15 ..."
    // Note: WKWebView may not include "Safari/" or "Version/"
    if user_agent.contains("Macintosh") && user_agent.contains("AppleWebKit/") {
        let version = user_agent
            .split("AppleWebKit/")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.split('(').next()) // Remove trailing (KHTML if present
            .unwrap_or("unknown");
        return ("webkit".to_string(), version.to_string());
    }

    ("webview".to_string(), "unknown".to_string())
}

/// POST `/session` - Create a new session
pub async fn create<R: Runtime + 'static>(
    State(state): State<Arc<AppState<R>>>,
    Json(request): Json<CreateSessionRequest>,
) -> WebDriverResult {
    let received_authorization = extract_authorization(&request.capabilities).ok_or_else(|| {
        WebDriverErrorResponse::invalid_argument(
            "the guarded automation server requires a per-run session identity",
        )
    })?;
    if !state.authorizes(received_authorization) {
        return Err(WebDriverErrorResponse::invalid_argument(
            "the guarded automation server refused a foreign or stale session identity",
        ));
    }

    // Extract window label from capabilities if provided
    let target_window = extract_window_label(&request.capabilities);

    // Wait for the target window (or first available if no target)
    let initial_window = wait_for_window(&state, 10_000, target_window.as_deref()).await?;

    // Query the webview for its user agent to get browser info
    let executor =
        state.get_executor_for_window(&initial_window, Timeouts::default(), Vec::new())?;
    let user_agent_result = executor
        .evaluate_js("(function() { return navigator.userAgent; })()")
        .await;

    let (browser_name, browser_version) = match user_agent_result {
        Ok(result) => {
            let user_agent = result.get("value").and_then(|v| v.as_str()).unwrap_or("");
            parse_user_agent(user_agent)
        }
        Err(_) => ("webview".to_string(), "unknown".to_string()),
    };

    let mut sessions = state.sessions.write().await;

    // Create session with initial window
    let session = sessions.create(initial_window);

    let response = SessionResponse {
        session_id: session.id.clone(),
        capabilities: json!({
            "browserName": browser_name,
            "browserVersion": browser_version,
            "platformName": std::env::consts::OS,
            "acceptInsecureCerts": false,
            "pageLoadStrategy": "normal",
            "setWindowRect": false,
            "osg:e2eIdentity": state.identity.as_str(),
            "osg:e2eProcessId": std::process::id(),
            "timeouts": {
                "implicit": session.timeouts.implicit_ms,
                "pageLoad": session.timeouts.page_load_ms,
                "script": session.timeouts.script_ms
            }
        }),
    };

    Ok(WebDriverResponse::success(response))
}

/// DELETE `/session/{session_id}` - Delete a session
pub async fn delete<R: Runtime>(
    State(state): State<Arc<AppState<R>>>,
    Path(session_id): Path<String>,
) -> WebDriverResult {
    let mut sessions = state.sessions.write().await;

    if sessions.delete(&session_id) {
        Ok(WebDriverResponse::null())
    } else {
        Err(WebDriverErrorResponse::invalid_session_id(&session_id))
    }
}
