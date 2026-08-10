use std::{env, fs, process::ExitCode};

use osg_gemini::{
    ApiKey, Error, GeminiClient, GenerateRequest, GenerationConfig, InlineMedia, MediaInput, Model,
    ThinkingLevel,
};
use tokio_util::sync::CancellationToken;

const MODELS: [Model; 4] = [
    Model::Gemini35FlashLite,
    Model::Gemini36Flash,
    Model::Gemini35Flash,
    Model::Gemini31FlashLite,
];

fn selected_model() -> Result<Option<Model>, &'static str> {
    let Ok(value) = env::var("OSG_GEMINI_SMOKE_MODEL") else {
        return Ok(None);
    };
    match value.as_str() {
        "gemini-3.5-flash-lite" => Ok(Some(Model::Gemini35FlashLite)),
        "gemini-3.6-flash" => Ok(Some(Model::Gemini36Flash)),
        "gemini-3.5-flash" => Ok(Some(Model::Gemini35Flash)),
        "gemini-3.1-flash-lite" => Ok(Some(Model::Gemini31FlashLite)),
        _ => Err("OSG_GEMINI_SMOKE_MODEL is not an allowed model"),
    }
}

fn failure_class(error: &Error) -> String {
    match error {
        Error::Cancelled => "cancelled".to_owned(),
        Error::InvalidConfig(_) => "invalid-config".to_owned(),
        Error::InvalidRequest(_) => "invalid-request".to_owned(),
        Error::UnsupportedMimeType(_) => "unsupported-mime".to_owned(),
        Error::InlineRequestTooLarge { .. } => "inline-too-large".to_owned(),
        Error::UploadTooLarge { .. } => "upload-too-large".to_owned(),
        Error::Io { .. } => "io".to_owned(),
        Error::Transport(kind) => format!("transport-{kind:?}"),
        Error::Timeout { .. } => "timeout".to_owned(),
        Error::Provider(provider) => format!("provider-http-{}", provider.http_status),
        Error::CooldownActive { .. } => "cooldown".to_owned(),
        Error::UploadProtocol(_) => "upload-protocol".to_owned(),
        Error::FileProcessingFailed { .. } => "file-processing".to_owned(),
        Error::UploadOutcomeUnknown => "upload-outcome-unknown".to_owned(),
        Error::ResponseTooLarge { .. } => "response-too-large".to_owned(),
        Error::NoTextOutput => "no-text".to_owned(),
        Error::NoImageOutput => "no-image".to_owned(),
        Error::InvalidImageOutput => "invalid-image".to_owned(),
        Error::ImageOutputBlocked => "image-blocked".to_owned(),
    }
}

fn read_required_file(variable: &'static str) -> Result<Vec<u8>, &'static str> {
    let path = env::var_os(variable).ok_or("live-smoke media path is not configured")?;
    fs::read(path).map_err(|_| "live-smoke media could not be read")
}

async fn run() -> Result<(), &'static str> {
    let key = env::var("GEMINI_API_KEY").map_err(|_| "GEMINI_API_KEY is not configured")?;
    let client = GeminiClient::new(ApiKey::new(key).map_err(|_| "GEMINI_API_KEY is invalid")?)
        .map_err(|_| "Gemini client configuration is invalid")?;
    let audio = read_required_file("OSG_GEMINI_SMOKE_AUDIO")?;
    let video = read_required_file("OSG_GEMINI_SMOKE_VIDEO")?;
    let model_filter = selected_model()?;
    let modality_filter = env::var("OSG_GEMINI_SMOKE_MODALITY").ok();
    if modality_filter
        .as_deref()
        .is_some_and(|value| !matches!(value, "audio" | "video"))
    {
        return Err("OSG_GEMINI_SMOKE_MODALITY must be audio or video");
    }
    let media = [
        ("audio", "audio/wav", audio, "AUDIO"),
        ("video", "video/mp4", video, "VIDEO"),
    ];
    let cancel = CancellationToken::new();
    let mut failed = false;

    for model in MODELS {
        if model_filter.is_some_and(|selected| selected != model) {
            continue;
        }
        for (label, mime, bytes, expected) in &media {
            if modality_filter
                .as_deref()
                .is_some_and(|selected| selected != *label)
            {
                continue;
            }
            let request = GenerateRequest {
                model,
                prompt:
                    "Respond with exactly one word describing the input medium: AUDIO or VIDEO."
                        .to_owned(),
                system_instruction: None,
                media: vec![MediaInput::Inline(
                    InlineMedia::new(*mime, bytes.clone())
                        .map_err(|_| "live-smoke media fixture is invalid")?,
                )],
                generation: GenerationConfig {
                    max_output_tokens: Some(256),
                    thinking_level: Some(ThinkingLevel::Minimal),
                    ..GenerationConfig::default()
                },
            };
            match client.generate(request, &cancel).await {
                Ok(response) => match response.required_text() {
                    Ok(text) if text.trim().eq_ignore_ascii_case(expected) => {
                        println!("PASS {} {label}", model.api_id());
                    }
                    Ok(_) => {
                        eprintln!("FAIL {} {label}: unexpected-output", model.api_id());
                        failed = true;
                    }
                    Err(error) => {
                        eprintln!("FAIL {} {label}: {}", model.api_id(), failure_class(&error));
                        failed = true;
                    }
                },
                Err(error) => {
                    eprintln!("FAIL {} {label}: {}", model.api_id(), failure_class(&error));
                    failed = true;
                }
            }
        }
    }

    if failed {
        Err("one or more live Gemini media checks failed")
    } else {
        Ok(())
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
