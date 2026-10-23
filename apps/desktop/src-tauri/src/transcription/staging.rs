use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

use osg_domain::{CueId, TranscriptRevisionId, TurnId, WordId};
use osg_infrastructure::storage::{TranscriptTurnRecord, TranscriptWordRecord};

use super::events::{ProjectedCueDto, TimedWordDto, TranscriptTurnDto};
use super::planner::WindowRange;
use super::projection::ProjectedWordResult;

const NATURAL_PAUSE_THRESHOLD_MS: i64 = 1_000;
const NATURAL_MAX_WORDS: usize = 12;
const NATURAL_MIN_SENTENCE_WORDS: usize = 4;
// Two conventional 42-character subtitle lines, not 42 characters for the entire cue.
const NATURAL_MAX_CHARACTERS: usize = 84;

fn ends_sentence(text: &str) -> bool {
    text.trim_end_matches(['\"', '\'', '”', '’', '»', ')', ']', '}'])
        .ends_with(['.', '!', '?', '…', '。', '！', '？'])
}

fn cue_character_count(words: &[(WordId, &ProjectedWordResult)], next: &str) -> usize {
    words
        .iter()
        .map(|(_, word)| word.text.chars().count())
        .sum::<usize>()
        + words.len()
        + next.chars().count()
}

#[derive(Debug, Clone)]
pub(crate) struct StagedWindowResult {
    pub(crate) window_index: usize,
    pub(crate) window: WindowRange,
    pub(crate) words: Vec<ProjectedWordResult>,
}

pub(crate) struct PromotedWindowData {
    pub(crate) word_records: Vec<TranscriptWordRecord>,
    pub(crate) turn_records: Vec<TranscriptTurnRecord>,
    pub(crate) word_dtos: Vec<TimedWordDto>,
    pub(crate) turn_dtos: Vec<TranscriptTurnDto>,
    pub(crate) projected_cues: Vec<ProjectedCueDto>,
}

pub(crate) struct StagingBuffer {
    staged: Mutex<BTreeMap<usize, StagedWindowResult>>,
    failed_indices: Mutex<BTreeSet<usize>>,
    next_promote_index: AtomicUsize,
    current_word_ordinal: AtomicU32,
    current_turn_ordinal: AtomicU32,
}

impl Default for StagingBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl StagingBuffer {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self {
            staged: Mutex::new(BTreeMap::new()),
            failed_indices: Mutex::new(BTreeSet::new()),
            next_promote_index: AtomicUsize::new(0),
            current_word_ordinal: AtomicU32::new(1),
            current_turn_ordinal: AtomicU32::new(1),
        }
    }

    pub(crate) fn insert(&self, result: StagedWindowResult) {
        let mut map = self.staged.lock().expect("staging lock poisoned");
        let failed = self
            .failed_indices
            .lock()
            .expect("failed_indices lock poisoned");
        if !failed.contains(&result.window_index) {
            map.insert(result.window_index, result);
        }
    }

    /// Pops the next sequentially promotable window, advancing `next_promote_index`
    /// past any failed windows so subsequent completed sister windows are never stranded.
    pub(crate) fn pop_promotable(&self) -> Option<StagedWindowResult> {
        let mut map = self.staged.lock().expect("staging lock poisoned");
        let failed = self
            .failed_indices
            .lock()
            .expect("failed_indices lock poisoned");

        loop {
            let next = self.next_promote_index.load(Ordering::Acquire);
            if failed.contains(&next) {
                // Window `next` failed permanently; advance pointer past it
                self.next_promote_index.fetch_add(1, Ordering::Release);
                continue;
            }

            if map.contains_key(&next) {
                let result = map.remove(&next)?;
                self.next_promote_index.fetch_add(1, Ordering::Release);
                return Some(result);
            }

            return None;
        }
    }

    #[cfg(test)]
    #[must_use]
    pub(crate) fn next_promote_index(&self) -> usize {
        self.next_promote_index.load(Ordering::Acquire)
    }

    /// Skips a window index if it permanently failed, registering it so `pop_promotable`
    /// can advance past it regardless of arrival order.
    pub(crate) fn skip_failed_window(&self, failed_index: usize) -> bool {
        let mut map = self.staged.lock().expect("staging lock poisoned");
        map.remove(&failed_index);
        let mut failed = self
            .failed_indices
            .lock()
            .expect("failed_indices lock poisoned");
        failed.insert(failed_index)
    }

    #[cfg(test)]
    #[must_use]
    pub(crate) fn is_window_failed(&self, index: usize) -> bool {
        self.failed_indices
            .lock()
            .expect("failed_indices lock poisoned")
            .contains(&index)
    }

    #[must_use]
    pub(crate) fn failed_indices_count(&self) -> usize {
        self.failed_indices
            .lock()
            .expect("failed_indices lock poisoned")
            .len()
    }

    /// Prepares `SQLite` records and frontend DTOs for a promotable window result.
    /// Contiguous 1-based canonical ordinals are guaranteed.
    #[allow(clippy::too_many_lines)]
    pub(crate) fn prepare_promotion(
        &self,
        revision_id: TranscriptRevisionId,
        staged: StagedWindowResult,
    ) -> PromotedWindowData {
        let mut valid_words: Vec<ProjectedWordResult> = staged
            .words
            .into_iter()
            .filter(ProjectedWordResult::is_valid_for_subtitles)
            .collect();

        // Sort chronologically within the window
        valid_words.sort_by_key(|w| (w.project_start_ms, w.project_end_ms));

        let mut word_records = Vec::with_capacity(valid_words.len());
        let mut word_dtos = Vec::with_capacity(valid_words.len());
        let mut turn_records = Vec::new();
        let mut turn_dtos = Vec::new();
        let mut projected_cues = Vec::new();

        if valid_words.is_empty() {
            return PromotedWindowData {
                word_records,
                turn_records,
                word_dtos,
                turn_dtos,
                projected_cues,
            };
        }

        // Group consecutive words by speaker into turns
        let mut current_turn_words: Vec<(WordId, u32, &ProjectedWordResult)> = Vec::new();
        let mut current_speaker: Option<String> = None;

        let flush_turn = |turn_words: &[(WordId, u32, &ProjectedWordResult)],
                          turn_records: &mut Vec<TranscriptTurnRecord>,
                          turn_dtos: &mut Vec<TranscriptTurnDto>| {
            if turn_words.is_empty() {
                return;
            }
            let turn_id = TurnId::new();
            let turn_ordinal = self.current_turn_ordinal.fetch_add(1, Ordering::Relaxed);
            let start_ms = turn_words.first().map_or(0, |(_, _, w)| w.project_start_ms);
            let end_ms = turn_words
                .last()
                .map_or(start_ms, |(_, _, w)| w.project_end_ms);
            let speaker_id = turn_words
                .first()
                .and_then(|(_, _, w)| w.speaker_id.clone())
                .unwrap_or_else(|| format!("w{}:speaker_0", staged.window_index));
            let text = turn_words
                .iter()
                .map(|(_, _, w)| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let start_word_ordinal = turn_words.first().map_or(1, |(_, ord, _)| *ord);
            let end_word_ordinal = turn_words
                .last()
                .map_or(start_word_ordinal, |(_, ord, _)| *ord);

            turn_records.push(TranscriptTurnRecord {
                id: turn_id,
                revision_id,
                ordinal: turn_ordinal,
                speaker_id: speaker_id.clone(),
                start_ms,
                end_ms,
                text: text.clone(),
                start_word_ordinal,
                end_word_ordinal,
                metadata_json: "{}".to_owned(),
            });

            turn_dtos.push(TranscriptTurnDto {
                id: turn_id,
                revision_id,
                ordinal: turn_ordinal,
                speaker_id,
                start_ms,
                end_ms,
                text,
                start_word_ordinal,
                end_word_ordinal,
            });
        };

        // Group into readable subtitle phrases. A one-second threshold preserves normal
        // intra-sentence hesitation; only a substantial pause or sufficiently complete sentence
        // starts a new phrase, while size limits still keep every cue readable.
        let mut current_cue_words: Vec<(WordId, &ProjectedWordResult)> = Vec::new();

        let flush_cue = |cue_words: &[(WordId, &ProjectedWordResult)],
                         projected_cues: &mut Vec<ProjectedCueDto>| {
            if cue_words.is_empty() {
                return;
            }
            let cue_id = CueId::new();
            let start_ms = cue_words.first().map_or(0, |(_, w)| w.project_start_ms);
            let end_ms = cue_words.last().map_or(start_ms, |(_, w)| w.project_end_ms);
            let speaker_id = cue_words.first().and_then(|(_, w)| w.speaker_id.clone());
            let text = cue_words
                .iter()
                .map(|(_, w)| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let word_ids = cue_words.iter().map(|(id, _)| *id).collect();

            projected_cues.push(ProjectedCueDto {
                id: cue_id,
                start_ms,
                end_ms,
                text,
                speaker_id,
                word_ids,
            });
        };

        for word in &valid_words {
            let word_id = WordId::new();
            let ordinal = self.current_word_ordinal.fetch_add(1, Ordering::Relaxed);
            let interpolated = matches!(
                word.status,
                super::projection::WordProjectionStatus::Interpolated
            );
            let provenance = if interpolated {
                "interpolated"
            } else {
                "provider"
            };
            let metadata_json = if interpolated {
                r#"{"timing":"utterance_interpolated"}"#
            } else {
                "{}"
            };

            word_records.push(TranscriptWordRecord {
                id: word_id,
                revision_id,
                turn_id: None, // Will be linked if needed
                ordinal,
                text: word.text.clone(),
                raw_start_ns: word.raw_start_ns,
                raw_end_ns: word.raw_end_ns,
                start_ms: word.project_start_ms,
                end_ms: word.project_end_ms,
                speaker_id: word.speaker_id.clone(),
                confidence: None, // This provider response does not supply confidence.
                is_unaligned: word.is_unaligned,
                alignment_status: word.alignment_status.clone(),
                provenance: provenance.to_owned(),
                metadata_json: metadata_json.to_owned(),
            });

            word_dtos.push(TimedWordDto {
                id: word_id,
                revision_id,
                ordinal,
                text: word.text.clone(),
                start_ms: word.project_start_ms,
                end_ms: word.project_end_ms,
                speaker_id: word.speaker_id.clone(),
                confidence: None,
                provenance: provenance.to_owned(),
                alignment_status: word.alignment_status.clone(),
            });

            // Turn chunking
            let speaker_changed = current_speaker != word.speaker_id;
            if speaker_changed && !current_turn_words.is_empty() {
                flush_turn(&current_turn_words, &mut turn_records, &mut turn_dtos);
                current_turn_words.clear();
            }
            current_speaker.clone_from(&word.speaker_id);
            current_turn_words.push((word_id, ordinal, word));

            // Never label two speakers as one cue, even when their speech is contiguous.
            // Keep the existing pause and size bounds for ordinary grouped subtitles.
            let pause_split = current_cue_words.last().is_some_and(|(_, prev)| {
                word.project_start_ms.saturating_sub(prev.project_end_ms)
                    >= NATURAL_PAUSE_THRESHOLD_MS
            });
            let sentence_split = current_cue_words
                .last()
                .is_some_and(|(_, previous)| ends_sentence(&previous.text));
            let size_split = current_cue_words.len() >= NATURAL_MAX_WORDS
                || cue_character_count(&current_cue_words, &word.text) > NATURAL_MAX_CHARACTERS;
            // Live Transcribe may finalize very short clauses aggressively. Punctuation alone is
            // not enough to freeze a one- or two-word subtitle; keep that provisional tail open.
            let phrase_split = (current_cue_words.len() >= 2 && pause_split)
                || (current_cue_words.len() >= NATURAL_MIN_SENTENCE_WORDS && sentence_split);
            if (speaker_changed || phrase_split || size_split) && !current_cue_words.is_empty() {
                flush_cue(&current_cue_words, &mut projected_cues);
                current_cue_words.clear();
            }
            current_cue_words.push((word_id, word));
        }

        flush_turn(&current_turn_words, &mut turn_records, &mut turn_dtos);
        flush_cue(&current_cue_words, &mut projected_cues);

        PromotedWindowData {
            word_records,
            turn_records,
            word_dtos,
            turn_dtos,
            projected_cues,
        }
    }
}

#[cfg(test)]
mod tests;
