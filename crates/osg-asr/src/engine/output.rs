//! Validation of the worker's transcript payload into a bounded, publishable `Transcription`.

use super::{Transcription, TranscriptionRequest, map_backend};
use crate::protocol::{WireBackend, WireWord};
use crate::segment::{Word, segment_words};
use crate::{AsrEngineId, AsrError, LanguageCode, Result};

const MAX_TRANSCRIPT_BYTES: usize = 8 * 1024 * 1024;
const MAX_WORDS: usize = 250_000;
const MAX_WORD_BYTES: usize = 4 * 1024;
const MAX_WORD_BYTES_TOTAL: usize = 16 * 1024 * 1024;

pub(super) fn build_transcription(
    engine: AsrEngineId,
    request: &TranscriptionRequest,
    transcript: &str,
    language: Option<&str>,
    backend: WireBackend,
    wire_words: Vec<WireWord>,
    join_without_spaces: bool,
) -> Result<Transcription> {
    if transcript.len() > MAX_TRANSCRIPT_BYTES
        || transcript
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(AsrError::InvalidOutput);
    }
    let language = language
        .map(LanguageCode::new)
        .transpose()
        .map_err(|_| AsrError::InvalidOutput)?;
    let words = validate_words(wire_words, request.audio.duration_ms())?;
    let mut segments = segment_words(&words, request.options.segmentation(), join_without_spaces);
    // A model may place its final word at or past the decoded audio end; the clamp above then
    // collapses it to a zero-length tail. A cue without extent is meaningless on every consumer's
    // timeline and the WebView boundary rightly refuses the whole payload over one — a real
    // four-window run lost its last window exactly that way. Publish only segments with extent.
    segments.retain(|segment| segment.end_ms > segment.start_ms);
    let text = transcript.trim().to_owned();
    if segments.is_empty() && !text.is_empty() {
        segments.push(crate::Segment {
            start_ms: 0,
            end_ms: request.audio.duration_ms(),
            text: normalize_word(&text)?,
        });
    }
    Ok(Transcription {
        engine,
        text,
        segments,
        duration_ms: request.audio.duration_ms(),
        language,
        backend: map_backend(backend),
    })
}

fn validate_words(wire_words: Vec<WireWord>, duration_ms: u64) -> Result<Vec<Word>> {
    if wire_words.len() > MAX_WORDS {
        return Err(AsrError::InvalidOutput);
    }
    let mut words = Vec::with_capacity(wire_words.len());
    let mut previous_start = 0;
    let mut text_bytes = 0_usize;
    for word in wire_words {
        let text = normalize_word(&word.text)?;
        text_bytes = text_bytes
            .checked_add(text.len())
            .ok_or(AsrError::InvalidOutput)?;
        if text.is_empty()
            || text.len() > MAX_WORD_BYTES
            || text_bytes > MAX_WORD_BYTES_TOTAL
            || !word.start_seconds.is_finite()
            || !word.end_seconds.is_finite()
            || word.start_seconds < 0.0
            || word.end_seconds < word.start_seconds
        {
            return Err(AsrError::InvalidOutput);
        }
        let start_ms = seconds_to_milliseconds(word.start_seconds)?;
        let end_ms = seconds_to_milliseconds(word.end_seconds)?.min(duration_ms);
        if start_ms > duration_ms || start_ms < previous_start || end_ms < start_ms {
            return Err(AsrError::InvalidOutput);
        }
        previous_start = start_ms;
        words.push(Word {
            text,
            start_ms,
            end_ms,
        });
    }
    Ok(words)
}

fn normalize_word(value: &str) -> Result<String> {
    if value.contains('\0') {
        return Err(AsrError::InvalidOutput);
    }
    Ok(value.split_whitespace().collect::<Vec<_>>().join(" "))
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]
fn seconds_to_milliseconds(seconds: f64) -> Result<u64> {
    let milliseconds = seconds * 1_000.0;
    if !milliseconds.is_finite() || milliseconds < 0.0 || milliseconds > u64::MAX as f64 {
        return Err(AsrError::InvalidOutput);
    }
    Ok(milliseconds.round() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::test_support::write_wav;
    use crate::{NormalizedAudio, TranscriptionOptions};

    #[test]
    fn a_tail_word_clamped_to_the_audio_end_never_publishes_a_zero_length_segment() {
        // A model may start its final word at the decoded audio end; the clamp collapses it to a
        // zero-length tail that every consumer's timeline contract refuses. It must be dropped,
        // not published — a real four-window run lost its last window over exactly this payload.
        let directory =
            std::env::temp_dir().join(format!("osg-asr-tail-clamp-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let wav = directory.join("one-second.wav");
        write_wav(&wav, 1_000);
        let audio = NormalizedAudio::open(&wav).unwrap();
        assert_eq!(audio.duration_ms(), 1_000);
        // One word per segment: the tail word must not be able to hide inside a wider segment.
        let segmentation =
            crate::SegmentationOptions::new(crate::SegmentStrategy::Sentence, 60, Some(1), 800)
                .unwrap();
        let request = TranscriptionRequest::new(audio, TranscriptionOptions::new(segmentation));
        let transcription = build_transcription(
            AsrEngineId::FasterWhisperTurbo,
            &request,
            "hello world",
            Some("en"),
            WireBackend::Cpu,
            vec![
                WireWord {
                    text: "hello".to_owned(),
                    start_seconds: 0.0,
                    end_seconds: 0.6,
                },
                WireWord {
                    text: "world".to_owned(),
                    start_seconds: 1.0,
                    end_seconds: 1.4,
                },
            ],
            false,
        )
        .expect("a tail-clamped payload must remain publishable");
        assert!(
            !transcription.segments.is_empty(),
            "the real words vanished"
        );
        for segment in &transcription.segments {
            assert!(
                segment.end_ms > segment.start_ms,
                "published a zero-length segment: {segment:?}"
            );
        }
        std::fs::remove_dir_all(&directory).ok();
    }
}
