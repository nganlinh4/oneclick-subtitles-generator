use crate::{SubtitleCue, SubtitleTrack};

use super::SubtitleFormatError;

pub fn parse_srt(input: &str) -> Result<Vec<SubtitleCue>, SubtitleFormatError> {
    let normalized = input
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    let blocks: Vec<&str> = normalized
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .collect();
    if blocks.is_empty() {
        return Err(SubtitleFormatError::EmptyDocument);
    }

    blocks
        .into_iter()
        .enumerate()
        .map(|(index, block)| parse_block(index + 1, block))
        .collect()
}

fn parse_block(block_number: usize, block: &str) -> Result<SubtitleCue, SubtitleFormatError> {
    let lines: Vec<&str> = block.lines().collect();
    let timing_index = usize::from(
        lines
            .first()
            .is_some_and(|line| line.trim().parse::<u32>().is_ok()),
    );
    let timing = lines
        .get(timing_index)
        .ok_or_else(|| invalid_block(block_number, "missing timing line"))?;
    let (start, end) = timing
        .split_once("-->")
        .ok_or_else(|| invalid_block(block_number, "timing line must contain `-->`"))?;
    let start_ms = parse_timestamp(start.trim())?;
    let end_token = end
        .split_whitespace()
        .next()
        .ok_or_else(|| invalid_block(block_number, "missing end timestamp"))?;
    let end_ms = parse_timestamp(end_token)?;
    let text = lines.get(timing_index + 1..).unwrap_or_default().join("\n");

    SubtitleCue::new(start_ms, end_ms, text).map_err(Into::into)
}

fn invalid_block(block: usize, reason: &str) -> SubtitleFormatError {
    SubtitleFormatError::InvalidSrtCue {
        block,
        reason: reason.to_owned(),
    }
}

fn parse_timestamp(value: &str) -> Result<i64, SubtitleFormatError> {
    let normalized = value.replace('.', ",");
    let (clock, fraction) = normalized
        .split_once(',')
        .ok_or_else(|| SubtitleFormatError::InvalidTimestamp(value.to_owned()))?;
    let clock_parts: Vec<&str> = clock.split(':').collect();
    if clock_parts.len() != 3 || fraction.is_empty() || fraction.len() > 3 {
        return Err(SubtitleFormatError::InvalidTimestamp(value.to_owned()));
    }

    let hours = parse_timestamp_part(clock_parts[0], value)?;
    let minutes = parse_timestamp_part(clock_parts[1], value)?;
    let seconds = parse_timestamp_part(clock_parts[2], value)?;
    if minutes >= 60 || seconds >= 60 || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(SubtitleFormatError::InvalidTimestamp(value.to_owned()));
    }

    let fraction_value = fraction
        .parse::<i64>()
        .map_err(|_| SubtitleFormatError::InvalidTimestamp(value.to_owned()))?;
    let milliseconds = match fraction.len() {
        1 => fraction_value * 100,
        2 => fraction_value * 10,
        _ => fraction_value,
    };

    hours
        .checked_mul(3_600_000)
        .and_then(|total| {
            minutes
                .checked_mul(60_000)
                .and_then(|minutes_ms| total.checked_add(minutes_ms))
        })
        .and_then(|total| {
            seconds
                .checked_mul(1_000)
                .and_then(|seconds_ms| total.checked_add(seconds_ms))
        })
        .and_then(|total| total.checked_add(milliseconds))
        .ok_or_else(|| SubtitleFormatError::InvalidTimestamp(value.to_owned()))
}

fn parse_timestamp_part(part: &str, original: &str) -> Result<i64, SubtitleFormatError> {
    part.parse::<i64>()
        .map_err(|_| SubtitleFormatError::InvalidTimestamp(original.to_owned()))
}

#[must_use]
pub fn write_srt(track: &SubtitleTrack) -> String {
    let mut output = String::new();
    for cue in track.cues() {
        output.push_str(&cue.ordinal().to_string());
        output.push('\n');
        output.push_str(&format_timestamp(cue.start_ms()));
        output.push_str(" --> ");
        output.push_str(&format_timestamp(cue.end_ms()));
        output.push('\n');
        output.push_str(cue.text());
        output.push_str("\n\n");
    }
    output
}

#[must_use]
pub fn write_text(track: &SubtitleTrack) -> String {
    track
        .cues()
        .iter()
        .map(SubtitleCue::text)
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_timestamp(value_ms: i64) -> String {
    let hours = value_ms / 3_600_000;
    let minutes = value_ms % 3_600_000 / 60_000;
    let seconds = value_ms % 60_000 / 1_000;
    let milliseconds = value_ms % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}")
}

#[cfg(test)]
mod tests {
    use crate::{SubtitleTrack, TrackOrigin};

    use super::{parse_srt, write_srt};

    #[test]
    fn parses_bom_crlf_multiline_and_fraction_variants() {
        let input = "\u{feff}1\r\n00:00:01,5 --> 00:00:02.250\r\nFirst line\r\nSecond line\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,010\r\nDone\r\n";
        let cues = parse_srt(input).expect("valid SRT");

        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start_ms(), 1_500);
        assert_eq!(cues[0].end_ms(), 2_250);
        assert_eq!(cues[0].text(), "First line\nSecond line");
    }

    #[test]
    fn writes_sequential_millisecond_srt() {
        let track = SubtitleTrack::new(
            "Example".to_owned(),
            TrackOrigin::Srt,
            parse_srt("8\n00:00:02,745 --> 00:00:04,025\nHello\n").expect("valid SRT"),
        )
        .expect("valid track");

        assert_eq!(
            write_srt(&track),
            "1\n00:00:02,745 --> 00:00:04,025\nHello\n\n"
        );
    }
}
