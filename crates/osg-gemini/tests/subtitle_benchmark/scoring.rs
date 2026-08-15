use std::collections::HashMap;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::manifest::{TimedLine, TimingCase, TranscriptionCase, TranslationCase};

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ScoreOutcome {
    pub score: f64,
    pub strict_pass: bool,
    pub details: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubtitleOutput {
    #[serde(default)]
    index: Option<usize>,
    start_time: String,
    end_time: String,
    text: String,
}

#[derive(Debug, Deserialize)]
struct TranslationOutput {
    original: String,
    translated: String,
}

#[allow(clippy::too_many_lines)]
pub(crate) fn score_transcription(case: &TranscriptionCase, raw: &str) -> Result<ScoreOutcome> {
    let output: Vec<SubtitleOutput> = serde_json::from_str(raw)
        .with_context(|| format!("{} output is not a subtitle array", case.id))?;
    let mut parsed = Vec::with_capacity(output.len());
    for item in output {
        let start_ms = parse_timestamp(&item.start_time)?;
        let end_ms = parse_timestamp(&item.end_time)?;
        parsed.push((start_ms, end_ms, item.text));
    }

    let hypothesis = parsed
        .iter()
        .map(|(_, _, text)| text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if case.reference_text.is_empty() {
        let hallucinated_chars = normalized_chars(&hypothesis).len();
        let is_empty = parsed.is_empty();
        return Ok(ScoreOutcome {
            score: if is_empty { 1.0 } else { 0.0 },
            strict_pass: is_empty,
            details: json!({
                "hallucinatedChars": hallucinated_chars,
                "segments": parsed.len(),
                "speechExpected": false
            }),
        });
    }
    ensure!(
        !parsed.is_empty(),
        "{} returned no speech segments",
        case.id
    );

    let digit_aware = case.tags.iter().any(|tag| tag == "digits");
    let reference_words = normalized_transcript(&case.reference_text, digit_aware);
    let hypothesis_words = normalized_transcript(&hypothesis, digit_aware);
    let reference_chars = if digit_aware {
        normalized_chars(&reference_words.join(""))
    } else {
        normalized_chars(&case.reference_text)
    };
    let hypothesis_chars = if digit_aware {
        normalized_chars(&hypothesis_words.join(""))
    } else {
        normalized_chars(&hypothesis)
    };
    let wer = error_rate(&reference_words, &hypothesis_words);
    let cer = error_rate(&reference_chars, &hypothesis_chars);

    let mut monotonic = true;
    let mut valid_ranges = true;
    let mut bounded = true;
    let mut overlaps = 0_usize;
    let mut readability_violations = 0_usize;
    let mut previous_start = 0_u64;
    let mut previous_end = 0_u64;
    for (index, (start, end, text)) in parsed.iter().enumerate() {
        valid_ranges &= start < end;
        bounded &= *start <= case.duration_ms.saturating_add(1_000)
            && *end <= case.duration_ms.saturating_add(1_500);
        if index > 0 {
            monotonic &= *start >= previous_start;
            overlaps += usize::from(*start < previous_end);
        }
        let duration_seconds = as_f64_u64(end.saturating_sub(*start)) / 1_000.0;
        let cps = text
            .chars()
            .filter(|character| !character.is_whitespace())
            .count();
        let cps = as_f64_usize(cps) / duration_seconds.max(0.001);
        readability_violations += usize::from(duration_seconds < 0.2 || cps > 30.0);
        previous_start = *start;
        previous_end = *end;
    }

    let first_start = parsed.first().map_or(0, |item| item.0);
    let last_end = parsed.last().map_or(0, |item| item.1);
    let expected_start = case
        .expected_speech_start_ms
        .context("missing speech start")?;
    let expected_end = case.expected_speech_end_ms.context("missing speech end")?;
    let start_error_ms = first_start.abs_diff(expected_start);
    let end_error_ms = last_end.abs_diff(expected_end);
    let timing_score =
        1.0 - (as_f64_u64(start_error_ms.saturating_add(end_error_ms)) / 3_000.0).min(1.0);
    let structural_score = if monotonic && valid_ranges && bounded {
        1.0 - (as_f64_usize(overlaps + readability_violations) / as_f64_usize(parsed.len()))
            .min(1.0)
    } else {
        0.0
    };
    let accuracy = if digit_aware {
        1.0 - wer.min(1.0)
    } else if case.language == "Japanese" {
        1.0 - cer.min(1.0)
    } else {
        0.8 * (1.0 - wer.min(1.0)) + 0.2 * (1.0 - cer.min(1.0))
    };
    let score = 0.8 * accuracy + 0.1 * timing_score + 0.1 * structural_score;
    let strict_pass = if digit_aware {
        wer <= 0.25
    } else if case.language == "Japanese" {
        cer <= 0.20
    } else {
        wer <= 0.25 && cer <= 0.20
    } && start_error_ms <= 1_500
        && end_error_ms <= 1_500
        && monotonic
        && valid_ranges
        && bounded
        && overlaps == 0;

    Ok(ScoreOutcome {
        score: round_six(score),
        strict_pass,
        details: json!({
            "wer": round_six(wer),
            "cer": round_six(cer),
            "referenceWords": reference_words.len(),
            "hypothesisWords": hypothesis_words.len(),
            "segments": parsed.len(),
            "startErrorMs": start_error_ms,
            "endErrorMs": end_error_ms,
            "monotonic": monotonic,
            "validRanges": valid_ranges,
            "bounded": bounded,
            "overlaps": overlaps,
            "readabilityViolations": readability_violations,
            "normalization": if digit_aware { "digit-aware" } else { "unicode-alphanumeric" },
            "tags": &case.tags
        }),
    })
}

pub(crate) fn score_timing(case: &TimingCase, raw: &str) -> Result<ScoreOutcome> {
    let output: Vec<SubtitleOutput> = serde_json::from_str(raw)
        .with_context(|| format!("{} output is not a timed subtitle array", case.id))?;
    let parsed = output
        .iter()
        .map(|item| {
            let start = parse_timestamp(&item.start_time)?;
            let end = parse_timestamp(&item.end_time)?;
            ensure!(start < end, "{} returned an invalid interval", case.id);
            Ok((start, end))
        })
        .collect::<Result<Vec<_>>>()?;
    let cardinality = output.len() == case.lines.len();
    let mut exact = cardinality;
    let mut ordered = cardinality;
    let mut boundary_errors = Vec::new();
    let mut overlaps = Vec::new();
    for (position, expected) in case.lines.iter().enumerate() {
        let Some(actual) = output.get(position) else {
            exact = false;
            ordered = false;
            continue;
        };
        exact &= actual.index == Some(expected.index) && actual.text == expected.text;
        ordered &= actual.index == Some(position);
        let (start, end) = parsed[position];
        boundary_errors.push(start.abs_diff(expected.start_ms));
        boundary_errors.push(end.abs_diff(expected.end_ms));
        overlaps.push(interval_iou(start, end, expected));
    }
    let mae_ms = mean_u64(&boundary_errors).unwrap_or_else(|| as_f64_u64(case.duration_ms));
    let mean_iou = mean(&overlaps).unwrap_or(0.0);
    let coverage_score = if exact && ordered { 1.0 } else { 0.0 };
    let timing_score = 1.0 - (mae_ms / 1_500.0).min(1.0);
    let score = 0.5 * coverage_score + 0.3 * timing_score + 0.2 * mean_iou;
    Ok(ScoreOutcome {
        score: round_six(score),
        strict_pass: exact && ordered && mae_ms <= 500.0 && mean_iou >= 0.60,
        details: json!({
            "expectedLines": case.lines.len(),
            "returnedLines": output.len(),
            "cardinality": cardinality,
            "exactTextAndIndex": exact,
            "ordered": ordered,
            "boundaryMaeMs": round_six(mae_ms),
            "meanIntervalIou": round_six(mean_iou)
        }),
    })
}

pub(crate) fn score_translation(case: &TranslationCase, raw: &str) -> Result<ScoreOutcome> {
    let output: Vec<TranslationOutput> = serde_json::from_str(raw)
        .with_context(|| format!("{} output is not a translation array", case.id))?;
    let cardinality = output.len() == case.lines.len();
    let originals_exact = cardinality
        && output
            .iter()
            .zip(&case.lines)
            .all(|(actual, expected)| actual.original.as_str() == expected);
    let translations = output
        .iter()
        .map(|item| item.translated.as_str())
        .collect::<Vec<_>>();
    let joined_source = case.lines.join("\n");
    let joined_output = translations.join("\n");
    let protected_total = case.required_exact.len();
    let protected_preserved = case
        .required_exact
        .iter()
        .filter(|token| {
            count_occurrences(&joined_output, token) >= count_occurrences(&joined_source, token)
        })
        .count();
    let forbidden_found = case
        .forbidden_terms
        .iter()
        .filter(|term| joined_output.to_lowercase().contains(&term.to_lowercase()))
        .cloned()
        .collect::<Vec<_>>();
    let chrf_scores = translations
        .iter()
        .zip(&case.references)
        .map(|(actual, reference)| chrf(reference, actual))
        .collect::<Vec<_>>();
    let mean_chrf = mean(&chrf_scores).unwrap_or(0.0);
    let protected_score = if protected_total == 0 {
        1.0
    } else {
        as_f64_usize(protected_preserved) / as_f64_usize(protected_total)
    };
    let structural_score = if cardinality && originals_exact && forbidden_found.is_empty() {
        1.0
    } else {
        0.0
    };
    let score = 0.35 * structural_score + 0.25 * protected_score + 0.40 * mean_chrf;
    Ok(ScoreOutcome {
        score: round_six(score),
        strict_pass: cardinality
            && originals_exact
            && protected_preserved == protected_total
            && forbidden_found.is_empty()
            && mean_chrf >= 0.45,
        details: json!({
            "expectedLines": case.lines.len(),
            "returnedLines": output.len(),
            "cardinality": cardinality,
            "originalsExact": originals_exact,
            "protectedTotal": protected_total,
            "protectedPreserved": protected_preserved,
            "forbiddenFound": forbidden_found,
            "meanChrf": round_six(mean_chrf),
            "rubric": &case.rubric
        }),
    })
}

pub(crate) fn self_check() -> Result<()> {
    ensure!(
        parse_timestamp("00m05s100ms")? == 5_100,
        "timestamp parser drift"
    );
    ensure!(
        parse_timestamp("12m59s999ms")? == 779_999,
        "minute parser drift"
    );
    ensure!(
        parse_timestamp("00m01s00ms")? == 1_000 && parse_timestamp("00m10s63ms")? == 10_063,
        "production-compatible millisecond parsing drift"
    );
    ensure!(
        parse_timestamp("0m5s100ms").is_err(),
        "timestamps must retain leading zeros"
    );
    ensure!(
        (error_rate(&["a", "b"], &["a", "c"]) - 0.5).abs() < f64::EPSILON,
        "edit distance drift"
    );
    ensure!(
        chrf("same text", "same text") > 0.999,
        "chrF identity drift"
    );
    ensure!(chrf("alpha", "omega") < 0.35, "chrF discrimination drift");
    ensure!(
        normalized_transcript("TWO ZERO TWO SIX", true) == normalized_transcript("2 0 2 6", true),
        "digit normalization drift"
    );
    ensure!(
        normalized_transcript("too zero two six", true) != normalized_transcript("2 0 2 6", true),
        "digit normalization became homophone-lenient"
    );
    let silence = TranscriptionCase {
        id: "self-check-silence".to_owned(),
        difficulty: 1,
        fixture: "fixtures/en-silence.flac".to_owned(),
        mime_type: "audio/flac".to_owned(),
        sha256: String::new(),
        duration_ms: 5_000,
        language: "None".to_owned(),
        reference_text: String::new(),
        expected_speech_start_ms: None,
        expected_speech_end_ms: None,
        tags: vec!["silence".to_owned()],
    };
    ensure!(
        score_transcription(&silence, "[]")?.strict_pass,
        "empty silence response must pass"
    );
    ensure!(
        !score_transcription(
            &silence,
            r#"[{"startTime":"00m00s000ms","endTime":"00m01s000ms","text":"..."}]"#,
        )?
        .strict_pass,
        "punctuation-only silence hallucination must fail"
    );
    Ok(())
}

fn parse_timestamp(value: &str) -> Result<u64> {
    let (minutes, rest) = value.split_once('m').context("timestamp lacks minutes")?;
    let (seconds, millis) = rest.split_once('s').context("timestamp lacks seconds")?;
    let millis = millis
        .strip_suffix("ms")
        .context("timestamp lacks milliseconds")?;
    ensure!(
        minutes.len() >= 2 && seconds.len() == 2 && !millis.is_empty() && millis.len() <= 3,
        "timestamp padding is invalid"
    );
    ensure!(
        minutes.chars().all(|value| value.is_ascii_digit())
            && seconds.chars().all(|value| value.is_ascii_digit())
            && millis.chars().all(|value| value.is_ascii_digit()),
        "timestamp contains non-digits"
    );
    let minutes: u64 = minutes.parse()?;
    let seconds: u64 = seconds.parse()?;
    let millis: u64 = millis.parse()?;
    ensure!(seconds < 60, "timestamp seconds are out of range");
    ensure!(millis < 1_000, "timestamp milliseconds are out of range");
    minutes
        .checked_mul(60_000)
        .and_then(|value| value.checked_add(seconds * 1_000))
        .and_then(|value| value.checked_add(millis))
        .context("timestamp overflow")
}

fn normalized_words(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            current.push(character);
        } else if !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn normalized_transcript(value: &str, digit_aware: bool) -> Vec<String> {
    let words = normalized_words(value);
    if !digit_aware {
        return words;
    }
    words
        .into_iter()
        .flat_map(|word| {
            if word.chars().all(|character| character.is_ascii_digit()) {
                return word
                    .chars()
                    .map(|character| character.to_string())
                    .collect();
            }
            let digit = match word.as_str() {
                "zero" => Some("0"),
                "one" => Some("1"),
                "two" => Some("2"),
                "three" => Some("3"),
                "four" => Some("4"),
                "five" => Some("5"),
                "six" => Some("6"),
                "seven" => Some("7"),
                "eight" => Some("8"),
                "nine" => Some("9"),
                _ => None,
            };
            digit.map_or_else(|| vec![word], |digit| vec![digit.to_owned()])
        })
        .collect()
}

fn normalized_chars(value: &str) -> Vec<char> {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn error_rate<T: Eq>(reference: &[T], hypothesis: &[T]) -> f64 {
    if reference.is_empty() {
        return if hypothesis.is_empty() { 0.0 } else { 1.0 };
    }
    as_f64_usize(levenshtein(reference, hypothesis)) / as_f64_usize(reference.len())
}

fn levenshtein<T: Eq>(left: &[T], right: &[T]) -> usize {
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    let mut current = vec![0; right.len() + 1];
    for (left_index, left_item) in left.iter().enumerate() {
        current[0] = left_index + 1;
        for (right_index, right_item) in right.iter().enumerate() {
            current[right_index + 1] = if left_item == right_item {
                previous[right_index]
            } else {
                1 + previous[right_index]
                    .min(previous[right_index + 1])
                    .min(current[right_index])
            };
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()]
}

fn chrf(reference: &str, hypothesis: &str) -> f64 {
    let reference = normalize_chrf(reference);
    let hypothesis = normalize_chrf(hypothesis);
    let mut scores = Vec::new();
    for width in 1..=6 {
        let reference_ngrams = ngrams(&reference, width);
        let hypothesis_ngrams = ngrams(&hypothesis, width);
        if reference_ngrams.is_empty() && hypothesis_ngrams.is_empty() {
            continue;
        }
        let overlap: usize = reference_ngrams
            .iter()
            .map(|(gram, count)| count.min(hypothesis_ngrams.get(gram).unwrap_or(&0)))
            .sum();
        let precision =
            as_f64_usize(overlap) / as_f64_usize(hypothesis_ngrams.values().sum::<usize>().max(1));
        let recall =
            as_f64_usize(overlap) / as_f64_usize(reference_ngrams.values().sum::<usize>().max(1));
        let beta_squared = 4.0;
        let denominator = beta_squared * precision + recall;
        scores.push(if denominator == 0.0 {
            0.0
        } else {
            (1.0 + beta_squared) * precision * recall / denominator
        });
    }
    mean(&scores).unwrap_or(0.0)
}

fn normalize_chrf(value: &str) -> Vec<char> {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .flat_map(char::to_lowercase)
        .collect()
}

fn ngrams(characters: &[char], width: usize) -> HashMap<Vec<char>, usize> {
    if characters.len() < width {
        return HashMap::new();
    }
    let mut counts = HashMap::new();
    for window in characters.windows(width) {
        *counts.entry(window.to_vec()).or_insert(0) += 1;
    }
    counts
}

fn interval_iou(start: u64, end: u64, expected: &TimedLine) -> f64 {
    let intersection = end
        .min(expected.end_ms)
        .saturating_sub(start.max(expected.start_ms));
    let union = end
        .max(expected.end_ms)
        .saturating_sub(start.min(expected.start_ms));
    if union == 0 {
        0.0
    } else {
        as_f64_u64(intersection) / as_f64_u64(union)
    }
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        0
    } else {
        haystack.match_indices(needle).count()
    }
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / as_f64_usize(values.len()))
}

fn mean_u64(values: &[u64]) -> Option<f64> {
    (!values.is_empty()).then(|| {
        values.iter().map(|value| as_f64_u64(*value)).sum::<f64>() / as_f64_usize(values.len())
    })
}

fn round_six(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn as_f64_usize(value: usize) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

fn as_f64_u64(value: u64) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}
