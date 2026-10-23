//! Offline regrouping policies and the word-slicing algorithms behind them.

use serde::{Deserialize, Serialize};

use super::{
    AlignmentState, ManualEditState, ProjectedCue, ScriptSpacing, TimedWord, TranscriptError,
};
use crate::ids::CueId;

/// Local offline regrouping policies supported without network calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GroupingPolicy {
    /// Natural phrasing based on pause duration and sentence punctuation.
    Natural {
        /// Pause between words in milliseconds to trigger a split (default: 300 ms).
        pause_threshold_ms: u32,
        /// Maximum words per cue (default: 12).
        max_words: u32,
        /// Maximum characters per line/cue (default: 42).
        max_characters: u32,
    },
    /// Short subtitle chunks for rapid speech or mobile views.
    Short {
        /// Maximum words per cue (default: 5).
        max_words: u32,
        /// Maximum cue duration in milliseconds (default: 2,500 ms).
        max_duration_ms: i64,
    },
    /// Rapid dynamic captioning: exactly one word per cue.
    OneWord {
        /// Minimum duration in milliseconds to avoid zero-duration cues (default: 50 ms).
        min_duration_ms: i64,
    },
    /// User customized parameters via UI sliders.
    Custom(CustomGroupingConfig),
}

impl Default for GroupingPolicy {
    fn default() -> Self {
        Self::Natural {
            pause_threshold_ms: 300,
            max_words: 12,
            max_characters: 42,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomGroupingConfig {
    pub max_words: Option<u32>,
    pub max_characters: Option<u32>,
    pub max_duration_ms: Option<i64>,
    pub pause_threshold_ms: u32,
    pub split_on_punctuation: bool,
}

fn project_one_word(
    words: &[TimedWord],
    min_duration_ms: i64,
) -> Result<Vec<ProjectedCue>, TranscriptError> {
    let mut cues = Vec::with_capacity(words.len());
    for (idx, word) in words.iter().enumerate() {
        let start_ms = word.start_ms();
        let mut end_ms = word.end_ms();
        if end_ms <= start_ms {
            end_ms = start_ms + min_duration_ms.max(1);
        }
        cues.push(ProjectedCue {
            id: CueId::new(),
            ordinal: u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyCues)?,
            start_ms,
            end_ms,
            text: word.text().to_owned(),
            word_ids: vec![word.id()],
            manual_state: ManualEditState::Clean,
            alignment_state: AlignmentState::FullyAligned,
            source_span: None,
        });
    }
    Ok(cues)
}

fn project_natural(
    words: &[TimedWord],
    pause_threshold_ms: u32,
    max_words: u32,
    max_characters: u32,
    spacing: ScriptSpacing,
) -> Result<Vec<ProjectedCue>, TranscriptError> {
    let mut cues = Vec::new();
    let mut start_idx = 0;

    for (idx, word) in words.iter().enumerate() {
        let is_last = idx + 1 == words.len();
        let pause = words
            .get(idx + 1)
            .map_or(0, |next| (next.start_ms() - word.end_ms()).max(0));
        let word_count = u32::try_from(idx + 1 - start_idx).unwrap_or(u32::MAX);
        let current_text_len: usize = words[start_idx..=idx]
            .iter()
            .map(|w| w.text().chars().count())
            .sum::<usize>()
            + spacing.separator().chars().count() * (idx - start_idx);

        let is_sentence_end = ends_sentence(word.text());
        let exceeds_pause = pause >= i64::from(pause_threshold_ms);
        let exceeds_words = word_count >= max_words;
        let exceeds_chars = current_text_len >= max_characters as usize;

        if is_last || exceeds_pause || is_sentence_end || exceeds_words || exceeds_chars {
            cues.push(create_cue_from_slice(
                &words[start_idx..=idx],
                cues.len() + 1,
                spacing,
            )?);
            start_idx = idx + 1;
        }
    }
    Ok(cues)
}

fn project_short(
    words: &[TimedWord],
    max_words: u32,
    max_duration_ms: i64,
    spacing: ScriptSpacing,
) -> Result<Vec<ProjectedCue>, TranscriptError> {
    let mut cues = Vec::new();
    let mut start_idx = 0;
    let mut slice_max_end = i64::MIN;

    for (idx, word) in words.iter().enumerate() {
        let is_last = idx + 1 == words.len();
        let word_count = u32::try_from(idx + 1 - start_idx).unwrap_or(u32::MAX);
        slice_max_end = slice_max_end.max(word.end_ms());
        let duration = slice_max_end - words[start_idx].start_ms();

        if is_last || word_count >= max_words || duration >= max_duration_ms {
            cues.push(create_cue_from_slice(
                &words[start_idx..=idx],
                cues.len() + 1,
                spacing,
            )?);
            start_idx = idx + 1;
            slice_max_end = i64::MIN;
        }
    }
    Ok(cues)
}

fn project_custom(
    words: &[TimedWord],
    config: &CustomGroupingConfig,
    spacing: ScriptSpacing,
) -> Result<Vec<ProjectedCue>, TranscriptError> {
    let mut cues = Vec::new();
    let mut start_idx = 0;
    let mut slice_max_end = i64::MIN;

    for (idx, word) in words.iter().enumerate() {
        let is_last = idx + 1 == words.len();
        let pause = words
            .get(idx + 1)
            .map_or(0, |next| (next.start_ms() - word.end_ms()).max(0));
        let word_count = u32::try_from(idx + 1 - start_idx).unwrap_or(u32::MAX);
        slice_max_end = slice_max_end.max(word.end_ms());
        let duration = slice_max_end - words[start_idx].start_ms();
        let current_text_len: usize = words[start_idx..=idx]
            .iter()
            .map(|w| w.text().chars().count())
            .sum::<usize>()
            + spacing.separator().chars().count() * (idx - start_idx);

        let pause_hit = pause >= i64::from(config.pause_threshold_ms);
        let punct_hit = config.split_on_punctuation && ends_sentence(word.text());
        let words_hit = config.max_words.is_some_and(|m| word_count >= m);
        let chars_hit = config
            .max_characters
            .is_some_and(|m| current_text_len >= m as usize);
        let dur_hit = config.max_duration_ms.is_some_and(|d| duration >= d);

        if is_last || pause_hit || punct_hit || words_hit || chars_hit || dur_hit {
            cues.push(create_cue_from_slice(
                &words[start_idx..=idx],
                cues.len() + 1,
                spacing,
            )?);
            start_idx = idx + 1;
            slice_max_end = i64::MIN;
        }
    }
    Ok(cues)
}

pub(super) fn project_words(
    words: &[TimedWord],
    policy: &GroupingPolicy,
    spacing: ScriptSpacing,
) -> Result<Vec<ProjectedCue>, TranscriptError> {
    match policy {
        GroupingPolicy::OneWord { min_duration_ms } => project_one_word(words, *min_duration_ms),
        GroupingPolicy::Short {
            max_words,
            max_duration_ms,
        } => project_short(words, *max_words, *max_duration_ms, spacing),
        GroupingPolicy::Natural {
            pause_threshold_ms,
            max_words,
            max_characters,
        } => project_natural(
            words,
            *pause_threshold_ms,
            *max_words,
            *max_characters,
            spacing,
        ),
        GroupingPolicy::Custom(cfg) => project_custom(words, cfg, spacing),
    }
}

fn create_cue_from_slice(
    words: &[TimedWord],
    ordinal: usize,
    spacing: ScriptSpacing,
) -> Result<ProjectedCue, TranscriptError> {
    let start_ms = words[0].start_ms();
    let mut end_ms = words
        .iter()
        .map(TimedWord::end_ms)
        .max()
        .unwrap_or(start_ms);
    if end_ms <= start_ms {
        end_ms = start_ms + 50;
    }
    let text = words
        .iter()
        .map(TimedWord::text)
        .collect::<Vec<_>>()
        .join(spacing.separator());
    let word_ids = words.iter().map(TimedWord::id).collect();

    Ok(ProjectedCue {
        id: CueId::new(),
        ordinal: u32::try_from(ordinal).map_err(|_| TranscriptError::TooManyCues)?,
        start_ms,
        end_ms,
        text,
        word_ids,
        manual_state: ManualEditState::Clean,
        alignment_state: AlignmentState::FullyAligned,
        source_span: None,
    })
}

fn ends_sentence(text: &str) -> bool {
    text.trim_end().ends_with(['.', '?', '!', '。', '？', '！'])
}
