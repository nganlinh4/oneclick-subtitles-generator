use std::{
    collections::{BTreeMap, HashSet},
    path::{Component, Path, PathBuf},
};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Manifest {
    pub protocol_version: u32,
    pub scoring_version: String,
    pub models: Vec<String>,
    pub prompts: Prompts,
    pub transcription_cases: Vec<TranscriptionCase>,
    pub timing_cases: Vec<TimingCase>,
    pub translation_cases: Vec<TranslationCase>,
    #[serde(skip)]
    root: PathBuf,
    #[serde(skip)]
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Prompts {
    pub transcription: String,
    pub timing: String,
    pub translation: String,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TranscriptionCase {
    pub id: String,
    pub difficulty: u8,
    pub fixture: String,
    pub mime_type: String,
    pub sha256: String,
    pub duration_ms: u64,
    pub language: String,
    pub reference_text: String,
    pub expected_speech_start_ms: Option<u64>,
    pub expected_speech_end_ms: Option<u64>,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TimingCase {
    pub id: String,
    pub difficulty: u8,
    pub fixture: String,
    pub mime_type: String,
    pub sha256: String,
    pub duration_ms: u64,
    pub lines: Vec<TimedLine>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TimedLine {
    pub index: usize,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct TranslationCase {
    pub id: String,
    pub difficulty: u8,
    pub source_language: String,
    pub target_language: String,
    pub lines: Vec<String>,
    pub references: Vec<String>,
    pub required_exact: Vec<String>,
    pub forbidden_terms: Vec<String>,
    pub rubric: Vec<String>,
}

impl Manifest {
    pub(crate) fn load() -> Result<Self> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("tests/subtitle-benchmark")
            .canonicalize()
            .context("locate tests/subtitle-benchmark")?;
        let bytes = std::fs::read(root.join("manifest.json")).context("read manifest.json")?;
        let mut manifest: Self = serde_json::from_slice(&bytes).context("parse manifest.json")?;
        manifest.root = root;
        manifest.bytes = bytes;
        Ok(manifest)
    }

    pub(crate) fn fixture_path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    pub(crate) fn fingerprint(&self) -> Result<String> {
        let mut fixtures = BTreeMap::new();
        for (path, expected) in self.fixture_declarations() {
            fixtures.insert(path, expected);
        }
        let mut digest = Sha256::new();
        digest.update(b"osg-subtitle-benchmark\0");
        digest.update(&self.bytes);
        digest.update(b"\0scoring-source\0");
        digest.update(include_bytes!("scoring.rs"));
        digest.update(b"\0runner-source\0");
        digest.update(include_bytes!("runner.rs"));
        for (relative, _) in fixtures {
            digest.update(b"\0fixture\0");
            digest.update(relative.as_bytes());
            digest.update(b"\0");
            digest.update(std::fs::read(self.fixture_path(relative))?);
        }
        let digest = digest.finalize();
        Ok(hex_digest(&digest))
    }

    #[allow(clippy::too_many_lines)]
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(self.protocol_version == 1, "unsupported protocol version");
        ensure!(
            self.scoring_version == "osg-subtitle-metrics-2026-08-13-v2",
            "unsupported scoring version"
        );
        ensure!(
            !self.prompts.transcription.trim().is_empty()
                && self.prompts.timing.contains("{count}")
                && self.prompts.timing.contains("{numbered_lines}")
                && self.prompts.translation.contains("{target_language}")
                && self.prompts.translation.contains("{json_examples}"),
            "benchmark prompt templates are incomplete"
        );

        let native_models = osg_gemini::supported_models()
            .iter()
            .map(|spec| spec.api_id.to_owned())
            .collect::<Vec<_>>();
        ensure!(
            self.models == native_models,
            "manifest model order drifted from production catalog"
        );

        let mut ids = HashSet::new();
        validate_difficulties("transcription", &self.transcription_cases, |case| {
            (&case.id, case.difficulty)
        })?;
        validate_difficulties("timing", &self.timing_cases, |case| {
            (&case.id, case.difficulty)
        })?;
        validate_difficulties("translation", &self.translation_cases, |case| {
            (&case.id, case.difficulty)
        })?;

        for case in &self.transcription_cases {
            ensure!(
                ids.insert(case.id.as_str()),
                "duplicate case ID {}",
                case.id
            );
            ensure!(
                (250..=120_000).contains(&case.duration_ms),
                "{} duration is out of bounds",
                case.id
            );
            ensure!(
                !case.language.trim().is_empty() && !case.tags.is_empty(),
                "{} lacks language or tags",
                case.id
            );
            ensure!(
                matches!(
                    case.mime_type.as_str(),
                    "audio/flac" | "audio/mpeg" | "audio/wav" | "video/mp4"
                ),
                "{} has an unsupported benchmark MIME type",
                case.id
            );
            match (case.expected_speech_start_ms, case.expected_speech_end_ms) {
                (Some(start), Some(end)) => ensure!(
                    start < end && end <= case.duration_ms,
                    "{} has invalid speech bounds",
                    case.id
                ),
                (None, None) => ensure!(
                    case.reference_text.is_empty(),
                    "{} is speechless but has a reference",
                    case.id
                ),
                _ => anyhow::bail!("{} has incomplete speech bounds", case.id),
            }
        }
        for case in &self.timing_cases {
            ensure!(
                ids.insert(case.id.as_str()),
                "duplicate case ID {}",
                case.id
            );
            ensure!(!case.lines.is_empty(), "{} has no timed lines", case.id);
            for (expected, line) in case.lines.iter().enumerate() {
                ensure!(
                    line.index == expected,
                    "{} indices must be contiguous",
                    case.id
                );
                ensure!(
                    !line.text.trim().is_empty(),
                    "{} has an empty timed line",
                    case.id
                );
                ensure!(
                    line.start_ms < line.end_ms && line.end_ms <= case.duration_ms,
                    "{} has invalid line timing",
                    case.id
                );
            }
        }
        for case in &self.translation_cases {
            ensure!(
                ids.insert(case.id.as_str()),
                "duplicate case ID {}",
                case.id
            );
            ensure!(
                !case.lines.is_empty() && case.lines.len() == case.references.len(),
                "{} line/reference cardinality differs",
                case.id
            );
            ensure!(
                !case.source_language.trim().is_empty()
                    && !case.target_language.trim().is_empty()
                    && case.source_language != case.target_language,
                "{} has invalid translation languages",
                case.id
            );
            ensure!(
                case.lines.iter().all(|line| !line.trim().is_empty()),
                "{} has a blank source line",
                case.id
            );
            ensure!(
                case.references.iter().all(|line| !line.trim().is_empty()),
                "{} has a blank reference line",
                case.id
            );
            ensure!(
                !case.rubric.is_empty(),
                "{} needs a human-review rubric",
                case.id
            );
        }

        let mut declared = BTreeMap::new();
        for (relative, expected) in self.fixture_declarations() {
            validate_relative_fixture(relative)?;
            if let Some(previous) = declared.insert(relative, expected) {
                ensure!(
                    previous == expected,
                    "fixture {relative} has conflicting hashes"
                );
            }
        }
        for (relative, expected) in declared {
            let path = self.fixture_path(relative);
            let metadata = std::fs::symlink_metadata(&path)
                .with_context(|| format!("read fixture metadata for {relative}"))?;
            ensure!(
                metadata.file_type().is_file() && !metadata.file_type().is_symlink(),
                "{relative} is not a regular fixture"
            );
            let canonical = path
                .canonicalize()
                .with_context(|| format!("canonicalize fixture {relative}"))?;
            ensure!(
                canonical.starts_with(&self.root),
                "{relative} resolves outside the benchmark root"
            );
            ensure!(
                (1..=16 * 1024 * 1024).contains(&metadata.len()),
                "{relative} has an invalid size"
            );
            ensure!(
                sha256_file(&path)? == expected,
                "fixture hash mismatch for {relative}"
            );
        }
        Ok(())
    }

    fn fixture_declarations(&self) -> Vec<(&str, &str)> {
        self.transcription_cases
            .iter()
            .map(|case| (case.fixture.as_str(), case.sha256.as_str()))
            .chain(
                self.timing_cases
                    .iter()
                    .map(|case| (case.fixture.as_str(), case.sha256.as_str())),
            )
            .collect()
    }
}

fn validate_difficulties<T>(
    suite: &str,
    cases: &[T],
    identify: impl Fn(&T) -> (&String, u8),
) -> Result<()> {
    ensure!(!cases.is_empty(), "{suite} suite is empty");
    let expected = 1..=u8::try_from(cases.len()).context("too many benchmark cases")?;
    let actual = cases
        .iter()
        .map(|case| identify(case).1)
        .collect::<HashSet<_>>();
    ensure!(
        actual == expected.collect(),
        "{suite} difficulties must be contiguous from one"
    );
    let unique = cases
        .iter()
        .map(|case| identify(case).0)
        .collect::<HashSet<_>>();
    ensure!(
        unique.len() == cases.len(),
        "{suite} case IDs are not unique"
    );
    Ok(())
}

fn validate_relative_fixture(relative: &str) -> Result<()> {
    let path = Path::new(relative);
    ensure!(
        !path.is_absolute() && relative.starts_with("fixtures/"),
        "invalid fixture path {relative}"
    );
    ensure!(
        path.components()
            .all(|part| matches!(part, Component::Normal(_))),
        "unsafe fixture path {relative}"
    );
    ensure!(
        !relative.contains("videos/") && !relative.contains("subtitles/"),
        "legacy local media is forbidden"
    );
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let digest = Sha256::digest(bytes);
    Ok(hex_digest(&digest))
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}
