use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::StreamExt;
use osg_gemini::{
    CancellationToken, Error as GeminiError, GenerateRequest, GenerationConfig, MediaInput, Model,
    TokenUsage, UploadRequest,
};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::{
    manifest::{Manifest, TimingCase, TranscriptionCase, TranslationCase},
    report::{Attempt, Recorder, TokenUsageRecord, cell_key},
    scoring::{ScoreOutcome, score_timing, score_transcription, score_translation},
    setup::{CredentialPool, Pacer, Selection, Suite, output_dir, workspace_root},
};

const MAX_CAPTURED_OUTPUT_BYTES: usize = 1_048_576;

enum BenchmarkCase<'a> {
    Transcription(&'a TranscriptionCase),
    Timing(&'a TimingCase),
    Translation(&'a TranslationCase),
}

impl BenchmarkCase<'_> {
    fn suite(&self) -> Suite {
        match self {
            Self::Transcription(_) => Suite::Transcription,
            Self::Timing(_) => Suite::Timing,
            Self::Translation(_) => Suite::Translation,
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::Transcription(case) => &case.id,
            Self::Timing(case) => &case.id,
            Self::Translation(case) => &case.id,
        }
    }

    fn difficulty(&self) -> u8 {
        match self {
            Self::Transcription(case) => case.difficulty,
            Self::Timing(case) => case.difficulty,
            Self::Translation(case) => case.difficulty,
        }
    }

    fn media_duration_ms(&self) -> Option<u64> {
        match self {
            Self::Transcription(case) => Some(case.duration_ms),
            Self::Timing(case) => Some(case.duration_ms),
            Self::Translation(_) => None,
        }
    }
}

struct GenerationMetrics {
    raw: String,
    operation_ms: u64,
    upload_ms: Option<u64>,
    first_output_ms: Option<u64>,
    generation_ms: u64,
    usage: Option<TokenUsage>,
    model_version: Option<String>,
    cleanup_failed: bool,
}

#[allow(clippy::too_many_lines)]
pub(crate) async fn run() -> Result<()> {
    let manifest = Manifest::load()?;
    manifest.validate()?;
    let fingerprint = manifest.fingerprint()?;
    let selection = Selection::from_env(&manifest)?;
    let workspace = workspace_root()?;
    let mut credentials = CredentialPool::load(&workspace)?;
    let mut pacer = Pacer::from_env()?;
    let output = output_dir()?;
    let resume = std::env::var_os("SUBTITLE_BENCH_RESUME").is_some();
    let expected_cells = selected_case_count(&manifest, &selection) * selection.models.len();
    let mut recorder = Recorder::open(&output, resume, &manifest, &fingerprint, &selection)?;
    recorder.update(
        &manifest,
        &fingerprint,
        &selection,
        credentials.len(),
        expected_cells,
        "running",
    )?;
    let mut successful = recorder.successful_cells();

    println!(
        "subtitle benchmark: protocol={} fingerprint={} models={} cases={} credentials={} output={}",
        manifest.protocol_version,
        fingerprint,
        selection.models.len(),
        selected_case_count(&manifest, &selection),
        credentials.len(),
        output.display()
    );

    let max_difficulty = selected_cases(&manifest, &selection)
        .iter()
        .map(BenchmarkCase::difficulty)
        .max()
        .context("selected benchmark contains no cases")?;
    for difficulty in 1..=max_difficulty {
        for (suite_offset, suite) in Suite::ALL.into_iter().enumerate() {
            if !selection.suites.contains(&suite) {
                continue;
            }
            for benchmark_case in selected_cases(&manifest, &selection)
                .into_iter()
                .filter(|case| case.suite() == suite && case.difficulty() == difficulty)
            {
                let rotation =
                    (usize::from(difficulty - 1) + suite_offset) % selection.models.len();
                for model_offset in 0..selection.models.len() {
                    let model =
                        selection.models[(rotation + model_offset) % selection.models.len()];
                    let key = cell_key(suite.as_str(), benchmark_case.id(), model.api_id());
                    if successful.contains(&key) {
                        println!(
                            "skip successful cell: suite={} case={} model={}",
                            suite.as_str(),
                            benchmark_case.id(),
                            model.api_id()
                        );
                        continue;
                    }

                    pacer.wait().await;
                    let (credential_slot, client) = {
                        let credential = credentials.next();
                        (credential.slot().to_owned(), credential.client()?)
                    };
                    println!(
                        "start: difficulty={} suite={} case={} model={} credential={}",
                        difficulty,
                        suite.as_str(),
                        benchmark_case.id(),
                        model.api_id(),
                        credential_slot
                    );
                    let attempt = execute_cell(
                        &manifest,
                        &fingerprint,
                        &benchmark_case,
                        model,
                        &credential_slot,
                        &client,
                        &credentials,
                    )
                    .await;
                    let status = attempt.status.clone();
                    let score = attempt.score;
                    if status == "success" {
                        successful.insert(key);
                    }
                    recorder.append(attempt)?;
                    recorder.update(
                        &manifest,
                        &fingerprint,
                        &selection,
                        credentials.len(),
                        expected_cells,
                        "running",
                    )?;
                    println!(
                        "finish: suite={} case={} model={} status={} score={}",
                        suite.as_str(),
                        benchmark_case.id(),
                        model.api_id(),
                        status,
                        score.map_or_else(|| "n/a".to_owned(), |value| format!("{value:.4}"))
                    );
                }
            }
        }
    }

    recorder.finish(&manifest, &fingerprint, expected_cells)?;
    let final_state = if recorder.successful_cells().len() == expected_cells {
        "complete"
    } else {
        "complete_with_failures"
    };
    recorder.update(
        &manifest,
        &fingerprint,
        &selection,
        credentials.len(),
        expected_cells,
        final_state,
    )?;
    println!(
        "subtitle benchmark finished: state={} successful={}/{} output={}",
        final_state,
        recorder.successful_cells().len(),
        expected_cells,
        output.display()
    );
    Ok(())
}

async fn execute_cell(
    manifest: &Manifest,
    fingerprint: &str,
    benchmark_case: &BenchmarkCase<'_>,
    model: Model,
    credential_slot: &str,
    client: &osg_gemini::GeminiClient,
    credentials: &CredentialPool,
) -> Attempt {
    let started_at = now();
    let started = Instant::now();
    let result = generate(manifest, benchmark_case, model, client).await;
    let latency_ms = elapsed_ms(started.elapsed());
    let common = |status: &str| Attempt {
        protocol_version: manifest.protocol_version,
        scoring_version: manifest.scoring_version.clone(),
        fixture_fingerprint: fingerprint.to_owned(),
        suite: benchmark_case.suite().as_str().to_owned(),
        case_id: benchmark_case.id().to_owned(),
        difficulty: benchmark_case.difficulty(),
        model: model.api_id().to_owned(),
        credential_slot: credential_slot.to_owned(),
        status: status.to_owned(),
        failure_class: None,
        started_at: started_at.clone(),
        latency_ms,
        upload_ms: None,
        time_to_first_output_ms: None,
        generation_ms: None,
        media_duration_ms: benchmark_case.media_duration_ms(),
        real_time_factor: benchmark_case
            .media_duration_ms()
            .map(|duration| round_six(as_f64_u64(latency_ms) / as_f64_u64(duration))),
        output_chars: 0,
        token_usage: TokenUsageRecord::default(),
        provider_model_version: None,
        score: None,
        strict_pass: false,
        details: json!({}),
        raw_response: None,
        error: None,
        cleanup_failed: false,
    };

    let metrics = match result {
        Ok(metrics) => metrics,
        Err(error) => {
            let mut attempt = common("failed");
            attempt.failure_class = Some(classify_error(&error).to_owned());
            attempt.error = Some(credentials.redact(&error.to_string()));
            return attempt;
        }
    };
    let score_result = match benchmark_case {
        BenchmarkCase::Transcription(case) => score_transcription(case, &metrics.raw),
        BenchmarkCase::Timing(case) => score_timing(case, &metrics.raw),
        BenchmarkCase::Translation(case) => score_translation(case, &metrics.raw),
    };
    let usage = metrics
        .usage
        .as_ref()
        .map(token_usage_record)
        .unwrap_or_default();
    let mut attempt = common(if score_result.is_ok() {
        "success"
    } else {
        "failed"
    });
    attempt.upload_ms = metrics.upload_ms;
    attempt.latency_ms = metrics.operation_ms;
    attempt.real_time_factor = benchmark_case
        .media_duration_ms()
        .map(|duration| round_six(as_f64_u64(metrics.operation_ms) / as_f64_u64(duration)));
    attempt.time_to_first_output_ms = metrics.first_output_ms;
    attempt.generation_ms = Some(metrics.generation_ms);
    attempt.output_chars = metrics.raw.chars().count();
    attempt.token_usage = usage;
    attempt.provider_model_version = metrics.model_version;
    attempt.raw_response = Some(metrics.raw);
    attempt.cleanup_failed = metrics.cleanup_failed;
    match score_result {
        Ok(ScoreOutcome {
            score,
            strict_pass,
            details,
        }) => {
            attempt.score = Some(score);
            attempt.strict_pass = strict_pass;
            attempt.details = details;
        }
        Err(error) => {
            attempt.failure_class = Some("output-invalid".to_owned());
            attempt.error = Some(credentials.redact(&error.to_string()));
        }
    }
    attempt
}

async fn generate(
    manifest: &Manifest,
    benchmark_case: &BenchmarkCase<'_>,
    model: Model,
    client: &osg_gemini::GeminiClient,
) -> std::result::Result<GenerationMetrics, GeminiError> {
    let operation_started = Instant::now();
    let cancel = CancellationToken::new();
    let mut upload_ms = None;
    let mut uploaded_name = None;
    let media = match benchmark_case {
        BenchmarkCase::Transcription(case) => Some((&case.fixture, &case.mime_type)),
        BenchmarkCase::Timing(case) => Some((&case.fixture, &case.mime_type)),
        BenchmarkCase::Translation(_) => None,
    };
    let uploaded = if let Some((fixture, mime_type)) = media {
        let upload_started = Instant::now();
        let request = UploadRequest::new(manifest.fixture_path(fixture), mime_type)?
            .with_display_name(format!("OSG benchmark {}", benchmark_case.id()))?;
        let file = client.upload_file(request, &cancel).await?;
        uploaded_name = Some(file.name().to_owned());
        let active = match client.wait_until_active(file, &cancel).await {
            Ok(active) => active,
            Err(error) => {
                cleanup(client, uploaded_name.as_deref()).await;
                return Err(error);
            }
        };
        upload_ms = Some(elapsed_ms(upload_started.elapsed()));
        Some(active)
    } else {
        None
    };

    let (prompt, schema) = request_parts(manifest, benchmark_case);
    let request = GenerateRequest {
        model,
        prompt,
        system_instruction: None,
        media: uploaded.into_iter().map(MediaInput::Uploaded).collect(),
        generation: GenerationConfig {
            max_output_tokens: Some(8_192),
            thinking_level: Some(
                model
                    .spec()
                    .expect("benchmark models must come from the reviewed catalog")
                    .toolbox_thinking,
            ),
            media_resolution: None,
            response_json_schema: Some(schema),
        },
    };
    let generation_started = Instant::now();
    let generation = generate_text(client, request, &cancel, generation_started).await;
    let generation_ms = elapsed_ms(generation_started.elapsed());
    let operation_ms = elapsed_ms(operation_started.elapsed());
    let cleanup_failed = cleanup(client, uploaded_name.as_deref()).await;
    let (raw, first_output_ms, usage, model_version) = generation?;
    Ok(GenerationMetrics {
        raw,
        operation_ms,
        upload_ms,
        first_output_ms,
        generation_ms,
        usage,
        model_version,
        cleanup_failed,
    })
}

async fn generate_text(
    client: &osg_gemini::GeminiClient,
    request: GenerateRequest,
    cancel: &CancellationToken,
    started: Instant,
) -> std::result::Result<(String, Option<u64>, Option<TokenUsage>, Option<String>), GeminiError> {
    let mut stream = client.generate_stream(request, cancel).await?;
    let mut output = String::new();
    let mut first_output_ms = None;
    let mut usage = None;
    let mut model_version = None;
    while let Some(response) = stream.next().await {
        let response = response?;
        if let Some(text) = response.text() {
            first_output_ms.get_or_insert_with(|| elapsed_ms(started.elapsed()));
            ensure_output_bound(output.len(), text.len())?;
            output.push_str(&text);
        }
        if response.usage_metadata.is_some() {
            usage = response.usage_metadata;
        }
        if response.model_version.is_some() {
            model_version = response.model_version;
        }
    }
    if output.is_empty() {
        return Err(GeminiError::NoTextOutput);
    }
    Ok((output, first_output_ms, usage, model_version))
}

async fn cleanup(client: &osg_gemini::GeminiClient, name: Option<&str>) -> bool {
    let Some(name) = name else {
        return false;
    };
    client
        .delete_file(name, &CancellationToken::new())
        .await
        .is_err()
}

fn request_parts(manifest: &Manifest, benchmark_case: &BenchmarkCase<'_>) -> (String, Value) {
    match benchmark_case {
        BenchmarkCase::Transcription(_) => (
            manifest.prompts.transcription.clone(),
            subtitle_schema(false),
        ),
        BenchmarkCase::Timing(case) => {
            let numbered = case
                .lines
                .iter()
                .map(|line| format!("[{}] {}", line.index, line.text))
                .collect::<Vec<_>>()
                .join("\n");
            (
                manifest
                    .prompts
                    .timing
                    .replace("{count}", &case.lines.len().to_string())
                    .replace("{numbered_lines}", &numbered),
                subtitle_schema(true),
            )
        }
        BenchmarkCase::Translation(case) => {
            let examples = case
                .lines
                .iter()
                .map(|line| {
                    json!({
                        "original": line,
                        "translated": format!("[Translation of this line in {}]", case.target_language)
                    })
                })
                .collect::<Vec<_>>();
            let examples = serde_json::to_string_pretty(&examples)
                .expect("translation prompt examples must serialize");
            (
                manifest
                    .prompts
                    .translation
                    .replace("{count}", &case.lines.len().to_string())
                    .replace("{target_language}", &case.target_language)
                    .replace("{json_examples}", &examples),
                translation_schema(),
            )
        }
    }
}

fn subtitle_schema(provided: bool) -> Value {
    let mut properties = serde_json::Map::new();
    if provided {
        properties.insert(
            "index".to_owned(),
            json!({"type": "integer", "description": "0-based index from the provided list"}),
        );
    }
    properties.insert(
        "startTime".to_owned(),
        json!({"type": "string", "description": "Start time in MMmSSsNNNms format"}),
    );
    properties.insert(
        "endTime".to_owned(),
        json!({"type": "string", "description": "End time in MMmSSsNNNms format"}),
    );
    properties.insert("text".to_owned(), json!({"type": "string"}));
    let required = if provided {
        json!(["index", "startTime", "endTime", "text"])
    } else {
        json!(["startTime", "endTime", "text"])
    };
    json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": properties,
            "required": required
        }
    })
}

fn translation_schema() -> Value {
    json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "original": {"type": "string"},
                "translated": {"type": "string"}
            },
            "required": ["original", "translated"]
        }
    })
}

fn selected_cases<'a>(manifest: &'a Manifest, selection: &Selection) -> Vec<BenchmarkCase<'a>> {
    let mut cases = Vec::new();
    if selection.suites.contains(&Suite::Transcription) {
        cases.extend(
            manifest
                .transcription_cases
                .iter()
                .map(BenchmarkCase::Transcription),
        );
    }
    if selection.suites.contains(&Suite::Timing) {
        cases.extend(manifest.timing_cases.iter().map(BenchmarkCase::Timing));
    }
    if selection.suites.contains(&Suite::Translation) {
        cases.extend(
            manifest
                .translation_cases
                .iter()
                .map(BenchmarkCase::Translation),
        );
    }
    cases
}

fn selected_case_count(manifest: &Manifest, selection: &Selection) -> usize {
    selected_cases(manifest, selection).len()
}

fn token_usage_record(usage: &TokenUsage) -> TokenUsageRecord {
    TokenUsageRecord {
        prompt: usage.prompt_token_count,
        candidates: usage.candidates_token_count,
        total: usage.total_token_count,
        thoughts: usage.thoughts_token_count,
        cached: usage.cached_content_token_count,
    }
}

fn classify_error(error: &GeminiError) -> &'static str {
    match error {
        GeminiError::Cancelled => "cancelled",
        GeminiError::InvalidConfig(_) => "invalid-config",
        GeminiError::InvalidRequest(_) => "invalid-request",
        GeminiError::UnsupportedMimeType(_) => "unsupported-mime",
        GeminiError::InlineRequestTooLarge { .. }
        | GeminiError::UploadTooLarge { .. }
        | GeminiError::ResponseTooLarge { .. } => "size-limit",
        GeminiError::Io { .. } => "io",
        GeminiError::Transport(_) => "transport",
        GeminiError::Timeout { .. } => "timeout",
        GeminiError::Provider(error) if error.http_status == 429 => "rate-limit",
        GeminiError::Provider(_) => "provider",
        GeminiError::CooldownActive { .. } => "cooldown",
        GeminiError::UploadProtocol(_) | GeminiError::UploadOutcomeUnknown => "upload-protocol",
        GeminiError::FileProcessingFailed { .. } => "file-processing",
        GeminiError::NoTextOutput => "no-text-output",
        GeminiError::NoImageOutput
        | GeminiError::InvalidImageOutput
        | GeminiError::ImageOutputBlocked => "unexpected-image-output",
    }
}

fn ensure_output_bound(current: usize, additional: usize) -> std::result::Result<(), GeminiError> {
    if current.saturating_add(additional) > MAX_CAPTURED_OUTPUT_BYTES {
        Err(GeminiError::ResponseTooLarge {
            limit_bytes: MAX_CAPTURED_OUTPUT_BYTES,
        })
    } else {
        Ok(())
    }
}

fn elapsed_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn round_six(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn as_f64_u64(value: u64) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_preserve_the_production_task_shapes() {
        let manifest = Manifest::load().unwrap();
        let timing = BenchmarkCase::Timing(&manifest.timing_cases[0]);
        let (timing_prompt, timing_schema) = request_parts(&manifest, &timing);
        assert!(timing_prompt.contains("[0] I WOULD TRY"));
        assert!(timing_prompt.contains("exact text"));
        assert_eq!(
            timing_schema["items"]["required"],
            json!(["index", "startTime", "endTime", "text"])
        );

        let translation = BenchmarkCase::Translation(&manifest.translation_cases[0]);
        let (translation_prompt, translation_schema) = request_parts(&manifest, &translation);
        assert!(translation_prompt.contains("\"original\": \"The meeting starts at 09:30.\""));
        assert!(!translation_prompt.contains("[0] The meeting"));
        assert_eq!(
            translation_schema["items"]["required"],
            json!(["original", "translated"])
        );
    }
}
