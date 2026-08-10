//! Backend-only, bounded transport for Google's `Lyria RealTime` `WebSocket` API.
//!
//! The API key is accepted only as a secret value and is never exposed by a
//! serializable type or a `Debug` implementation. Provider messages are size
//! bounded before JSON parsing and again before PCM forwarding.

use std::{fmt, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;
use tokio::{net::TcpStream, time::Instant};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        protocol::{CloseFrame, WebSocketConfig},
    },
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

/// A validated non-zero prompt used to steer a live music session.
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeightedPrompt {
    text: String,
    weight: f32,
}

impl WeightedPrompt {
    /// Creates a bounded prompt. Lyria normalizes weights, while the `PromptDJ`
    /// UI exposes the inclusive range `(0, 2]` for active prompts.
    pub fn new(text: impl Into<String>, weight: f32) -> Result<Self> {
        let text = text.into();
        if text.trim().is_empty()
            || text.chars().count() > MAX_PROMPT_CHARS
            || !weight.is_finite()
            || weight <= 0.0
            || weight > 2.0
        {
            return Err(Error::InvalidPrompts);
        }
        Ok(Self { text, weight })
    }

    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    #[must_use]
    pub const fn weight(&self) -> f32 {
        self.weight
    }
}

impl fmt::Debug for WeightedPrompt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WeightedPrompt")
            .field("text", &"<redacted>")
            .field("weight", &self.weight)
            .finish()
    }
}

/// Validates the complete prompt set before it can cross the provider boundary.
pub fn validate_weighted_prompts(prompts: &[WeightedPrompt]) -> Result<()> {
    if prompts.is_empty() || prompts.len() > MAX_PROMPTS {
        return Err(Error::InvalidPrompts);
    }
    let mut total_chars = 0usize;
    for prompt in prompts {
        let prompt_chars = prompt.text.chars().count();
        total_chars = total_chars
            .checked_add(prompt_chars)
            .ok_or(Error::InvalidPrompts)?;
        if prompt.text.trim().is_empty()
            || prompt_chars > MAX_PROMPT_CHARS
            || !prompt.weight.is_finite()
            || prompt.weight <= 0.0
            || prompt.weight > 2.0
            || total_chars > MAX_TOTAL_PROMPT_CHARS
        {
            return Err(Error::InvalidPrompts);
        }
    }
    Ok(())
}

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

type SocketSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type SocketStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

fn ensure_tls_provider() -> Result<()> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    rustls::crypto::CryptoProvider::get_default()
        .map(|_| ())
        .ok_or(Error::ConnectionFailed)
}

async fn await_setup(
    sink: &mut SocketSink,
    stream: &mut SocketStream,
    cancellation: &CancellationToken,
) -> Result<()> {
    let deadline = Instant::now() + SETUP_TIMEOUT;
    loop {
        let incoming = tokio::select! {
            () = cancellation.cancelled() => return Err(Error::Cancelled),
            result = tokio::time::timeout_at(deadline, stream.next()) => {
                result.map_err(|_| Error::SetupTimeout)?
            }
        };
        let message = incoming
            .ok_or(Error::ConnectionFailed)?
            .map_err(|_| Error::ConnectionFailed)?;
        match message {
            Message::Ping(bytes) => send_message(sink, Message::Pong(bytes)).await?,
            Message::Pong(_) => {}
            Message::Close(_) => return Err(Error::ConnectionFailed),
            Message::Text(text) => {
                if parse_setup_message(text.as_bytes())? {
                    return Ok(());
                }
            }
            Message::Binary(bytes) => {
                if parse_setup_message(&bytes)? {
                    return Ok(());
                }
            }
            Message::Frame(_) => return Err(Error::ProtocolViolation),
        }
    }
}

async fn supervise_session<F>(
    sink: &mut SocketSink,
    stream: &mut SocketStream,
    commands: &mut tokio::sync::mpsc::Receiver<ClientCommand>,
    cancellation: &CancellationToken,
    on_event: &mut F,
) -> Result<()>
where
    F: FnMut(ServerEvent) -> std::result::Result<(), ()>,
{
    let idle_timer = tokio::time::sleep(PLAYING_IDLE_TIMEOUT);
    tokio::pin!(idle_timer);
    let mut is_playing = true;
    loop {
        tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                let _ = close_socket(sink).await;
                return Err(Error::Cancelled);
            }
            () = &mut idle_timer, if is_playing => {
                let _ = close_socket(sink).await;
                return Err(Error::TransportTimeout);
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    let _ = close_socket(sink).await;
                    return Ok(());
                };
                match command {
                    ClientCommand::SetWeightedPrompts(prompts) => {
                        validate_weighted_prompts(&prompts)?;
                        send_prompts(sink, &prompts).await?;
                    }
                    ClientCommand::Control(control) => {
                        send_control(sink, control).await?;
                        is_playing = match control {
                            PlaybackControl::Play => true,
                            PlaybackControl::Pause | PlaybackControl::Stop => false,
                            PlaybackControl::ResetContext => is_playing,
                        };
                        if is_playing {
                            idle_timer.as_mut().reset(Instant::now() + PLAYING_IDLE_TIMEOUT);
                        }
                        on_event(ServerEvent::ControlSent(control))
                            .map_err(|()| Error::OutputClosed)?;
                    }
                    ClientCommand::Close => {
                        let _ = close_socket(sink).await;
                        return Ok(());
                    }
                }
            }
            incoming = stream.next() => {
                let message = incoming
                    .ok_or(Error::ConnectionFailed)?
                    .map_err(|_| Error::ConnectionFailed)?;
                let received_audio = match message {
                    Message::Ping(bytes) => {
                        send_message(sink, Message::Pong(bytes)).await?;
                        false
                    }
                    Message::Pong(_) => false,
                    Message::Close(_) => return Err(Error::ConnectionFailed),
                    Message::Text(text) => forward_server_message(text.as_bytes(), on_event)?,
                    Message::Binary(bytes) => forward_server_message(&bytes, on_event)?,
                    Message::Frame(_) => return Err(Error::ProtocolViolation),
                };
                if is_playing && received_audio {
                    idle_timer.as_mut().reset(Instant::now() + PLAYING_IDLE_TIMEOUT);
                }
            }
        }
    }
}

async fn send_message(sink: &mut SocketSink, message: Message) -> Result<()> {
    tokio::time::timeout(SEND_TIMEOUT, sink.send(message))
        .await
        .map_err(|_| Error::TransportTimeout)?
        .map_err(|_| Error::ConnectionFailed)
}

async fn send_json(sink: &mut SocketSink, value: &Value) -> Result<()> {
    let serialized = serde_json::to_string(value).map_err(|_| Error::ProtocolViolation)?;
    if serialized.len() > MAX_SERVER_FRAME_BYTES {
        return Err(Error::ProtocolViolation);
    }
    send_message(sink, Message::Text(serialized.into())).await
}

async fn send_prompts(sink: &mut SocketSink, prompts: &[WeightedPrompt]) -> Result<()> {
    validate_weighted_prompts(prompts)?;
    let value = serde_json::json!({
        "clientContent": {
            "weightedPrompts": prompts,
        }
    });
    send_json(sink, &value).await
}

async fn send_control(sink: &mut SocketSink, control: PlaybackControl) -> Result<()> {
    send_json(sink, &serde_json::json!({ "playbackControl": control })).await
}

async fn close_socket(sink: &mut SocketSink) -> Result<()> {
    send_message(
        sink,
        Message::Close(Some(CloseFrame {
            code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "session closed".into(),
        })),
    )
    .await
}

fn parse_setup_message(bytes: &[u8]) -> Result<bool> {
    let value = parse_json(bytes)?;
    validate_server_union(&value)?;
    if value.get("setupComplete").is_some() {
        let setup = value.get("setupComplete").ok_or(Error::ProtocolViolation)?;
        return Ok(setup.as_object().is_some_and(serde_json::Map::is_empty));
    }
    Err(Error::ProtocolViolation)
}

fn forward_server_message<F>(bytes: &[u8], on_event: &mut F) -> Result<bool>
where
    F: FnMut(ServerEvent) -> std::result::Result<(), ()>,
{
    let value = parse_json(bytes)?;
    validate_server_union(&value)?;
    if let Some(content) = value.get("serverContent") {
        for pcm in parse_audio_content(content)? {
            on_event(ServerEvent::Audio(pcm)).map_err(|()| Error::OutputClosed)?;
        }
        return Ok(true);
    }
    if let Some(filtered) = value.get("filteredPrompt") {
        let object = filtered.as_object().ok_or(Error::ProtocolViolation)?;
        let text = bounded_string(object.get("text"), MAX_FILTER_TEXT_CHARS)?;
        let reason = bounded_string(object.get("filteredReason"), MAX_PROVIDER_NOTICE_CHARS)?;
        on_event(ServerEvent::FilteredPrompt { text, reason }).map_err(|()| Error::OutputClosed)?;
        return Ok(false);
    }
    if let Some(warning) = value.get("warning") {
        let warning = bounded_string(Some(warning), MAX_PROVIDER_NOTICE_CHARS)?;
        on_event(ServerEvent::Warning(warning)).map_err(|()| Error::OutputClosed)?;
        return Ok(false);
    }
    Err(Error::ProtocolViolation)
}

fn parse_json(bytes: &[u8]) -> Result<Value> {
    if bytes.is_empty() || bytes.len() > MAX_SERVER_MESSAGE_BYTES {
        return Err(Error::ProtocolViolation);
    }
    serde_json::from_slice(bytes).map_err(|_| Error::ProtocolViolation)
}

fn validate_server_union(value: &Value) -> Result<()> {
    let object = value.as_object().ok_or(Error::ProtocolViolation)?;
    if object.len() != 1 {
        return Err(Error::ProtocolViolation);
    }
    match object.keys().next().map(String::as_str) {
        Some("setupComplete" | "serverContent" | "filteredPrompt" | "warning") => Ok(()),
        _ => Err(Error::ProtocolViolation),
    }
}

fn parse_audio_content(content: &Value) -> Result<Vec<Vec<u8>>> {
    let object = content.as_object().ok_or(Error::ProtocolViolation)?;
    if object.keys().any(|key| key != "audioChunks") {
        return Err(Error::ProtocolViolation);
    }
    let chunks = object
        .get("audioChunks")
        .and_then(Value::as_array)
        .ok_or(Error::ProtocolViolation)?;
    if chunks.is_empty() || chunks.len() > MAX_AUDIO_CHUNKS_PER_MESSAGE {
        return Err(Error::ProtocolViolation);
    }
    let mut output = Vec::with_capacity(chunks.len());
    let mut total = 0usize;
    for chunk in chunks {
        let object = chunk.as_object().ok_or(Error::ProtocolViolation)?;
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "data" | "mimeType" | "sourceMetadata"))
        {
            return Err(Error::ProtocolViolation);
        }
        let mime = object
            .get("mimeType")
            .and_then(Value::as_str)
            .ok_or(Error::ProtocolViolation)?;
        validate_pcm_mime(mime)?;
        let encoded = object
            .get("data")
            .and_then(Value::as_str)
            .ok_or(Error::ProtocolViolation)?;
        let max_encoded = MAX_AUDIO_CHUNK_BYTES.div_ceil(3) * 4;
        if encoded.is_empty() || encoded.len() > max_encoded {
            return Err(Error::ProtocolViolation);
        }
        let decoded = STANDARD
            .decode(encoded)
            .map_err(|_| Error::ProtocolViolation)?;
        if decoded.is_empty()
            || decoded.len() > MAX_AUDIO_CHUNK_BYTES
            || decoded.len() % (usize::from(BYTES_PER_SAMPLE) * usize::from(CHANNEL_COUNT)) != 0
        {
            return Err(Error::ProtocolViolation);
        }
        total = total
            .checked_add(decoded.len())
            .ok_or(Error::ProtocolViolation)?;
        if total > MAX_AUDIO_BYTES_PER_MESSAGE {
            return Err(Error::ProtocolViolation);
        }
        output.push(decoded);
    }
    Ok(output)
}

fn validate_pcm_mime(mime: &str) -> Result<()> {
    if mime.len() > 128 || mime.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(Error::ProtocolViolation);
    }
    let mut parts = mime.split(';').map(str::trim);
    if !parts.next().is_some_and(|value| {
        value.eq_ignore_ascii_case("audio/l16") || value.eq_ignore_ascii_case("audio/pcm")
    }) {
        return Err(Error::ProtocolViolation);
    }
    let mut saw_rate = false;
    let mut saw_channels = false;
    for parameter in parts {
        if parameter.eq_ignore_ascii_case("rate=48000") {
            if saw_rate {
                return Err(Error::ProtocolViolation);
            }
            saw_rate = true;
        } else if parameter.eq_ignore_ascii_case("channels=2") {
            if saw_channels {
                return Err(Error::ProtocolViolation);
            }
            saw_channels = true;
        } else {
            return Err(Error::ProtocolViolation);
        }
    }
    if !saw_rate || !saw_channels {
        return Err(Error::ProtocolViolation);
    }
    Ok(())
}

fn bounded_string(value: Option<&Value>, maximum: usize) -> Result<String> {
    let value = value
        .and_then(Value::as_str)
        .ok_or(Error::ProtocolViolation)?;
    if value.chars().count() > maximum || value.bytes().any(|byte| byte == 0) {
        return Err(Error::ProtocolViolation);
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
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
        WeightedPrompt, forward_server_message, validate_weighted_prompts,
    };

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
        assert!(super::validate_pcm_mime("audio/l16;rate=48000;channels=2").is_ok());
        assert_eq!(
            super::validate_pcm_mime("audio/l16;rate=48000"),
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
}
