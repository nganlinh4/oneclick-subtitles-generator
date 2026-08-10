use crate::{AudioAsset, Result, SegmentId, SpeechError, TimeMicros};
use serde::Serialize;
use std::collections::HashSet;

const MAX_CLIPS: usize = 2_000;

/// Rules for resolving generated narration whose measured audio is longer than
/// its subtitle slot. All values use integer microseconds so identical inputs
/// produce identical timelines on every platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AlignmentPolicy {
    maximum_overlap: TimeMicros,
    recovery_overlap: TimeMicros,
    tail_padding: TimeMicros,
}

impl AlignmentPolicy {
    pub fn new(
        maximum_overlap: TimeMicros,
        recovery_overlap: TimeMicros,
        tail_padding: TimeMicros,
    ) -> Result<Self> {
        if recovery_overlap > maximum_overlap {
            return Err(SpeechError::InvalidOption(
                "recovery overlap cannot exceed maximum overlap",
            ));
        }
        if maximum_overlap.get() > 5_000_000 || tail_padding.get() > 30_000_000 {
            return Err(SpeechError::InvalidOption(
                "alignment tolerance or padding is too large",
            ));
        }
        Ok(Self {
            maximum_overlap,
            recovery_overlap,
            tail_padding,
        })
    }

    #[must_use]
    pub fn maximum_overlap(self) -> TimeMicros {
        self.maximum_overlap
    }

    #[must_use]
    pub fn recovery_overlap(self) -> TimeMicros {
        self.recovery_overlap
    }

    #[must_use]
    pub fn tail_padding(self) -> TimeMicros {
        self.tail_padding
    }
}

impl Default for AlignmentPolicy {
    fn default() -> Self {
        Self {
            maximum_overlap: TimeMicros::new(300_000).expect("constant is valid"),
            recovery_overlap: TimeMicros::new(200_000).expect("constant is valid"),
            tail_padding: TimeMicros::new(250_000).expect("constant is valid"),
        }
    }
}

/// A measured narration clip and its requested subtitle position.
#[derive(Clone, Debug)]
pub struct NarrationClip {
    id: SegmentId,
    asset: AudioAsset,
    requested_start: TimeMicros,
    cue_end: TimeMicros,
    measured_duration: TimeMicros,
}

impl NarrationClip {
    pub fn new(
        id: SegmentId,
        asset: AudioAsset,
        requested_start: TimeMicros,
        cue_end: TimeMicros,
        measured_duration: TimeMicros,
    ) -> Result<Self> {
        if cue_end < requested_start {
            return Err(SpeechError::InvalidInput(
                "subtitle cue ends before it starts",
            ));
        }
        if measured_duration == TimeMicros::ZERO {
            return Err(SpeechError::InvalidInput(
                "narration duration must be greater than zero",
            ));
        }
        Ok(Self {
            id,
            asset,
            requested_start,
            cue_end,
            measured_duration,
        })
    }

    #[must_use]
    pub fn id(&self) -> &SegmentId {
        &self.id
    }

    #[must_use]
    pub fn asset(&self) -> &AudioAsset {
        &self.asset
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AlignmentAdjustment {
    Original,
    ShiftedRight,
}

/// A render-ready clip. The asset remains a native, non-serializable
/// capability; timeline metadata can be exposed without revealing its path.
#[derive(Clone, Debug)]
pub struct AlignedClip {
    id: SegmentId,
    asset: AudioAsset,
    requested_start: TimeMicros,
    start: TimeMicros,
    end: TimeMicros,
    cue_end: TimeMicros,
    measured_duration: TimeMicros,
    adjustment: AlignmentAdjustment,
}

impl AlignedClip {
    #[must_use]
    pub fn id(&self) -> &SegmentId {
        &self.id
    }

    #[must_use]
    pub fn asset(&self) -> &AudioAsset {
        &self.asset
    }

    #[must_use]
    pub fn requested_start(&self) -> TimeMicros {
        self.requested_start
    }

    #[must_use]
    pub fn start(&self) -> TimeMicros {
        self.start
    }

    #[must_use]
    pub fn end(&self) -> TimeMicros {
        self.end
    }

    #[must_use]
    pub fn cue_end(&self) -> TimeMicros {
        self.cue_end
    }

    #[must_use]
    pub fn measured_duration(&self) -> TimeMicros {
        self.measured_duration
    }

    #[must_use]
    pub fn adjustment(&self) -> AlignmentAdjustment {
        self.adjustment
    }

    #[must_use]
    pub fn shift(&self) -> TimeMicros {
        self.start.saturating_sub(self.requested_start)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AlignmentStats {
    clip_count: usize,
    adjusted_count: usize,
    requested_duration: TimeMicros,
    natural_duration: TimeMicros,
    rendered_duration: TimeMicros,
    maximum_shift: TimeMicros,
}

impl AlignmentStats {
    #[must_use]
    pub fn clip_count(&self) -> usize {
        self.clip_count
    }

    #[must_use]
    pub fn adjusted_count(&self) -> usize {
        self.adjusted_count
    }

    #[must_use]
    pub fn requested_duration(&self) -> TimeMicros {
        self.requested_duration
    }

    #[must_use]
    pub fn natural_duration(&self) -> TimeMicros {
        self.natural_duration
    }

    #[must_use]
    pub fn rendered_duration(&self) -> TimeMicros {
        self.rendered_duration
    }

    #[must_use]
    pub fn maximum_shift(&self) -> TimeMicros {
        self.maximum_shift
    }
}

#[derive(Clone, Debug)]
pub struct AlignmentPlan {
    policy: AlignmentPolicy,
    clips: Vec<AlignedClip>,
    stats: AlignmentStats,
}

impl AlignmentPlan {
    pub fn build(mut clips: Vec<NarrationClip>, policy: AlignmentPolicy) -> Result<Self> {
        if clips.is_empty() || clips.len() > MAX_CLIPS {
            return Err(SpeechError::InvalidInput(
                "alignment requires between one and 2000 clips",
            ));
        }
        for clip in &clips {
            clip.asset.revalidate()?;
        }

        // `sort_by_key` is stable. Original order therefore breaks equal-start
        // ties deterministically and matches subtitle source ordering.
        clips.sort_by_key(|clip| clip.requested_start);

        let mut aligned = Vec::with_capacity(clips.len());
        let mut previous_end = TimeMicros::ZERO;
        let mut requested_duration = TimeMicros::ZERO;
        let mut natural_duration = TimeMicros::ZERO;
        let mut maximum_shift = TimeMicros::ZERO;
        let mut adjusted_count = 0;
        let mut ids = HashSet::with_capacity(clips.len());

        for clip in clips {
            if !ids.insert(clip.id.clone()) {
                return Err(SpeechError::InvalidInput(
                    "alignment contains a duplicate segment ID",
                ));
            }
            let threshold = previous_end.saturating_sub(policy.maximum_overlap);
            let needs_recovery = !aligned.is_empty() && clip.requested_start < threshold;
            let start = if needs_recovery {
                previous_end.saturating_sub(policy.recovery_overlap)
            } else {
                clip.requested_start
            };
            let end = start.checked_add(clip.measured_duration)?;
            let shift = start.saturating_sub(clip.requested_start);
            if needs_recovery {
                adjusted_count += 1;
            }
            maximum_shift = maximum_shift.max(shift);
            requested_duration = requested_duration.max(clip.cue_end);
            natural_duration = natural_duration.max(end);
            previous_end = previous_end.max(end);
            aligned.push(AlignedClip {
                id: clip.id,
                asset: clip.asset,
                requested_start: clip.requested_start,
                start,
                end,
                cue_end: clip.cue_end,
                measured_duration: clip.measured_duration,
                adjustment: if needs_recovery {
                    AlignmentAdjustment::ShiftedRight
                } else {
                    AlignmentAdjustment::Original
                },
            });
        }

        let rendered_duration = requested_duration
            .max(natural_duration)
            .checked_add(policy.tail_padding)?;
        let stats = AlignmentStats {
            clip_count: aligned.len(),
            adjusted_count,
            requested_duration,
            natural_duration,
            rendered_duration,
            maximum_shift,
        };
        Ok(Self {
            policy,
            clips: aligned,
            stats,
        })
    }

    #[must_use]
    pub fn policy(&self) -> AlignmentPolicy {
        self.policy
    }

    #[must_use]
    pub fn clips(&self) -> &[AlignedClip] {
        &self.clips
    }

    #[must_use]
    pub fn stats(&self) -> &AlignmentStats {
        &self.stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn clip(
        directory: &Path,
        id: &str,
        start_ms: u64,
        cue_end_ms: u64,
        duration_ms: u64,
    ) -> NarrationClip {
        let path = directory.join(format!("{id}.wav"));
        std::fs::write(&path, b"RIFFfixtureWAVEdata").unwrap();
        NarrationClip::new(
            SegmentId::new(id).unwrap(),
            AudioAsset::from_native_file(&path).unwrap(),
            TimeMicros::from_millis(start_ms).unwrap(),
            TimeMicros::from_millis(cue_end_ms).unwrap(),
            TimeMicros::from_millis(duration_ms).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn excess_overlap_is_recovered_without_fake_gap_distribution() {
        let directory = tempfile::tempdir().unwrap();
        let plan = AlignmentPlan::build(
            vec![
                clip(directory.path(), "one", 0, 1_000, 2_000),
                clip(directory.path(), "two", 1_000, 2_000, 800),
                clip(directory.path(), "three", 2_500, 3_000, 500),
            ],
            AlignmentPolicy::default(),
        )
        .unwrap();
        assert_eq!(plan.clips()[1].start().get(), 1_800_000);
        assert_eq!(plan.clips()[1].shift().get(), 800_000);
        assert_eq!(plan.clips()[2].start().get(), 2_500_000);
        assert_eq!(plan.stats().adjusted_count(), 1);
        assert_eq!(plan.stats().rendered_duration().get(), 3_250_000);
    }

    #[test]
    fn overlap_at_tolerance_is_not_shifted_and_ties_are_stable() {
        let directory = tempfile::tempdir().unwrap();
        let plan = AlignmentPlan::build(
            vec![
                clip(directory.path(), "first", 0, 1_000, 1_000),
                clip(directory.path(), "second", 700, 1_500, 500),
                clip(directory.path(), "third", 700, 1_500, 500),
            ],
            AlignmentPolicy::default(),
        )
        .unwrap();
        assert_eq!(plan.clips()[1].id().as_str(), "second");
        assert_eq!(plan.clips()[1].adjustment(), AlignmentAdjustment::Original);
        assert_eq!(plan.clips()[2].id().as_str(), "third");
    }

    #[test]
    fn plan_debug_never_exposes_asset_paths() {
        let directory = tempfile::tempdir().unwrap();
        let plan = AlignmentPlan::build(
            vec![clip(directory.path(), "private", 0, 100, 100)],
            AlignmentPolicy::default(),
        )
        .unwrap();
        assert!(!format!("{plan:?}").contains(directory.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn nested_short_clip_cannot_reduce_the_completed_timeline_frontier() {
        let directory = tempfile::tempdir().unwrap();
        let plan = AlignmentPlan::build(
            vec![
                clip(directory.path(), "long", 0, 10_000, 10_000),
                clip(directory.path(), "nested", 9_000, 9_100, 100),
                clip(directory.path(), "next", 9_650, 10_100, 100),
            ],
            AlignmentPolicy::default(),
        )
        .unwrap();
        assert_eq!(plan.clips()[2].start().get(), 9_800_000);
    }

    #[test]
    fn duplicate_segment_ids_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        assert!(
            AlignmentPlan::build(
                vec![
                    clip(directory.path(), "same", 0, 100, 100),
                    clip(directory.path(), "same", 200, 300, 100),
                ],
                AlignmentPolicy::default(),
            )
            .is_err()
        );
    }
}
