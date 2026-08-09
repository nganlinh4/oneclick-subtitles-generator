use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackOrigin {
    LegacyJson,
    Srt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCue {
    pub id: Uuid,
    pub ordinal: u32,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub source_id: Option<Uuid>,
}

impl SubtitleCue {
    pub fn new(start_ms: i64, end_ms: i64, text: String) -> Result<Self, SubtitleError> {
        Self::with_id(Uuid::new_v4(), start_ms, end_ms, text, None)
    }

    pub fn with_id(
        id: Uuid,
        start_ms: i64,
        end_ms: i64,
        text: String,
        source_id: Option<Uuid>,
    ) -> Result<Self, SubtitleError> {
        if start_ms < 0 {
            return Err(SubtitleError::NegativeStart(start_ms));
        }
        if end_ms <= start_ms {
            return Err(SubtitleError::InvalidRange { start_ms, end_ms });
        }

        Ok(Self {
            id,
            ordinal: 0,
            start_ms,
            end_ms,
            text,
            source_id,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrack {
    pub id: Uuid,
    pub label: String,
    pub origin: TrackOrigin,
    pub cues: Vec<SubtitleCue>,
    #[serde(skip_serializing)]
    prefix_max_end_ms: Vec<i64>,
}

impl SubtitleTrack {
    pub fn new(
        label: impl Into<String>,
        origin: TrackOrigin,
        mut cues: Vec<SubtitleCue>,
    ) -> Result<Self, SubtitleError> {
        if cues.is_empty() {
            return Err(SubtitleError::EmptyTrack);
        }

        cues.sort_by_key(|cue| (cue.start_ms, cue.end_ms, cue.ordinal));
        for (index, cue) in cues.iter_mut().enumerate() {
            cue.ordinal = u32::try_from(index + 1).map_err(|_| SubtitleError::TooManyCues)?;
        }

        let mut running_end = i64::MIN;
        let prefix_max_end_ms = cues
            .iter()
            .map(|cue| {
                running_end = running_end.max(cue.end_ms);
                running_end
            })
            .collect();

        let label = label.into();

        Ok(Self {
            id: Uuid::new_v4(),
            label: normalized_label(&label),
            origin,
            cues,
            prefix_max_end_ms,
        })
    }

    #[must_use]
    pub fn duration_ms(&self) -> i64 {
        self.prefix_max_end_ms.last().copied().unwrap_or_default()
    }

    #[must_use]
    pub fn active_cue_at(&self, time_ms: i64) -> Option<&SubtitleCue> {
        let upper_bound = self.cues.partition_point(|cue| cue.start_ms <= time_ms);
        if upper_bound == 0 {
            return None;
        }

        let mut index = upper_bound - 1;
        loop {
            let cue = &self.cues[index];
            if cue.end_ms > time_ms {
                return Some(cue);
            }
            if index == 0 || self.prefix_max_end_ms[index - 1] <= time_ms {
                return None;
            }
            index -= 1;
        }
    }
}

fn normalized_label(label: &str) -> String {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        "Imported subtitles".to_owned()
    } else {
        trimmed.to_owned()
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SubtitleError {
    #[error("a subtitle cue cannot start before zero milliseconds (received {0})")]
    NegativeStart(i64),
    #[error("a subtitle cue must end after it starts (start {start_ms}, end {end_ms})")]
    InvalidRange { start_ms: i64, end_ms: i64 },
    #[error("a subtitle track must contain at least one cue")]
    EmptyTrack,
    #[error("the subtitle track contains more cues than the supported ordinal range")]
    TooManyCues,
}

#[cfg(test)]
mod tests {
    use super::{SubtitleCue, SubtitleTrack, TrackOrigin};

    fn cue(start_ms: i64, end_ms: i64, text: &str) -> SubtitleCue {
        SubtitleCue::new(start_ms, end_ms, text.to_owned()).expect("valid cue")
    }

    #[test]
    fn track_sorts_and_reindexes_cues() {
        let track = SubtitleTrack::new(
            "Track".to_owned(),
            TrackOrigin::Srt,
            vec![cue(2_000, 3_000, "second"), cue(0, 1_000, "first")],
        )
        .expect("valid track");

        assert_eq!(track.cues[0].text, "first");
        assert_eq!(track.cues[0].ordinal, 1);
        assert_eq!(track.cues[1].ordinal, 2);
    }

    #[test]
    fn indexed_lookup_handles_overlapping_cues() {
        let track = SubtitleTrack::new(
            "Track".to_owned(),
            TrackOrigin::Srt,
            vec![
                cue(0, 10_000, "long"),
                cue(1_000, 2_000, "short"),
                cue(12_000, 13_000, "later"),
            ],
        )
        .expect("valid track");

        assert_eq!(
            track.active_cue_at(1_500).map(|item| item.text.as_str()),
            Some("short")
        );
        assert_eq!(
            track.active_cue_at(5_000).map(|item| item.text.as_str()),
            Some("long")
        );
        assert!(track.active_cue_at(11_000).is_none());
    }

    #[test]
    fn lookup_scales_to_large_tracks() {
        let cues = (0..10_000)
            .map(|index| {
                let start = i64::from(index) * 1_000;
                cue(start, start + 800, "caption")
            })
            .collect();
        let track =
            SubtitleTrack::new("Large".to_owned(), TrackOrigin::Srt, cues).expect("valid track");

        assert_eq!(
            track.active_cue_at(9_999_100).map(|item| item.ordinal),
            Some(10_000)
        );
    }
}
