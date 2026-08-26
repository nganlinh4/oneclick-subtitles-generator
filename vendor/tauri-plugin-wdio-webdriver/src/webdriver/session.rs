use std::collections::{HashMap, HashSet};

use serde::Serialize;
use uuid::Uuid;

use super::element::ElementStore;
use crate::platform::FrameId;
use crate::server::response::WebDriverErrorResponse;

/// Tracks currently pressed keys and pointer buttons for action state
#[derive(Debug, Default, Clone)]
pub struct ActionState {
    /// Currently pressed keyboard keys (`WebDriver` key codes)
    pub pressed_keys: HashSet<String>,
    /// Currently pressed pointer buttons by source ID
    pub pressed_buttons: HashMap<String, HashSet<u32>>,
    /// Last pointer position in viewport coordinates. Persisted across
    /// `performActions` calls so an `origin: "pointer"` move resolves relative to
    /// where the pointer actually is, not (0, 0) at the start of every call.
    pub pointer_position: (i32, i32),
}

/// Session timeouts configuration
#[derive(Debug, Clone, Serialize)]
#[allow(clippy::struct_field_names)]
pub struct Timeouts {
    /// Implicit wait timeout in milliseconds
    pub implicit_ms: u64,
    /// Page load timeout in milliseconds
    pub page_load_ms: u64,
    /// Script execution timeout in milliseconds
    pub script_ms: u64,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            implicit_ms: 0,
            page_load_ms: 300_000,
            script_ms: 30_000,
        }
    }
}

/// Represents a `WebDriver` session
#[derive(Debug)]
pub struct Session {
    /// Unique session identifier
    pub id: String,
    /// Session timeouts
    pub timeouts: Timeouts,
    /// Element reference storage
    pub elements: ElementStore,
    /// Current window handle
    pub current_window: String,
    /// Current frame context (stack of frame selectors)
    pub frame_context: Vec<FrameId>,
    /// Increments whenever the selected top-level browsing context changes
    pub browsing_context_generation: u64,
    /// Action state tracking for pressed keys/buttons
    pub action_state: ActionState,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SwitchWindowError {
    BrowsingContextGenerationOverflow,
}

impl Session {
    pub fn new(initial_window: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            timeouts: Timeouts::default(),
            elements: ElementStore::new(),
            current_window: initial_window,
            frame_context: Vec::new(),
            browsing_context_generation: 0,
            action_state: ActionState::default(),
        }
    }

    pub fn switch_to_window(&mut self, window: String) -> Result<(), SwitchWindowError> {
        let browsing_context_generation = self
            .browsing_context_generation
            .checked_add(1)
            .ok_or(SwitchWindowError::BrowsingContextGenerationOverflow)?;

        self.current_window = window;
        self.frame_context.clear();
        self.browsing_context_generation = browsing_context_generation;

        Ok(())
    }
}

/// Manages `WebDriver` sessions
#[derive(Debug, Default)]
pub struct SessionManager {
    sessions: HashMap<String, Session>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    /// Create a new session
    pub fn create(&mut self, initial_window: String) -> &Session {
        let session = Session::new(initial_window);
        let id = session.id.clone();
        self.sessions.insert(id.clone(), session);
        self.sessions.get(&id).expect("session was just inserted")
    }

    /// Get a session by ID
    pub fn get(&self, id: &str) -> Result<&Session, WebDriverErrorResponse> {
        self.sessions
            .get(id)
            .ok_or_else(|| WebDriverErrorResponse::invalid_session_id(id))
    }

    /// Get a mutable session by ID
    pub fn get_mut(&mut self, id: &str) -> Result<&mut Session, WebDriverErrorResponse> {
        self.sessions
            .get_mut(id)
            .ok_or_else(|| WebDriverErrorResponse::invalid_session_id(id))
    }

    /// Delete a session
    pub fn delete(&mut self, id: &str) -> bool {
        self.sessions.remove(id).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::{FrameId, Session, SwitchWindowError};

    #[test]
    fn switching_windows_updates_context_and_generation_together() {
        let mut session = Session::new("child-left".to_string());
        session.frame_context.push(FrameId::Index(0));

        assert_eq!(session.switch_to_window("child-right".to_string()), Ok(()));

        assert_eq!(session.current_window, "child-right");
        assert!(session.frame_context.is_empty());
        assert_eq!(session.browsing_context_generation, 1);
    }

    #[test]
    fn switching_windows_at_max_generation_leaves_session_unchanged() {
        let mut session = Session::new("child-left".to_string());
        session.frame_context.push(FrameId::Index(0));
        session.browsing_context_generation = u64::MAX;

        let result = session.switch_to_window("child-right".to_string());

        assert_eq!(
            result,
            Err(SwitchWindowError::BrowsingContextGenerationOverflow)
        );
        assert_eq!(session.current_window, "child-left");
        assert!(matches!(
            session.frame_context.as_slice(),
            [FrameId::Index(0)]
        ));
        assert_eq!(session.browsing_context_generation, u64::MAX);
    }
}
