//! Early text only. Live supplies no media offsets: never turn these drafts into timed words.
use crate::{CancellationToken, Error, GeminiClient, Result, TransportKind};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

const ENDPOINT: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const LIMIT: usize = 256 * 1024;
fn invalid() -> Error {
    Error::InvalidRequest("Live requires bounded 16-kHz mono PCM16 WAV".into())
}

fn ensure_tls_provider() -> Result<()> {
    // The desktop links both rustls crypto backends. Automatic provider selection panics.
    // Match the existing Live Music transport, respecting a provider installed by another caller.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    rustls::crypto::CryptoProvider::get_default().map(|_| ())
        .ok_or(Error::Transport(TransportKind::Connect))
}

fn wav_pcm(bytes: &[u8]) -> Result<&[u8]> {
    if bytes.len() > 4_000_000
        || bytes.get(..4) != Some(b"RIFF")
        || bytes.get(8..12) != Some(b"WAVE")
    {
        return Err(invalid());
    }
    let mut position = 12usize;
    let mut format_ok = false;
    while position + 8 <= bytes.len() {
        let size = u32::from_le_bytes(
            bytes[position + 4..position + 8]
                .try_into()
                .map_err(|_| invalid())?,
        ) as usize;
        let start = position + 8;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(invalid)?;
        let chunk = &bytes[start..end];
        match &bytes[position..position + 4] {
            b"fmt " => {
                format_ok = chunk.len() >= 16
                    && chunk[..4] == [1, 0, 1, 0]
                    && chunk[4..8] == 16000u32.to_le_bytes()
                    && chunk[14..16] == [16, 0];
            }
            b"data" if format_ok && size > 0 && size.is_multiple_of(2) => return Ok(chunk),
            _ => {}
        }
        position = end + size % 2;
    }
    Err(invalid())
}

impl GeminiClient {
    /// One bounded window, paced at source rate. Callback replaces the current window's draft.
    /// Authentication and all transport errors stay in Rust; no URLs or keys escape this method.
    pub async fn transcribe_live_draft(
        &self,
        wav: &[u8],
        language_hints: &[String],
        cancellation: &CancellationToken,
        mut on_text: impl FnMut(String) + Send,
    ) -> Result<()> {
        let pcm = wav_pcm(wav)?;
        ensure_tls_provider()?;
        let mut endpoint = url::Url::parse(ENDPOINT).expect("constant endpoint");
        endpoint
            .query_pairs_mut()
            .append_pair("key", self.inner.api_key.expose());
        let task = async {
            let config = WebSocketConfig::default()
                .max_message_size(Some(LIMIT))
                .max_frame_size(Some(LIMIT));
            let (socket, _) = tokio::time::timeout(
                Duration::from_secs(15),
                connect_async_with_config(endpoint.as_str(), Some(config), false),
            )
            .await
            .map_err(|_| Error::Transport(TransportKind::Timeout))?
            .map_err(|_| Error::Transport(TransportKind::Connect))?;
            let (mut sender, mut receiver) = socket.split();
            sender.send(Message::Text(json!({"setup": {"model": "models/gemini-3.5-transcribe-live", "generationConfig": {"responseModalities": ["TEXT"]}, "inputAudioTranscription": {"languageCodes": language_hints}}}).to_string().into()))
                .await.map_err(|_| Error::Transport(TransportKind::Body))?;
            let setup = tokio::time::timeout(Duration::from_secs(15), receiver.next())
                .await
                .map_err(|_| Error::Transport(TransportKind::Timeout))?
                .ok_or(Error::Transport(TransportKind::Body))?
                .map_err(|_| Error::Transport(TransportKind::Body))?;
            let value: Value = serde_json::from_slice(&setup.into_data())
                .map_err(|_| Error::Transport(TransportKind::Decode))?;
            if value.get("setupComplete").is_none() {
                return Err(Error::Transport(TransportKind::Connect));
            }
            let send_audio = async {
                let mut pacing = tokio::time::interval(Duration::from_millis(100));
                pacing.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                for chunk in pcm.chunks(3200) {
                    pacing.tick().await;
                    sender.send(Message::Text(json!({"realtimeInput": {"audio": {"mimeType": "audio/pcm;rate=16000", "data": STANDARD.encode(chunk)}}}).to_string().into()))
                        .await.map_err(|_| Error::Transport(TransportKind::Body))?;
                }
                sender
                    .send(Message::Text(
                        json!({"realtimeInput":{"audioStreamEnd":true}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .map_err(|_| Error::Transport(TransportKind::Body))?;
                tokio::time::sleep(Duration::from_secs(8)).await;
                Ok::<(), Error>(())
            };
            let receive_text = async {
                let mut finalized = String::new();
                while let Some(message) = receiver.next().await {
                    let message = message.map_err(|_| Error::Transport(TransportKind::Body))?;
                    if matches!(message, Message::Close(_)) {
                        return Ok(());
                    }
                    if !matches!(message, Message::Text(_) | Message::Binary(_)) {
                        continue;
                    }
                    let value: Value = serde_json::from_slice(&message.into_data())
                        .map_err(|_| Error::Transport(TransportKind::Decode))?;
                    if value.get("error").is_some() {
                        return Err(Error::Transport(TransportKind::Body));
                    }
                    let content = &value["serverContent"];
                    if let Some(text) = content["inputTranscription"]["text"].as_str() {
                        if finalized.len() + text.len() > LIMIT {
                            return Err(Error::ResponseTooLarge { limit_bytes: LIMIT });
                        }
                        if !finalized.is_empty() {
                            finalized.push(' ');
                        }
                        finalized.push_str(text);
                        on_text(finalized.clone());
                    } else if let Some(text) = content["interimInputTranscription"]["text"].as_str()
                    {
                        if finalized.len() + text.len() > LIMIT {
                            return Err(Error::ResponseTooLarge { limit_bytes: LIMIT });
                        }
                        on_text(format!("{finalized} {text}").trim().to_owned());
                    }
                }
                Ok::<(), Error>(())
            };
            tokio::select! { result = send_audio => result, result = receive_text => result }
        };
        tokio::select! {
            () = cancellation.cancelled() => Err(Error::Cancelled),
            result = tokio::time::timeout(Duration::from_secs(150), task) => result.map_err(|_| Error::Transport(TransportKind::Timeout))?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::wav_pcm;

    #[test]
    fn websocket_crypto_provider_is_explicit_and_idempotent() {
        super::ensure_tls_provider().unwrap();
        super::ensure_tls_provider().unwrap();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn only_valid_bounded_pcm_is_streamed_without_wav_headers() {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&38u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&[1, 0, 1, 0]);
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&32000u32.to_le_bytes());
        wav.extend_from_slice(&[2, 0, 16, 0]);
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&2u32.to_le_bytes());
        wav.extend_from_slice(&[42, 0]);
        assert_eq!(wav_pcm(&wav).unwrap(), &[42, 0]);
        assert!(wav_pcm(&wav[..45]).is_err());
        wav[22] = 2; // Stereo must not be mislabeled as mono.
        assert!(wav_pcm(&wav).is_err());
        assert!(wav_pcm(&vec![0; 4_000_001]).is_err());
    }
}
