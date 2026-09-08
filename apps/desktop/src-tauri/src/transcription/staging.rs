use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Mutex;

use osg_domain::{CueId, TranscriptRevisionId, TurnId, WordId};
use osg_infrastructure::storage::{TranscriptTurnRecord, TranscriptWordRecord};

use super::events::{ProjectedCueDto, TimedWordDto, TranscriptTurnDto};
use super::planner::WindowRange;
use super::projection::ProjectedWordResult;

const NATURAL_PAUSE_THRESHOLD_MS: i64 = 1_000;
const NATURAL_MAX_WORDS: usize = 12;
// Two conventional 42-character subtitle lines, not 42 characters for the entire cue.
const NATURAL_MAX_CHARACTERS: usize = 84;

fn ends_sentence(text: &str) -> bool {
    text.trim_end_matches(['\"', '\'', '”', '’', '»', ')', ']', '}'])
        .ends_with(['.', '!', '?', '…', '。', '！', '？'])
}

fn cue_character_count(words: &[(WordId, &ProjectedWordResult)], next: &str) -> usize {
    words.iter().map(|(_, word)| word.text.chars().count()).sum::<usize>()
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
    #[allow(dead_code)]
    pub(crate) window_index: usize,
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
        let failed = self.failed_indices.lock().expect("failed_indices lock poisoned");
        if !failed.contains(&result.window_index) {
            map.insert(result.window_index, result);
        }
    }

    /// Pops the next sequentially promotable window, advancing `next_promote_index`
    /// past any failed windows so subsequent completed sister windows are never stranded.
    pub(crate) fn pop_promotable(&self) -> Option<StagedWindowResult> {
        let mut map = self.staged.lock().expect("staging lock poisoned");
        let failed = self.failed_indices.lock().expect("failed_indices lock poisoned");

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

    #[allow(dead_code)]
    #[must_use]
    pub(crate) fn next_promote_index(&self) -> usize {
        self.next_promote_index.load(Ordering::Acquire)
    }

    /// Skips a window index if it permanently failed, registering it so `pop_promotable`
    /// can advance past it regardless of arrival order.
    pub(crate) fn skip_failed_window(&self, failed_index: usize) -> bool {
        let mut map = self.staged.lock().expect("staging lock poisoned");
        map.remove(&failed_index);
        let mut failed = self.failed_indices.lock().expect("failed_indices lock poisoned");
        failed.insert(failed_index)
    }

    #[allow(dead_code)]
    #[must_use]
    pub(crate) fn is_window_failed(&self, index: usize) -> bool {
        self.failed_indices
            .lock()
            .expect("failed_indices lock poisoned")
            .contains(&index)
    }

    #[allow(dead_code)]
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
                window_index: staged.window_index,
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
            let end_ms = turn_words.last().map_or(start_ms, |(_, _, w)| w.project_end_ms);
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
            let end_word_ordinal = turn_words.last().map_or(start_word_ordinal, |(_, ord, _)| *ord);

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

        // Group into readable subtitle phrases. A 300 ms threshold split normal intra-sentence
        // hesitations into one-word cues; only a substantial pause or sentence boundary starts a
        // new phrase, while size limits still keep every cue readable.
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
            let interpolated = matches!(word.status, super::projection::WordProjectionStatus::Interpolated);
            let provenance = if interpolated { "interpolated" } else { "provider" };
            let metadata_json = if interpolated { r#"{"timing":"utterance_interpolated"}"# } else { "{}" };

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
                word.project_start_ms.saturating_sub(prev.project_end_ms) >= NATURAL_PAUSE_THRESHOLD_MS
            });
            let sentence_split = current_cue_words.last()
                .is_some_and(|(_, previous)| ends_sentence(&previous.text));
            let size_split = current_cue_words.len() >= NATURAL_MAX_WORDS
                || cue_character_count(&current_cue_words, &word.text) > NATURAL_MAX_CHARACTERS;
            let phrase_split = current_cue_words.len() >= 2 && (pause_split || sentence_split);
            if (speaker_changed || phrase_split || size_split) && !current_cue_words.is_empty() {
                flush_cue(&current_cue_words, &mut projected_cues);
                current_cue_words.clear();
            }
            current_cue_words.push((word_id, word));
        }

        flush_turn(&current_turn_words, &mut turn_records, &mut turn_dtos);
        flush_cue(&current_cue_words, &mut projected_cues);

        PromotedWindowData {
            window_index: staged.window_index,
            word_records,
            turn_records,
            word_dtos,
            turn_dtos,
            projected_cues,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcription::projection::WordProjectionStatus;

    #[test]
    fn test_staging_head_of_line_sequencing() {
        let staging = StagingBuffer::new();

        let win0 = StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 60_000),
            words: vec![ProjectedWordResult {
                status: WordProjectionStatus::Accepted,
                text: "hello".to_owned(),
                raw_start_ns: 0,
                raw_end_ns: 500_000_000,
                project_start_ms: 0,
                project_end_ms: 500,
                speaker_id: Some("w0:1".to_owned()),
                is_unaligned: false,
                alignment_status: "aligned".to_owned(),
            }],
        };

        let win1 = StagedWindowResult {
            window_index: 1,
            window: WindowRange::new(1, 60_000, 120_000),
            words: vec![ProjectedWordResult {
                status: WordProjectionStatus::Accepted,
                text: "world".to_owned(),
                raw_start_ns: 0,
                raw_end_ns: 500_000_000,
                project_start_ms: 60_000,
                project_end_ms: 60_500,
                speaker_id: Some("w1:1".to_owned()),
                is_unaligned: false,
                alignment_status: "aligned".to_owned(),
            }],
        };

        // Window 1 arrives first (out-of-order)
        staging.insert(win1);
        assert!(staging.pop_promotable().is_none());

        // Window 0 arrives
        staging.insert(win0);

        // Window 0 popped first
        let popped0 = staging.pop_promotable().unwrap();
        assert_eq!(popped0.window_index, 0);

        // Window 1 popped next
        let popped1 = staging.pop_promotable().unwrap();
        assert_eq!(popped1.window_index, 1);

        assert!(staging.pop_promotable().is_none());
    }

    #[test]
    fn test_monotonic_ordinals_across_windows() {
        let staging = StagingBuffer::new();
        let rev_id = TranscriptRevisionId::new();

        let win0 = StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 60_000),
            words: vec![
                ProjectedWordResult {
                    status: WordProjectionStatus::Accepted,
                    text: "word1".to_owned(),
                    raw_start_ns: 0,
                    raw_end_ns: 500_000_000,
                    project_start_ms: 0,
                    project_end_ms: 500,
                    speaker_id: None,
                    is_unaligned: false,
                    alignment_status: "aligned".to_owned(),
                },
                ProjectedWordResult {
                    status: WordProjectionStatus::Accepted,
                    text: "word2".to_owned(),
                    raw_start_ns: 500_000_000,
                    raw_end_ns: 1_000_000_000,
                    project_start_ms: 500,
                    project_end_ms: 1000,
                    speaker_id: None,
                    is_unaligned: false,
                    alignment_status: "aligned".to_owned(),
                },
            ],
        };

        let win1 = StagedWindowResult {
            window_index: 1,
            window: WindowRange::new(1, 60_000, 120_000),
            words: vec![ProjectedWordResult {
                status: WordProjectionStatus::Accepted,
                text: "word3".to_owned(),
                raw_start_ns: 0,
                raw_end_ns: 500_000_000,
                project_start_ms: 60_000,
                project_end_ms: 60_500,
                speaker_id: None,
                is_unaligned: false,
                alignment_status: "aligned".to_owned(),
            }],
        };

        let data0 = staging.prepare_promotion(rev_id, win0);
        assert_eq!(data0.word_records[0].ordinal, 1);
        assert_eq!(data0.word_records[1].ordinal, 2);

        let data1 = staging.prepare_promotion(rev_id, win1);
        assert_eq!(data1.word_records[0].ordinal, 3);
    }

    #[test]
    fn test_stress_out_of_order_window_completions_3_1_0_2() {
        let staging = StagingBuffer::new();
        let rev_id = TranscriptRevisionId::new();

        let make_word = |text: &str, start_ms: i64, end_ms: i64| ProjectedWordResult {
            status: WordProjectionStatus::Accepted,
            text: text.to_owned(),
            raw_start_ns: (start_ms * 1_000_000).cast_unsigned(),
            raw_end_ns: (end_ms * 1_000_000).cast_unsigned(),
            project_start_ms: start_ms,
            project_end_ms: end_ms,
            speaker_id: Some("speaker_0".to_owned()),
            is_unaligned: false,
            alignment_status: "aligned".to_owned(),
        };

        // Window 0: 3 words
        let win0 = StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 60_000),
            words: vec![
                make_word("the", 0, 500),
                make_word("quick", 500, 1000),
                make_word("brown", 1000, 1500),
            ],
        };

        // Window 1: 2 words
        let win1 = StagedWindowResult {
            window_index: 1,
            window: WindowRange::new(1, 60_000, 120_000),
            words: vec![
                make_word("fox", 60_000, 60_500),
                make_word("jumps", 60_500, 61_000),
            ],
        };

        // Window 2: 4 words
        let win2 = StagedWindowResult {
            window_index: 2,
            window: WindowRange::new(2, 120_000, 180_000),
            words: vec![
                make_word("over", 120_000, 120_500),
                make_word("the", 120_500, 121_000),
                make_word("lazy", 121_000, 121_500),
                make_word("dog", 121_500, 122_000),
            ],
        };

        // Window 3: 1 word
        let win3 = StagedWindowResult {
            window_index: 3,
            window: WindowRange::new(3, 180_000, 240_000),
            words: vec![make_word("again", 180_000, 180_500)],
        };

        // Arrival sequence: 3, 1, 0, 2
        staging.insert(win3);
        assert!(staging.pop_promotable().is_none());

        staging.insert(win1);
        assert!(staging.pop_promotable().is_none());

        staging.insert(win0);
        // Window 0 should be popped first
        let popped0 = staging.pop_promotable().expect("window 0 ready");
        assert_eq!(popped0.window_index, 0);
        let data0 = staging.prepare_promotion(rev_id, popped0);
        assert_eq!(data0.word_records.len(), 3);
        assert_eq!(data0.word_records[0].ordinal, 1);
        assert_eq!(data0.word_records[1].ordinal, 2);
        assert_eq!(data0.word_records[2].ordinal, 3);

        // Window 1 should be popped next
        let popped1 = staging.pop_promotable().expect("window 1 ready");
        assert_eq!(popped1.window_index, 1);
        let data1 = staging.prepare_promotion(rev_id, popped1);
        assert_eq!(data1.word_records.len(), 2);
        assert_eq!(data1.word_records[0].ordinal, 4);
        assert_eq!(data1.word_records[1].ordinal, 5);

        // Window 2 hasn't arrived yet, so pop_promotable must return None even though window 3 is in buffer
        assert!(staging.pop_promotable().is_none());

        // Now Window 2 arrives
        staging.insert(win2);

        // Window 2 popped
        let popped2 = staging.pop_promotable().expect("window 2 ready");
        assert_eq!(popped2.window_index, 2);
        let data2 = staging.prepare_promotion(rev_id, popped2);
        assert_eq!(data2.word_records.len(), 4);
        assert_eq!(data2.word_records[0].ordinal, 6);
        assert_eq!(data2.word_records[1].ordinal, 7);
        assert_eq!(data2.word_records[2].ordinal, 8);
        assert_eq!(data2.word_records[3].ordinal, 9);

        // Window 3 popped
        let popped3 = staging.pop_promotable().expect("window 3 ready");
        assert_eq!(popped3.window_index, 3);
        let data3 = staging.prepare_promotion(rev_id, popped3);
        assert_eq!(data3.word_records.len(), 1);
        assert_eq!(data3.word_records[0].ordinal, 10);

        // Buffer is completely drained
        assert!(staging.pop_promotable().is_none());

        // Collect all ordinals and verify strictly contiguous 1..10
        let mut all_ordinals: Vec<u32> = Vec::new();
        for data in [&data0, &data1, &data2, &data3] {
            for record in &data.word_records {
                all_ordinals.push(record.ordinal);
            }
        }
        assert_eq!(all_ordinals, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }

    #[test]
    fn test_stress_empty_windows_interleaved_out_of_order() {
        let staging = StagingBuffer::new();
        let rev_id = TranscriptRevisionId::new();

        let make_word = |text: &str, start_ms: i64, end_ms: i64| ProjectedWordResult {
            status: WordProjectionStatus::Accepted,
            text: text.to_owned(),
            raw_start_ns: (start_ms * 1_000_000).cast_unsigned(),
            raw_end_ns: (end_ms * 1_000_000).cast_unsigned(),
            project_start_ms: start_ms,
            project_end_ms: end_ms,
            speaker_id: None,
            is_unaligned: false,
            alignment_status: "aligned".to_owned(),
        };

        // Window 0: 2 words
        let win0 = StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 60_000),
            words: vec![make_word("w0_a", 0, 500), make_word("w0_b", 500, 1000)],
        };

        // Window 1: EMPTY (0 words)
        let win1 = StagedWindowResult {
            window_index: 1,
            window: WindowRange::new(1, 60_000, 120_000),
            words: vec![],
        };

        // Window 2: 3 words
        let win2 = StagedWindowResult {
            window_index: 2,
            window: WindowRange::new(2, 120_000, 180_000),
            words: vec![
                make_word("w2_a", 120_000, 120_500),
                make_word("w2_b", 120_500, 121_000),
                make_word("w2_c", 121_000, 121_500),
            ],
        };

        // Window 3: EMPTY (0 words)
        let win3 = StagedWindowResult {
            window_index: 3,
            window: WindowRange::new(3, 180_000, 240_000),
            words: vec![],
        };

        // Window 4: 1 word
        let win4 = StagedWindowResult {
            window_index: 4,
            window: WindowRange::new(4, 240_000, 300_000),
            words: vec![make_word("w4_a", 240_000, 240_500)],
        };

        // Arrival order: 3, 1, 4, 0, 2
        staging.insert(win3);
        staging.insert(win1);
        staging.insert(win4);
        assert!(staging.pop_promotable().is_none());

        staging.insert(win0);
        let p0 = staging.pop_promotable().unwrap();
        assert_eq!(p0.window_index, 0);
        let d0 = staging.prepare_promotion(rev_id, p0);
        assert_eq!(d0.word_records.len(), 2);
        assert_eq!(d0.word_records[0].ordinal, 1);
        assert_eq!(d0.word_records[1].ordinal, 2);

        // Window 1 was already inserted, so it pops immediately
        let p1 = staging.pop_promotable().unwrap();
        assert_eq!(p1.window_index, 1);
        let d1 = staging.prepare_promotion(rev_id, p1);
        assert!(d1.word_records.is_empty());

        // Window 2 not yet inserted, pop returns None
        assert!(staging.pop_promotable().is_none());

        staging.insert(win2);
        let p2 = staging.pop_promotable().unwrap();
        assert_eq!(p2.window_index, 2);
        let d2 = staging.prepare_promotion(rev_id, p2);
        assert_eq!(d2.word_records.len(), 3);
        assert_eq!(d2.word_records[0].ordinal, 3);
        assert_eq!(d2.word_records[1].ordinal, 4);
        assert_eq!(d2.word_records[2].ordinal, 5);

        // Window 3 pops immediately (empty)
        let p3 = staging.pop_promotable().unwrap();
        assert_eq!(p3.window_index, 3);
        let d3 = staging.prepare_promotion(rev_id, p3);
        assert!(d3.word_records.is_empty());

        // Window 4 pops immediately
        let p4 = staging.pop_promotable().unwrap();
        assert_eq!(p4.window_index, 4);
        let d4 = staging.prepare_promotion(rev_id, p4);
        assert_eq!(d4.word_records.len(), 1);
        assert_eq!(d4.word_records[0].ordinal, 6);

        let mut ordinals = Vec::new();
        for d in [&d0, &d1, &d2, &d3, &d4] {
            for r in &d.word_records {
                ordinals.push(r.ordinal);
            }
        }
        // Strictly contiguous 1..6 despite empty windows
        assert_eq!(ordinals, vec![1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn test_skip_failed_window_out_of_order_promotes_subsequent() {
        let staging = StagingBuffer::new();

        // Window 0 is actively processing (next_promote_index is 0).
        assert_eq!(staging.next_promote_index(), 0);

        // Window 1 fails out-of-order in parallel worker:
        let skipped = staging.skip_failed_window(1);
        assert!(skipped, "skip_failed_window(1) must return true and register failure");
        assert!(staging.is_window_failed(1));

        // next_promote_index remains 0 because Window 0 hasn't completed or failed yet
        assert_eq!(staging.next_promote_index(), 0);

        // Window 0 arrives
        let win0 = StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 60_000),
            words: vec![],
        };
        staging.insert(win0);

        // Window 2 arrives (completed sister window)
        let win2 = StagedWindowResult {
            window_index: 2,
            window: WindowRange::new(2, 120_000, 180_000),
            words: vec![],
        };
        staging.insert(win2);

        // Window 0 is popped
        let popped0 = staging.pop_promotable().expect("window 0 popped");
        assert_eq!(popped0.window_index, 0);

        // Now pop_promotable() is called:
        // Staging buffer encounters failed window 1, automatically advances
        // next_promote_index past 1, and immediately returns window 2!
        let popped2 = staging.pop_promotable().expect("window 2 popped past failed window 1");
        assert_eq!(popped2.window_index, 2);

        // Staging buffer is now drained
        assert!(staging.pop_promotable().is_none());
        assert_eq!(staging.next_promote_index(), 3);
    }

    #[test]
    fn test_skip_failed_window_multiple_out_of_order_contiguous_ordinals() {
        let staging = StagingBuffer::new();
        let rev_id = TranscriptRevisionId::new();

        let make_word = |text: &str, start_ms: i64, end_ms: i64| ProjectedWordResult {
            status: WordProjectionStatus::Accepted,
            text: text.to_owned(),
            raw_start_ns: (start_ms * 1_000_000).cast_unsigned(),
            raw_end_ns: (end_ms * 1_000_000).cast_unsigned(),
            project_start_ms: start_ms,
            project_end_ms: end_ms,
            speaker_id: None,
            is_unaligned: false,
            alignment_status: "aligned".to_owned(),
        };

        let win0 = StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 60_000),
            words: vec![make_word("first", 0, 500)],
        };
        let win2 = StagedWindowResult {
            window_index: 2,
            window: WindowRange::new(2, 120_000, 180_000),
            words: vec![make_word("second", 120_000, 120_500)],
        };
        let win4 = StagedWindowResult {
            window_index: 4,
            window: WindowRange::new(4, 240_000, 300_000),
            words: vec![make_word("third", 240_000, 240_500)],
        };

        // Out-of-order failures: window 3 fails first, then window 1 fails
        assert!(staging.skip_failed_window(3));
        assert!(staging.skip_failed_window(1));

        // Completions arrive in scrambled order: 4, 0, 2
        staging.insert(win4);
        staging.insert(win0);
        staging.insert(win2);

        // Popping order must strictly be 0, 2, 4
        let p0 = staging.pop_promotable().expect("window 0 ready");
        assert_eq!(p0.window_index, 0);
        let d0 = staging.prepare_promotion(rev_id, p0);
        assert_eq!(d0.word_records[0].ordinal, 1);

        let p2 = staging.pop_promotable().expect("window 2 ready past failed 1");
        assert_eq!(p2.window_index, 2);
        let d2 = staging.prepare_promotion(rev_id, p2);
        assert_eq!(d2.word_records[0].ordinal, 2);

        let p4 = staging.pop_promotable().expect("window 4 ready past failed 3");
        assert_eq!(p4.window_index, 4);
        let d4 = staging.prepare_promotion(rev_id, p4);
        assert_eq!(d4.word_records[0].ordinal, 3);

        assert!(staging.pop_promotable().is_none());
        assert_eq!(staging.next_promote_index(), 5);
        assert_eq!(staging.failed_indices_count(), 2);
    }

    #[test]
    fn test_skip_failed_window_head_of_line_failure() {
        let staging = StagingBuffer::new();

        let win1 = StagedWindowResult {
            window_index: 1,
            window: WindowRange::new(1, 60_000, 120_000),
            words: vec![],
        };

        // Window 0 permanently fails
        assert!(staging.skip_failed_window(0));

        // Window 1 arrives
        staging.insert(win1);

        // pop_promotable advances past 0 and returns Window 1
        let popped = staging.pop_promotable().expect("window 1 ready past failed window 0");
        assert_eq!(popped.window_index, 1);
        assert_eq!(staging.next_promote_index(), 2);
        assert!(staging.pop_promotable().is_none());
    }

    fn make_test_word(text: &str, start_ms: i64, end_ms: i64) -> ProjectedWordResult {
        ProjectedWordResult {
            status: WordProjectionStatus::Accepted,
            text: text.to_owned(),
            raw_start_ns: (start_ms * 1_000_000).cast_unsigned(),
            raw_end_ns: (end_ms * 1_000_000).cast_unsigned(),
            project_start_ms: start_ms,
            project_end_ms: end_ms,
            speaker_id: Some("speaker_0".to_owned()),
            is_unaligned: false,
            alignment_status: "aligned".to_owned(),
        }
    }

    #[test]
    fn adjacent_speakers_produce_separate_cues_without_invented_confidence() {
        let staging = StagingBuffer::new();
        let first = make_test_word("Hello", 0, 500);
        let mut second = make_test_word("Goodbye", 500, 1000);
        second.speaker_id = Some("speaker_1".to_owned());
        let mut unknown = make_test_word("Unidentified", 1000, 1500);
        unknown.speaker_id = None;
        let promoted = staging.prepare_promotion(
            TranscriptRevisionId::new(),
            StagedWindowResult {
                window_index: 0,
                window: WindowRange::new(0, 0, 60_000),
                words: vec![first, second, unknown],
            },
        );
        assert_eq!(promoted.projected_cues.len(), 3);
        for (cue, (text, speaker, start)) in promoted.projected_cues.iter().zip([
            ("Hello", Some("speaker_0"), 0),
            ("Goodbye", Some("speaker_1"), 500),
            ("Unidentified", None, 1000),
        ]) {
            assert_eq!(cue.text, text);
            assert_eq!(cue.speaker_id.as_deref(), speaker);
            assert_eq!(cue.start_ms, start);
            assert_eq!(cue.end_ms, start + 500);
            assert_eq!(cue.word_ids.len(), 1);
        }
        assert!(promoted.word_records.iter().all(|word| word.confidence.is_none()));
        assert!(promoted.word_dtos.iter().all(|word| word.confidence.is_none()));
    }

    #[test]
    fn natural_grouping_ignores_brief_hesitation_but_splits_a_substantial_pause() {
        let promoted = StagingBuffer::new().prepare_promotion(
            TranscriptRevisionId::new(),
            StagedWindowResult {
                window_index: 0,
                window: WindowRange::new(0, 0, 60_000),
                words: vec![
                    make_test_word("Hello", 0, 500),
                    make_test_word("there", 500, 1000),
                    make_test_word("Again", 1300, 1800),
                    make_test_word("later", 2800, 3200),
                ],
            },
        );
        assert_eq!(promoted.projected_cues.len(), 2);
        assert_eq!(promoted.projected_cues[0].text, "Hello there Again");
        assert_eq!(promoted.projected_cues[0].word_ids.len(), 3);
        assert_eq!(promoted.projected_cues[1].text, "later");
    }

    #[test]
    #[allow(clippy::too_many_lines)]
    fn thousands_of_live_interpolated_words_promote_into_sqlite() {
        use osg_domain::ProjectMetadata;
        use osg_infrastructure::storage::{Database, TranscriptRevisionRecord};
        use tempfile::tempdir;

        let directory = tempdir().unwrap();
        let database = Database::open(directory.path().join("live-promotion.db")).unwrap();
        let project = ProjectMetadata::new("Live promotion").unwrap();
        database.create_project(&project).unwrap();
        let revision_id = TranscriptRevisionId::new();
        database.transcript_insert_revision(&TranscriptRevisionRecord {
            id: revision_id,
            project_id: project.id(),
            media_id: None,
            provider: "gemini".to_owned(),
            model: "gemini-3.5-transcribe-live".to_owned(),
            source_range_start_ms: 0,
            source_range_end_ms: 600_000,
            state: "in_progress".to_owned(),
            fingerprint: "live-promotion".to_owned(),
            word_count: 0,
            metadata_json: "{}".to_owned(),
            created_at_ms: 1,
            updated_at_ms: 1,
        }).unwrap();
        let words = (0_i64..3_500).map(|index| ProjectedWordResult {
            status: WordProjectionStatus::Interpolated,
            text: format!("w{index}"),
            raw_start_ns: (index * 100_000_000).cast_unsigned(),
            raw_end_ns: (index * 100_000_000 + 90_000_000).cast_unsigned(),
            project_start_ms: index * 100,
            project_end_ms: index * 100 + 90,
            speaker_id: None,
            is_unaligned: true,
            alignment_status: "unaligned".to_owned(),
        }).collect();
        let promoted = StagingBuffer::new().prepare_promotion(revision_id, StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 600_000),
            words,
        });
        assert!(promoted.word_records.iter().all(|word| {
            word.alignment_status == "unaligned"
                && word.provenance == "interpolated"
                && word.metadata_json == r#"{"timing":"utterance_interpolated"}"#
        }));
        database.transcript_promote_window(
            revision_id, &promoted.turn_records, &promoted.word_records,
        ).unwrap();
        assert_eq!(database.transcript_get_revision(revision_id).unwrap().unwrap().word_count, 3_500);
    }

    fn generate_permutations(items: &[usize]) -> Vec<Vec<usize>> {
        fn permute(k: usize, arr: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
            if k == 1 {
                out.push(arr.clone());
                return;
            }
            for i in 0..k {
                permute(k - 1, arr, out);
                if k % 2 == 1 {
                    arr.swap(0, k - 1);
                } else {
                    arr.swap(i, k - 1);
                }
            }
        }
        let mut out = Vec::new();
        let mut arr = items.to_vec();
        permute(items.len(), &mut arr, &mut out);
        out
    }

    #[test]
    fn test_adversarial_all_24_permutations_windows_1_and_3_fail_0_and_2_succeed() {
        let rev_id = TranscriptRevisionId::new();

        let create_win0 = || StagedWindowResult {
            window_index: 0,
            window: WindowRange::new(0, 0, 60_000),
            words: vec![
                make_test_word("w0_a", 0, 500),
                make_test_word("w0_b", 500, 1000),
                make_test_word("w0_c", 1000, 1500),
            ],
        };
        let create_win2 = || StagedWindowResult {
            window_index: 2,
            window: WindowRange::new(2, 120_000, 180_000),
            words: vec![
                make_test_word("w2_a", 120_000, 120_500),
                make_test_word("w2_b", 120_500, 121_000),
            ],
        };

        let permutations = generate_permutations(&[0, 1, 2, 3]);
        assert_eq!(permutations.len(), 24);

        // Test Phase A: Batch drain after all events are processed in each permutation
        for perm in &permutations {
            let staging = StagingBuffer::new();
            for &event in perm {
                match event {
                    0 => staging.insert(create_win0()),
                    1 => { staging.skip_failed_window(1); }
                    2 => staging.insert(create_win2()),
                    3 => { staging.skip_failed_window(3); }
                    _ => unreachable!(),
                }
            }

            let mut popped = Vec::new();
            while let Some(w) = staging.pop_promotable() {
                popped.push(w);
            }

            assert_eq!(popped.len(), 2, "Permutation {perm:?} must yield exactly 2 windows");
            assert_eq!(popped[0].window_index, 0, "Window 0 must be first in {perm:?}");
            assert_eq!(popped[1].window_index, 2, "Window 2 must be second in {perm:?}");

            let d0 = staging.prepare_promotion(rev_id, popped.remove(0));
            let d2 = staging.prepare_promotion(rev_id, popped.remove(0));

            assert_eq!(d0.word_records.len(), 3);
            assert_eq!(d0.word_records.iter().map(|w| w.ordinal).collect::<Vec<_>>(), vec![1, 2, 3]);

            assert_eq!(d2.word_records.len(), 2);
            assert_eq!(d2.word_records.iter().map(|w| w.ordinal).collect::<Vec<_>>(), vec![4, 5]);

            let all_ordinals: Vec<u32> = d0.word_records.iter().chain(d2.word_records.iter()).map(|w| w.ordinal).collect();
            assert_eq!(all_ordinals, vec![1, 2, 3, 4, 5], "Ordinals must be contiguous 1..5 in {perm:?}");

            assert_eq!(staging.next_promote_index(), 4);
            assert_eq!(staging.failed_indices_count(), 2);
            assert!(staging.is_window_failed(1));
            assert!(staging.is_window_failed(3));
        }

        // Test Phase B: Interleaved drain between events in each permutation
        for perm in &permutations {
            let staging = StagingBuffer::new();
            let mut popped = Vec::new();

            for &event in perm {
                match event {
                    0 => staging.insert(create_win0()),
                    1 => { staging.skip_failed_window(1); }
                    2 => staging.insert(create_win2()),
                    3 => { staging.skip_failed_window(3); }
                    _ => unreachable!(),
                }
                while let Some(w) = staging.pop_promotable() {
                    popped.push(w);
                }
            }

            assert_eq!(popped.len(), 2, "Interleaved {perm:?} must yield exactly 2 windows");
            assert_eq!(popped[0].window_index, 0);
            assert_eq!(popped[1].window_index, 2);

            let d0 = staging.prepare_promotion(rev_id, popped.remove(0));
            let d2 = staging.prepare_promotion(rev_id, popped.remove(0));

            let all_ordinals: Vec<u32> = d0.word_records.iter().chain(d2.word_records.iter()).map(|w| w.ordinal).collect();
            assert_eq!(all_ordinals, vec![1, 2, 3, 4, 5]);
            assert_eq!(staging.next_promote_index(), 4);
        }
    }

    #[test]
    fn test_adversarial_multithreaded_out_of_order_windows_1_and_3_fail_0_and_2_succeed() {
        use std::sync::Arc;
        let rev_id = TranscriptRevisionId::new();

        for _ in 0..200 {
            let staging = Arc::new(StagingBuffer::new());

            let s0 = Arc::clone(&staging);
            let h0 = std::thread::spawn(move || {
                let win0 = StagedWindowResult {
                    window_index: 0,
                    window: WindowRange::new(0, 0, 60_000),
                    words: vec![
                        make_test_word("a", 0, 500),
                        make_test_word("b", 500, 1000),
                    ],
                };
                s0.insert(win0);
            });

            let s1 = Arc::clone(&staging);
            let h1 = std::thread::spawn(move || {
                s1.skip_failed_window(1);
            });

            let s2 = Arc::clone(&staging);
            let h2 = std::thread::spawn(move || {
                let win2 = StagedWindowResult {
                    window_index: 2,
                    window: WindowRange::new(2, 120_000, 180_000),
                    words: vec![
                        make_test_word("c", 120_000, 120_500),
                        make_test_word("d", 120_500, 121_000),
                        make_test_word("e", 121_000, 121_500),
                    ],
                };
                s2.insert(win2);
            });

            let s3 = Arc::clone(&staging);
            let h3 = std::thread::spawn(move || {
                s3.skip_failed_window(3);
            });

            h0.join().unwrap();
            h1.join().unwrap();
            h2.join().unwrap();
            h3.join().unwrap();

            let mut popped = Vec::new();
            while let Some(w) = staging.pop_promotable() {
                popped.push(w);
            }

            assert_eq!(popped.len(), 2);
            assert_eq!(popped[0].window_index, 0);
            assert_eq!(popped[1].window_index, 2);

            let d0 = staging.prepare_promotion(rev_id, popped.remove(0));
            let d2 = staging.prepare_promotion(rev_id, popped.remove(0));

            let ordinals: Vec<u32> = d0.word_records.iter().chain(d2.word_records.iter()).map(|w| w.ordinal).collect();
            assert_eq!(ordinals, vec![1, 2, 3, 4, 5]);
            assert_eq!(staging.next_promote_index(), 4);
        }
    }
}
