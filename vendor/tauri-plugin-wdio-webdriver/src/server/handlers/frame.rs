use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::Value;
use tauri::Runtime;

use crate::platform::FrameId;
use crate::server::response::{WebDriverErrorResponse, WebDriverResponse, WebDriverResult};
use crate::server::AppState;

fn browsing_context_changed_error<R: Runtime>(
    state: &AppState<R>,
    current_window: &str,
    frame_id: Option<&FrameId>,
) -> WebDriverErrorResponse {
    if !state.has_window_label(current_window) {
        return WebDriverErrorResponse::no_such_window();
    }

    if matches!(frame_id, Some(FrameId::Element(_))) {
        return WebDriverErrorResponse::stale_element_reference();
    }

    WebDriverErrorResponse::unknown_error("Browsing context changed while switching frame")
}

#[derive(Debug, PartialEq, Eq)]
enum FrameContextCommitError {
    WindowMissing,
    BrowsingContextChanged,
}

enum FrameContextMutation {
    Clear,
    Push(FrameId),
    Pop,
}

fn commit_frame_context(
    session: &mut crate::webdriver::session::Session,
    browsing_context_generation: u64,
    original_window_exists: bool,
    mutation: FrameContextMutation,
) -> Result<(), FrameContextCommitError> {
    if !original_window_exists {
        return Err(FrameContextCommitError::WindowMissing);
    }

    if session.browsing_context_generation != browsing_context_generation {
        return Err(FrameContextCommitError::BrowsingContextChanged);
    }

    match mutation {
        FrameContextMutation::Clear => session.frame_context.clear(),
        FrameContextMutation::Push(frame_id) => session.frame_context.push(frame_id),
        FrameContextMutation::Pop => {
            session.frame_context.pop();
        }
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct SwitchFrameRequest {
    pub id: Value,
}

/// POST `/session/{session_id}/frame` - Switch to frame
pub async fn switch_to_frame<R: Runtime + 'static>(
    State(state): State<Arc<AppState<R>>>,
    Path(session_id): Path<String>,
    Json(request): Json<SwitchFrameRequest>,
) -> WebDriverResult {
    // First, read session data without modifying
    let sessions = state.sessions.read().await;
    let session = sessions.get(&session_id)?;

    // Get current context for validation (before any changes)
    let current_window = session.current_window.clone();
    let timeouts = session.timeouts.clone();
    let current_frame_context = session.frame_context.clone();
    let browsing_context_generation = session.browsing_context_generation;

    // Parse the frame ID to determine what we're switching to
    let (frame_id, js_var_for_element) = match &request.id {
        Value::Null => {
            drop(sessions);

            let mut sessions = state.sessions.write().await;
            let session = sessions.get_mut(&session_id)?;
            let original_window_exists = state.has_window_label(&current_window);
            match commit_frame_context(
                session,
                browsing_context_generation,
                original_window_exists,
                FrameContextMutation::Clear,
            ) {
                Ok(()) => {}
                Err(FrameContextCommitError::WindowMissing) => {
                    return Err(WebDriverErrorResponse::no_such_window());
                }
                Err(FrameContextCommitError::BrowsingContextChanged) => {
                    return Err(browsing_context_changed_error(
                        &state,
                        &current_window,
                        None,
                    ));
                }
            }

            return Ok(WebDriverResponse::null());
        }
        Value::Number(n) => {
            let index = n.as_u64().ok_or_else(|| {
                WebDriverErrorResponse::invalid_argument(
                    "Frame index must be a non-negative integer",
                )
            })?;
            let index = u32::try_from(index)
                .map_err(|_| WebDriverErrorResponse::invalid_argument("Frame index too large"))?;

            (FrameId::Index(index), None)
        }
        Value::Object(obj) => {
            // W3C element reference format
            if let Some(element_id) = obj.get("element-6066-11e4-a52e-4f735466cecf") {
                let element_id = element_id.as_str().ok_or_else(|| {
                    WebDriverErrorResponse::invalid_argument("Element reference must be a string")
                })?;

                // Look up the element's js_var
                let element = session
                    .elements
                    .get(element_id)
                    .ok_or_else(WebDriverErrorResponse::no_such_element)?;

                let js_var = element.js_ref.clone();
                (FrameId::Element(js_var.clone()), Some(js_var))
            } else {
                return Err(WebDriverErrorResponse::invalid_argument(
                    "Invalid frame identifier object",
                ));
            }
        }
        _ => {
            return Err(WebDriverErrorResponse::invalid_argument(
                "Frame ID must be null, a number, or an element reference",
            ));
        }
    };
    drop(sessions);

    // Create executor with CURRENT frame context (not the new one) to validate
    let executor =
        state.get_executor_for_window(&current_window, timeouts, current_frame_context)?;

    // Validate the frame exists from current context
    executor.switch_to_frame(frame_id.clone()).await?;

    // Validation passed - now update the session's frame context
    let mut sessions = state.sessions.write().await;
    let session = sessions.get_mut(&session_id)?;

    let frame_id = match frame_id {
        FrameId::Index(index) => FrameId::Index(index),
        FrameId::Element(_) => FrameId::Element(
            js_var_for_element.expect("element frame IDs always have an element reference"),
        ),
    };
    let original_window_exists = state.has_window_label(&current_window);
    match commit_frame_context(
        session,
        browsing_context_generation,
        original_window_exists,
        FrameContextMutation::Push(frame_id.clone()),
    ) {
        Ok(()) => {}
        Err(FrameContextCommitError::WindowMissing) => {
            return Err(WebDriverErrorResponse::no_such_window());
        }
        Err(FrameContextCommitError::BrowsingContextChanged) => {
            return Err(browsing_context_changed_error(
                &state,
                &current_window,
                Some(&frame_id),
            ));
        }
    }

    Ok(WebDriverResponse::null())
}

/// POST `/session/{session_id}/frame/parent` - Switch to parent frame
pub async fn switch_to_parent_frame<R: Runtime + 'static>(
    State(state): State<Arc<AppState<R>>>,
    Path(session_id): Path<String>,
) -> WebDriverResult {
    let sessions = state.sessions.read().await;
    let session = sessions.get(&session_id)?;
    let current_window = session.current_window.clone();
    let timeouts = session.timeouts.clone();
    let frame_context = session.frame_context.clone();
    let browsing_context_generation = session.browsing_context_generation;
    drop(sessions);

    let executor = state.get_executor_for_window(&current_window, timeouts, frame_context)?;
    executor.switch_to_parent_frame().await?;

    let mut sessions = state.sessions.write().await;
    let session = sessions.get_mut(&session_id)?;
    let original_window_exists = state.has_window_label(&current_window);
    match commit_frame_context(
        session,
        browsing_context_generation,
        original_window_exists,
        FrameContextMutation::Pop,
    ) {
        Ok(()) => {}
        Err(FrameContextCommitError::WindowMissing) => {
            return Err(WebDriverErrorResponse::no_such_window());
        }
        Err(FrameContextCommitError::BrowsingContextChanged) => {
            return Err(browsing_context_changed_error(
                &state,
                &current_window,
                None,
            ));
        }
    }

    Ok(WebDriverResponse::null())
}

#[cfg(test)]
mod tests {
    use super::{commit_frame_context, FrameContextCommitError, FrameContextMutation};
    use crate::platform::FrameId;
    use crate::webdriver::session::Session;

    #[test]
    fn refuses_to_commit_a_frame_after_the_original_window_is_removed() {
        let mut session = Session::new("child-left".to_string());
        let generation = session.browsing_context_generation;

        let result = commit_frame_context(
            &mut session,
            generation,
            false,
            FrameContextMutation::Push(FrameId::Index(0)),
        );

        assert_eq!(result, Err(FrameContextCommitError::WindowMissing));
        assert!(session.frame_context.is_empty());
    }

    #[test]
    fn prioritizes_a_removed_window_over_a_changed_browsing_context() {
        let mut session = Session::new("child-left".to_string());
        session.browsing_context_generation = 1;

        let result = commit_frame_context(
            &mut session,
            0,
            false,
            FrameContextMutation::Push(FrameId::Index(0)),
        );

        assert_eq!(result, Err(FrameContextCommitError::WindowMissing));
        assert!(session.frame_context.is_empty());
    }

    #[test]
    fn preserves_frame_context_when_top_level_commit_loses_the_selected_window() {
        let mut session = Session::new("child-left".to_string());
        session.frame_context.push(FrameId::Index(0));
        session.frame_context.push(FrameId::Index(1));
        let generation = session.browsing_context_generation;

        let result =
            commit_frame_context(&mut session, generation, false, FrameContextMutation::Clear);

        assert_eq!(result, Err(FrameContextCommitError::WindowMissing));
        assert!(matches!(
            session.frame_context.as_slice(),
            [FrameId::Index(0), FrameId::Index(1)]
        ));
    }

    #[test]
    fn preserves_frame_context_when_parent_commit_loses_the_selected_window() {
        let mut session = Session::new("child-left".to_string());
        session.frame_context.push(FrameId::Index(0));
        session.frame_context.push(FrameId::Index(1));
        let generation = session.browsing_context_generation;

        let result =
            commit_frame_context(&mut session, generation, false, FrameContextMutation::Pop);

        assert_eq!(result, Err(FrameContextCommitError::WindowMissing));
        assert!(matches!(
            session.frame_context.as_slice(),
            [FrameId::Index(0), FrameId::Index(1)]
        ));
    }

    #[test]
    fn clears_frame_context_when_switching_to_top_level() {
        let mut session = Session::new("child-left".to_string());
        session.frame_context.push(FrameId::Index(0));
        let generation = session.browsing_context_generation;

        let result =
            commit_frame_context(&mut session, generation, true, FrameContextMutation::Clear);

        assert_eq!(result, Ok(()));
        assert!(session.frame_context.is_empty());
    }

    #[test]
    fn pops_one_frame_context_when_switching_to_parent() {
        let mut session = Session::new("child-left".to_string());
        session.frame_context.push(FrameId::Index(0));
        session.frame_context.push(FrameId::Index(1));
        let generation = session.browsing_context_generation;

        let result =
            commit_frame_context(&mut session, generation, true, FrameContextMutation::Pop);

        assert_eq!(result, Ok(()));
        assert!(matches!(
            session.frame_context.as_slice(),
            [FrameId::Index(0)]
        ));
    }
}
