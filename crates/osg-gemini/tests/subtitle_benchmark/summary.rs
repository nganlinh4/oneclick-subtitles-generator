//! Aggregated benchmark reports: `summary.json`, `summary.md`, and the translation review sheet.

use std::{
    collections::{BTreeMap, HashSet},
    fmt::Write as _,
    path::Path,
};

use anyhow::Result;
use serde::Serialize;

use super::{Attempt, now, write_json};
use crate::manifest::Manifest;

pub(super) struct CellCounts {
    pub(super) expected: usize,
    pub(super) attempted: usize,
    pub(super) successful: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    protocol_version: u32,
    scoring_version: String,
    fixture_fingerprint: String,
    generated_at: String,
    expected_cells: usize,
    attempted_cells: usize,
    successful_cells: usize,
    attempts: usize,
    complete: bool,
    groups: Vec<GroupSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupSummary {
    suite: String,
    model: String,
    attempt_count: usize,
    cell_count: usize,
    successful_attempts: usize,
    failed_attempts: usize,
    reliability: f64,
    strict_pass_rate: f64,
    mean_score: Option<f64>,
    median_latency_ms: Option<u64>,
    p90_time_to_first_output_ms: Option<u64>,
    total_tokens: u64,
    cleanup_failures: usize,
}

pub(super) fn write_reports(
    output: &Path,
    manifest: &Manifest,
    fingerprint: &str,
    cells: &CellCounts,
    attempts: &[Attempt],
) -> Result<()> {
    let summary = Summary {
        protocol_version: manifest.protocol_version,
        scoring_version: manifest.scoring_version.clone(),
        fixture_fingerprint: fingerprint.to_owned(),
        generated_at: now(),
        expected_cells: cells.expected,
        attempted_cells: cells.attempted,
        successful_cells: cells.successful,
        attempts: attempts.len(),
        complete: cells.attempted == cells.expected,
        groups: summarize_groups(attempts),
    };
    write_json(output.join("summary.json"), &summary)?;
    std::fs::write(output.join("summary.md"), render_summary(&summary))?;
    std::fs::write(
        output.join("translation-review.md"),
        render_translation_review(manifest, attempts),
    )?;
    Ok(())
}

fn summarize_groups(attempts: &[Attempt]) -> Vec<GroupSummary> {
    let mut grouped = BTreeMap::<(&str, &str), Vec<&Attempt>>::new();
    for attempt in attempts {
        grouped
            .entry((&attempt.suite, &attempt.model))
            .or_default()
            .push(attempt);
    }
    grouped
        .into_iter()
        .map(|((suite, model), attempts)| {
            let successful = attempts
                .iter()
                .filter(|attempt| attempt.status == "success")
                .copied()
                .collect::<Vec<_>>();
            let cell_count = attempts
                .iter()
                .map(|attempt| attempt.case_id.as_str())
                .collect::<HashSet<_>>()
                .len();
            let strict_passes = successful
                .iter()
                .filter(|attempt| attempt.strict_pass)
                .count();
            let scores = successful
                .iter()
                .filter_map(|attempt| attempt.score)
                .collect::<Vec<_>>();
            let mut latencies = attempts
                .iter()
                .map(|attempt| attempt.latency_ms)
                .collect::<Vec<_>>();
            let mut first_output = attempts
                .iter()
                .filter_map(|attempt| attempt.time_to_first_output_ms)
                .collect::<Vec<_>>();
            GroupSummary {
                suite: suite.to_owned(),
                model: model.to_owned(),
                attempt_count: attempts.len(),
                cell_count,
                successful_attempts: successful.len(),
                failed_attempts: attempts.len() - successful.len(),
                reliability: ratio(successful.len(), attempts.len()),
                strict_pass_rate: ratio(strict_passes, successful.len()),
                mean_score: mean(&scores),
                median_latency_ms: percentile(&mut latencies, 1, 2),
                p90_time_to_first_output_ms: percentile(&mut first_output, 9, 10),
                total_tokens: attempts
                    .iter()
                    .filter_map(|attempt| attempt.token_usage.total)
                    .sum(),
                cleanup_failures: attempts
                    .iter()
                    .filter(|attempt| attempt.cleanup_failed)
                    .count(),
            }
        })
        .collect()
}

fn render_summary(summary: &Summary) -> String {
    let mut output = format!(
        "# OSG subtitle benchmark summary\n\nProtocol: {}  \nScoring: `{}`  \nFixture fingerprint: `{}`  \nCells attempted: {}/{}  \nValid-output cells: {}  \nComplete: {}\n\n",
        summary.protocol_version,
        summary.scoring_version,
        summary.fixture_fingerprint,
        summary.attempted_cells,
        summary.expected_cells,
        summary.successful_cells,
        summary.complete
    );
    output.push_str("| Suite | Model | Reliability | Strict pass* | Mean score | Median latency | P90 first output | Tokens |\n");
    output.push_str("|---|---|---:|---:|---:|---:|---:|---:|\n");
    for group in &summary.groups {
        writeln!(
            output,
            "| {} | {} | {:.1}% | {:.1}% | {} | {} ms | {} ms | {} |",
            group.suite,
            group.model,
            group.reliability * 100.0,
            group.strict_pass_rate * 100.0,
            display_score(group.mean_score),
            display_number(group.median_latency_ms),
            display_number(group.p90_time_to_first_output_ms),
            group.total_tokens
        )
        .expect("writing to a String cannot fail");
    }
    output.push_str("\n*Strict-pass rate is conditional on successful provider output. Reliability is reported separately; translation still requires human review.\n");
    output
}

fn render_translation_review(manifest: &Manifest, attempts: &[Attempt]) -> String {
    let rubrics = manifest
        .translation_cases
        .iter()
        .map(|case| (case.id.as_str(), case.rubric.as_slice()))
        .collect::<BTreeMap<_, _>>();
    let mut latest = BTreeMap::<(&str, &str), &Attempt>::new();
    for attempt in attempts
        .iter()
        .filter(|attempt| attempt.suite == "translation" && attempt.status == "success")
    {
        latest.insert((&attempt.case_id, &attempt.model), attempt);
    }
    let mut output = "# Translation human review\n\nAutomatic chrF is only an aid. Score each rubric item against the recorded output before publishing a translation ranking.\n\n".to_owned();
    for ((case_id, model), attempt) in latest {
        writeln!(output, "## {case_id} — {model}\n").expect("writing to a String cannot fail");
        if let Some(rubric) = rubrics.get(case_id) {
            for item in *rubric {
                writeln!(output, "- [ ] {item}").expect("writing to a String cannot fail");
            }
        }
        output.push_str("\n```json\n");
        output.push_str(attempt.raw_response.as_deref().unwrap_or(""));
        output.push_str("\n```\n\n");
    }
    output
}

fn percentile(values: &mut [u64], numerator: usize, denominator: usize) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    let position = (values.len() - 1)
        .saturating_mul(numerator)
        .div_ceil(denominator);
    values.get(position).copied()
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| {
        let value = values.iter().sum::<f64>() / as_f64_usize(values.len());
        (value * 1_000_000.0).round() / 1_000_000.0
    })
}

fn ratio(numerator: usize, denominator: usize) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        as_f64_usize(numerator) / as_f64_usize(denominator)
    }
}

fn display_score(value: Option<f64>) -> String {
    value.map_or_else(|| "—".to_owned(), |value| format!("{value:.4}"))
}

fn display_number(value: Option<u64>) -> String {
    value.map_or_else(|| "—".to_owned(), |value| value.to_string())
}

fn as_f64_usize(value: usize) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::percentile;

    #[test]
    fn integer_percentiles_are_stable() {
        let mut values = vec![40, 10, 30, 20];
        assert_eq!(percentile(&mut values, 1, 2), Some(30));
        assert_eq!(percentile(&mut values, 9, 10), Some(40));
        assert_eq!(percentile(&mut [], 1, 2), None);
    }
}
