use std::{fmt, sync::Arc};

use osg_infrastructure::secrets::{CredentialId, CredentialPurpose};
use osg_live_music::{
    ClientCommand, Error as LiveMusicError, LiveMusicClient, PlaybackControl, ServerEvent,
    WeightedPrompt,
};
use serde::{Deserialize, Serialize};
use tauri::{
    State,
    ipc::{Channel, InvokeResponseBody},
};
use tokio::sync::{Mutex, mpsc};
use tokio_util::sync::CancellationToken;
use uuid::{Uuid, Version};

use crate::{
    error::{CommandError, CommandResult},
    state::DesktopState,
};

const COMMAND_CAPACITY: usize = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    missing_debug_implementations,
    reason = "music prompts are private user content"
)]
pub(crate) struct LiveMusicStartRequest {
    credential_id: CredentialId,
    weighted_prompts: Vec<WeightedPromptRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    missing_debug_implementations,
    reason = "music prompts are private user content"
)]
pub(crate) struct WeightedPromptRequest {
    text: String,
    weight: f32,
}

fn native_prompts(requests: Vec<WeightedPromptRequest>) -> CommandResult<Vec<WeightedPrompt>> {
    let prompts = requests
        .into_iter()
        .map(|prompt| WeightedPrompt::new(prompt.text, prompt.weight))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid_prompts())?;
    osg_live_music::validate_weighted_prompts(&prompts).map_err(|_| invalid_prompts())?;
    Ok(prompts)
}

fn invalid_prompts() -> CommandError {
    CommandError::invalid_input("The live music prompts are invalid.")
}

fn invalid_session() -> CommandError {
    CommandError::invalid_input("The live music session is invalid or no longer active.")
}

fn runtime_busy() -> CommandError {
    CommandError::invalid_input("A live music session is already active.")
}

fn command_queue_busy() -> CommandError {
    CommandError::internal("The live music command queue is temporarily unavailable.")
}

fn require_session_id(id: Uuid) -> CommandResult<Uuid> {
    if id.get_version() == Some(Version::SortRand) {
        Ok(id)
    } else {
        Err(invalid_session())
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LiveMusicControlRequest {
    Play,
    Pause,
    Stop,
    ResetContext,
}

impl From<LiveMusicControlRequest> for PlaybackControl {
    fn from(value: LiveMusicControlRequest) -> Self {
        match value {
            LiveMusicControlRequest::Play => Self::Play,
            LiveMusicControlRequest::Pause => Self::Pause,
            LiveMusicControlRequest::Stop => Self::Stop,
            LiveMusicControlRequest::ResetContext => Self::ResetContext,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiveMusicSessionSnapshot {
    id: Uuid,
    model: &'static str,
    sample_rate_hz: u32,
    channels: u8,
    format: &'static str,
}

impl LiveMusicSessionSnapshot {
    fn new(id: Uuid) -> Self {
        Self {
            id,
            model: osg_live_music::MODEL_RESOURCE,
            sample_rate_hz: osg_live_music::SAMPLE_RATE_HZ,
            channels: osg_live_music::CHANNEL_COUNT,
            format: "pcm16le",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum LiveMusicEvent {
    Ready {
        session_id: Uuid,
    },
    ControlApplied {
        session_id: Uuid,
        control: PlaybackControl,
    },
    FilteredPrompt {
        session_id: Uuid,
        text: String,
        reason: String,
    },
    Warning {
        session_id: Uuid,
        message: String,
    },
    Closed {
        session_id: Uuid,
    },
    Failed {
        session_id: Uuid,
        error: LiveMusicPublicError,
    },
}

impl fmt::Debug for LiveMusicEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ready { session_id } => formatter
                .debug_struct("Ready")
                .field("session_id", session_id)
                .finish(),
            Self::ControlApplied {
                session_id,
                control,
            } => formatter
                .debug_struct("ControlApplied")
                .field("session_id", session_id)
                .field("control", control)
                .finish(),
            Self::FilteredPrompt { session_id, .. } => formatter
                .debug_struct("FilteredPrompt")
                .field("session_id", session_id)
                .field("content", &"<redacted>")
                .finish(),
            Self::Warning { session_id, .. } => formatter
                .debug_struct("Warning")
                .field("session_id", session_id)
                .field("content", &"<redacted>")
                .finish(),
            Self::Closed { session_id } => formatter
                .debug_struct("Closed")
                .field("session_id", session_id)
                .finish(),
            Self::Failed { session_id, error } => formatter
                .debug_struct("Failed")
                .field("session_id", session_id)
                .field("error", error)
                .finish(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiveMusicPublicError {
    code: &'static str,
    message: &'static str,
}

impl LiveMusicPublicError {
    const fn from_transport(error: LiveMusicError) -> Self {
        match error {
            LiveMusicError::SetupTimeout | LiveMusicError::TransportTimeout => Self {
                code: "liveMusicTimedOut",
                message: "The native live music session timed out.",
            },
            LiveMusicError::ProtocolViolation => Self {
                code: "liveMusicProtocolFailed",
                message: "The live music provider returned an invalid response.",
            },
            LiveMusicError::InvalidPrompts => Self {
                code: "invalidLiveMusicPrompts",
                message: "The native live music prompts are invalid.",
            },
            LiveMusicError::ConnectionFailed => Self {
                code: "liveMusicUnavailable",
                message: "The native live music service is unavailable.",
            },
            LiveMusicError::OutputClosed => Self {
                code: "liveMusicChannelClosed",
                message: "The native live music output channel closed.",
            },
            LiveMusicError::Cancelled => Self {
                code: "liveMusicCancelled",
                message: "The native live music session was cancelled.",
            },
        }
    }
}

#[derive(Clone)]
struct ActiveSession {
    id: Uuid,
    commands: mpsc::Sender<ClientCommand>,
    cancellation: CancellationToken,
}

#[derive(Default)]
struct LiveMusicRuntimeInner {
    active: Mutex<Option<ActiveSession>>,
}

/// Owns the sole provider session so overlapping `WebViews` cannot create
/// unsupervised sockets or duplicate audio streams.
#[derive(Clone, Default)]
pub(crate) struct LiveMusicRuntime {
    inner: Arc<LiveMusicRuntimeInner>,
}

impl fmt::Debug for LiveMusicRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LiveMusicRuntime")
            .field("provider", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl LiveMusicRuntime {
    async fn sender(&self, id: Uuid) -> CommandResult<mpsc::Sender<ClientCommand>> {
        let id = require_session_id(id)?;
        let active = self.inner.active.lock().await;
        active
            .as_ref()
            .filter(|session| session.id == id)
            .map(|session| session.commands.clone())
            .ok_or_else(invalid_session)
    }

    async fn cancellation(&self, id: Uuid) -> CommandResult<CancellationToken> {
        let id = require_session_id(id)?;
        let active = self.inner.active.lock().await;
        active
            .as_ref()
            .filter(|session| session.id == id)
            .map(|session| session.cancellation.clone())
            .ok_or_else(invalid_session)
    }

    async fn clear_if_current(&self, id: Uuid) {
        let mut active = self.inner.active.lock().await;
        if active.as_ref().is_some_and(|session| session.id == id) {
            *active = None;
        }
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn live_music_start(
    state: State<'_, DesktopState>,
    runtime: State<'_, LiveMusicRuntime>,
    request: LiveMusicStartRequest,
    on_event: Channel<LiveMusicEvent>,
    on_audio: Channel<InvokeResponseBody>,
) -> CommandResult<LiveMusicSessionSnapshot> {
    let prompts = native_prompts(request.weighted_prompts)?;
    let mut active = runtime.inner.active.lock().await;
    if active.is_some() {
        return Err(runtime_busy());
    }

    let credentials = state.credentials.clone();
    let credential_id = request.credential_id;
    let api_key = tauri::async_runtime::spawn_blocking(move || {
        credentials.resolve(credential_id, CredentialPurpose::GeminiApiKey)
    })
    .await
    .map_err(|_| CommandError::internal("The credential task stopped unexpectedly."))??;

    let session_id = Uuid::now_v7();
    let (command_tx, command_rx) = mpsc::channel(COMMAND_CAPACITY);
    let cancellation = CancellationToken::new();
    *active = Some(ActiveSession {
        id: session_id,
        commands: command_tx,
        cancellation: cancellation.clone(),
    });
    drop(active);

    let managed_runtime = runtime.inner().clone();
    tauri::async_runtime::spawn(async move {
        let client = LiveMusicClient::default();
        let result = client
            .run(
                api_key,
                prompts,
                command_rx,
                cancellation,
                |event| match event {
                    ServerEvent::Audio(bytes) => on_audio
                        .send(InvokeResponseBody::Raw(bytes))
                        .map_err(|_| ()),
                    ServerEvent::SetupComplete => on_event
                        .send(LiveMusicEvent::Ready { session_id })
                        .map_err(|_| ()),
                    ServerEvent::ControlSent(control) => on_event
                        .send(LiveMusicEvent::ControlApplied {
                            session_id,
                            control,
                        })
                        .map_err(|_| ()),
                    ServerEvent::FilteredPrompt { text, reason } => on_event
                        .send(LiveMusicEvent::FilteredPrompt {
                            session_id,
                            text,
                            reason,
                        })
                        .map_err(|_| ()),
                    ServerEvent::Warning(message) => on_event
                        .send(LiveMusicEvent::Warning {
                            session_id,
                            message,
                        })
                        .map_err(|_| ()),
                },
            )
            .await;

        match result {
            Ok(()) | Err(LiveMusicError::Cancelled) => {
                let _ = on_event.send(LiveMusicEvent::Closed { session_id });
            }
            Err(LiveMusicError::OutputClosed) => {}
            Err(error) => {
                let _ = on_event.send(LiveMusicEvent::Failed {
                    session_id,
                    error: LiveMusicPublicError::from_transport(error),
                });
            }
        }
        managed_runtime.clear_if_current(session_id).await;
    });

    Ok(LiveMusicSessionSnapshot::new(session_id))
}

#[tauri::command]
pub(crate) async fn live_music_update(
    runtime: State<'_, LiveMusicRuntime>,
    session_id: Uuid,
    weighted_prompts: Vec<WeightedPromptRequest>,
) -> CommandResult<()> {
    let prompts = native_prompts(weighted_prompts)?;
    runtime
        .sender(session_id)
        .await?
        .try_send(ClientCommand::SetWeightedPrompts(prompts))
        .map_err(|_| command_queue_busy())
}

#[tauri::command]
pub(crate) async fn live_music_control(
    runtime: State<'_, LiveMusicRuntime>,
    session_id: Uuid,
    control: LiveMusicControlRequest,
) -> CommandResult<()> {
    runtime
        .sender(session_id)
        .await?
        .try_send(ClientCommand::Control(control.into()))
        .map_err(|_| command_queue_busy())
}

#[tauri::command]
pub(crate) async fn live_music_close(
    runtime: State<'_, LiveMusicRuntime>,
    session_id: Uuid,
) -> CommandResult<()> {
    runtime.cancellation(session_id).await?.cancel();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        LiveMusicEvent, LiveMusicSessionSnapshot, WeightedPromptRequest, native_prompts,
        require_session_id,
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
}
