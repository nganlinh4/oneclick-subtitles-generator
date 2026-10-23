use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    ActiveSession, LiveMusicEvent, LiveMusicRuntime, LiveMusicSessionSnapshot,
    WeightedPromptRequest, native_prompts, require_session_id,
};

#[test]
fn request_validation_rejects_empty_zero_and_oversized_prompt_sets() {
    assert!(native_prompts(Vec::new()).is_err());
    assert!(
        native_prompts(vec![WeightedPromptRequest {
            text: "ambient".to_owned(),
            weight: 0.0,
        }])
        .is_err()
    );
    assert!(
        native_prompts(
            (0..17)
                .map(|index| WeightedPromptRequest {
                    text: format!("prompt {index}"),
                    weight: 1.0,
                })
                .collect()
        )
        .is_err()
    );
}

#[test]
fn session_ids_are_v7_and_private_provider_text_is_debug_redacted() {
    let snapshot = LiveMusicSessionSnapshot::new(uuid::Uuid::now_v7());
    assert!(require_session_id(snapshot.id).is_ok());
    assert!(require_session_id(uuid::Uuid::new_v4()).is_err());

    let event = LiveMusicEvent::FilteredPrompt {
        session_id: snapshot.id,
        text: "private prompt".to_owned(),
        reason: "private reason".to_owned(),
    };
    let debug = format!("{event:?}");
    assert!(!debug.contains("private prompt"));
    assert!(!debug.contains("private reason"));

    let wire = serde_json::to_value(LiveMusicEvent::Ready {
        session_id: snapshot.id,
    })
    .expect("serialize event");
    assert_eq!(
        wire.get("event").and_then(serde_json::Value::as_str),
        Some("ready")
    );
    assert_eq!(
        wire.get("sessionId").and_then(serde_json::Value::as_str),
        Some(snapshot.id.to_string().as_str())
    );
    assert!(wire.get("session_id").is_none());
}

#[tokio::test]
async fn start_rollback_cancels_only_the_exact_operation_owner() {
    let runtime = LiveMusicRuntime::default();
    let owner = uuid::Uuid::now_v7();
    let unrelated = uuid::Uuid::now_v7();
    let cancellation = CancellationToken::new();
    let (commands, _receiver) = mpsc::channel(1);
    *runtime.inner.active.lock().await = Some(ActiveSession {
        id: uuid::Uuid::now_v7(),
        start_operation_id: owner,
        commands,
        cancellation: cancellation.clone(),
    });

    assert!(
        !runtime
            .rollback_start(unrelated)
            .await
            .expect("unrelated rollback")
    );
    assert!(!cancellation.is_cancelled());
    assert!(runtime.rollback_start(owner).await.expect("owned rollback"));
    assert!(cancellation.is_cancelled());
}
