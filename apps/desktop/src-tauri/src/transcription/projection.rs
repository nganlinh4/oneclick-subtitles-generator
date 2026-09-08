use osg_gemini::duration::parse_duration_nanos;
use osg_gemini::TranscriptionWord;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::planner::WindowRange;

#[derive(Debug, Error)]
pub(crate) enum ProjectionError {
    #[error("duration parsing failed: {0}")]
    Gemini(#[from] osg_gemini::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum WordProjectionStatus {
    Accepted,
    /// A provider utterance interval divided into subtitle words without native word timestamps.
    Interpolated,
    Clamped {
        original_end_ms: i64,
        overshoot_ms: i64,
    },
    Quarantined {
        reason: String,
    },
    Rejected {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectedWordResult {
    pub(crate) status: WordProjectionStatus,
    pub(crate) text: String,
    pub(crate) raw_start_ns: u64,
    pub(crate) raw_end_ns: u64,
    pub(crate) project_start_ms: i64,
    pub(crate) project_end_ms: i64,
    pub(crate) speaker_id: Option<String>,
    pub(crate) is_unaligned: bool,
    pub(crate) alignment_status: String,
}

impl ProjectedWordResult {
    #[must_use]
    pub(crate) const fn is_valid_for_subtitles(&self) -> bool {
        !matches!(self.status, WordProjectionStatus::Rejected { .. })
    }
}

/// Projects a single provider word into the project timeline coordinates.
///
/// Rules:
/// - Start coordinate: `window.start_ms + start_offset_ms`
/// - End coordinate: `window.start_ms + end_offset_ms`
/// - If end offset exceeds window duration by <= 100ms, clamps end coordinate to `window.end_ms`.
/// - If end offset exceeds window duration by > 100ms, marks as quarantined (`is_unaligned = true`).
/// - If end offset < start offset or start < 0, marks as rejected.
/// - Namespaces speaker label as `w{window_index}:{speaker}`.
pub(crate) fn project_window_word(
    word: &TranscriptionWord,
    window: &WindowRange,
) -> Result<ProjectedWordResult, ProjectionError> {
    let raw_start_ns = parse_duration_nanos(&word.start_offset)?;
    let raw_end_ns = parse_duration_nanos(&word.end_offset)?;

    let start_offset_ms = (raw_start_ns / 1_000_000).cast_signed();
    let end_offset_ms = (raw_end_ns / 1_000_000).cast_signed();

    let speaker_id = word
        .speaker_label
        .as_ref()
        .map(|s| format!("w{}:{s}", window.index));

    if end_offset_ms < start_offset_ms {
        return Ok(ProjectedWordResult {
            status: WordProjectionStatus::Rejected {
                reason: "reversed_timestamps".to_owned(),
            },
            text: word.word.clone(),
            raw_start_ns,
            raw_end_ns,
            project_start_ms: window.start_ms + start_offset_ms,
            project_end_ms: window.start_ms + end_offset_ms,
            speaker_id,
            is_unaligned: true,
            alignment_status: "unaligned".to_owned(),
        });
    }

    let win_dur_ms = window.duration_ms();

    // Check 2: Word starts at or beyond window duration
    // Quarantined rather than clamped to prevent negative duration (project_start_ms > project_end_ms)
    // or collapsed 0ms points at the boundary. Preserves true offsets and passes SQLite CHECK(end_ms >= start_ms).
    if start_offset_ms >= win_dur_ms {
        return Ok(ProjectedWordResult {
            status: WordProjectionStatus::Quarantined {
                reason: "starts_after_window_end".to_owned(),
            },
            text: word.word.clone(),
            raw_start_ns,
            raw_end_ns,
            project_start_ms: window.start_ms + start_offset_ms,
            project_end_ms: window.start_ms + end_offset_ms,
            speaker_id,
            is_unaligned: true,
            alignment_status: "unaligned".to_owned(),
        });
    }

    if end_offset_ms > win_dur_ms {
        let overshoot_ms = end_offset_ms - win_dur_ms;
        if overshoot_ms <= 100 {
            // Clamped overshoot <= 100ms
            return Ok(ProjectedWordResult {
                status: WordProjectionStatus::Clamped {
                    original_end_ms: window.start_ms + end_offset_ms,
                    overshoot_ms,
                },
                text: word.word.clone(),
                raw_start_ns,
                raw_end_ns,
                project_start_ms: window.start_ms + start_offset_ms,
                project_end_ms: window.end_ms, // clamped to window boundary
                speaker_id,
                is_unaligned: false,
                alignment_status: "modified".to_owned(),
            });
        }

        // Quarantined overshoot > 100ms
        return Ok(ProjectedWordResult {
            status: WordProjectionStatus::Quarantined {
                reason: format!("overshoot_exceeds_100ms_{overshoot_ms}ms"),
            },
            text: word.word.clone(),
            raw_start_ns,
            raw_end_ns,
            project_start_ms: window.start_ms + start_offset_ms,
            project_end_ms: window.start_ms + end_offset_ms,
            speaker_id,
            is_unaligned: true,
            alignment_status: "unaligned".to_owned(),
        });
    }

    let result = ProjectedWordResult {
        status: WordProjectionStatus::Accepted,
        text: word.word.clone(),
        raw_start_ns,
        raw_end_ns,
        project_start_ms: window.start_ms + start_offset_ms,
        project_end_ms: window.start_ms + end_offset_ms,
        speaker_id,
        is_unaligned: false,
        alignment_status: "aligned".to_owned(),
    };

    #[cfg(debug_assertions)]
    if !matches!(result.status, WordProjectionStatus::Rejected { .. }) {
        debug_assert!(
            result.project_end_ms >= result.project_start_ms,
            "Projection invariant violation: project_end_ms ({}) < project_start_ms ({}) for word '{}'",
            result.project_end_ms,
            result.project_start_ms,
            result.text
        );
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normal_projection() {
        let window = WindowRange::new(1, 60_000, 120_000);
        let word = TranscriptionWord {
            word: "hello".to_owned(),
            start_offset: "4.500s".to_owned(),
            end_offset: "4.950s".to_owned(),
            speaker_label: Some("speaker_1".to_owned()),
        };

        let result = project_window_word(&word, &window).unwrap();
        assert_eq!(result.status, WordProjectionStatus::Accepted);
        assert_eq!(result.project_start_ms, 64_500);
        assert_eq!(result.project_end_ms, 64_950);
        assert_eq!(result.speaker_id, Some("w1:speaker_1".to_owned()));
        assert!(!result.is_unaligned);
        assert_eq!(result.alignment_status, "aligned");
    }

    #[test]
    fn test_overshoot_clamp_100ms() {
        let window = WindowRange::new(0, 0, 60_000);
        let word = TranscriptionWord {
            word: "end_word".to_owned(),
            start_offset: "59.500s".to_owned(),
            end_offset: "60.100s".to_owned(),
            speaker_label: Some("1".to_owned()),
        };

        let result = project_window_word(&word, &window).unwrap();
        assert_eq!(
            result.status,
            WordProjectionStatus::Clamped {
                original_end_ms: 60_100,
                overshoot_ms: 100,
            }
        );
        assert_eq!(result.project_start_ms, 59_500);
        assert_eq!(result.project_end_ms, 60_000); // clamped to window end
        assert_eq!(result.speaker_id, Some("w0:1".to_owned()));
        assert!(!result.is_unaligned);
        assert_eq!(result.alignment_status, "modified");
    }

    #[test]
    fn test_overshoot_quarantine_above_100ms() {
        let window = WindowRange::new(0, 0, 60_000);
        let word = TranscriptionWord {
            word: "excessive".to_owned(),
            start_offset: "59.000s".to_owned(),
            end_offset: "60.250s".to_owned(),
            speaker_label: None,
        };

        let result = project_window_word(&word, &window).unwrap();
        assert!(matches!(
            result.status,
            WordProjectionStatus::Quarantined { .. }
        ));
        assert!(result.is_unaligned);
        assert_eq!(result.alignment_status, "unaligned");
        assert_eq!(result.project_end_ms, 60_250);
    }

    #[test]
    fn test_reversed_timestamps_rejected() {
        let window = WindowRange::new(0, 0, 60_000);
        let word = TranscriptionWord {
            word: "reversed".to_owned(),
            start_offset: "5.000s".to_owned(),
            end_offset: "4.000s".to_owned(),
            speaker_label: None,
        };

        let result = project_window_word(&word, &window).unwrap();
        assert!(matches!(
            result.status,
            WordProjectionStatus::Rejected { .. }
        ));
        assert!(!result.is_valid_for_subtitles());
    }

    #[test]
    fn test_starts_after_window_end_quarantined_not_inverted() {
        let window = WindowRange::new(0, 0, 60_000);
        // Word starts 20ms after window end, ends 80ms after window end (overshoot 80ms <= 100ms)
        let word = TranscriptionWord {
            word: "late_word".to_owned(),
            start_offset: "60.020s".to_owned(),
            end_offset: "60.080s".to_owned(),
            speaker_label: Some("1".to_owned()),
        };

        let result = project_window_word(&word, &window).unwrap();
        assert_eq!(
            result.status,
            WordProjectionStatus::Quarantined {
                reason: "starts_after_window_end".to_owned(),
            }
        );
        // Invariant: end_ms >= start_ms
        assert_eq!(result.project_start_ms, 60_020);
        assert_eq!(result.project_end_ms, 60_080);
        assert!(result.project_end_ms >= result.project_start_ms);
        assert!(result.is_unaligned);
        assert_eq!(result.alignment_status, "unaligned");
        assert!(result.is_valid_for_subtitles());
    }

    #[test]
    fn test_starts_at_exact_window_end_quarantined() {
        let window = WindowRange::new(0, 0, 60_000);
        // Word starts exactly at 60.000s, ends at 60.050s
        let word = TranscriptionWord {
            word: "edge_word".to_owned(),
            start_offset: "60.000s".to_owned(),
            end_offset: "60.050s".to_owned(),
            speaker_label: None,
        };

        let result = project_window_word(&word, &window).unwrap();
        assert_eq!(
            result.status,
            WordProjectionStatus::Quarantined {
                reason: "starts_after_window_end".to_owned(),
            }
        );
        assert_eq!(result.project_start_ms, 60_000);
        assert_eq!(result.project_end_ms, 60_050);
        assert!(result.project_end_ms >= result.project_start_ms);
        assert!(result.is_unaligned);
        assert_eq!(result.alignment_status, "unaligned");
    }

    #[test]
    fn test_nonzero_window_offset_starts_after_window_end() {
        // Window 2: [60_000, 120_000] (duration = 60_000ms)
        let window = WindowRange::new(2, 60_000, 120_000);
        let word = TranscriptionWord {
            word: "offset_late".to_owned(),
            start_offset: "60.010s".to_owned(),
            end_offset: "60.070s".to_owned(),
            speaker_label: Some("spk_a".to_owned()),
        };

        let result = project_window_word(&word, &window).unwrap();
        assert_eq!(
            result.status,
            WordProjectionStatus::Quarantined {
                reason: "starts_after_window_end".to_owned(),
            }
        );
        // Project start = 60_000 + 60_010 = 120_010
        // Project end = 60_000 + 60_070 = 120_070
        assert_eq!(result.project_start_ms, 120_010);
        assert_eq!(result.project_end_ms, 120_070);
        assert_eq!(result.speaker_id, Some("w2:spk_a".to_owned()));
        assert!(result.project_end_ms >= result.project_start_ms);
        assert!(result.is_unaligned);
        assert_eq!(result.alignment_status, "unaligned");
    }

    #[test]
    fn test_starts_inside_and_overshoots_by_100ms_still_clamped() {
        let window = WindowRange::new(0, 0, 60_000);
        let word = TranscriptionWord {
            word: "valid_clamped".to_owned(),
            start_offset: "59.500s".to_owned(),
            end_offset: "60.100s".to_owned(),
            speaker_label: None,
        };

        let result = project_window_word(&word, &window).unwrap();
        assert_eq!(
            result.status,
            WordProjectionStatus::Clamped {
                original_end_ms: 60_100,
                overshoot_ms: 100,
            }
        );
        assert_eq!(result.project_start_ms, 59_500);
        assert_eq!(result.project_end_ms, 60_000); // Clamped
        assert!(result.project_end_ms > result.project_start_ms);
        assert!(!result.is_unaligned);
        assert_eq!(result.alignment_status, "modified");
    }

    #[test]
    fn test_exhaustive_projection_invariants() {
        let window = WindowRange::new(1, 30_000, 90_000); // duration = 60_000ms
        let test_cases = [
            // (start, end, expected_status_prefix)
            ("0.000s", "0.500s", "accepted"),
            ("59.000s", "60.000s", "accepted"),
            ("59.500s", "60.050s", "clamped"),
            ("59.500s", "60.100s", "clamped"),
            ("59.500s", "60.101s", "quarantined"),
            ("60.000s", "60.050s", "quarantined"),
            ("60.020s", "60.080s", "quarantined"),
            ("70.000s", "71.000s", "quarantined"),
            ("10.000s", "9.000s", "rejected"),
        ];

        for (s, e, expected_prefix) in test_cases {
            let word = TranscriptionWord {
                word: "test".to_owned(),
                start_offset: s.to_owned(),
                end_offset: e.to_owned(),
                speaker_label: None,
            };
            let result = project_window_word(&word, &window).unwrap();

            if result.status == WordProjectionStatus::Accepted {
                assert_eq!(expected_prefix, "accepted");
                assert!(result.project_end_ms >= result.project_start_ms);
                assert!(!result.is_unaligned);
                assert_eq!(result.alignment_status, "aligned");
            } else if matches!(result.status, WordProjectionStatus::Clamped { .. }) {
                assert_eq!(expected_prefix, "clamped");
                assert!(result.project_end_ms >= result.project_start_ms);
                assert!(!result.is_unaligned);
                assert_eq!(result.alignment_status, "modified");
            } else if matches!(result.status, WordProjectionStatus::Quarantined { .. }) {
                assert_eq!(expected_prefix, "quarantined");
                assert!(result.project_end_ms >= result.project_start_ms);
                assert!(result.is_unaligned);
                assert_eq!(result.alignment_status, "unaligned");
            } else if matches!(result.status, WordProjectionStatus::Rejected { .. }) {
                assert_eq!(expected_prefix, "rejected");
                assert!(!result.is_valid_for_subtitles());
            }
        }
    }

    #[test]
    #[allow(clippy::too_many_lines, clippy::cast_possible_truncation)]
    fn test_adversarial_boundary_conditions_and_sqlite_insertion() {
        use osg_domain::{ProjectMetadata, TranscriptRevisionId};
        use osg_infrastructure::storage::transcripts::TranscriptRevisionRecord;
        use osg_infrastructure::storage::Database;
        use tempfile::tempdir;
        use crate::transcription::staging::{StagedWindowResult, StagingBuffer};

        let dir = tempdir().unwrap();
        let db_path = dir.path().join("projection_test.db");
        let db = Database::open(&db_path).unwrap();

        let meta = ProjectMetadata::new("Projection Invariant Test").unwrap();
        db.create_project(&meta).unwrap();
        let project_id = meta.id();

        let rev_id = TranscriptRevisionId::new();
        let rev = TranscriptRevisionRecord {
            id: rev_id,
            project_id,
            media_id: None,
            provider: "gemini".to_string(),
            model: "gemini-3.5-transcribe".to_string(),
            source_range_start_ms: 0,
            source_range_end_ms: 300_000,
            state: "in_progress".to_string(),
            fingerprint: "test-fp".to_string(),
            word_count: 0,
            metadata_json: "{}".to_string(),
            created_at_ms: 1000,
            updated_at_ms: 1000,
        };
        db.transcript_insert_revision(&rev).unwrap();

        let window = WindowRange::new(0, 0, 60_000); // 60s window: [0ms, 60000ms]
        let staging = StagingBuffer::new();

        // Boundary cases mandated by prompt:
        // words start at or after window duration (e.g. start = 60.000s, 60.001s, 60.050s on a 60s window)
        let boundary_words = vec![
            // 1. Exactly at window duration (60.000s) with 0ms duration
            TranscriptionWord {
                word: "exact_zero_dur".to_string(),
                start_offset: "60.000s".to_string(),
                end_offset: "60.000s".to_string(),
                speaker_label: Some("1".to_string()),
            },
            // 2. Exactly at window duration (60.000s), ends at 60.001s
            TranscriptionWord {
                word: "exact_1ms".to_string(),
                start_offset: "60.000s".to_string(),
                end_offset: "60.001s".to_string(),
                speaker_label: Some("1".to_string()),
            },
            // 3. Exactly at window duration (60.000s), ends at 60.050s
            TranscriptionWord {
                word: "exact_50ms".to_string(),
                start_offset: "60.000s".to_string(),
                end_offset: "60.050s".to_string(),
                speaker_label: Some("1".to_string()),
            },
            // 4. Exactly at window duration (60.000s), ends at 60.100s (100ms overshoot)
            TranscriptionWord {
                word: "exact_100ms".to_string(),
                start_offset: "60.000s".to_string(),
                end_offset: "60.100s".to_string(),
                speaker_label: Some("1".to_string()),
            },
            // 5. Exactly at window duration (60.000s), ends at 60.150s (>100ms overshoot)
            TranscriptionWord {
                word: "exact_150ms".to_string(),
                start_offset: "60.000s".to_string(),
                end_offset: "60.150s".to_string(),
                speaker_label: Some("1".to_string()),
            },
            // 6. After window duration: 60.001s, ends at 60.001s (0ms duration)
            TranscriptionWord {
                word: "after_1ms_zero".to_string(),
                start_offset: "60.001s".to_string(),
                end_offset: "60.001s".to_string(),
                speaker_label: Some("2".to_string()),
            },
            // 7. After window duration: 60.001s, ends at 60.050s
            TranscriptionWord {
                word: "after_1ms_50".to_string(),
                start_offset: "60.001s".to_string(),
                end_offset: "60.050s".to_string(),
                speaker_label: Some("2".to_string()),
            },
            // 8. After window duration: 60.050s, ends at 60.050s
            TranscriptionWord {
                word: "after_50ms_zero".to_string(),
                start_offset: "60.050s".to_string(),
                end_offset: "60.050s".to_string(),
                speaker_label: Some("2".to_string()),
            },
            // 9. After window duration: 60.050s, ends at 60.080s
            TranscriptionWord {
                word: "after_50ms_80".to_string(),
                start_offset: "60.050s".to_string(),
                end_offset: "60.080s".to_string(),
                speaker_label: Some("2".to_string()),
            },
            // 10. Normal word inside window: 10.000s to 10.500s
            TranscriptionWord {
                word: "normal_inside".to_string(),
                start_offset: "10.000s".to_string(),
                end_offset: "10.500s".to_string(),
                speaker_label: Some("1".to_string()),
            },
            // 11. Word starting inside and overshooting by 50ms (clamped to 60_000)
            TranscriptionWord {
                word: "overshoot_clamped".to_string(),
                start_offset: "59.800s".to_string(),
                end_offset: "60.050s".to_string(),
                speaker_label: Some("1".to_string()),
            },
        ];

        let mut projected_words = Vec::new();
        for raw in &boundary_words {
            let proj = project_window_word(raw, &window).expect("projection must succeed");
            // Invariant 1: project_end_ms >= project_start_ms
            assert!(
                proj.project_end_ms >= proj.project_start_ms,
                "Invariant violated: project_end_ms ({}) < project_start_ms ({}) for word '{}'",
                proj.project_end_ms,
                proj.project_start_ms,
                proj.text
            );
            // Invariant 2: raw_end_ns >= raw_start_ns
            assert!(
                proj.raw_end_ns >= proj.raw_start_ns,
                "Raw invariant violated: raw_end_ns ({}) < raw_start_ns ({}) for word '{}'",
                proj.raw_end_ns,
                proj.raw_start_ns,
                proj.text
            );
            // Invariant 3: valid for subtitles
            assert!(proj.is_valid_for_subtitles());
            projected_words.push(proj);
        }

        let staged = StagedWindowResult {
            window_index: 0,
            window,
            words: projected_words,
        };

        let promoted_data = staging.prepare_promotion(rev_id, staged);
        assert!(!promoted_data.word_records.is_empty());
        assert!(!promoted_data.turn_records.is_empty());

        // Invariant 4: SQLite insertion must not trigger CHECK constraint violations
        let commit_res = db.transcript_promote_window(
            rev_id,
            &promoted_data.turn_records,
            &promoted_data.word_records,
        );
        assert!(
            commit_res.is_ok(),
            "SQLite CHECK constraint violation during window promotion: {:?}",
            commit_res.err()
        );

        // Verify revision word count updated
        let fetched_rev = db
            .transcript_get_revision(rev_id)
            .unwrap()
            .expect("revision exists");
        assert_eq!(fetched_rev.word_count, boundary_words.len() as u32);

        // Verify all words retrieved from database satisfy end_ms >= start_ms
        let queried = db
            .transcript_query_words_in_range(rev_id, 0, 200_000)
            .unwrap();
        assert_eq!(queried.len(), boundary_words.len());
        for w in &queried {
            assert!(
                w.end_ms >= w.start_ms,
                "Database returned inverted word: start_ms={}, end_ms={}",
                w.start_ms,
                w.end_ms
            );
            assert!(
                w.raw_end_ns >= w.raw_start_ns,
                "Database returned inverted raw: raw_start_ns={}, raw_end_ns={}",
                w.raw_start_ns,
                w.raw_end_ns
            );
        }
    }

    #[test]
    #[allow(clippy::uninlined_format_args)]
    fn test_adversarial_submillisecond_reversed_timestamps() {
        use osg_domain::{ProjectMetadata, TranscriptRevisionId};
        use osg_infrastructure::storage::transcripts::TranscriptRevisionRecord;
        use osg_infrastructure::storage::Database;
        use tempfile::tempdir;
        use crate::transcription::staging::{StagedWindowResult, StagingBuffer};

        let window = WindowRange::new(0, 0, 60_000);
        let reversed_subms_word = TranscriptionWord {
            word: "subms_rev".to_string(),
            start_offset: "10.000900s".to_string(), // 10_000_900_000 ns (10000ms)
            end_offset: "10.000100s".to_string(),   // 10_000_100_000 ns (10000ms)
            speaker_label: None,
        };

        let proj = project_window_word(&reversed_subms_word, &window).expect("projection call");

        let dir = tempdir().unwrap();
        let db_path = dir.path().join("subms_test.db");
        let db = Database::open(&db_path).unwrap();
        let meta = ProjectMetadata::new("Subms Test").unwrap();
        db.create_project(&meta).unwrap();
        let project_id = meta.id();

        let rev_id = TranscriptRevisionId::new();
        let rev = TranscriptRevisionRecord {
            id: rev_id,
            project_id,
            media_id: None,
            provider: "gemini".to_string(),
            model: "gemini-3.5-transcribe".to_string(),
            source_range_start_ms: 0,
            source_range_end_ms: 60_000,
            state: "in_progress".to_string(),
            fingerprint: "test-fp".to_string(),
            word_count: 0,
            metadata_json: "{}".to_string(),
            created_at_ms: 1000,
            updated_at_ms: 1000,
        };
        db.transcript_insert_revision(&rev).unwrap();

        let staging = StagingBuffer::new();
        let staged = StagedWindowResult {
            window_index: 0,
            window,
            words: vec![proj.clone()],
        };
        let promoted_data = staging.prepare_promotion(rev_id, staged);

        let commit_res = db.transcript_promote_window(
            rev_id,
            &promoted_data.turn_records,
            &promoted_data.word_records,
        );

        if proj.raw_end_ns < proj.raw_start_ns {
            assert!(
                commit_res.is_err(),
                "SQLite MUST reject raw_end_ns < raw_start_ns"
            );
        }
    }

    #[test]
    #[allow(clippy::uninlined_format_args)]
    fn test_adversarial_overlong_speaker_label() {
        use osg_domain::{ProjectMetadata, TranscriptRevisionId};
        use osg_infrastructure::storage::transcripts::TranscriptRevisionRecord;
        use osg_infrastructure::storage::Database;
        use tempfile::tempdir;
        use crate::transcription::staging::{StagedWindowResult, StagingBuffer};

        let window = WindowRange::new(0, 0, 60_000);
        // 64 character speaker label: when prefixed with "w0:", length becomes 67 (> 64)
        let long_speaker_word = TranscriptionWord {
            word: "long_spk".to_string(),
            start_offset: "1.000s".to_string(),
            end_offset: "1.500s".to_string(),
            speaker_label: Some("s".repeat(64)),
        };

        let proj = project_window_word(&long_speaker_word, &window).expect("projection call");

        let dir = tempdir().unwrap();
        let db_path = dir.path().join("speaker_test.db");
        let db = Database::open(&db_path).unwrap();
        let meta = ProjectMetadata::new("Speaker Test").unwrap();
        db.create_project(&meta).unwrap();
        let project_id = meta.id();

        let rev_id = TranscriptRevisionId::new();
        let rev = TranscriptRevisionRecord {
            id: rev_id,
            project_id,
            media_id: None,
            provider: "gemini".to_string(),
            model: "gemini-3.5-transcribe".to_string(),
            source_range_start_ms: 0,
            source_range_end_ms: 60_000,
            state: "in_progress".to_string(),
            fingerprint: "test-fp".to_string(),
            word_count: 0,
            metadata_json: "{}".to_string(),
            created_at_ms: 1000,
            updated_at_ms: 1000,
        };
        db.transcript_insert_revision(&rev).unwrap();

        let staging = StagingBuffer::new();
        let staged = StagedWindowResult {
            window_index: 0,
            window,
            words: vec![proj],
        };
        let promoted_data = staging.prepare_promotion(rev_id, staged);

        let commit_res = db.transcript_promote_window(
            rev_id,
            &promoted_data.turn_records,
            &promoted_data.word_records,
        );

        assert!(commit_res.is_err(), "SQLite must reject overlong speaker label");
    }
}

