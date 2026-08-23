use std::sync::Mutex;

use tauri::{CloseRequestApi, Manager, State, WebviewWindow};
use uuid::{Uuid, Version};

const CLOSE_CHECKPOINT_HANDLER: &str = "__OSG_FLUSH_BEFORE_CLOSE__";
const CLOSE_CHECKPOINT_PENDING: &str = "__OSG_PENDING_CLOSE_CHECKPOINT__";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum CloseCheckpointPhase {
    #[default]
    Idle,
    Pending(Uuid),
    Armed(Uuid),
    Closing(Uuid),
}

#[derive(Default)]
pub(crate) struct AppCloseCheckpointState {
    phase: Mutex<CloseCheckpointPhase>,
}

enum CloseRequestDecision {
    Allow,
    Prevent { nonce: Uuid },
    PreventUnavailable,
}

impl AppCloseCheckpointState {
    fn request(&self) -> CloseRequestDecision {
        let Ok(mut phase) = self.phase.lock() else {
            return CloseRequestDecision::PreventUnavailable;
        };
        match *phase {
            CloseCheckpointPhase::Idle => {
                let nonce = Uuid::new_v4();
                *phase = CloseCheckpointPhase::Pending(nonce);
                CloseRequestDecision::Prevent { nonce }
            }
            CloseCheckpointPhase::Pending(nonce) => CloseRequestDecision::Prevent { nonce },
            CloseCheckpointPhase::Armed(_) => {
                *phase = CloseCheckpointPhase::Idle;
                CloseRequestDecision::Allow
            }
            // `WebviewWindow::close` emits the native close request after `begin_commit` has
            // consumed the arm. Keep allowing that request until the runtime destroys the window;
            // resetting here could make a duplicate native event manufacture a fresh checkpoint.
            CloseCheckpointPhase::Closing(_) => CloseRequestDecision::Allow,
        }
    }

    fn complete(&self, nonce: Uuid) -> bool {
        let Ok(mut phase) = self.phase.lock() else {
            return false;
        };
        match *phase {
            CloseCheckpointPhase::Pending(expected) if expected == nonce => {
                *phase = CloseCheckpointPhase::Armed(nonce);
                true
            }
            CloseCheckpointPhase::Armed(expected) if expected == nonce => true,
            _ => false,
        }
    }

    fn fail(&self, nonce: Uuid) -> bool {
        let Ok(mut phase) = self.phase.lock() else {
            return false;
        };
        if matches!(*phase, CloseCheckpointPhase::Pending(expected) if expected == nonce) {
            *phase = CloseCheckpointPhase::Idle;
            true
        } else {
            false
        }
    }

    fn begin_commit(&self, nonce: Uuid) -> bool {
        let Ok(mut phase) = self.phase.lock() else {
            return false;
        };
        if matches!(*phase, CloseCheckpointPhase::Armed(expected) if expected == nonce) {
            *phase = CloseCheckpointPhase::Closing(nonce);
            true
        } else {
            false
        }
    }

    fn cancel_commit(&self, nonce: Uuid) -> bool {
        let Ok(mut phase) = self.phase.lock() else {
            return false;
        };
        if matches!(*phase, CloseCheckpointPhase::Closing(expected) if expected == nonce) {
            *phase = CloseCheckpointPhase::Idle;
            true
        } else {
            false
        }
    }
}

fn parse_nonce(value: &str) -> Option<Uuid> {
    let nonce = Uuid::parse_str(value).ok()?;
    (nonce.get_version() == Some(Version::Random)).then_some(nonce)
}

fn checkpoint_script(nonce: Uuid) -> String {
    let encoded = serde_json::to_string(&nonce.to_string()).expect("a UUID is valid JSON text");
    format!(
        "(() => {{ const nonce = {encoded}; window.{CLOSE_CHECKPOINT_PENDING} = nonce; \
         const handler = window.{CLOSE_CHECKPOINT_HANDLER}; \
         if (typeof handler === 'function') handler(nonce); }})();"
    )
}

/// Refuse the first native close, then ask the already-loaded editor to drain its durable queue.
/// Only the second close after an exact one-shot capability has been armed is allowed through.
pub(crate) fn handle_close_requested(
    window: &tauri::Window,
    api: &CloseRequestApi,
    state: &AppCloseCheckpointState,
) {
    match state.request() {
        CloseRequestDecision::Allow => {}
        CloseRequestDecision::Prevent { nonce } => {
            api.prevent_close();
            if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                if webview.eval(checkpoint_script(nonce).as_str()).is_err() {
                    crate::diagnostics::record("app.close_checkpoint_delivery_failed", &[]);
                }
            } else {
                crate::diagnostics::record("app.close_checkpoint_delivery_failed", &[]);
            }
        }
        CloseRequestDecision::PreventUnavailable => {
            api.prevent_close();
            crate::diagnostics::record("app.close_checkpoint_state_unavailable", &[]);
        }
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn app_close_checkpoint_complete(
    state: State<'_, AppCloseCheckpointState>,
    nonce: String,
) -> bool {
    parse_nonce(&nonce).is_some_and(|nonce| state.complete(nonce))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn app_close_checkpoint_failed(
    state: State<'_, AppCloseCheckpointState>,
    nonce: String,
) -> bool {
    parse_nonce(&nonce).is_some_and(|nonce| state.fail(nonce))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects WebviewWindow and State as owned command extractors"
)]
pub(crate) fn app_close_checkpoint_commit(
    window: WebviewWindow,
    state: State<'_, AppCloseCheckpointState>,
    nonce: String,
) -> bool {
    let Some(nonce) = parse_nonce(&nonce) else {
        return false;
    };
    if !state.begin_commit(nonce) {
        return false;
    }
    if window.close().is_ok() {
        true
    } else {
        // A failed native close must consume neither this checkpoint nor the next user attempt.
        // Otherwise edits made after the failure could leave through the stale armed capability.
        state.cancel_commit(nonce);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn requested_nonce(state: &AppCloseCheckpointState) -> Uuid {
        let CloseRequestDecision::Prevent { nonce } = state.request() else {
            panic!("the first close must be prevented");
        };
        nonce
    }

    #[test]
    fn exact_pending_nonce_is_required_before_close_can_be_armed() {
        let state = AppCloseCheckpointState::default();
        let nonce = requested_nonce(&state);

        assert!(!state.complete(Uuid::new_v4()));
        assert!(matches!(
            state.request(),
            CloseRequestDecision::Prevent { nonce: repeated } if repeated == nonce
        ));
        assert!(state.complete(nonce));
        assert!(matches!(state.request(), CloseRequestDecision::Allow));
        assert!(matches!(
            state.request(),
            CloseRequestDecision::Prevent { nonce: next } if next != nonce
        ));
    }

    #[test]
    fn failed_checkpoint_is_retryable_but_cannot_clear_an_armed_close() {
        let state = AppCloseCheckpointState::default();
        let first = requested_nonce(&state);
        assert!(!state.fail(Uuid::new_v4()));
        assert!(state.fail(first));

        let second = requested_nonce(&state);
        assert_ne!(first, second);
        assert!(state.complete(second));
        assert!(!state.fail(second));
        assert!(state.begin_commit(second));
        assert!(!state.begin_commit(second));
        assert!(!state.begin_commit(first));
        assert!(state.cancel_commit(second));
        assert!(!state.cancel_commit(second));
        assert!(matches!(
            state.request(),
            CloseRequestDecision::Prevent { nonce: third } if third != second
        ));
    }

    #[test]
    fn a_native_close_after_an_exact_completed_checkpoint_is_allowed_once() {
        let state = AppCloseCheckpointState::default();
        let nonce = requested_nonce(&state);
        assert!(state.complete(nonce));
        assert!(matches!(state.request(), CloseRequestDecision::Allow));
        assert!(matches!(
            state.request(),
            CloseRequestDecision::Prevent { nonce: next } if next != nonce
        ));
    }

    #[test]
    fn only_random_uuid_capabilities_are_accepted() {
        assert!(parse_nonce(&Uuid::new_v4().to_string()).is_some());
        assert!(parse_nonce(&Uuid::now_v7().to_string()).is_none());
        assert!(parse_nonce("not-a-uuid").is_none());
    }

    #[test]
    fn evaluated_script_contains_only_the_exact_nonce_and_private_entrypoint() {
        let nonce = Uuid::new_v4();
        let script = checkpoint_script(nonce);
        assert!(script.contains(&nonce.to_string()));
        assert!(script.contains(CLOSE_CHECKPOINT_HANDLER));
        assert!(script.contains(CLOSE_CHECKPOINT_PENDING));
        assert!(!script.contains("window.close"));
    }
}
