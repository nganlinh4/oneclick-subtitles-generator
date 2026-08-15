use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use osg_gemini::{ApiKey, GeminiClient, Model};
use tokio::time::Instant;

use crate::manifest::Manifest;

pub(crate) struct Credential {
    slot: String,
    secret: String,
}

impl Credential {
    pub(crate) fn slot(&self) -> &str {
        &self.slot
    }

    pub(crate) fn client(&self) -> Result<GeminiClient> {
        Ok(GeminiClient::new(ApiKey::new(self.secret.clone())?)?)
    }
}

pub(crate) struct CredentialPool {
    credentials: Vec<Credential>,
    cursor: usize,
}

impl CredentialPool {
    pub(crate) fn load(workspace: &Path) -> Result<Self> {
        let dotenv = parse_dotenv(&workspace.join(".env"));
        let mut credentials = Vec::new();
        let mut seen = HashSet::new();
        for index in 1..=20 {
            let slot = credential_slot(index);
            let value = std::env::var_os(&slot)
                .map(|value| value.to_string_lossy().into_owned())
                .or_else(|| dotenv.get(&slot).cloned())
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
            if let Some(secret) = value
                && seen.insert(secret.clone())
            {
                ApiKey::new(secret.clone())
                    .with_context(|| format!("validate credential in {slot}"))?;
                credentials.push(Credential { slot, secret });
            }
        }
        ensure!(!credentials.is_empty(), "no Gemini credentials were found");
        Ok(Self {
            credentials,
            cursor: 0,
        })
    }

    pub(crate) fn len(&self) -> usize {
        self.credentials.len()
    }

    pub(crate) fn next(&mut self) -> &Credential {
        let index = self.cursor % self.credentials.len();
        self.cursor = self.cursor.wrapping_add(1);
        &self.credentials[index]
    }

    pub(crate) fn redact(&self, value: &str) -> String {
        let mut output = value.to_owned();
        for credential in &self.credentials {
            if credential.secret.len() >= 8 {
                output = output.replace(&credential.secret, "[REDACTED]");
            }
        }
        output.chars().take(512).collect()
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum Suite {
    Transcription,
    Timing,
    Translation,
}

impl Suite {
    pub(crate) const ALL: [Self; 3] = [Self::Transcription, Self::Timing, Self::Translation];

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Transcription => "transcription",
            Self::Timing => "timing",
            Self::Translation => "translation",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|suite| suite.as_str() == value)
    }
}

pub(crate) struct Selection {
    pub models: Vec<Model>,
    pub suites: HashSet<Suite>,
}

impl Selection {
    pub(crate) fn from_env(manifest: &Manifest) -> Result<Self> {
        let models = match std::env::var("SUBTITLE_BENCH_MODELS") {
            Ok(value) => value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(parse_model)
                .collect::<Result<Vec<_>>>()?,
            Err(_) => manifest
                .models
                .iter()
                .map(|value| parse_model(value))
                .collect::<Result<Vec<_>>>()?,
        };
        ensure!(!models.is_empty(), "no benchmark models were selected");
        ensure!(
            models.iter().collect::<HashSet<_>>().len() == models.len(),
            "selected models are duplicated"
        );

        let suites = match std::env::var("SUBTITLE_BENCH_SUITES") {
            Ok(value) => value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| Suite::parse(value).with_context(|| format!("unknown suite {value}")))
                .collect::<Result<HashSet<_>>>()?,
            Err(_) => Suite::ALL.into_iter().collect(),
        };
        ensure!(!suites.is_empty(), "no benchmark suites were selected");
        Ok(Self { models, suites })
    }
}

pub(crate) struct Pacer {
    minimum_gap: Duration,
    last_start: Option<Instant>,
}

impl Pacer {
    pub(crate) fn from_env() -> Result<Self> {
        let milliseconds = std::env::var("SUBTITLE_BENCH_MIN_START_GAP_MS")
            .ok()
            .map(|value| value.parse::<u64>())
            .transpose()
            .context("parse SUBTITLE_BENCH_MIN_START_GAP_MS")?
            .unwrap_or(1_000);
        ensure!(
            milliseconds <= 60_000,
            "benchmark pacing exceeds 60 seconds"
        );
        Ok(Self {
            minimum_gap: Duration::from_millis(milliseconds),
            last_start: None,
        })
    }

    pub(crate) async fn wait(&mut self) {
        if let Some(last_start) = self.last_start {
            let remaining = self.minimum_gap.saturating_sub(last_start.elapsed());
            if !remaining.is_zero() {
                tokio::time::sleep(remaining).await;
            }
        }
        self.last_start = Some(Instant::now());
    }
}

pub(crate) fn workspace_root() -> Result<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .context("locate workspace root")
}

pub(crate) fn output_dir() -> Result<PathBuf> {
    let root = workspace_root()?;
    if let Some(path) = std::env::var_os("SUBTITLE_BENCH_RESUME") {
        return Ok(resolve_output_path(&root, PathBuf::from(path)));
    }
    if let Some(path) = std::env::var_os("SUBTITLE_BENCH_OUTPUT") {
        return Ok(resolve_output_path(&root, PathBuf::from(path)));
    }
    let timestamp = time::OffsetDateTime::now_utc().unix_timestamp();
    Ok(root
        .join("target/subtitle-benchmark/runs")
        .join(format!("{timestamp}-protocol1")))
}

fn resolve_output_path(workspace: &Path, path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        workspace.join(path)
    }
}

fn parse_model(value: &str) -> Result<Model> {
    osg_gemini::supported_models()
        .iter()
        .find(|spec| spec.api_id == value)
        .map(|spec| spec.model)
        .with_context(|| format!("model {value} is not in the production catalog"))
}

fn credential_slot(index: usize) -> String {
    if index == 1 {
        "GEMINI_API_KEY".to_owned()
    } else {
        format!("GEMINI_API_KEY_{index}")
    }
}

fn parse_dotenv(path: &Path) -> HashMap<String, String> {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    parse_dotenv_contents(&contents)
}

fn parse_dotenv_contents(contents: &str) -> HashMap<String, String> {
    let mut output = HashMap::new();
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let Some((name, raw_value)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if !canonical_slot(name) {
            continue;
        }
        let value = dotenv_value(raw_value);
        output.insert(name.to_owned(), value);
    }
    output
}

fn canonical_slot(value: &str) -> bool {
    if value == "GEMINI_API_KEY" {
        return true;
    }
    value
        .strip_prefix("GEMINI_API_KEY_")
        .and_then(|suffix| suffix.parse::<u8>().ok().map(|number| (suffix, number)))
        .is_some_and(|(suffix, number)| (2..=20).contains(&number) && suffix == number.to_string())
}

fn dotenv_value(raw: &str) -> String {
    let value = raw.trim();
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        return value[1..value.len() - 1].to_owned();
    }
    value
        .split_once(" #")
        .map_or(value, |(before, _)| before)
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{parse_dotenv_contents, resolve_output_path};

    #[test]
    fn dotenv_parser_accepts_only_canonical_bounded_slots() {
        let values = parse_dotenv_contents(
            "# ignored\nGEMINI_API_KEY=primary\nexport GEMINI_API_KEY_2=\"second\"\nGEMINI_API_KEY_20='twentieth'\nGEMINI_API_KEY_02=nope\nGEMINI_API_KEY_21=nope\nOTHER=secret\n",
        );
        assert_eq!(values.len(), 3);
        assert_eq!(values["GEMINI_API_KEY"], "primary");
        assert_eq!(values["GEMINI_API_KEY_2"], "second");
        assert_eq!(values["GEMINI_API_KEY_20"], "twentieth");
    }

    #[test]
    fn relative_output_paths_are_workspace_relative() {
        let workspace = Path::new("C:/workspace");
        assert_eq!(
            resolve_output_path(workspace, "target/run".into()),
            workspace.join("target/run")
        );
        let absolute = Path::new("C:/elsewhere/run").to_path_buf();
        assert_eq!(resolve_output_path(workspace, absolute.clone()), absolute);
    }
}
