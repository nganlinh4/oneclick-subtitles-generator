use std::sync::Arc;

use osg_domain::{AssetId, JobKind, JobSnapshot, JobUpdate};
use osg_gemini::{
    ApiKey, GeminiClient, ImageAspectRatio, ImageGenerateRequest, ImageModel, ImageSize,
    ReferenceImage,
};
use osg_infrastructure::secrets::{CredentialId, CredentialPurpose};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use tauri::{
    State,
    ipc::{Channel, InvokeResponseBody},
};

use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::image_blob::ImageBlobStore;
use crate::state::DesktopState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    missing_debug_implementations,
    reason = "the prompt is private user content"
)]
pub(crate) struct GeminiImageStartRequest {
    credential_id: CredentialId,
    model: ImageModel,
    prompt: String,
    reference_asset_id: AssetId,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum GeminiImageEvent {
    Completed {
        job: JobSnapshot,
        mime_type: &'static str,
        size_bytes: usize,
    },
    Cancelled {
        job: JobSnapshot,
    },
    Failed {
        job: Option<JobSnapshot>,
        error: CommandError,
    },
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Channel as owned command extractors"
)]
pub(crate) async fn gemini_image_start(
    state: State<'_, DesktopState>,
    images: State<'_, ImageBlobStore>,
    request: GeminiImageStartRequest,
    on_event: Channel<GeminiImageEvent>,
    on_image: Channel<InvokeResponseBody>,
) -> CommandResult<JobSnapshot> {
    let reference = images
        .resolve(request.reference_asset_id)?
        .ok_or_else(reference_unavailable)?;
    let jobs = Arc::clone(&state.jobs);
    let ticket = background::register_running(&jobs, JobKind::GenerateImage).await?;
    let initial = ticket.snapshot().clone();
    let job_id = initial.id();
    let cancellation = ticket.cancellation().clone();
    let credentials = state.credentials.clone();

    tauri::async_runtime::spawn(async move {
        let result = run_image(&credentials, request, reference, &cancellation, &on_image).await;

        match result {
            Ok((mime_type, size_bytes)) => {
                match background::apply(&jobs, job_id, JobUpdate::Succeed).await {
                    Ok(job) => {
                        let _ = on_event.send(GeminiImageEvent::Completed {
                            job,
                            mime_type,
                            size_bytes,
                        });
                    }
                    Err(error) => {
                        let job = background::snapshot(&jobs, job_id).await;
                        let _ = on_event.send(GeminiImageEvent::Failed { job, error });
                    }
                }
            }
            Err(error) if cancellation.is_cancelled() => {
                match background::finish_cancellation(&jobs, job_id).await {
                    Ok(job) => {
                        let _ = on_event.send(GeminiImageEvent::Cancelled { job });
                    }
                    Err(job_error) => {
                        let job = background::snapshot(&jobs, job_id).await;
                        let _ = on_event.send(GeminiImageEvent::Failed {
                            job,
                            error: job_error,
                        });
                    }
                }
                drop(error);
            }
            Err(error) => {
                let job = background::finish_failure(&jobs, job_id).await;
                let _ = on_event.send(GeminiImageEvent::Failed { job, error });
            }
        }
    });

    Ok(initial)
}

async fn run_image(
    credentials: &osg_infrastructure::secrets::CredentialService<
        osg_infrastructure::secrets::KeyringCredentialBackend,
    >,
    request: GeminiImageStartRequest,
    reference: ReferenceImage,
    cancellation: &osg_gemini::CancellationToken,
    image_channel: &Channel<InvokeResponseBody>,
) -> CommandResult<(&'static str, usize)> {
    let credential_id = request.credential_id;
    let credentials = credentials.clone();
    let secret = tauri::async_runtime::spawn_blocking(move || {
        credentials.resolve(credential_id, CredentialPurpose::GeminiApiKey)
    })
    .await
    .map_err(|_| CommandError::internal("The credential task stopped unexpectedly."))??;
    if cancellation.is_cancelled() {
        return Err(osg_gemini::Error::Cancelled.into());
    }

    let client = GeminiClient::new(ApiKey::new(secret.expose_secret().to_owned())?)?;
    let image = client
        .generate_image(
            ImageGenerateRequest {
                model: request.model,
                prompt: request.prompt,
                reference,
                aspect_ratio: ImageAspectRatio::Landscape16By9,
                image_size: ImageSize::OneK,
            },
            cancellation,
        )
        .await?;
    let mime_type = image.mime_type();
    let size_bytes = image.bytes().len();
    image_channel
        .send(InvokeResponseBody::Raw(image.bytes().to_vec()))
        .map_err(|_| CommandError::channel_closed())?;
    Ok((mime_type, size_bytes))
}

fn reference_unavailable() -> CommandError {
    CommandError::invalid_input("The reference image is no longer available.")
}

#[cfg(test)]
mod tests {
    use osg_domain::{JobKind, JobSnapshot, JobState};
    use serde_json::json;

    use super::{GeminiImageEvent, GeminiImageStartRequest};

    #[test]
    fn request_accepts_only_the_stable_video_capable_image_model() {
        let credential_id = osg_infrastructure::secrets::CredentialId::new();
        let reference_asset_id = osg_domain::AssetId::new();
        assert!(
            serde_json::from_value::<GeminiImageStartRequest>(json!({
                "credentialId": credential_id,
                "model": "gemini-3.1-flash-image",
                "prompt": "generate",
                "referenceAssetId": reference_asset_id
            }))
            .is_ok()
        );
        assert!(
            serde_json::from_value::<GeminiImageStartRequest>(json!({
                "credentialId": credential_id,
                "model": "gemini-2.5-flash-image",
                "prompt": "generate",
                "referenceAssetId": reference_asset_id
            }))
            .is_err()
        );
    }

    #[test]
    fn completion_metadata_is_binary_and_path_free() {
        let mut succeeded = JobSnapshot::new(JobKind::GenerateImage);
        succeeded.start().expect("start");
        succeeded.succeed().expect("succeed");
        assert_eq!(succeeded.state(), JobState::Succeeded);
        let value = serde_json::to_value(GeminiImageEvent::Completed {
            job: succeeded,
            mime_type: "image/png",
            size_bytes: 1024,
        })
        .expect("serialize");
        let serialized = value.to_string();
        assert!(!serialized.contains("path"));
        assert!(!serialized.contains("data"));
        assert_eq!(value["sizeBytes"], 1024);
    }
}
