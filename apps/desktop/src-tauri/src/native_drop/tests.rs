use std::path::PathBuf;

use tauri::{PhysicalPosition, ipc::Channel};
use uuid::Uuid;

use super::{
    DropOffer, MediaDropRejection, NativeMediaDropEvent, NativeMediaDropState, OFFER_TTL,
    Subscription,
};

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
        serde_json::from_str(include_str!("../../capabilities/main.json"))
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
    assert!(
        !permissions.iter().any(|permission| {
            permission.starts_with("fs:") || permission.starts_with("shell:")
        })
    );
}

#[test]
fn desktop_config_enables_the_native_handler_without_relaxing_csp() {
    let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .expect("valid Tauri configuration");
    let main_window = &config["app"]["windows"][0];
    let csp = &config["app"]["security"]["csp"];

    assert_eq!(main_window["dragDropEnabled"], true);
    assert_eq!(csp["object-src"], "'none'");
    assert_eq!(csp["script-src"], "'self'");
}
