use std::{
    fmt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{DragDropEvent, Manager, State, Webview, Window, WindowEvent, ipc::Channel};
use uuid::Uuid;

use crate::{
    commands::import_media_path,
    error::{CommandError, CommandResult},
    state::{DesktopSessionSnapshot, DesktopState},
};

const OFFER_TTL: Duration = Duration::from_secs(30);
const OVER_EVENT_INTERVAL: Duration = Duration::from_millis(16);

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhysicalDropPosition {
    x: f64,
    y: f64,
}

impl From<tauri::PhysicalPosition<f64>> for PhysicalDropPosition {
    fn from(position: tauri::PhysicalPosition<f64>) -> Self {
        Self {
            x: position.x,
            y: position.y,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MediaDropRejection {
    NoFiles,
    MultipleFiles,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum NativeMediaDropEvent {
    Enter {
        drag_id: Uuid,
        sequence: u64,
        position: PhysicalDropPosition,
    },
    Over {
        drag_id: Uuid,
        sequence: u64,
        position: PhysicalDropPosition,
    },
    Leave {
        drag_id: Uuid,
        sequence: u64,
    },
    Drop {
        drag_id: Uuid,
        offer_id: Uuid,
        sequence: u64,
        position: PhysicalDropPosition,
    },
    Rejected {
        drag_id: Uuid,
        reason: MediaDropRejection,
        sequence: u64,
        position: PhysicalDropPosition,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeMediaDropSubscription {
    id: Uuid,
}

struct Subscription {
    id: Uuid,
    webview_label: String,
    channel: Channel<NativeMediaDropEvent>,
}

impl fmt::Debug for Subscription {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Subscription")
            .field("id", &self.id)
            .field("webview_label", &self.webview_label)
            .field("channel", &"<redacted>")
            .finish()
    }
}

struct DropOffer {
    id: Uuid,
    subscription_id: Uuid,
    webview_label: String,
    path: PathBuf,
    expires_at: Instant,
}

impl fmt::Debug for DropOffer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DropOffer")
            .field("id", &self.id)
            .field("subscription_id", &self.subscription_id)
            .field("webview_label", &self.webview_label)
            .field("path", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Debug, Default)]
struct DropStateInner {
    subscription: Option<Subscription>,
    active_drag: Option<Uuid>,
    offer: Option<DropOffer>,
    sequence: u64,
    last_over_at: Option<Instant>,
}

#[derive(Clone, Default)]
pub(crate) struct NativeMediaDropState {
    inner: Arc<Mutex<DropStateInner>>,
}

impl fmt::Debug for NativeMediaDropState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeMediaDropState")
            .field("inner", &"<redacted>")
            .finish()
    }
}

impl NativeMediaDropState {
    fn next_sequence(inner: &mut DropStateInner) -> u64 {
        inner.sequence = inner.sequence.saturating_add(1);
        inner.sequence
    }

    fn publish(&self, subscription_id: Uuid, event: NativeMediaDropEvent) {
        let channel = self.inner.lock().ok().and_then(|inner| {
            inner
                .subscription
                .as_ref()
                .filter(|subscription| subscription.id == subscription_id)
                .map(|subscription| subscription.channel.clone())
        });
        let Some(channel) = channel else {
            return;
        };
        if channel.send(event).is_err()
            && let Ok(mut inner) = self.inner.lock()
            && inner.subscription.as_ref().map(|value| value.id) == Some(subscription_id)
        {
            inner.subscription = None;
            inner.active_drag = None;
            inner.offer = None;
        }
    }

    fn expire_offer(&self, offer_id: Uuid) {
        if let Ok(mut inner) = self.inner.lock()
            && inner.offer.as_ref().map(|offer| offer.id) == Some(offer_id)
            && inner
                .offer
                .as_ref()
                .is_some_and(|offer| Instant::now() >= offer.expires_at)
        {
            inner.offer = None;
        }
    }

    fn redeem_offer(&self, webview_label: &str, offer_id: Uuid) -> CommandResult<PathBuf> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| CommandError::internal("the native drop service is unavailable"))?;
        let Some(offer) = inner.offer.as_ref() else {
            return Err(CommandError::invalid_input(
                "The native media drop is unavailable or expired.",
            ));
        };
        let active_subscription = inner.subscription.as_ref().map(|value| value.id);
        let expired = Instant::now() >= offer.expires_at;
        if expired {
            inner.offer = None;
            return Err(CommandError::invalid_input(
                "The native media drop is unavailable or expired.",
            ));
        }
        if offer.id != offer_id
            || offer.webview_label != webview_label
            || Some(offer.subscription_id) != active_subscription
        {
            return Err(CommandError::invalid_input(
                "The native media drop is unavailable or expired.",
            ));
        }
        Ok(inner.offer.take().expect("the validated offer exists").path)
    }

    pub(crate) fn clear_webview(&self, webview_label: &str) {
        let removed = self.inner.lock().ok().and_then(|mut inner| {
            if inner
                .subscription
                .as_ref()
                .is_some_and(|subscription| subscription.webview_label == webview_label)
            {
                inner.active_drag = None;
                inner.offer = None;
                inner.last_over_at = None;
                return inner.subscription.take();
            }
            None
        });
        drop(removed);
    }

    fn handle_drag_drop(&self, event: &DragDropEvent) {
        match event {
            DragDropEvent::Enter { position, .. } => self.handle_enter(*position),
            DragDropEvent::Over { position } => self.handle_over(*position),
            DragDropEvent::Drop { paths, position } => self.handle_drop(paths, *position),
            DragDropEvent::Leave => self.handle_leave(),
            _ => {}
        }
    }

    fn handle_enter(&self, position: tauri::PhysicalPosition<f64>) {
        let published = self.inner.lock().ok().and_then(|mut inner| {
            let subscription_id = inner.subscription.as_ref()?.id;
            let drag_id = Uuid::new_v4();
            inner.active_drag = Some(drag_id);
            inner.offer = None;
            inner.last_over_at = None;
            let sequence = Self::next_sequence(&mut inner);
            Some((
                subscription_id,
                NativeMediaDropEvent::Enter {
                    drag_id,
                    sequence,
                    position: position.into(),
                },
            ))
        });
        if let Some((subscription_id, event)) = published {
            self.publish(subscription_id, event);
        }
    }

    fn handle_over(&self, position: tauri::PhysicalPosition<f64>) {
        let now = Instant::now();
        let published = self.inner.lock().ok().and_then(|mut inner| {
            if inner
                .last_over_at
                .is_some_and(|last| now.saturating_duration_since(last) < OVER_EVENT_INTERVAL)
            {
                return None;
            }
            let subscription_id = inner.subscription.as_ref()?.id;
            let drag_id = inner.active_drag?;
            inner.last_over_at = Some(now);
            let sequence = Self::next_sequence(&mut inner);
            Some((
                subscription_id,
                NativeMediaDropEvent::Over {
                    drag_id,
                    sequence,
                    position: position.into(),
                },
            ))
        });
        if let Some((subscription_id, event)) = published {
            self.publish(subscription_id, event);
        }
    }

    fn handle_drop(&self, paths: &[PathBuf], position: tauri::PhysicalPosition<f64>) {
        let now = Instant::now();
        let published = self.inner.lock().ok().and_then(|mut inner| {
            let subscription_id = inner.subscription.as_ref()?.id;
            let webview_label = inner.subscription.as_ref()?.webview_label.clone();
            let drag_id = inner.active_drag.take().unwrap_or_else(Uuid::new_v4);
            inner.last_over_at = None;
            inner.offer = None;
            let sequence = Self::next_sequence(&mut inner);
            let position = position.into();
            match paths {
                [path] => {
                    let offer_id = Uuid::new_v4();
                    inner.offer = Some(DropOffer {
                        id: offer_id,
                        subscription_id,
                        webview_label,
                        path: path.clone(),
                        expires_at: now + OFFER_TTL,
                    });
                    Some((
                        subscription_id,
                        Some(offer_id),
                        NativeMediaDropEvent::Drop {
                            drag_id,
                            offer_id,
                            sequence,
                            position,
                        },
                    ))
                }
                [] => Some((
                    subscription_id,
                    None,
                    NativeMediaDropEvent::Rejected {
                        drag_id,
                        reason: MediaDropRejection::NoFiles,
                        sequence,
                        position,
                    },
                )),
                _ => Some((
                    subscription_id,
                    None,
                    NativeMediaDropEvent::Rejected {
                        drag_id,
                        reason: MediaDropRejection::MultipleFiles,
                        sequence,
                        position,
                    },
                )),
            }
        });
        if let Some((subscription_id, offer_id, event)) = published {
            self.publish(subscription_id, event);
            if let Some(offer_id) = offer_id {
                let state = self.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(OFFER_TTL).await;
                    state.expire_offer(offer_id);
                });
            }
        }
    }

    fn handle_leave(&self) {
        let published = self.inner.lock().ok().and_then(|mut inner| {
            let subscription_id = inner.subscription.as_ref()?.id;
            let drag_id = inner.active_drag.take()?;
            inner.last_over_at = None;
            let sequence = Self::next_sequence(&mut inner);
            Some((
                subscription_id,
                NativeMediaDropEvent::Leave { drag_id, sequence },
            ))
        });
        if let Some((subscription_id, event)) = published {
            self.publish(subscription_id, event);
        }
    }
}

pub(crate) fn handle_native_media_drop_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let state = window.state::<NativeMediaDropState>();
    match event {
        WindowEvent::DragDrop(event) => state.handle_drag_drop(event),
        WindowEvent::Destroyed => state.clear_webview(window.label()),
        _ => {}
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects Webview and State as owned command extractors"
)]
pub(crate) fn media_drop_subscribe(
    webview: Webview,
    state: State<'_, NativeMediaDropState>,
    on_event: Channel<NativeMediaDropEvent>,
) -> CommandResult<NativeMediaDropSubscription> {
    if webview.label() != "main" {
        return Err(CommandError::invalid_input(
            "Native media drops are unavailable in this window.",
        ));
    }
    let id = Uuid::new_v4();
    let previous = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| CommandError::internal("the native drop service is unavailable"))?;
        inner.active_drag = None;
        inner.offer = None;
        inner.sequence = 0;
        inner.last_over_at = None;
        inner.subscription.replace(Subscription {
            id,
            webview_label: webview.label().to_owned(),
            channel: on_event,
        })
    };
    drop(previous);
    Ok(NativeMediaDropSubscription { id })
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects Webview and State as owned command extractors"
)]
pub(crate) fn media_drop_unsubscribe(
    webview: Webview,
    state: State<'_, NativeMediaDropState>,
    subscription_id: Uuid,
) -> CommandResult<()> {
    let removed = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| CommandError::internal("the native drop service is unavailable"))?;
        let matches = inner.subscription.as_ref().is_some_and(|subscription| {
            subscription.id == subscription_id && subscription.webview_label == webview.label()
        });
        if !matches {
            return Ok(());
        }
        inner.active_drag = None;
        inner.offer = None;
        inner.last_over_at = None;
        inner.subscription.take()
    };
    drop(removed);
    Ok(())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects Webview and State as owned command extractors"
)]
pub(crate) fn media_drop_discard(
    webview: Webview,
    state: State<'_, NativeMediaDropState>,
    offer_id: Uuid,
) -> CommandResult<()> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| CommandError::internal("the native drop service is unavailable"))?;
    if inner
        .offer
        .as_ref()
        .is_some_and(|offer| offer.id == offer_id && offer.webview_label == webview.label())
    {
        inner.offer = None;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn media_drop_claim(
    webview: Webview,
    drop_state: State<'_, NativeMediaDropState>,
    desktop_state: State<'_, DesktopState>,
    offer_id: Uuid,
) -> CommandResult<DesktopSessionSnapshot> {
    let path = drop_state.redeem_offer(webview.label(), offer_id)?;

    import_media_path(&desktop_state, path).await
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tauri::{PhysicalPosition, ipc::Channel};

    use super::{
        DropOffer, MediaDropRejection, NativeMediaDropEvent, NativeMediaDropState, OFFER_TTL,
        Subscription,
    };
    use uuid::Uuid;

    fn subscribed_state() -> NativeMediaDropState {
        let state = NativeMediaDropState::default();
        state.inner.lock().expect("drop state").subscription = Some(Subscription {
            id: Uuid::new_v4(),
            webview_label: "main".to_owned(),
            channel: Channel::new(|_| Ok(())),
        });
        state
    }

    #[test]
    fn serialized_events_are_strictly_path_free() {
        let drag_id = Uuid::new_v4();
        let offer_id = Uuid::new_v4();
        let event = NativeMediaDropEvent::Drop {
            drag_id,
            offer_id,
            sequence: 4,
            position: super::PhysicalDropPosition { x: 12.0, y: 24.0 },
        };
        let json = serde_json::to_string(&event).expect("serializable event");

        assert_eq!(
            json,
            format!(
                r#"{{"type":"drop","dragId":"{drag_id}","offerId":"{offer_id}","sequence":4,"position":{{"x":12.0,"y":24.0}}}}"#
            )
        );
        assert!(!json.to_ascii_lowercase().contains("path"));
    }

    #[test]
    fn rejected_events_expose_only_a_bounded_reason() {
        let event = NativeMediaDropEvent::Rejected {
            drag_id: Uuid::new_v4(),
            reason: MediaDropRejection::MultipleFiles,
            sequence: 2,
            position: super::PhysicalDropPosition { x: 1.0, y: 2.0 },
        };
        let value = serde_json::to_value(event).expect("serializable event");

        assert_eq!(value["type"], "rejected");
        assert_eq!(value["reason"], "multipleFiles");
        assert!(value.get("paths").is_none());
    }

    #[test]
    fn offer_debug_output_redacts_its_native_path() {
        let secret = "C:\\private\\family-video.mp4";
        let offer = DropOffer {
            id: Uuid::new_v4(),
            subscription_id: Uuid::new_v4(),
            webview_label: "main".to_owned(),
            path: PathBuf::from(secret),
            expires_at: std::time::Instant::now() + OFFER_TTL,
        };

        let output = format!("{offer:?}");
        assert!(!output.contains(secret));
        assert!(output.contains("<redacted>"));
    }

    #[test]
    fn one_file_creates_one_bounded_offer_and_the_next_drop_replaces_it() {
        let state = subscribed_state();
        let first = PathBuf::from("C:\\private\\first.mp4");
        let second = PathBuf::from("C:\\private\\second.mp4");

        state.handle_drop(
            std::slice::from_ref(&first),
            PhysicalPosition::new(1.0, 2.0),
        );
        let first_id = state
            .inner
            .lock()
            .expect("drop state")
            .offer
            .as_ref()
            .expect("first offer")
            .id;
        state.handle_drop(
            std::slice::from_ref(&second),
            PhysicalPosition::new(3.0, 4.0),
        );
        let inner = state.inner.lock().expect("drop state");
        let offer = inner.offer.as_ref().expect("replacement offer");

        assert_ne!(offer.id, first_id);
        assert_eq!(offer.path, second);
    }

    #[test]
    fn offer_redemption_is_bound_to_the_window_and_consumes_exactly_once() {
        let state = subscribed_state();
        let path = PathBuf::from("C:\\private\\single-use.mp4");
        state.handle_drop(std::slice::from_ref(&path), PhysicalPosition::new(1.0, 2.0));
        let offer_id = state
            .inner
            .lock()
            .expect("drop state")
            .offer
            .as_ref()
            .expect("offer")
            .id;

        assert!(state.redeem_offer("other-window", offer_id).is_err());
        assert!(state.inner.lock().expect("drop state").offer.is_some());
        assert_eq!(
            state.redeem_offer("main", offer_id).expect("redeemed"),
            path
        );
        assert!(state.redeem_offer("main", offer_id).is_err());
    }

    #[test]
    fn empty_and_multiple_file_drops_never_create_an_offer() {
        let state = subscribed_state();

        state.handle_drop(&[], PhysicalPosition::new(1.0, 2.0));
        assert!(state.inner.lock().expect("drop state").offer.is_none());
        state.handle_drop(
            &[PathBuf::from("one.mp4"), PathBuf::from("two.mp4")],
            PhysicalPosition::new(1.0, 2.0),
        );
        assert!(state.inner.lock().expect("drop state").offer.is_none());
    }

    #[test]
    fn an_expired_offer_is_removed_without_serializing_its_path() {
        let state = subscribed_state();
        state.handle_drop(
            &[PathBuf::from("C:\\private\\expired.mp4")],
            PhysicalPosition::new(1.0, 2.0),
        );
        let offer_id = {
            let mut inner = state.inner.lock().expect("drop state");
            let offer = inner.offer.as_mut().expect("offer");
            offer.expires_at = std::time::Instant::now()
                .checked_sub(std::time::Duration::from_millis(1))
                .expect("a one millisecond subtraction is representable");
            offer.id
        };

        state.expire_offer(offer_id);

        assert!(state.inner.lock().expect("drop state").offer.is_none());
    }

    #[test]
    fn native_drop_acl_denies_raw_tauri_events_and_broad_file_access() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json"))
                .expect("valid main capability");
        let permissions = capability["permissions"]
            .as_array()
            .expect("permission list")
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>();

        assert!(permissions.contains(&"use-native-media-drop"));
        assert!(permissions.contains(&"core:event:deny-listen"));
        assert!(!permissions.contains(&"core:default"));
        assert!(!permissions.contains(&"core:event:default"));
        assert!(!permissions.contains(&"core:event:allow-listen"));
        assert!(!permissions.iter().any(|permission| {
            permission.starts_with("fs:") || permission.starts_with("shell:")
        }));
    }

    #[test]
    fn desktop_config_enables_the_native_handler_without_relaxing_csp() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("valid Tauri configuration");
        let main_window = &config["app"]["windows"][0];
        let csp = &config["app"]["security"]["csp"];

        assert_eq!(main_window["dragDropEnabled"], true);
        assert_eq!(csp["object-src"], "'none'");
        assert_eq!(csp["script-src"], "'self'");
    }
}
