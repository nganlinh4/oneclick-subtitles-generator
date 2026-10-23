use osg_gemini::TranscriptionWord;
use osg_gemini::duration::parse_duration_nanos;
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
mod tests;
