pub(crate) mod alert_state;
mod executor;

pub use alert_state::AlertStateManager;
pub use executor::*;

#[cfg(target_os = "windows")]
pub use windows::AsyncScriptState;
#[cfg(target_os = "windows")]
pub use windows::ScriptExecutionLocks;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "android")]
mod android;

#[cfg(target_os = "ios")]
mod ios;

use std::sync::Arc;
use tauri::{Runtime, WebviewWindow};

use crate::webdriver::Timeouts;

/// Create a platform-specific executor for the given window
#[cfg(target_os = "macos")]
pub fn create_executor<R: Runtime + 'static>(
    window: WebviewWindow<R>,
    timeouts: Timeouts,
    frame_context: Vec<FrameId>,
) -> Arc<dyn PlatformExecutor<R>> {
    Arc::new(macos::MacOSExecutor::new(window, timeouts, frame_context))
}

/// Create a platform-specific executor for the given window
#[cfg(target_os = "windows")]
pub fn create_executor<R: Runtime + 'static>(
    window: WebviewWindow<R>,
    timeouts: Timeouts,
    frame_context: Vec<FrameId>,
) -> Arc<dyn PlatformExecutor<R>> {
    Arc::new(windows::WindowsExecutor::new(
        window,
        timeouts,
        frame_context,
    ))
}

/// Create a platform-specific executor for the given window
#[cfg(target_os = "linux")]
pub fn create_executor<R: Runtime + 'static>(
    window: WebviewWindow<R>,
    timeouts: Timeouts,
    frame_context: Vec<FrameId>,
) -> Arc<dyn PlatformExecutor<R>> {
    Arc::new(linux::LinuxExecutor::new(window, timeouts, frame_context))
}

/// Create a platform-specific executor for the given window
#[cfg(target_os = "android")]
pub fn create_executor<R: Runtime + 'static>(
    window: WebviewWindow<R>,
    timeouts: Timeouts,
    frame_context: Vec<FrameId>,
) -> Arc<dyn PlatformExecutor<R>> {
    Arc::new(android::AndroidExecutor::new(
        window,
        timeouts,
        frame_context,
    ))
}

/// Create a platform-specific executor for the given window
#[cfg(target_os = "ios")]
pub fn create_executor<R: Runtime + 'static>(
    window: WebviewWindow<R>,
    timeouts: Timeouts,
    frame_context: Vec<FrameId>,
) -> Arc<dyn PlatformExecutor<R>> {
    Arc::new(ios::IOSExecutor::new(window, timeouts, frame_context))
}

/// Register platform-specific webview handlers at webview creation time.
/// This is called from the plugin's `on_webview_ready` hook.
/// Note: Mobile platforms (Android/iOS) handle this via native plugins.
pub fn register_webview_handlers<R: Runtime>(webview: &tauri::Webview<R>) {
    #[cfg(target_os = "windows")]
    windows::register_webview_handlers(webview);
    #[cfg(target_os = "macos")]
    macos::register_webview_handlers(webview);
    #[cfg(target_os = "linux")]
    linux::register_webview_handlers(webview);

    let _ = webview; // Avoid unused variable warning on platforms without handlers
}

/// Start the macOS headless run-loop pump as early as possible — from the plugin's `setup` hook, on
/// the main thread — so it covers cold-start / deeplink navigation before the first webview is ready.
/// `Once`-guarded in `macos::start_runloop_pump`, so the `on_webview_ready` call remains a harmless
/// fallback. macOS only. See #540.
#[cfg(target_os = "macos")]
pub fn start_runloop_pump_early<R: Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app.run_on_main_thread(|| unsafe { macos::start_runloop_pump() });
}
