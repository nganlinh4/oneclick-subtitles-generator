//! The live socket: setup handshake, supervision loop, and bounded sends.

use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use serde_json::Value;
use tokio::{net::TcpStream, time::Instant};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, protocol::CloseFrame},
};
use tokio_util::sync::CancellationToken;

use crate::{
    ClientCommand, Error, MAX_SERVER_FRAME_BYTES, PLAYING_IDLE_TIMEOUT, PlaybackControl, Result,
    SEND_TIMEOUT, SETUP_TIMEOUT, ServerEvent, WeightedPrompt,
};

use crate::protocol::{forward_server_message, parse_setup_message};
use crate::validate_weighted_prompts;

pub(crate) type SocketSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
pub(crate) type SocketStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

pub(crate) fn ensure_tls_provider() -> Result<()> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    rustls::crypto::CryptoProvider::get_default()
        .map(|_| ())
        .ok_or(Error::ConnectionFailed)
}

pub(crate) async fn await_setup(
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

pub(crate) async fn supervise_session<F>(
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
                        on_event(ServerEvent::PromptsSent {
                            count: prompts.len(),
                        })
                        .map_err(|()| Error::OutputClosed)?;
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

pub(crate) async fn send_json(sink: &mut SocketSink, value: &Value) -> Result<()> {
    let serialized = serde_json::to_string(value).map_err(|_| Error::ProtocolViolation)?;
    if serialized.len() > MAX_SERVER_FRAME_BYTES {
        return Err(Error::ProtocolViolation);
    }
    send_message(sink, Message::Text(serialized.into())).await
}

pub(crate) async fn send_prompts(sink: &mut SocketSink, prompts: &[WeightedPrompt]) -> Result<()> {
    validate_weighted_prompts(prompts)?;
    let value = serde_json::json!({
        "clientContent": {
            "weightedPrompts": prompts,
        }
    });
    send_json(sink, &value).await
}

pub(crate) async fn send_control(sink: &mut SocketSink, control: PlaybackControl) -> Result<()> {
    send_json(sink, &serde_json::json!({ "playbackControl": control })).await
}

pub(crate) async fn close_socket(sink: &mut SocketSink) -> Result<()> {
    send_message(
        sink,
        Message::Close(Some(CloseFrame {
            code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "session closed".into(),
        })),
    )
    .await
}
