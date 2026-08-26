use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;
use tokio::sync::oneshot;

/// Correlates DirectEval results the webview reports back out-of-band, keyed by id.
///
/// The macOS DirectEval path runs its script via `callAsyncJavaScript` to keep the run loop pumping
/// (so the app's own `core.invoke` IPC resolves on a headless runner) but must NOT read the result
/// from that call's completion handler — macOS 26.4's WebKit reclaims it intermittently. Instead the
/// script posts `{ id, result }` to a `WKScriptMessageHandler`, which calls `complete` to wake the
/// executor awaiting `register`. Mirrors the Windows `AsyncScriptState` native-handler pattern.
/// Removable once the upstream reclaim is resolved:
/// https://github.com/webdriverio/desktop-mobile/issues/540
#[derive(Default)]
pub struct EvalResultRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl EvalResultRegistry {
    pub fn register(&self, id: String) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, tx);
        }
        rx
    }

    /// No-op if `id` is unknown or already completed, so a duplicate or late report is harmless.
    pub fn complete(&self, id: &str, result: Value) {
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(tx) = pending.remove(id) {
                let _ = tx.send(result);
            }
        }
    }

    /// Drop a pending registration (e.g. on timeout) so its sender doesn't leak.
    pub fn cancel(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(id);
        }
    }
}
