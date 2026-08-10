use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{CueId, SubtitleCue, SubtitleTrack};

use super::SubtitleFormatError;

// A subtitle timestamp beyond one thousand Julian years is corrupt for every
// media container we support. Keeping an explicit product bound also makes the
// legacy floating-point conversion checked instead of relying on saturating
// float-to-integer casts.
const MAX_SUBTITLE_SECONDS: f64 = 31_557_600_000.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCue {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    original_id: Option<Value>,
    #[serde(default)]
    start: Option<f64>,
    #[serde(default)]
    end: Option<f64>,
    #[serde(default)]
    start_time: Option<f64>,
    #[serde(default)]
    end_time: Option<f64>,
    text: Option<String>,
}

pub fn parse_legacy_json(input: &str) -> Result<Vec<SubtitleCue>, SubtitleFormatError> {
    let raw: Vec<LegacyCue> = serde_json::from_str(input)?;
    if raw.is_empty() {
        return Err(SubtitleFormatError::EmptyDocument);
    }

    let assigned_ids: Vec<CueId> = raw.iter().map(|_| CueId::new()).collect();
    let legacy_ids: HashMap<String, CueId> = raw
        .iter()
        .zip(assigned_ids.iter().copied())
        .filter_map(|(cue, id)| cue.id.as_ref().and_then(identity_key).map(|key| (key, id)))
        .collect();

    raw.into_iter()
        .zip(assigned_ids)
        .enumerate()
        .map(|(index, (cue, id))| {
            let start_ms =
                seconds_to_milliseconds(cue.start.or(cue.start_time), index + 1, "start")?;
            let end_ms = seconds_to_milliseconds(cue.end.or(cue.end_time), index + 1, "end")?;
            let text = cue
                .text
                .ok_or_else(|| invalid_legacy(index + 1, "missing text"))?;
            let source_id = cue
                .original_id
                .as_ref()
                .and_then(identity_key)
                .and_then(|key| legacy_ids.get(&key).copied());
            SubtitleCue::with_id(id, start_ms, end_ms, text, source_id).map_err(Into::into)
        })
        .collect()
}

fn identity_key(value: &Value) -> Option<String> {
    serde_json::to_string(value).ok()
}

fn seconds_to_milliseconds(
    value: Option<f64>,
    index: usize,
    field: &str,
) -> Result<i64, SubtitleFormatError> {
    let seconds = value.ok_or_else(|| invalid_legacy(index, &format!("missing {field} time")))?;
    if !seconds.is_finite() || !(0.0..=MAX_SUBTITLE_SECONDS).contains(&seconds) {
        return Err(invalid_legacy(index, &format!("invalid {field} time")));
    }

    let milliseconds = (seconds * 1_000.0).round();
    format!("{milliseconds:.0}")
        .parse()
        .map_err(|_| invalid_legacy(index, &format!("invalid {field} time")))
}

fn invalid_legacy(index: usize, reason: &str) -> SubtitleFormatError {
    SubtitleFormatError::InvalidLegacyCue {
        index,
        reason: reason.to_owned(),
    }
}

#[derive(Serialize)]
struct ExportCue<'a> {
    id: u32,
    start: serde_json::Number,
    end: serde_json::Number,
    text: &'a str,
}

fn milliseconds_as_seconds(milliseconds: i64) -> serde_json::Number {
    let whole_seconds = milliseconds.div_euclid(1_000);
    let fractional_milliseconds = milliseconds.rem_euclid(1_000);

    format!("{whole_seconds}.{fractional_milliseconds:03}")
        .parse()
        .expect("validated subtitle milliseconds always form a JSON number")
}

pub fn write_legacy_json(track: &SubtitleTrack) -> Result<String, SubtitleFormatError> {
    let cues: Vec<ExportCue<'_>> = track
        .cues()
        .iter()
        .map(|cue| ExportCue {
            id: cue.ordinal(),
            start: milliseconds_as_seconds(cue.start_ms()),
            end: milliseconds_as_seconds(cue.end_ms()),
            text: cue.text(),
        })
        .collect();
    serde_json::to_string_pretty(&cues).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use crate::{SubtitleTrack, TrackOrigin};

    use super::{parse_legacy_json, write_legacy_json};

    #[test]
    fn accepts_legacy_timing_aliases_and_lineage() {
        let input = r#"[
          {"id": 10, "start": 2.745, "end": 4.025, "text": "First"},
          {"id": 11, "startTime": 4.1, "endTime": 5.2, "text": "Second", "originalId": 10}
        ]"#;
        let cues = parse_legacy_json(input).expect("valid legacy JSON");

        assert_eq!(cues[0].start_ms(), 2_745);
        assert_eq!(cues[1].end_ms(), 5_200);
        assert_eq!(cues[1].source_id(), Some(cues[0].id()));
    }

    #[test]
    fn exports_the_stable_legacy_minimum() {
        let track = SubtitleTrack::new(
            "Example".to_owned(),
            TrackOrigin::LegacyJson,
            parse_legacy_json(r#"[{"start":0,"end":1.25,"text":"Hello"}]"#).expect("valid JSON"),
        )
        .expect("valid track");
        let output = write_legacy_json(&track).expect("serializable track");

        assert!(output.contains("\"id\": 1"));
        assert!(output.contains("\"end\": 1.25"));
    }
}
