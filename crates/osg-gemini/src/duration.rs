use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{Error, Result, types::TranscriptionWord};

const NANOS_PER_SEC: u64 = 1_000_000_000;
const NANOS_PER_MS: u64 = 1_000_000;

/// Maximum allowable provider boundary overshoot in milliseconds.
pub const MAX_ALLOWED_END_OVERSHOOT_MS: i64 = 100;

/// Parses a protobuf duration string (e.g. "12.345678900s", "0s", "1.5s")
/// into exact nanoseconds using bounded integer arithmetic without floating-point loss.
pub fn parse_duration_nanos(duration_str: &str) -> Result<u64> {
    let s = duration_str.trim();
    if !s.ends_with('s') {
        return Err(Error::InvalidRequest(format!(
            "Invalid duration string format: duration must end with 's', got '{s}'"
        )));
    }
    let body = &s[..s.len() - 1];
    if body.is_empty() {
        return Err(Error::InvalidRequest("empty duration value".to_owned()));
    }
    if body.starts_with('-') {
        return Err(Error::InvalidRequest(format!(
            "Negative duration offset disallowed: '{s}'"
        )));
    }
    if body.starts_with('+') {
        return Err(Error::InvalidRequest(format!(
            "leading plus disallowed: '{s}'"
        )));
    }

    let mut parts = body.split('.');
    let secs_part = parts.next().unwrap_or("");
    let frac_part = parts.next();
    if parts.next().is_some() {
        return Err(Error::InvalidRequest(format!(
            "Malformed duration decimal: '{s}'"
        )));
    }

    // Parse seconds
    let secs: u64 = if secs_part.is_empty() {
        0
    } else {
        if !secs_part.chars().all(|c| c.is_ascii_digit()) {
            return Err(Error::InvalidRequest(format!(
                "non-digit characters in seconds: '{secs_part}'"
            )));
        }
        secs_part
            .parse::<u64>()
            .map_err(|_| Error::InvalidRequest(format!("seconds overflow: '{secs_part}'")))?
    };

    // Parse subsecond nanoseconds (up to 9 digits)
    let nanos: u64 = match frac_part {
        None => 0,
        Some(frac) => {
            if frac.is_empty() {
                0
            } else {
                if !frac.chars().all(|c| c.is_ascii_digit()) {
                    return Err(Error::InvalidRequest(format!(
                        "non-digit characters in fraction: '{frac}'"
                    )));
                }
                // Pad or truncate to exactly 9 digits
                let mut padded = [b'0'; 9];
                let take_len = frac.len().min(9);
                padded[..take_len].copy_from_slice(&frac.as_bytes()[..take_len]);
                let frac_9 = std::str::from_utf8(&padded)
                    .map_err(|_| Error::InvalidRequest("invalid utf8 fraction".to_owned()))?;
                frac_9
                    .parse::<u64>()
                    .map_err(|_| Error::InvalidRequest(format!("fraction parse error: '{frac}'")))?
            }
        }
    };

    secs.checked_mul(NANOS_PER_SEC)
        .and_then(|total_secs_nanos| total_secs_nanos.checked_add(nanos))
        .ok_or_else(|| Error::InvalidRequest(format!("total duration nanoseconds overflow: '{s}'")))
}

/// Parse duration string into integer milliseconds with truncation.
pub fn parse_duration_ms(duration_str: &str) -> Result<i64> {
    let nanos = parse_duration_nanos(duration_str)?;
    let ms = nanos / NANOS_PER_MS;
    i64::try_from(ms)
        .map_err(|_| Error::InvalidRequest(format!("milliseconds overflow: '{duration_str}'")))
}

/// Parse duration string directly into `std::time::Duration`.
pub fn parse_duration(duration_str: &str) -> Result<Duration> {
    let nanos = parse_duration_nanos(duration_str)?;
    Ok(Duration::from_nanos(nanos))
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WordProjectionStatus {
    /// Normal word strictly within media boundaries.
    Accepted,
    /// Word exceeded media boundary by <= 100ms and was clamped.
    Clamped {
        original_end_ms: i64,
        clamped_end_ms: i64,
        overshoot_ms: i64,
    },
    /// Word exceeded media boundary by > 100ms or started after media end.
    Quarantined {
        reason: String,
    },
    /// Word rejected due to malformed, negative, or reversed timestamps.
    Rejected {
        reason: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedWord {
    pub word: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub speaker_label: Option<String>,
    pub status: WordProjectionStatus,
}

/// Projects raw provider word observation against media/chunk duration bounds.
#[must_use]
pub fn project_word_with_100ms_overshoot_policy(
    raw_word: &TranscriptionWord,
    media_duration_ms: i64,
) -> ProjectedWord {
    let start_ms = match parse_duration_ms(&raw_word.start_offset) {
        Ok(ms) => ms,
        Err(e) => {
            return ProjectedWord {
                word: raw_word.word.clone(),
                start_ms: 0,
                end_ms: 0,
                speaker_label: raw_word.speaker_label.clone(),
                status: WordProjectionStatus::Rejected {
                    reason: format!("invalid_start_offset: {e}"),
                },
            };
        }
    };

    let end_ms = match parse_duration_ms(&raw_word.end_offset) {
        Ok(ms) => ms,
        Err(e) => {
            return ProjectedWord {
                word: raw_word.word.clone(),
                start_ms,
                end_ms: start_ms,
                speaker_label: raw_word.speaker_label.clone(),
                status: WordProjectionStatus::Rejected {
                    reason: format!("invalid_end_offset: {e}"),
                },
            };
        }
    };

    // Check 1: Reversed timestamps
    if end_ms < start_ms {
        return ProjectedWord {
            word: raw_word.word.clone(),
            start_ms,
            end_ms,
            speaker_label: raw_word.speaker_label.clone(),
            status: WordProjectionStatus::Rejected {
                reason: "reversed_timestamps".to_owned(),
            },
        };
    }

    // Check 2: Word starts after media end
    if start_ms > media_duration_ms {
        return ProjectedWord {
            word: raw_word.word.clone(),
            start_ms,
            end_ms,
            speaker_label: raw_word.speaker_label.clone(),
            status: WordProjectionStatus::Quarantined {
                reason: "starts_after_media_end".to_owned(),
            },
        };
    }

    // Check 3: End exceeds media duration
    if end_ms > media_duration_ms {
        let overshoot_ms = end_ms - media_duration_ms;
        if overshoot_ms <= MAX_ALLOWED_END_OVERSHOOT_MS {
            return ProjectedWord {
                word: raw_word.word.clone(),
                start_ms,
                end_ms: media_duration_ms, // clamped
                speaker_label: raw_word.speaker_label.clone(),
                status: WordProjectionStatus::Clamped {
                    original_end_ms: end_ms,
                    clamped_end_ms: media_duration_ms,
                    overshoot_ms,
                },
            };
        }
        return ProjectedWord {
            word: raw_word.word.clone(),
            start_ms,
            end_ms,
            speaker_label: raw_word.speaker_label.clone(),
            status: WordProjectionStatus::Quarantined {
                reason: format!("overshoot_exceeds_100ms_{overshoot_ms}ms"),
            },
        };
    }

    // Accepted normal word
    ProjectedWord {
        word: raw_word.word.clone(),
        start_ms,
        end_ms,
        speaker_label: raw_word.speaker_label.clone(),
        status: WordProjectionStatus::Accepted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nanosecond_precision() {
        assert_eq!(parse_duration_nanos("0s").unwrap(), 0);
        assert_eq!(parse_duration_nanos("1s").unwrap(), 1_000_000_000);
        assert_eq!(parse_duration_nanos("12.345s").unwrap(), 12_345_000_000);
        assert_eq!(parse_duration_nanos("0.000000001s").unwrap(), 1);
        assert_eq!(parse_duration_nanos("0.120s").unwrap(), 120_000_000);
        assert_eq!(parse_duration_nanos("1.500s").unwrap(), 1_500_000_000);
        assert_eq!(parse_duration_nanos("300.100s").unwrap(), 300_100_000_000);
    }

    #[test]
    fn test_subsecond_padding_and_truncation() {
        assert_eq!(parse_duration_nanos("1.1s").unwrap(), 1_100_000_000);
        assert_eq!(
            parse_duration_nanos("1.123456789123s").unwrap(),
            1_123_456_789
        );
    }

    #[test]
    fn test_duration_ms() {
        assert_eq!(parse_duration_ms("0.120s").unwrap(), 120);
        assert_eq!(parse_duration_ms("1.500s").unwrap(), 1500);
        assert_eq!(parse_duration_ms("300.100s").unwrap(), 300_100);
    }

    #[test]
    fn test_error_rejections() {
        assert!(parse_duration_nanos("-1s").is_err());
        assert!(parse_duration_nanos("+1s").is_err());
        assert!(parse_duration_nanos("12.34.5s").is_err());
        assert!(parse_duration_nanos("12s_foo").is_err());
        assert!(parse_duration_nanos("s").is_err());
        assert!(parse_duration_nanos("").is_err());
    }

    #[test]
    fn test_overshoot_policy() {
        let media_duration_ms = 300_000;

        // Case A: Normal
        let w_norm = TranscriptionWord {
            word: "valid".into(),
            start_offset: "298.000s".into(),
            end_offset: "299.500s".into(),
            speaker_label: Some("1".into()),
        };
        let p_norm = project_word_with_100ms_overshoot_policy(&w_norm, media_duration_ms);
        assert_eq!(p_norm.status, WordProjectionStatus::Accepted);
        assert_eq!(p_norm.start_ms, 298_000);
        assert_eq!(p_norm.end_ms, 299_500);

        // Case B: Clamped <= 100ms
        let w_clamp = TranscriptionWord {
            word: "overshoot".into(),
            start_offset: "299.500s".into(),
            end_offset: "300.100s".into(),
            speaker_label: None,
        };
        let p_clamp = project_word_with_100ms_overshoot_policy(&w_clamp, media_duration_ms);
        assert_eq!(
            p_clamp.status,
            WordProjectionStatus::Clamped {
                original_end_ms: 300_100,
                clamped_end_ms: 300_000,
                overshoot_ms: 100,
            }
        );
        assert_eq!(p_clamp.end_ms, 300_000);

        // Case C: Quarantined > 100ms
        let w_quar = TranscriptionWord {
            word: "excessive".into(),
            start_offset: "299.000s".into(),
            end_offset: "300.250s".into(),
            speaker_label: None,
        };
        let p_quar = project_word_with_100ms_overshoot_policy(&w_quar, media_duration_ms);
        assert_eq!(
            p_quar.status,
            WordProjectionStatus::Quarantined {
                reason: "overshoot_exceeds_100ms_250ms".into(),
            }
        );

        // Case D: Starts after media end
        let w_after = TranscriptionWord {
            word: "after".into(),
            start_offset: "301.000s".into(),
            end_offset: "302.000s".into(),
            speaker_label: None,
        };
        let p_after = project_word_with_100ms_overshoot_policy(&w_after, media_duration_ms);
        assert_eq!(
            p_after.status,
            WordProjectionStatus::Quarantined {
                reason: "starts_after_media_end".into(),
            }
        );

        // Case E: Reversed timestamps
        let w_rev = TranscriptionWord {
            word: "reversed".into(),
            start_offset: "10.000s".into(),
            end_offset: "8.000s".into(),
            speaker_label: None,
        };
        let p_rev = project_word_with_100ms_overshoot_policy(&w_rev, 30_000);
        assert_eq!(
            p_rev.status,
            WordProjectionStatus::Rejected {
                reason: "reversed_timestamps".into(),
            }
        );
    }
}
