use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

use std::sync::Arc;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod error;
#[cfg(target_os = "macos")]
mod eval_channel;
mod platform;
mod server;
mod webdriver;

pub use error::{Error, Result};

/// Environment variable name for configuring the port
pub const PORT_ENV_VAR: &str = "TAURI_WEBDRIVER_PORT";
const MINIMUM_EPHEMERAL_PORT: u16 = 49_152;

/// Per-run process nonce echoed by status/session responses.
pub const IDENTITY_ENV_VAR: &str = "OSG_E2E_WEBDRIVER_IDENTITY";
/// Separate capability secret; never exposed by the public status endpoint.
pub const AUTHORIZATION_ENV_VAR: &str = "OSG_E2E_WEBDRIVER_AUTHORIZATION";

/// Frozen into the automation binary so the launcher can reject an older, unsafe build.
pub const AUTOMATION_SERVER_GUARD: &str =
    "The OSG automation WebDriver refuses native-window mutation and unidentified sessions.";

pub(crate) type WindowGuard<R> =
    Arc<dyn Fn(&tauri::Window<R>) -> std::result::Result<(), String> + Send + Sync>;

fn valid_identity(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn required_credentials() -> (String, String) {
    let identity = std::env::var(IDENTITY_ENV_VAR).unwrap_or_default();
    let authorization = std::env::var(AUTHORIZATION_ENV_VAR).unwrap_or_default();
    assert!(
        valid_identity(&identity) && valid_identity(&authorization) && identity != authorization,
        "{AUTOMATION_SERVER_GUARD}"
    );
    (identity, authorization)
}

/// Initializes the guarded plugin on the fresh high loopback port owned by this run.
#[must_use]
pub fn init_with_window_guard<R, F>(window_guard: F) -> TauriPlugin<R>
where
    R: Runtime,
    F: Fn(&tauri::Window<R>) -> std::result::Result<(), String> + Send + Sync + 'static,
{
    let port = std::env::var(PORT_ENV_VAR)
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|port| *port >= MINIMUM_EPHEMERAL_PORT)
        .unwrap_or_else(|| panic!("{AUTOMATION_SERVER_GUARD}"));

    init_with_port_and_window_guard(port, window_guard)
}

#[must_use]
fn init_with_port_and_window_guard<R, F>(port: u16, window_guard: F) -> TauriPlugin<R>
where
    R: Runtime,
    F: Fn(&tauri::Window<R>) -> std::result::Result<(), String> + Send + Sync + 'static,
{
    let (identity, authorization) = required_credentials();
    let window_guard: WindowGuard<R> = Arc::new(window_guard);
    Builder::new("wdio-webdriver")
        .setup(move |app, api| {
            #[cfg(mobile)]
            let webdriver = mobile::init(app, api)?;
            #[cfg(desktop)]
            let webdriver = desktop::init(app, api);
            app.manage(webdriver);

            // Manage async script state for native message handlers (Windows only)
            #[cfg(target_os = "windows")]
            app.manage(platform::AsyncScriptState::default());
            // Serialize concurrent ExecuteScript calls per webview (Windows only)
            #[cfg(target_os = "windows")]
            app.manage(platform::ScriptExecutionLocks::default());

            // Manage per-window alert state
            app.manage(platform::AlertStateManager::default());

            // Arc so the (non-generic) objc2 message handler can hold its own clone; see eval_channel.
            #[cfg(target_os = "macos")]
            app.manage(std::sync::Arc::new(
                eval_channel::EvalResultRegistry::default(),
            ));

            // Start the macOS headless run-loop pump early (before any webview loads); Once-guarded,
            // so the on_webview_ready registration remains a fallback. See #540.
            #[cfg(target_os = "macos")]
            platform::start_runloop_pump_early(app.app_handle());

            // Start the WebDriver HTTP server
            let app_handle = app.app_handle().clone();
            server::start(
                app_handle,
                port,
                identity.clone(),
                authorization.clone(),
                Arc::clone(&window_guard),
            );
            tracing::info!("WDIO WebDriver plugin initialized on port {port}");

            Ok(())
        })
        .on_webview_ready(|webview| {
            platform::register_webview_handlers(&webview);
        })
        .build()
}
