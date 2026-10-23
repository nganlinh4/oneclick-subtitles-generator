//! Prompt, provider-payload, and mock-socket session tests.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use futures_util::{SinkExt, StreamExt};
use secrecy::SecretString;
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

use super::{
    CancellationToken, ClientCommand, Error, LiveMusicClient, PlaybackControl, ServerEvent,
    WeightedPrompt, validate_weighted_prompts,
};
use crate::protocol::forward_server_message;

fn prompt() -> WeightedPrompt {
    WeightedPrompt::new("minimal techno", 1.0).expect("valid prompt")
}

#[test]
fn prompt_validation_is_bounded_and_debug_is_redacted() {
    let prompt = prompt();
    assert_eq!(prompt.text(), "minimal techno");
    assert!(!format!("{prompt:?}").contains("minimal techno"));
    assert_eq!(WeightedPrompt::new("", 1.0), Err(Error::InvalidPrompts));
    assert_eq!(
        WeightedPrompt::new("valid", 0.0),
        Err(Error::InvalidPrompts)
    );
    assert_eq!(
        WeightedPrompt::new("valid", f32::NAN),
        Err(Error::InvalidPrompts)
    );
    assert_eq!(
        validate_weighted_prompts(&vec![prompt; 17]),
        Err(Error::InvalidPrompts)
    );
}

#[test]
fn tls_crypto_provider_is_selected_without_process_configuration() {
    super::ensure_tls_provider().expect("TLS provider");
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
}

#[test]
fn hostile_provider_payloads_fail_closed_without_debug_leaks() {
    let secret_text = "private filtered prompt";
    let secret_reason = "private reason";
    let mut captured = Vec::new();
    forward_server_message(
        format!(
            r#"{{"filteredPrompt":{{"text":"{secret_text}","filteredReason":"{secret_reason}"}}}}"#
        )
        .as_bytes(),
        &mut |event| {
            captured.push(event);
            Ok(())
        },
    )
    .expect("valid bounded filtered prompt");
    let debug = format!("{:?}", captured.first().expect("event"));
    assert!(!debug.contains(secret_text));
    assert!(!debug.contains(secret_reason));

    for hostile in [
        br#"{"serverContent":{"audioChunks":[{"data":"!!!"}]}}"#.as_slice(),
        br#"{"setupComplete":{},"warning":"ambiguous"}"#.as_slice(),
        br#"{"unknown":{}}"#.as_slice(),
        br#"{"serverContent":{"audioChunks":[{"data":"AQID","mimeType":"text/plain"}]}}"#
            .as_slice(),
    ] {
        assert_eq!(
            forward_server_message(hostile, &mut |_| Ok(())),
            Err(Error::ProtocolViolation)
        );
    }
    assert!(crate::protocol::validate_pcm_mime("audio/l16;rate=48000;channels=2").is_ok());
    assert_eq!(
        crate::protocol::validate_pcm_mime("audio/l16;rate=48000"),
        Err(Error::ProtocolViolation)
    );
}

async fn mock_endpoint(server_message: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind mock");
    let address = listener.local_addr().expect("mock address");
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept mock");
        let mut socket = accept_async(stream).await.expect("websocket handshake");
        let setup = socket.next().await.expect("setup frame").expect("setup");
        assert!(
            setup
                .into_text()
                .expect("setup text")
                .contains("lyria-realtime-exp")
        );
        socket
            .send(Message::Text(r#"{"setupComplete":{}}"#.into()))
            .await
            .expect("send setup complete");
        let _ = socket.next().await;
        let _ = socket.next().await;
        socket
            .send(Message::Text(server_message.into()))
            .await
            .expect("send mock message");
        let _ = socket.next().await;
    });
    format!("ws://{address}/live-music")
}

#[tokio::test]
async fn hostile_mock_server_invalid_base64_terminates_session() {
    let endpoint =
        mock_endpoint(r#"{"serverContent":{"audioChunks":[{"data":"not-base64"}]}}"#).await;
    let client = LiveMusicClient::for_test_endpoint(endpoint);
    let (_tx, rx) = tokio::sync::mpsc::channel::<ClientCommand>(4);
    let result = client
        .run(
            SecretString::from("mock-secret"),
            vec![prompt()],
            rx,
            CancellationToken::new(),
            |_| Ok(()),
        )
        .await;
    assert_eq!(result, Err(Error::ProtocolViolation));
}

#[tokio::test]
async fn mock_server_pcm_is_decoded_and_control_is_bounded() {
    let pcm = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        [0_u8, 1, 2, 3, 4, 5, 6, 7],
    );
    let message = Box::leak(
            format!(
                r#"{{"serverContent":{{"audioChunks":[{{"data":"{pcm}","mimeType":"audio/l16;rate=48000;channels=2"}}]}}}}"#
            )
            .into_boxed_str(),
        );
    let endpoint = mock_endpoint(message).await;
    let client = LiveMusicClient::for_test_endpoint(endpoint);
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    let cancellation = CancellationToken::new();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let captured_for_callback = Arc::clone(&captured);
    let cancellation_for_callback = cancellation.clone();
    let run = tokio::spawn(async move {
        client
            .run(
                SecretString::from("mock-secret"),
                vec![prompt()],
                rx,
                cancellation,
                move |event| {
                    if matches!(event, ServerEvent::Audio(_)) {
                        cancellation_for_callback.cancel();
                    }
                    captured_for_callback
                        .lock()
                        .expect("capture lock")
                        .push(event);
                    Ok(())
                },
            )
            .await
    });
    tx.send(ClientCommand::Control(PlaybackControl::ResetContext))
        .await
        .expect("queue control");
    assert_eq!(run.await.expect("join"), Err(Error::Cancelled));
    let captured = captured.lock().expect("capture lock");
    assert!(
        captured
            .iter()
            .any(|event| { matches!(event, ServerEvent::Audio(bytes) if bytes.len() == 8) })
    );
}

#[tokio::test]
#[ignore = "requires OSG_LIVE_MUSIC_TEST_KEY and contacts the official preview API"]
async fn official_endpoint_smoke_receives_pcm() {
    let key = std::env::var("OSG_LIVE_MUSIC_TEST_KEY").expect("test key configured");
    let cancellation = CancellationToken::new();
    let cancellation_for_callback = cancellation.clone();
    let saw_ready = Arc::new(AtomicBool::new(false));
    let saw_audio = Arc::new(AtomicBool::new(false));
    let ready_for_callback = Arc::clone(&saw_ready);
    let audio_for_callback = Arc::clone(&saw_audio);
    let (_tx, rx) = tokio::sync::mpsc::channel(4);
    let result = LiveMusicClient::default()
        .run(
            SecretString::from(key),
            vec![prompt()],
            rx,
            cancellation,
            move |event| {
                match event {
                    ServerEvent::SetupComplete => {
                        ready_for_callback.store(true, Ordering::Relaxed);
                    }
                    ServerEvent::Audio(_) => {
                        audio_for_callback.store(true, Ordering::Relaxed);
                        cancellation_for_callback.cancel();
                    }
                    ServerEvent::FilteredPrompt { .. }
                    | ServerEvent::PromptsSent { .. }
                    | ServerEvent::Warning(_)
                    | ServerEvent::ControlSent(_) => {}
                }
                Ok(())
            },
        )
        .await;
    assert_eq!(
        result,
        Err(Error::Cancelled),
        "ready={}, audio={}",
        saw_ready.load(Ordering::Relaxed),
        saw_audio.load(Ordering::Relaxed)
    );
}
