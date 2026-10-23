//! Prompt and response-schema shaping for each benchmark suite, mirroring the production tasks.

use serde_json::{Value, json};

use super::BenchmarkCase;
use crate::manifest::Manifest;

pub(super) fn request_parts(
    manifest: &Manifest,
    benchmark_case: &BenchmarkCase<'_>,
) -> (String, Value) {
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
