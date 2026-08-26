use std::net::SocketAddr;
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};
use tokio::runtime::Runtime as TokioRuntime;
use tokio::sync::RwLock;

pub mod handlers;
pub mod response;
pub mod router;

use crate::platform::{create_executor, FrameId, PlatformExecutor};
use crate::server::response::WebDriverErrorResponse;
use crate::webdriver::{SessionManager, Timeouts};
use crate::WindowGuard;

/// Shared state for the `WebDriver` server
pub struct AppState<R: Runtime> {
    pub app: AppHandle<R>,
    authorization: String,
    pub identity: String,
    pub sessions: RwLock<SessionManager>,
    window_guard: WindowGuard<R>,
}

impl<R: Runtime + 'static> AppState<R> {
    pub fn new(
        app: AppHandle<R>,
        identity: String,
        authorization: String,
        window_guard: WindowGuard<R>,
    ) -> Self {
        Self {
            app,
            authorization,
            identity,
            sessions: RwLock::new(SessionManager::new()),
            window_guard,
        }
    }

    pub fn authorizes(&self, candidate: &str) -> bool {
        candidate == self.authorization.as_str()
    }

    /// Re-apply the application's native isolation invariant before every HTTP command.
    pub fn enforce_window_guard(&self) -> Result<(), WebDriverErrorResponse> {
        for webview in self.app.webview_windows().values() {
            let window = webview.as_ref().window();
            (self.window_guard)(&window).map_err(|message| {
                WebDriverErrorResponse::unknown_error(&format!(
                    "the automation window failed its native safety invariant: {message}"
                ))
            })?;
        }
        Ok(())
    }

    /// Get a platform executor for a specific window by label
    pub fn get_executor_for_window(
        &self,
        window_label: &str,
        timeouts: Timeouts,
        frame_context: Vec<FrameId>,
    ) -> Result<Arc<dyn PlatformExecutor<R>>, WebDriverErrorResponse> {
        self.app
            .webview_windows()
            .get(window_label)
            .cloned()
            .map(|window| create_executor(window, timeouts, frame_context))
            .ok_or_else(WebDriverErrorResponse::no_such_window)
    }

    /// Whether a window with this label is still registered
    pub fn has_window_label(&self, window_label: &str) -> bool {
        self.app.webview_windows().contains_key(window_label)
    }

    /// Get all window labels
    pub fn get_window_labels(&self) -> Vec<String> {
        self.app.webview_windows().keys().cloned().collect()
    }
}

/// Start the `WebDriver` HTTP server on the specified port
pub fn start<R: Runtime + 'static>(
    app: AppHandle<R>,
    port: u16,
    identity: String,
    authorization: String,
    window_guard: WindowGuard<R>,
) {
    std::thread::spawn(move || {
        let rt = match TokioRuntime::new() {
            Ok(rt) => rt,
            Err(e) => {
                tracing::error!("Failed to create Tokio runtime for WebDriver server: {}", e);
                return;
            }
        };

        rt.block_on(async {
            let state = Arc::new(AppState::new(app, identity, authorization, window_guard));
            let router = router::create_router(state);

            // On Android, bind to all interfaces for WiFi accessibility
            // On other platforms, bind to localhost only for security
            #[cfg(target_os = "android")]
            let addr = SocketAddr::from(([0, 0, 0, 0], port));
            #[cfg(not(target_os = "android"))]
            let addr = SocketAddr::from(([127, 0, 0, 1], port));

            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => {
                    tracing::error!(
                        "Failed to bind WebDriver server to {} — port may already be in use: {}",
                        addr,
                        e
                    );
                    return;
                }
            };

            tracing::info!("WebDriver server listening on http://{}", addr);

            if let Err(e) = axum::serve(listener, router).await {
                tracing::error!("WebDriver server error: {}", e);
            }
        });
    });
}
