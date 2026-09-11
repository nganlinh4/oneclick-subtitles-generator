//! Standalone Gemini Live transcription over source-paced PCM.
use crate::{CancellationToken, Error, GeminiClient, Result, TransportKind};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::sync::watch;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

const ENDPOINT: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const LIMIT: usize = 256 * 1024;
// Live Transcription supports ten-minute sessions. PCM16 mono at 16 kHz consumes 32,000 bytes
// per second; the previous 4 MB request cap silently disabled Live after roughly 125 seconds.
const MAX_PCM_BYTES: usize = 16_000 * 2 * 60 * 10;
// A connection is capped at about ten minutes. Reserve headroom for setup, finalization, and
// provider jitter; one user-visible window may therefore use more than one sequential session.
const MAX_SESSION_PCM_BYTES: usize = 16_000 * 2 * 60 * 8;
// Live Transcribe is a real-time streaming recognizer. A 3,200-byte PCM16/16-kHz/mono packet is
// exactly 100 ms of source audio and must therefore be paced at 100 ms. Sending it at 2x measured
// only 46.3% reference-word recall on a real 15-minute captioned video.
const PACKET_PACING_MS: u64 = 100;
// audioStreamEnd finalizes current speech but deliberately keeps a continuous Live session open for
// later audio. The service therefore does not reliably send turnComplete/generationComplete. A
// bounded period with no further messages is the native protocol's usable end-of-input boundary.
const FINAL_QUIET_DRAIN_SECS: u64 = 12;
fn invalid() -> Error {
    Error::InvalidRequest("Live requires bounded 16-kHz mono PCM16 WAV".into())
}

/// A provider transcription update located on the source-paced PCM clock.
/// Gemini Live does not expose word offsets. Final events are authoritative utterances; interim
/// events are replaceable hypotheses and must never be persisted as subtitle rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveTranscriptionEvent {
    pub kind: LiveTranscriptionKind,
    pub text: String,
    pub language_code: Option<String>,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveTranscriptionKind {
    Interim,
    Final,
}

fn source_ms(sent_pcm_bytes: &AtomicU64) -> u64 {
    // PCM16 mono, 16 kHz: 32 bytes per millisecond.
    sent_pcm_bytes.load(Ordering::Acquire) / 32
}

fn minimum_spoken_duration_ms(text: &str) -> u64 {
    // Live exposes text but no offsets. Do not squeeze a complete sentence into the 300 ms used
    // to seed its first interim: distribute it over a conservative speech span derived from the
    // finalized token count. The adjacent finalized boundary remains authoritative, so this can
    // never overlap the preceding utterance. 320 ms/token corresponds to 187.5 spoken words/min,
    // deliberately faster than ordinary speech so the estimate does not invent long lead-ins.
    let token_count = text.split_whitespace().count().max(1) as u64;
    token_count.saturating_mul(320).clamp(300, 15_000)
}

fn final_turn_received(stream_ended: &AtomicBool, content: &Value) -> bool {
    stream_ended.load(Ordering::Acquire)
        && (content["turnComplete"].as_bool() == Some(true)
            || content["generationComplete"].as_bool() == Some(true))
}

fn setup_message(language_hints: &[String]) -> Value {
    // LiveConnect setup fields are siblings. Nesting the transcription or VAD
    // configuration inside generationConfig is accepted by the socket handshake
    // but ignored by the service, producing a connected session with no transcript.
    json!({"setup": {
        "model": "models/gemini-3.5-transcribe-live",
        "generationConfig": {"responseModalities": ["TEXT"]},
        // Completeness is the product invariant; subtitle grouping and cleanup happen downstream.
        // SMART intentionally removes disfluencies and therefore cannot be the source transcript.
        "inputAudioTranscription": {"languageCodes": language_hints, "mode": "VERBATIM"}
    }})
}

#[derive(Default)]
struct LiveEventAccumulator {
    active_start: Option<u64>,
    active_end: Option<u64>,
    previous_final_end: u64,
}

impl LiveEventAccumulator {
    fn with_source_offset(source_offset_ms: u64) -> Self {
        Self {
            active_start: None,
            active_end: None,
            previous_final_end: source_offset_ms,
        }
    }

    fn observe(
        &mut self,
        content: &Value,
        source_position_ms: u64,
    ) -> Result<Option<LiveTranscriptionEvent>> {
        let (kind, transcription) = if content["inputTranscription"]["text"].is_string() {
            (LiveTranscriptionKind::Final, &content["inputTranscription"])
        } else if content["interimInputTranscription"]["text"].is_string() {
            (
                LiveTranscriptionKind::Interim,
                &content["interimInputTranscription"],
            )
        } else {
            return Ok(None);
        };
        let text = transcription["text"].as_str().unwrap_or_default().trim();
        if text.is_empty() {
            return Ok(None);
        }
        if text.len() > LIMIT {
            return Err(Error::ResponseTooLarge { limit_bytes: LIMIT });
        }
        let observed_end_ms = source_position_ms.max(self.previous_final_end + 1);
        let end_ms = match kind {
            LiveTranscriptionKind::Interim => {
                self.active_end = Some(observed_end_ms);
                observed_end_ms
            }
            // A final message is emitted after the provider has finished recognizing the
            // utterance. That network/VAD delay is not source audio and must not move subtitles
            // later. The most recent interim is the last source-clock observation belonging to
            // the utterance. Some very short utterances have no interim, so retain the receipt
            // clock as the explicit fallback for that case.
            LiveTranscriptionKind::Final => self
                .active_end
                .take()
                .unwrap_or(observed_end_ms)
                .max(self.previous_final_end + 1),
        };
        let start_ms = match kind {
            LiveTranscriptionKind::Interim => *self
                .active_start
                .get_or_insert_with(|| end_ms.saturating_sub(300).max(self.previous_final_end)),
            LiveTranscriptionKind::Final => {
                let observed_start = self.active_start.take().unwrap_or(self.previous_final_end);
                observed_start
                    .min(end_ms.saturating_sub(minimum_spoken_duration_ms(text)))
                    .max(self.previous_final_end)
                    .min(end_ms.saturating_sub(1))
            }
        };
        if kind == LiveTranscriptionKind::Final {
            self.active_start = None;
            self.active_end = None;
            self.previous_final_end = end_ms;
        }
        Ok(Some(LiveTranscriptionEvent {
            kind,
            text: text.to_owned(),
            language_code: transcription["languageCode"].as_str().map(str::to_owned),
            start_ms,
            end_ms,
        }))
    }
}

fn ensure_tls_provider() -> Result<()> {
    // The desktop links both rustls crypto backends. Automatic provider selection panics.
    // Match the existing Live Music transport, respecting a provider installed by another caller.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    rustls::crypto::CryptoProvider::get_default()
        .map(|_| ())
        .ok_or(Error::Transport(TransportKind::Connect))
}

fn wav_pcm(bytes: &[u8]) -> Result<&[u8]> {
    if bytes.len() > MAX_PCM_BYTES + 4_096
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

// Session setup, its concurrent producer/consumer pair, and terminal handshake remain together so
// neither half can silently outlive the other; extracting one would obscure that ownership.
#[allow(clippy::too_many_lines)]
async fn transcribe_live_session(
    endpoint: &url::Url,
    pcm: &[u8],
    source_offset_ms: u64,
    language_hints: &[String],
    mut on_event: impl FnMut(LiveTranscriptionEvent) + Send,
) -> Result<()> {
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
    sender
        .send(Message::Text(
            setup_message(language_hints).to_string().into(),
        ))
        .await
        .map_err(|_| Error::Transport(TransportKind::Body))?;
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

    let sent_pcm_bytes = Arc::new(AtomicU64::new(0));
    let stream_ended = Arc::new(AtomicBool::new(false));
    let (ended_tx, ended_rx) = watch::channel(false);
    let send_clock = Arc::clone(&sent_pcm_bytes);
    let send_ended = Arc::clone(&stream_ended);
    let send_audio = async move {
        let mut pacing = tokio::time::interval(Duration::from_millis(PACKET_PACING_MS));
        pacing.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        for chunk in pcm.chunks(3200) {
            pacing.tick().await;
            sender.send(Message::Text(json!({"realtimeInput": {"audio": {"mimeType": "audio/pcm;rate=16000", "data": STANDARD.encode(chunk)}}}).to_string().into()))
                .await.map_err(|_| Error::Transport(TransportKind::Body))?;
            send_clock.fetch_add(chunk.len() as u64, Ordering::Release);
        }
        tokio::time::timeout(
            Duration::from_secs(5),
            sender.send(Message::Text(
                json!({"realtimeInput":{"audioStreamEnd":true}})
                    .to_string()
                    .into(),
            )),
        )
        .await
        .map_err(|_| Error::Transport(TransportKind::Timeout))?
        .map_err(|_| Error::Transport(TransportKind::Body))?;
        // Start the bounded final-drain period only after the provider has accepted the explicit
        // end marker. Publishing this state before the send gave the receiver permission to time
        // out successfully while the marker was still blocked in the socket sink.
        send_ended.store(true, Ordering::Release);
        let _ = ended_tx.send(true);
        Ok::<(), Error>(())
    };
    let receive_clock = Arc::clone(&sent_pcm_bytes);
    let receive_ended = Arc::clone(&stream_ended);
    let receive_text = async {
        let mut ended_rx = ended_rx;
        // Server-side VAD owns real speech boundaries. The former fixed eight-second manual turns
        // cut through active speech and immediately reopened without waiting for finalization,
        // which discarded large spans of otherwise valid audio.
        let mut events = LiveEventAccumulator::with_source_offset(source_offset_ms);
        loop {
            let next = if *ended_rx.borrow() {
                match tokio::time::timeout(
                    Duration::from_secs(FINAL_QUIET_DRAIN_SECS),
                    receiver.next(),
                )
                .await
                {
                    Ok(next) => next,
                    // Every received message restarts this wait. Forty-second real-provider probes
                    // produced no later text or terminal marker, confirming that quiet—not a turn
                    // marker—is the completion signal available to a finite-file client.
                    Err(_) => return Ok(()),
                }
            } else {
                tokio::select! {
                    next = receiver.next() => next,
                    changed = ended_rx.changed() => {
                        if changed.is_err() {
                            return Ok(());
                        }
                        continue;
                    }
                }
            };
            let Some(message) = next else {
                return Ok(());
            };
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
            let position_ms = source_offset_ms + source_ms(&receive_clock);
            if let Some(event) = events.observe(content, position_ms)? {
                on_event(event);
            }
            if final_turn_received(&receive_ended, content) {
                return Ok(());
            }
        }
    };
    let ((), ()) = tokio::try_join!(send_audio, receive_text)?;
    Ok(())
}

impl GeminiClient {
    /// One bounded window, paced at source rate. Final callbacks are independent utterances.
    /// Authentication and all transport errors stay in Rust; no URLs or keys escape this method.
    pub async fn transcribe_live(
        &self,
        wav: &[u8],
        language_hints: &[String],
        cancellation: &CancellationToken,
        mut on_event: impl FnMut(LiveTranscriptionEvent) + Send,
    ) -> Result<()> {
        let pcm = wav_pcm(wav)?;
        ensure_tls_provider()?;
        // Live WebSockets consume the same per-credential provider concurrency budget as REST
        // requests. Previously this path bypassed GeminiClient's semaphore entirely, so a long
        // recording with sixteen planned windows opened sixteen sessions on one key at once;
        // Google accepted the first eight and rejected the rest. Waiting here preserves every
        // requested Live window on the same model instead of failing or switching engines.
        let _permit = self.acquire(cancellation).await?;
        let mut endpoint = url::Url::parse(ENDPOINT).expect("constant endpoint");
        endpoint
            .query_pairs_mut()
            .append_pair("key", self.inner.api_key.expose());
        let task = async {
            for (session_index, session_pcm) in pcm.chunks(MAX_SESSION_PCM_BYTES).enumerate() {
                let source_offset_ms = (session_index * MAX_SESSION_PCM_BYTES / 32) as u64;
                transcribe_live_session(
                    &endpoint,
                    session_pcm,
                    source_offset_ms,
                    language_hints,
                    &mut on_event,
                )
                .await?;
            }
            Ok(())
        };
        tokio::select! {
            () = cancellation.cancelled() => Err(Error::Cancelled),
            result = tokio::time::timeout(Duration::from_secs((pcm.len() as u64).div_ceil(32_000) + 45), task) => result.map_err(|_| Error::Transport(TransportKind::Timeout))?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{LiveEventAccumulator, LiveTranscriptionKind, setup_message, source_ms, wav_pcm};
    use crate::{ApiKey, Error, GeminiClient};
    use serde_json::json;
    use std::sync::atomic::AtomicU64;
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    fn one_sample_wav() -> Vec<u8> {
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
        wav
    }

    #[test]
    fn websocket_crypto_provider_is_explicit_and_idempotent() {
        super::ensure_tls_provider().unwrap();
        super::ensure_tls_provider().unwrap();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn only_valid_bounded_pcm_is_streamed_without_wav_headers() {
        let mut wav = one_sample_wav();
        assert_eq!(wav_pcm(&wav).unwrap(), &[42, 0]);
        assert!(wav_pcm(&wav[..45]).is_err());
        wav[22] = 2; // Stereo must not be mislabeled as mono.
        assert!(wav_pcm(&wav).is_err());
        assert!(wav_pcm(&vec![0; super::MAX_PCM_BYTES + 4_097]).is_err());
    }

    #[tokio::test]
    async fn live_sessions_wait_for_the_credential_concurrency_budget() {
        let client = GeminiClient::builder(ApiKey::new("secret").unwrap())
            .max_concurrent_requests(1)
            .build()
            .unwrap();
        let holder_cancel = CancellationToken::new();
        let _held = client.acquire(&holder_cancel).await.unwrap();
        let cancel = CancellationToken::new();
        let wav = one_sample_wav();
        let waiting = client.transcribe_live(&wav, &[], &cancel, |_| {});
        tokio::pin!(waiting);

        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut waiting)
                .await
                .is_err()
        );
        cancel.cancel();
        assert!(matches!(waiting.await, Err(Error::Cancelled)));
    }

    #[test]
    fn source_clock_is_derived_from_pcm_bytes() {
        let sent = AtomicU64::new(32_000);
        assert_eq!(source_ms(&sent), 1_000);
    }

    #[test]
    fn live_transcription_uses_verbatim_mode_and_server_vad() {
        let value = setup_message(&["ko-KR".to_owned()]);
        let setup = &value["setup"];
        assert_eq!(
            setup["inputAudioTranscription"]["languageCodes"][0],
            "ko-KR"
        );
        assert_eq!(setup["inputAudioTranscription"]["mode"], "VERBATIM");
        assert!(setup.get("realtimeInputConfig").is_none());
        assert!(
            setup["generationConfig"]
                .get("inputAudioTranscription")
                .is_none()
        );
        assert!(
            setup["generationConfig"]
                .get("realtimeInputConfig")
                .is_none()
        );
    }

    #[test]
    fn ten_minute_window_stays_below_connection_limit_by_using_two_sessions() {
        let ten_minute_pcm_bytes = std::hint::black_box(super::MAX_PCM_BYTES);
        assert!(super::MAX_SESSION_PCM_BYTES < ten_minute_pcm_bytes);
        assert_eq!(
            ten_minute_pcm_bytes.div_ceil(super::MAX_SESSION_PCM_BYTES),
            2
        );
    }

    #[test]
    fn finalized_utterances_are_independent_and_monotonic() {
        let mut state = LiveEventAccumulator::default();
        let interim = state
            .observe(&json!({"interimInputTranscription":{"text":"hel"}}), 1_000)
            .unwrap()
            .unwrap();
        let first = state
            .observe(
                &json!({"inputTranscription":{"text":"hello","languageCode":"en"}}),
                1_400,
            )
            .unwrap()
            .unwrap();
        let second = state
            .observe(&json!({"inputTranscription":{"text":"world"}}), 2_000)
            .unwrap()
            .unwrap();
        assert_eq!(interim.kind, LiveTranscriptionKind::Interim);
        assert_eq!((interim.start_ms, interim.end_ms), (700, 1_000));
        assert_eq!((first.start_ms, first.end_ms), (680, 1_000));
        assert_eq!((second.start_ms, second.end_ms), (1_000, 2_000));
        assert_eq!(first.language_code.as_deref(), Some("en"));
    }

    #[test]
    fn delayed_finalization_does_not_shift_the_audio_boundary() {
        let mut state = LiveEventAccumulator::with_source_offset(60_000);
        state
            .observe(
                &json!({"interimInputTranscription":{"text":"still speaking"}}),
                64_500,
            )
            .unwrap();
        let final_event = state
            .observe(
                &json!({"inputTranscription":{"text":"still speaking"}}),
                66_200,
            )
            .unwrap()
            .unwrap();
        assert_eq!((final_event.start_ms, final_event.end_ms), (63_860, 64_500));
    }

    #[test]
    fn final_without_an_interim_uses_the_source_receipt_clock() {
        let mut state = LiveEventAccumulator::with_source_offset(7_000);
        let final_event = state
            .observe(&json!({"inputTranscription":{"text":"yes"}}), 7_240)
            .unwrap()
            .unwrap();
        assert_eq!((final_event.start_ms, final_event.end_ms), (7_000, 7_240));
    }

    #[test]
    fn finalized_sentence_uses_its_text_span_without_crossing_the_prior_final() {
        let mut state = LiveEventAccumulator::with_source_offset(10_000);
        let first = state
            .observe(
                &json!({"inputTranscription":{"text":"one two three four five"}}),
                12_000,
            )
            .unwrap()
            .unwrap();
        assert_eq!((first.start_ms, first.end_ms), (10_000, 12_000));

        state
            .observe(
                &json!({"interimInputTranscription":{"text":"six seven eight nine"}}),
                12_600,
            )
            .unwrap();
        let second = state
            .observe(
                &json!({"inputTranscription":{"text":"six seven eight nine"}}),
                13_100,
            )
            .unwrap()
            .unwrap();
        assert_eq!((second.start_ms, second.end_ms), (12_000, 12_600));
    }
}
