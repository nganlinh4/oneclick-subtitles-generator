//! Caption projections over a revision, with manual edits preserved across regrouping.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::{
    GroupingPolicy, ScriptSpacing, TimedWord, TranscriptError, TranscriptRevision,
    grouping::project_words,
};
use crate::{
    ids::{CueId, ProjectionId, TrackId, TranscriptRevisionId, WordId},
    subtitles::{SubtitleCue, SubtitleError, SubtitleTrack, TrackOrigin},
};

/// Tracking state of manual user edits on a projected cue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ManualEditState {
    /// Pure projection derived directly from words; can be freely reflowed.
    #[default]
    Clean,
    /// User edited the cue text; protected from automatic reflow overwrite.
    EditedText,
    /// User dragged timeline start/end boundaries.
    AdjustedTiming,
    /// Explicitly locked by user against any grouping changes.
    Locked,
}

/// Synchronization alignment state of a projected cue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AlignmentState {
    /// All underlying words are verbatim provider aligned.
    #[default]
    FullyAligned,
    /// Some words were manually edited or inserted.
    PartiallyAligned,
    /// Cue boundary dragged or synthetic interval without direct word timing.
    Unaligned,
}

/// Link to source word span for translation tracks (prevents fake target word timestamps).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceWordSpan {
    pub revision_id: TranscriptRevisionId,
    pub start_word_id: WordId,
    pub end_word_id: WordId,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// A subtitle cue projected from one or more words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedCue {
    pub id: CueId,
    pub ordinal: u32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub word_ids: Vec<WordId>,
    pub manual_state: ManualEditState,
    pub alignment_state: AlignmentState,
    pub source_span: Option<SourceWordSpan>,
}

/// Derived caption projection over a durable transcript revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionProjection {
    id: ProjectionId,
    revision_id: TranscriptRevisionId,
    track_id: TrackId,
    policy: GroupingPolicy,
    pub(super) cues: Vec<ProjectedCue>,
}

impl CaptionProjection {
    /// Creates a complete caption projection from a revision using the given policy.
    /// Runs 100% offline with zero network calls.
    pub fn project(
        revision: &TranscriptRevision,
        track_id: TrackId,
        policy: GroupingPolicy,
        spacing: ScriptSpacing,
    ) -> Result<Self, TranscriptError> {
        let words = revision.words();
        if words.is_empty() {
            return Ok(Self {
                id: ProjectionId::new(),
                revision_id: revision.id(),
                track_id,
                policy,
                cues: Vec::new(),
            });
        }

        let cues = project_words(words, &policy, spacing)?;

        Ok(Self {
            id: ProjectionId::new(),
            revision_id: revision.id(),
            track_id,
            policy,
            cues,
        })
    }

    /// Regroups captions under a new policy while strictly preserving manual user edits.
    pub fn regroup_preserving_edits(
        &self,
        revision: &TranscriptRevision,
        new_policy: GroupingPolicy,
        spacing: ScriptSpacing,
    ) -> Result<Self, TranscriptError> {
        let mut preserved: Vec<ProjectedCue> = self
            .cues
            .iter()
            .filter(|c| c.manual_state != ManualEditState::Clean)
            .cloned()
            .collect();

        if preserved.is_empty() {
            return Self::project(revision, self.track_id, new_policy, spacing);
        }

        let preserved_word_ids: HashSet<WordId> = preserved
            .iter()
            .flat_map(|c| c.word_ids.iter().copied())
            .collect();

        let mut unprojected_slices: Vec<Vec<TimedWord>> = Vec::new();
        let mut current_slice: Vec<TimedWord> = Vec::new();

        for word in revision.words() {
            if preserved_word_ids.contains(&word.id()) {
                if !current_slice.is_empty() {
                    unprojected_slices.push(std::mem::take(&mut current_slice));
                }
            } else {
                current_slice.push(word.clone());
            }
        }
        if !current_slice.is_empty() {
            unprojected_slices.push(current_slice);
        }

        let mut fresh_cues: Vec<ProjectedCue> = Vec::new();
        for slice in unprojected_slices {
            let slice_cues = project_words(&slice, &new_policy, spacing)?;
            fresh_cues.extend(slice_cues);
        }

        preserved.extend(fresh_cues);
        preserved.sort_by_key(|c| (c.start_ms, c.end_ms));
        for (idx, cue) in preserved.iter_mut().enumerate() {
            cue.ordinal = u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyCues)?;
        }

        Ok(Self {
            id: ProjectionId::new(),
            revision_id: revision.id(),
            track_id: self.track_id,
            policy: new_policy,
            cues: preserved,
        })
    }

    /// Splits an existing cue at the given word index into two new cues.
    #[allow(clippy::similar_names)]
    pub fn split_cue(
        &mut self,
        cue_id: CueId,
        at_word_index: usize,
        revision: &TranscriptRevision,
        spacing: ScriptSpacing,
    ) -> Result<(CueId, CueId), TranscriptError> {
        let pos = self
            .cues
            .iter()
            .position(|c| c.id == cue_id)
            .ok_or(TranscriptError::CueNotFound(cue_id))?;
        let cue = &self.cues[pos];
        if at_word_index == 0 || at_word_index >= cue.word_ids.len() {
            return Err(TranscriptError::InvalidSplitIndex);
        }

        let first_word_ids = cue.word_ids[..at_word_index].to_vec();
        let second_word_ids = cue.word_ids[at_word_index..].to_vec();

        let first_words: Vec<&TimedWord> = first_word_ids
            .iter()
            .filter_map(|id| revision.find_word(*id))
            .collect();
        let second_words: Vec<&TimedWord> = second_word_ids
            .iter()
            .filter_map(|id| revision.find_word(*id))
            .collect();

        if first_words.is_empty() || second_words.is_empty() {
            return Err(TranscriptError::WordNotFound);
        }

        let cue1_id = CueId::new();
        let cue2_id = CueId::new();

        let start_ms1 = first_words[0].start_ms();
        let mut end_ms1 = first_words
            .iter()
            .map(|w| w.end_ms())
            .max()
            .unwrap_or(start_ms1);
        if end_ms1 <= start_ms1 {
            end_ms1 = start_ms1 + 50;
        }

        let start_ms2 = second_words[0].start_ms();
        let mut end_ms2 = second_words
            .iter()
            .map(|w| w.end_ms())
            .max()
            .unwrap_or(start_ms2);
        if end_ms2 <= start_ms2 {
            end_ms2 = start_ms2 + 50;
        }

        let source_span1 = cue.source_span.as_ref().map(|s| SourceWordSpan {
            revision_id: s.revision_id,
            start_word_id: first_word_ids[0],
            end_word_id: *first_word_ids.last().unwrap(),
            start_ms: start_ms1,
            end_ms: end_ms1,
        });

        let source_span2 = cue.source_span.as_ref().map(|s| SourceWordSpan {
            revision_id: s.revision_id,
            start_word_id: second_word_ids[0],
            end_word_id: *second_word_ids.last().unwrap(),
            start_ms: start_ms2,
            end_ms: end_ms2,
        });

        let cue1 = ProjectedCue {
            id: cue1_id,
            ordinal: cue.ordinal,
            start_ms: start_ms1,
            end_ms: end_ms1,
            text: first_words
                .iter()
                .map(|w| w.text())
                .collect::<Vec<_>>()
                .join(spacing.separator()),
            word_ids: first_word_ids,
            manual_state: ManualEditState::EditedText,
            alignment_state: cue.alignment_state,
            source_span: source_span1,
        };

        let cue2 = ProjectedCue {
            id: cue2_id,
            ordinal: cue.ordinal + 1,
            start_ms: start_ms2,
            end_ms: end_ms2,
            text: second_words
                .iter()
                .map(|w| w.text())
                .collect::<Vec<_>>()
                .join(spacing.separator()),
            word_ids: second_word_ids,
            manual_state: ManualEditState::EditedText,
            alignment_state: cue.alignment_state,
            source_span: source_span2,
        };

        self.cues.remove(pos);
        self.cues.insert(pos, cue2);
        self.cues.insert(pos, cue1);

        for (idx, c) in self.cues.iter_mut().enumerate() {
            c.ordinal = u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyCues)?;
        }

        Ok((cue1_id, cue2_id))
    }

    /// Merges two adjacent cues into one.
    pub fn merge_cues(
        &mut self,
        first_cue_id: CueId,
        second_cue_id: CueId,
        _revision: &TranscriptRevision,
        spacing: ScriptSpacing,
    ) -> Result<CueId, TranscriptError> {
        let pos1 = self
            .cues
            .iter()
            .position(|c| c.id == first_cue_id)
            .ok_or(TranscriptError::CueNotFound(first_cue_id))?;
        let pos2 = self
            .cues
            .iter()
            .position(|c| c.id == second_cue_id)
            .ok_or(TranscriptError::CueNotFound(second_cue_id))?;

        if pos1 + 1 != pos2 {
            return Err(TranscriptError::CuesNotAdjacent);
        }

        let cue1 = &self.cues[pos1];
        let cue2 = &self.cues[pos2];

        let mut merged_word_ids = cue1.word_ids.clone();
        merged_word_ids.extend_from_slice(&cue2.word_ids);

        let text = match (cue1.text.is_empty(), cue2.text.is_empty()) {
            (true, true) => String::new(),
            (true, false) => cue2.text.clone(),
            (false, true) => cue1.text.clone(),
            (false, false) => {
                let sep = spacing.separator();
                if sep.is_empty()
                    || cue1.text.ends_with(char::is_whitespace)
                    || cue2.text.starts_with(char::is_whitespace)
                {
                    format!("{}{}", cue1.text, cue2.text)
                } else {
                    format!("{}{}{}", cue1.text, sep, cue2.text)
                }
            }
        };

        let start_ms = cue1.start_ms.min(cue2.start_ms);
        let mut end_ms = cue1.end_ms.max(cue2.end_ms);
        if end_ms <= start_ms {
            end_ms = start_ms + 50;
        }

        let manual_state = if cue1.manual_state == ManualEditState::Locked
            || cue2.manual_state == ManualEditState::Locked
        {
            ManualEditState::Locked
        } else {
            ManualEditState::EditedText
        };

        let source_span = match (&cue1.source_span, &cue2.source_span) {
            (Some(s1), Some(s2)) if s1.revision_id == s2.revision_id => Some(SourceWordSpan {
                revision_id: s1.revision_id,
                start_word_id: s1.start_word_id,
                end_word_id: s2.end_word_id,
                start_ms: s1.start_ms.min(s2.start_ms),
                end_ms: s1.end_ms.max(s2.end_ms),
            }),
            (Some(s1), None) => Some(s1.clone()),
            (None, Some(s2)) => Some(s2.clone()),
            _ => None,
        };

        let new_cue_id = CueId::new();
        let merged_cue = ProjectedCue {
            id: new_cue_id,
            ordinal: cue1.ordinal,
            start_ms,
            end_ms,
            text,
            word_ids: merged_word_ids,
            manual_state,
            alignment_state: if cue1.alignment_state == AlignmentState::FullyAligned
                && cue2.alignment_state == AlignmentState::FullyAligned
            {
                AlignmentState::FullyAligned
            } else {
                AlignmentState::PartiallyAligned
            },
            source_span,
        };

        self.cues.remove(pos2);
        self.cues[pos1] = merged_cue;

        for (idx, c) in self.cues.iter_mut().enumerate() {
            c.ordinal = u32::try_from(idx + 1).map_err(|_| TranscriptError::TooManyCues)?;
        }

        Ok(new_cue_id)
    }

    /// Converts this projection into a standard `SubtitleTrack` for editor preview and export.
    pub fn to_subtitle_track(
        &self,
        label: impl Into<String>,
        origin: TrackOrigin,
    ) -> Result<SubtitleTrack, SubtitleError> {
        let mut subtitle_cues = Vec::with_capacity(self.cues.len());
        for cue in &self.cues {
            let subtitle_cue = SubtitleCue::restore(
                cue.id,
                cue.ordinal,
                cue.start_ms,
                cue.end_ms,
                cue.text.clone(),
                None,
            )?;
            subtitle_cues.push(subtitle_cue);
        }
        SubtitleTrack::new(label, origin, subtitle_cues)
    }

    /// Extracts relational cue-word mappings for the `cue_word_mappings` `SQLite` table.
    #[must_use]
    pub fn cue_word_mappings(&self) -> Vec<(CueId, Vec<WordId>)> {
        self.cues
            .iter()
            .map(|c| (c.id, c.word_ids.clone()))
            .collect()
    }

    /// Finds the active word inside a cue at playback time `time_ms` for word-synchronized reveal styling.
    #[must_use]
    pub fn active_word_in_cue<'a>(
        &self,
        cue: &ProjectedCue,
        revision: &'a TranscriptRevision,
        time_ms: i64,
    ) -> Option<&'a TimedWord> {
        if time_ms < cue.start_ms || time_ms >= cue.end_ms {
            return None;
        }
        for word_id in &cue.word_ids {
            if let Some(word) = revision
                .find_word(*word_id)
                .filter(|w| w.start_ms() <= time_ms && time_ms < w.end_ms())
            {
                return Some(word);
            }
        }
        None
    }

    #[must_use]
    pub const fn id(&self) -> ProjectionId {
        self.id
    }
    #[must_use]
    pub const fn revision_id(&self) -> TranscriptRevisionId {
        self.revision_id
    }
    #[must_use]
    pub const fn track_id(&self) -> TrackId {
        self.track_id
    }
    #[must_use]
    pub fn policy(&self) -> &GroupingPolicy {
        &self.policy
    }
    #[must_use]
    pub fn cues(&self) -> &[ProjectedCue] {
        &self.cues
    }
}
