//! Live (streaming) window transcription: sparse-attempt retry and utterance projection.

use std::sync::Arc;

use osg_gemini::{AudioTranscriptionConfig, GeminiClient, LiveTranscriptionKind};
use tokio_util::sync::CancellationToken;

use super::{TimedWindowCallback, WorkerError};
use crate::transcription::planner::WindowRange;
use crate::transcription::projection::{ProjectedWordResult, WordProjectionStatus};
use crate::transcription::staging::StagedWindowResult;

const LIVE_SPARSE_MIN_WINDOW_MS: i64 = 15_000;

pub(super) fn live_attempt_is_sparse(result: &StagedWindowResult) -> bool {
    let owned_duration_ms = result.window.duration_ms();
    let minimum_words =
        usize::try_from((owned_duration_ms / 1_000).cast_unsigned()).unwrap_or(usize::MAX);
    owned_duration_ms >= LIVE_SPARSE_MIN_WINDOW_MS && result.words.len() < minimum_words
}

pub(super) fn prefer_more_complete_live_attempt(
    first: StagedWindowResult,
    second: StagedWindowResult,
) -> StagedWindowResult {
    if second.words.len() > first.words.len() {
        second
    } else {
        first
    }
}

pub(super) async fn execute_live_window(
    client: &GeminiClient,
    wav_bytes: &[u8],
    window: &WindowRange,
    config: &AudioTranscriptionConfig,
    cancellation: &CancellationToken,
    on_timed_window: TimedWindowCallback,
) -> Result<StagedWindowResult, WorkerError> {
    let first = execute_live_window_once(
        client,
        wav_bytes,
        window,
        config,
        cancellation,
        Arc::clone(&on_timed_window),
        1,
    )
    .await?;
    if !live_attempt_is_sparse(&first) {
        return Ok(first);
    }

    crate::diagnostics::record(
        "transcribe.live.sparse_retry",
        &[
            ("window", window.index.to_string()),
            ("first_words", first.words.len().to_string()),
        ],
    );
    // The retry uses the same Live model and audio. Do not intermingle two stochastic attempts on
    // screen; publish the replacement atomically only when it is demonstrably more complete.
    let second = execute_live_window_once(
        client,
        wav_bytes,
        window,
        config,
        cancellation,
        Arc::new(|_| {}),
        2,
    )
    .await?;
    let selected = prefer_more_complete_live_attempt(first, second);
    on_timed_window(selected.clone());
    crate::diagnostics::record(
        "transcribe.live.sparse_retry_finished",
        &[
            ("window", window.index.to_string()),
            ("selected_words", selected.words.len().to_string()),
        ],
    );
    Ok(selected)
}

async fn execute_live_window_once(
    client: &GeminiClient,
    wav_bytes: &[u8],
    window: &WindowRange,
    config: &AudioTranscriptionConfig,
    cancellation: &CancellationToken,
    on_timed_window: TimedWindowCallback,
    attempt: u8,
) -> Result<StagedWindowResult, WorkerError> {
    let started = std::time::Instant::now();
    let mut finalized = Vec::new();
    let mut first_final_seen = false;
    let window_index = window.index;
    let audio_start_ms = window.context_start_ms;
    let window_duration_ms = (window.end_ms - audio_start_ms).cast_unsigned();
    crate::diagnostics::record(
        "transcribe.live.started",
        &[
            ("window", window_index.to_string()),
            ("attempt", attempt.to_string()),
        ],
    );
    client
        .transcribe_live(wav_bytes, &config.language_hints, cancellation, |event| {
            if event.text.trim().is_empty() {
                return;
            }
            if event.kind != LiveTranscriptionKind::Final {
                return;
            }
            let start_ms = event.start_ms.min(window_duration_ms.saturating_sub(1));
            let end_ms = event.end_ms.min(window_duration_ms).max(start_ms + 1);
            let owned_words = project_live_utterance(&event.text, start_ms, end_ms, audio_start_ms)
                .into_iter()
                .filter(|word| live_word_is_owned(word, window));
            finalized.extend(owned_words);
            if !first_final_seen {
                first_final_seen = true;
                crate::diagnostics::record(
                    "transcribe.live.first_final",
                    &[
                        ("window", window_index.to_string()),
                        ("elapsed_ms", started.elapsed().as_millis().to_string()),
                    ],
                );
            }
            on_timed_window(StagedWindowResult {
                window_index,
                window: WindowRange::new(window_index, window.start_ms, window.end_ms),
                words: finalized.clone(),
            });
        })
        .await?;
    crate::diagnostics::record(
        "transcribe.live.finished",
        &[
            ("window", window_index.to_string()),
            ("attempt", attempt.to_string()),
            ("finalized", finalized.len().to_string()),
            ("elapsed_ms", started.elapsed().as_millis().to_string()),
            (
                "outcome",
                if finalized.is_empty() { "empty" } else { "ok" }.to_owned(),
            ),
        ],
    );
    Ok(StagedWindowResult {
        window_index,
        window: *window,
        words: finalized,
    })
}

pub(super) fn live_word_is_owned(word: &ProjectedWordResult, window: &WindowRange) -> bool {
    let midpoint = word.project_start_ms + (word.project_end_ms - word.project_start_ms) / 2;
    midpoint >= window.start_ms && midpoint < window.end_ms
}

pub(super) fn project_live_utterance(
    text: &str,
    start_ms: u64,
    end_ms: u64,
    window_start_ms: i64,
) -> Vec<ProjectedWordResult> {
    let tokens = text.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return Vec::new();
    }
    let weights = tokens
        .iter()
        .map(|token| token.chars().count().max(1) as u64)
        .collect::<Vec<_>>();
    let total_weight = weights.iter().sum::<u64>().max(1);
    let duration = end_ms.saturating_sub(start_ms).max(tokens.len() as u64);
    let mut elapsed_weight = 0_u64;
    tokens
        .into_iter()
        .zip(weights)
        .map(|(token, weight)| {
            let token_start = start_ms + duration.saturating_mul(elapsed_weight) / total_weight;
            elapsed_weight += weight;
            let token_end = (start_ms + duration.saturating_mul(elapsed_weight) / total_weight)
                .max(token_start + 1)
                .min(end_ms);
            ProjectedWordResult {
                status: WordProjectionStatus::Interpolated,
                text: token.to_owned(),
                raw_start_ns: token_start.saturating_mul(1_000_000),
                raw_end_ns: token_end.saturating_mul(1_000_000),
                project_start_ms: window_start_ms + token_start.cast_signed(),
                project_end_ms: window_start_ms + token_end.cast_signed(),
                speaker_id: None,
                is_unaligned: true,
                alignment_status: "unaligned".to_owned(),
            }
        })
        .collect()
}
