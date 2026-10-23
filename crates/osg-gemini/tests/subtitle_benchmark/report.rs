use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{manifest::Manifest, setup::Selection};

#[path = "summary.rs"]
mod summary;

use summary::{CellCounts, write_reports};

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
        let cells = CellCounts {
            expected: expected_cells,
            attempted: attempted_cells,
            successful: successful_cells,
        };
        write_reports(&self.output, manifest, fingerprint, &cells, &self.attempts)
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

fn write_json(path: PathBuf, value: &impl Serialize) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    std::fs::write(path, bytes)?;
    Ok(())
}

fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown".to_owned())
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
