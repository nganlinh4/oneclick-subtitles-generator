//! Native speech synthesis: supervised workers, narration jobs, reference audio, alignment and
//! durable speech artifacts.

mod alignment;
mod alignment_job;
mod artifact_types;
mod artifacts;
mod batch;
mod commands;
mod export;
mod jobs;
mod lifecycle;
mod narration;
mod reference;
mod requests;
mod runtime;
mod runtime_workers;
mod voice_conversion;

use std::time::Duration;

pub(crate) use self::commands::{
    speech_alignment_result, speech_alignment_start, speech_job_results, speech_probe,
    speech_runtime_stop, speech_start, speech_status, speech_voice_conversion_start,
    speech_voice_inventory,
};
pub(crate) use self::export::{
    speech_artifact_export, speech_artifact_resolve, speech_playback_release,
};
pub(crate) use self::narration::{
    speech_artifact_edit, speech_project_narration_get, speech_project_narration_put,
};
pub(crate) use self::reference::{
    speech_reference_clear, speech_reference_commit, speech_reference_extract,
    speech_reference_get, speech_reference_import, speech_reference_select,
};
pub(crate) use self::runtime::SpeechRuntime;

pub(crate) const WORKER_BYTES: &[u8] =
    include_bytes!("../../../../crates/osg-speech/worker/osg_speech_worker.py");
const SPEECH_TIMEOUT: Duration = Duration::from_hours(2);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const REFERENCE_PREPARE_TIMEOUT: Duration = Duration::from_mins(10);
const REFERENCE_EXTRACTION_TIMEOUT: Duration = Duration::from_mins(5);
const NARRATION_EDIT_TIMEOUT: Duration = Duration::from_mins(10);
const MAX_SEGMENTS: usize = 1_000;
const MAX_BATCH_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_SEGMENT_TEXT_CHARACTERS: usize = 8_000;
const MAX_CHATTERBOX_TEXT_CHARACTERS: usize = 300;
const MAX_REFERENCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CONVERSION_INPUT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXPORT_ARCHIVE_BYTES: u64 = MAX_CONVERSION_INPUT_BYTES + 16 * 1024 * 1024;
const MAX_EXPORT_FILE_NAME_BYTES: usize = 128;
const MAX_ALIGNMENT_INPUT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ALIGNMENT_DURATION_MICROS: u64 = 4 * 60 * 60 * 1_000_000;
const ALIGNMENT_TIMEOUT: Duration = Duration::from_hours(2);
const ALIGNMENT_MANIFEST_SCOPE: &str = "speechAlignmentJobs";
const ALIGNMENT_MANIFEST_SCHEMA_VERSION: u32 = 2;
const PROJECT_NARRATION_SCOPE: &str = "projectNarration";
const PROJECT_NARRATION_SCHEMA_VERSION: u32 = 1;
const MAX_F5_REFERENCE_MS: u64 = 12_000;
const MAX_CHATTERBOX_REFERENCE_MS: u64 = 60_000;
const MANIFEST_SCOPE: &str = "speechJobs";
const MANIFEST_SCHEMA_VERSION: u32 = 2;
const MAX_LIFECYCLE_EPOCH: u64 = 9_007_199_254_740_991;
const CHATTERBOX_LANGUAGES: &[&str] = &[
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no",
    "pl", "pt", "ru", "sv", "sw", "tr", "zh",
];
pub(crate) const F5_MODEL_IDS: &[&str] = &[
    "f5tts-v1-base",
    "F5TTS_v1_Base",
    "f5tts-spanish",
    "f5tts-russian",
    "f5tts-portuguese-br",
    "f5tts-italian",
    "f5tts-vietnamese-vivoice",
    "f5tts-german",
    "f5tts-finnish",
    "f5tts-polish",
];

#[cfg(test)]
mod tests;
