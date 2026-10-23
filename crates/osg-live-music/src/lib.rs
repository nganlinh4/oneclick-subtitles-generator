//! Backend-only, bounded transport for Google's `Lyria RealTime` `WebSocket` API.
//!
//! The API key is accepted only as a secret value and is never exposed by a
//! serializable type or a `Debug` implementation. Provider messages are size
//! bounded before JSON parsing and again before PCM forwarding.

mod prompt;
mod protocol;
mod session;

use std::{fmt, time::Duration};

use futures_util::StreamExt;
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use thiserror::Error;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig},
};
use tokio_util::sync::CancellationToken;
use url::Url;

/// Current model resource documented for the Live Music API.
pub const MODEL_RESOURCE: &str = "models/lyria-realtime-exp";
/// Provider output sample rate.
pub const SAMPLE_RATE_HZ: u32 = 48_000;
/// Provider output channel count.
pub const CHANNEL_COUNT: u8 = 2;
/// Provider output sample width.
pub const BYTES_PER_SAMPLE: u8 = 2;

const OFFICIAL_ENDPOINT: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic";
const MAX_PROMPTS: usize = 16;
const MAX_PROMPT_CHARS: usize = 512;
const MAX_TOTAL_PROMPT_CHARS: usize = 4_096;
const MAX_SERVER_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_SERVER_FRAME_BYTES: usize = 512 * 1024;
const MAX_AUDIO_CHUNKS_PER_MESSAGE: usize = 16;
const MAX_AUDIO_CHUNK_BYTES: usize = 512 * 1024;
const MAX_AUDIO_BYTES_PER_MESSAGE: usize = 1024 * 1024;
const MAX_FILTER_TEXT_CHARS: usize = MAX_PROMPT_CHARS;
const MAX_PROVIDER_NOTICE_CHARS: usize = 2_048;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SETUP_TIMEOUT: Duration = Duration::from_secs(15);
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const PLAYING_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

pub use prompt::{WeightedPrompt, validate_weighted_prompts};

use session::{
    SocketSink, SocketStream, await_setup, ensure_tls_provider, send_control, send_json,
    send_prompts, supervise_session,
};

/// Supported provider playback controls.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlaybackControl {
    Play,
    Pause,
    Stop,
    ResetContext,
}

/// A bounded command delivered to one supervised session.
pub enum ClientCommand {
    SetWeightedPrompts(Vec<WeightedPrompt>),
    Control(PlaybackControl),
    Close,
}

impl fmt::Debug for ClientCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SetWeightedPrompts(prompts) => formatter
                .debug_struct("SetWeightedPrompts")
                .field("prompt_count", &prompts.len())
                .finish(),
            Self::Control(control) => formatter.debug_tuple("Control").field(control).finish(),
            Self::Close => formatter.write_str("Close"),
        }
    }
}

/// Sanitized events emitted by a live session. PCM is already decoded.
pub enum ServerEvent {
    SetupComplete,
    Audio(Vec<u8>),
    PromptsSent { count: usize },
    FilteredPrompt { text: String, reason: String },
    Warning(String),
    ControlSent(PlaybackControl),
}

impl fmt::Debug for ServerEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SetupComplete => formatter.write_str("SetupComplete"),
            Self::Audio(bytes) => formatter
                .debug_struct("Audio")
                .field("bytes", &bytes.len())
                .finish(),
            Self::PromptsSent { count } => formatter
                .debug_struct("PromptsSent")
                .field("count", count)
                .finish(),
            Self::FilteredPrompt { .. } => formatter
                .debug_struct("FilteredPrompt")
                .field("content", &"<redacted>")
                .finish(),
            Self::Warning(_) => formatter
                .debug_tuple("Warning")
                .field(&"<redacted>")
                .finish(),
            Self::ControlSent(control) => {
                formatter.debug_tuple("ControlSent").field(control).finish()
            }
        }
    }
}

/// Transport and validation failures never retain provider payloads, URLs, or
/// credentials.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum Error {
    #[error("live music operation was cancelled")]
    Cancelled,
    #[error("invalid live music prompts")]
    InvalidPrompts,
    #[error("live music connection failed")]
    ConnectionFailed,
    #[error("live music setup timed out")]
    SetupTimeout,
    #[error("live music transport timed out")]
    TransportTimeout,
    #[error("live music provider protocol violation")]
    ProtocolViolation,
    #[error("live music result channel closed")]
    OutputClosed,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Immutable client configuration for the official provider endpoint.
#[derive(Clone)]
pub struct LiveMusicClient {
    endpoint: String,
}

impl Default for LiveMusicClient {
    fn default() -> Self {
        Self {
            endpoint: OFFICIAL_ENDPOINT.to_owned(),
        }
    }
}

impl fmt::Debug for LiveMusicClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LiveMusicClient")
            .field("endpoint", &"<redacted>")
            .field("model", &MODEL_RESOURCE)
            .finish()
    }
}

impl LiveMusicClient {
    /// Connects, performs the setup handshake, and owns the socket until it is
    /// explicitly closed, cancelled, or fails. The callback is invoked inline;
    /// returning an error stops the session so a dead `WebView` cannot accumulate
    /// unbounded audio.
    pub async fn run<F>(
        &self,
        api_key: SecretString,
        initial_prompts: Vec<WeightedPrompt>,
        mut commands: tokio::sync::mpsc::Receiver<ClientCommand>,
        cancellation: CancellationToken,
        mut on_event: F,
    ) -> Result<()>
    where
        F: FnMut(ServerEvent) -> std::result::Result<(), ()> + Send,
    {
        validate_weighted_prompts(&initial_prompts)?;
        let (mut sink, mut stream) = self.connect(api_key, &cancellation).await?;
        send_json(
            &mut sink,
            &serde_json::json!({ "setup": { "model": MODEL_RESOURCE } }),
        )
        .await?;
        await_setup(&mut sink, &mut stream, &cancellation).await?;
        on_event(ServerEvent::SetupComplete).map_err(|()| Error::OutputClosed)?;
        send_prompts(&mut sink, &initial_prompts).await?;
        on_event(ServerEvent::PromptsSent {
            count: initial_prompts.len(),
        })
        .map_err(|()| Error::OutputClosed)?;
        send_control(&mut sink, PlaybackControl::Play).await?;
        on_event(ServerEvent::ControlSent(PlaybackControl::Play))
            .map_err(|()| Error::OutputClosed)?;
        supervise_session(
            &mut sink,
            &mut stream,
            &mut commands,
            &cancellation,
            &mut on_event,
        )
        .await
    }

    async fn connect(
        &self,
        api_key: SecretString,
        cancellation: &CancellationToken,
    ) -> Result<(SocketSink, SocketStream)> {
        ensure_tls_provider()?;
        let request = self.provider_request(&api_key)?;
        drop(api_key);
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_SERVER_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_SERVER_FRAME_BYTES));
        let connect = connect_async_with_config(request, Some(config), true);
        let (socket, _) = tokio::select! {
            () = cancellation.cancelled() => return Err(Error::Cancelled),
            result = tokio::time::timeout(CONNECT_TIMEOUT, connect) => {
                result.map_err(|_| Error::TransportTimeout)?
                    .map_err(|_| Error::ConnectionFailed)?
            }
        };
        Ok(socket.split())
    }

    fn provider_request(
        &self,
        api_key: &SecretString,
    ) -> Result<tokio_tungstenite::tungstenite::http::Request<()>> {
        let mut url = Url::parse(&self.endpoint).map_err(|_| Error::ConnectionFailed)?;
        let is_official = url.scheme() == "wss"
            && url.host_str() == Some("generativelanguage.googleapis.com")
            && url.path()
                == "/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic";
        #[cfg(not(test))]
        if !is_official {
            return Err(Error::ConnectionFailed);
        }
        #[cfg(test)]
        if !(is_official || url.scheme() == "ws" && url.host_str() == Some("127.0.0.1")) {
            return Err(Error::ConnectionFailed);
        }
        url.query_pairs_mut()
            .clear()
            .append_pair("key", api_key.expose_secret());
        url.as_str()
            .into_client_request()
            .map_err(|_| Error::ConnectionFailed)
    }

    #[cfg(test)]
    fn for_test_endpoint(endpoint: String) -> Self {
        Self { endpoint }
    }
}

#[cfg(test)]
mod tests;
