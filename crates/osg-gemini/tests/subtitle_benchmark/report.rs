use std::{
    collections::{BTreeMap, HashSet},
    fmt::Write as _,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{manifest::Manifest, setup::Selection};

pub(crate) const ATTEMPTS_FILE: &str = "attempts.jsonl";
const RUN_FILE: &str = "run.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Attempt {
    pub protocol_version: u32,
    pub scoring_version: String,
    pub fixture_fingerprint: String,
    pub suite: String,
    pub case_id: String,
    pub difficulty: u8,
    pub model: String,
    pub credential_slot: String,
    pub status: String,
    pub failure_class: Option<String>,
    pub started_at: String,
    pub latency_ms: u64,
    pub upload_ms: Option<u64>,
    pub time_to_first_output_ms: Option<u64>,
    pub generation_ms: Option<u64>,
    pub media_duration_ms: Option<u64>,
    pub real_time_factor: Option<f64>,
    pub output_chars: usize,
    pub token_usage: TokenUsageRecord,
    pub provider_model_version: Option<String>,
    pub score: Option<f64>,
    pub strict_pass: bool,
    pub details: Value,
    pub raw_response: Option<String>,
    pub error: Option<String>,
    pub cleanup_failed: bool,
}

impl Attempt {
    pub(crate) fn cell_key(&self) -> String {
        cell_key(&self.suite, &self.case_id, &self.model)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenUsageRecord {
    pub prompt: Option<u64>,
    pub candidates: Option<u64>,
    pub total: Option<u64>,
    pub thoughts: Option<u64>,
    pub cached: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunRecord {
    protocol_version: u32,
    scoring_version: String,
    fixture_fingerprint: String,
    state: String,
    started_at: String,
    updated_at: String,
    models: Vec<String>,
    suites: Vec<String>,
    credential_slots: usize,
    expected_cells: usize,
    attempted_cells: usize,
    successful_cells: usize,
    attempts: usize,
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

pub(crate) struct Recorder {
    output: PathBuf,
    attempts: Vec<Attempt>,
    append: File,
    started_at: String,
}

impl Recorder {
    pub(crate) fn open(
        output: &Path,
        resume: bool,
        manifest: &Manifest,
        fingerprint: &str,
        selection: &Selection,
    ) -> Result<Self> {
        if output.exists() {
            let metadata = std::fs::symlink_metadata(output).context("inspect benchmark output")?;
            ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "benchmark output must be a regular directory"
            );
            if !resume {
                ensure!(
                    std::fs::read_dir(output)?.next().is_none(),
                    "benchmark output already contains files; use SUBTITLE_BENCH_RESUME"
                );
            }
        } else {
            std::fs::create_dir_all(output).context("create benchmark output")?;
        }

        let attempts = if resume {
            validate_resume(output, manifest.protocol_version, fingerprint, selection)?
        } else {
            Vec::new()
        };
        let append = OpenOptions::new()
            .create(true)
            .append(true)
            .open(output.join(ATTEMPTS_FILE))
            .context("open append-only benchmark attempts")?;
        Ok(Self {
            output: output.to_owned(),
            attempts,
            append,
            started_at: now(),
        })
    }

    pub(crate) fn successful_cells(&self) -> HashSet<String> {
        self.attempts
            .iter()
            .filter(|attempt| attempt.status == "success")
            .map(Attempt::cell_key)
            .collect()
    }

    pub(crate) fn append(&mut self, attempt: Attempt) -> Result<()> {
        serde_json::to_writer(&mut self.append, &attempt).context("serialize benchmark attempt")?;
        self.append.write_all(b"\n")?;
        self.append.flush()?;
        self.append.sync_data()?;
        self.attempts.push(attempt);
        Ok(())
    }

    pub(crate) fn update(
        &self,
        manifest: &Manifest,
        fingerprint: &str,
        selection: &Selection,
        credential_slots: usize,
        expected_cells: usize,
        state: &str,
    ) -> Result<()> {
        let attempted_cells = self
            .attempts
            .iter()
            .map(Attempt::cell_key)
            .collect::<HashSet<_>>()
            .len();
        let successful_cells = self.successful_cells().len();
        let mut suites = selection
            .suites
            .iter()
            .map(|suite| suite.as_str().to_owned())
            .collect::<Vec<_>>();
        suites.sort();
        let record = RunRecord {
            protocol_version: manifest.protocol_version,
            scoring_version: manifest.scoring_version.clone(),
            fixture_fingerprint: fingerprint.to_owned(),
            state: state.to_owned(),
            started_at: self.started_at.clone(),
            updated_at: now(),
            models: selection
                .models
                .iter()
                .map(|model| model.api_id().to_owned())
                .collect(),
            suites,
            credential_slots,
            expected_cells,
            attempted_cells,
            successful_cells,
            attempts: self.attempts.len(),
        };
        write_json(self.output.join(RUN_FILE), &record)
    }

    pub(crate) fn finish(
        &self,
        manifest: &Manifest,
        fingerprint: &str,
        expected_cells: usize,
    ) -> Result<()> {
        let attempted_cells = self
            .attempts
            .iter()
            .map(Attempt::cell_key)
            .collect::<HashSet<_>>()
            .len();
        let successful_cells = self.successful_cells().len();
        let summary = Summary {
            protocol_version: manifest.protocol_version,
            scoring_version: manifest.scoring_version.clone(),
            fixture_fingerprint: fingerprint.to_owned(),
            generated_at: now(),
            expected_cells,
            attempted_cells,
            successful_cells,
            attempts: self.attempts.len(),
            complete: attempted_cells == expected_cells,
            groups: summarize_groups(&self.attempts),
        };
        write_json(self.output.join("summary.json"), &summary)?;
        std::fs::write(self.output.join("summary.md"), render_summary(&summary))?;
        std::fs::write(
            self.output.join("translation-review.md"),
            render_translation_review(manifest, &self.attempts),
        )?;
        Ok(())
    }
}

pub(crate) fn cell_key(suite: &str, case_id: &str, model: &str) -> String {
    format!("{suite}\0{case_id}\0{model}")
}

fn validate_resume(
    output: &Path,
    protocol: u32,
    fingerprint: &str,
    selection: &Selection,
) -> Result<Vec<Attempt>> {
    let run_path = output.join(RUN_FILE);
    ensure!(
        run_path.is_file(),
        "resume directory does not contain run.json"
    );
    let run: RunRecord =
        serde_json::from_slice(&std::fs::read(&run_path)?).context("parse resume run.json")?;
    ensure!(
        run.protocol_version == protocol,
        "resume protocol version differs"
    );
    ensure!(
        run.fixture_fingerprint == fingerprint,
        "resume fixture fingerprint differs"
    );
    let selected_models = selection
        .models
        .iter()
        .map(|model| model.api_id().to_owned())
        .collect::<Vec<_>>();
    let mut selected_suites = selection
        .suites
        .iter()
        .map(|suite| suite.as_str().to_owned())
        .collect::<Vec<_>>();
    selected_suites.sort();
    ensure!(
        run.models == selected_models,
        "resume model selection differs"
    );
    ensure!(
        run.suites == selected_suites,
        "resume suite selection differs"
    );

    let attempts_path = output.join(ATTEMPTS_FILE);
    if !attempts_path.exists() {
        return Ok(Vec::new());
    }
    let mut attempts = Vec::new();
    for (index, line) in BufReader::new(File::open(attempts_path)?)
        .lines()
        .enumerate()
    {
        let line = line?;
        ensure!(
            !line.trim().is_empty(),
            "attempts.jsonl contains a blank line at {}",
            index + 1
        );
        let attempt: Attempt = serde_json::from_str(&line)
            .with_context(|| format!("parse attempt line {}", index + 1))?;
        ensure!(
            attempt.protocol_version == protocol,
            "attempt protocol differs at line {}",
            index + 1
        );
        ensure!(
            attempt.fixture_fingerprint == fingerprint,
            "attempt fingerprint differs at line {}",
            index + 1
        );
        attempts.push(attempt);
    }
    Ok(attempts)
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

fn write_json(path: PathBuf, value: &impl Serialize) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    std::fs::write(path, bytes)?;
    Ok(())
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

fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown".to_owned())
}

fn as_f64_usize(value: usize) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use osg_gemini::Model;
    use serde_json::json;

    use super::*;
    use crate::setup::Suite;

    #[test]
    fn recorder_appends_reports_and_resumes_only_compatible_runs() {
        let manifest = Manifest::load().unwrap();
        manifest.validate().unwrap();
        let fingerprint = manifest.fingerprint().unwrap();
        let selection = Selection {
            models: vec![Model::Gemini31FlashLite],
            suites: HashSet::from([Suite::Translation]),
        };
        let temporary = tempfile::tempdir().unwrap();
        let output = temporary.path().join("run");
        let mut recorder =
            Recorder::open(&output, false, &manifest, &fingerprint, &selection).unwrap();
        recorder
            .update(&manifest, &fingerprint, &selection, 20, 1, "running")
            .unwrap();
        recorder
            .append(sample_attempt(&manifest, &fingerprint))
            .unwrap();
        recorder.finish(&manifest, &fingerprint, 1).unwrap();
        recorder
            .update(&manifest, &fingerprint, &selection, 20, 1, "complete")
            .unwrap();

        let summary: Value =
            serde_json::from_slice(&std::fs::read(output.join("summary.json")).unwrap()).unwrap();
        assert_eq!(summary["attemptedCells"], 1);
        assert_eq!(summary["successfulCells"], 1);
        assert_eq!(summary["groups"][0]["reliability"], 1.0);
        assert!(output.join("translation-review.md").is_file());

        let resumed = Recorder::open(&output, true, &manifest, &fingerprint, &selection).unwrap();
        assert_eq!(resumed.successful_cells().len(), 1);

        let incompatible = Selection {
            models: vec![Model::Gemini36Flash],
            suites: HashSet::from([Suite::Translation]),
        };
        assert!(Recorder::open(&output, true, &manifest, &fingerprint, &incompatible).is_err());
    }

    #[test]
    fn integer_percentiles_are_stable() {
        let mut values = vec![40, 10, 30, 20];
        assert_eq!(percentile(&mut values, 1, 2), Some(30));
        assert_eq!(percentile(&mut values, 9, 10), Some(40));
        assert_eq!(percentile(&mut [], 1, 2), None);
    }

    fn sample_attempt(manifest: &Manifest, fingerprint: &str) -> Attempt {
        Attempt {
            protocol_version: manifest.protocol_version,
            scoring_version: manifest.scoring_version.clone(),
            fixture_fingerprint: fingerprint.to_owned(),
            suite: "translation".to_owned(),
            case_id: "translation-01-en-vi-dialogue".to_owned(),
            difficulty: 1,
            model: Model::Gemini31FlashLite.api_id().to_owned(),
            credential_slot: "GEMINI_API_KEY".to_owned(),
            status: "success".to_owned(),
            failure_class: None,
            started_at: "2026-08-13T00:00:00Z".to_owned(),
            latency_ms: 100,
            upload_ms: None,
            time_to_first_output_ms: Some(40),
            generation_ms: Some(100),
            media_duration_ms: None,
            real_time_factor: None,
            output_chars: 55,
            token_usage: TokenUsageRecord {
                total: Some(20),
                ..TokenUsageRecord::default()
            },
            provider_model_version: Some("test-model".to_owned()),
            score: Some(0.9),
            strict_pass: true,
            details: json!({"meanChrf": 0.9}),
            raw_response: Some("[]".to_owned()),
            error: None,
            cleanup_failed: false,
        }
    }
}
