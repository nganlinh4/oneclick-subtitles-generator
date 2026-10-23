//! Gemini image generation: durable generated-image artifacts owned by projects.

mod commands;
mod completion;
mod format;
mod generation;
mod publication;
mod types;

use std::time::Duration;

pub(crate) use self::commands::{
    generated_image_clear, generated_image_delete, generated_image_export, generated_image_list,
    generated_image_playback_release, generated_image_resolve,
};
pub(crate) use self::completion::gemini_image_complete;
pub(crate) use self::generation::gemini_image_start;
pub(crate) use self::types::GeneratedImageRuntime;

const MAX_GENERATED_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PROJECT_IMAGES: usize = 64;
const MAX_EXPORT_NAME_BYTES: usize = 240;
const ARTIFACT_KIND_PREFIX: &str = "generatedBackgroundImage:";
const COMPLETION_ACK_TIMEOUT: Duration = Duration::from_secs(30);
const COMPLETION_ACK_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_COMPLETED_IMAGE_RECEIPTS: usize = 128;
const COMMIT_ON_JOB_SUCCESS_METADATA_KEY: &str = "commitOnJobSuccess";

#[cfg(test)]
mod tests;
