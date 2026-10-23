//! Speech backend identity, status DTOs and validated synthesis requests.

use std::fmt;

use osg_domain::ProjectId;
use osg_engine_packages::SpeechPackageId;
use osg_infrastructure::secrets::CredentialId;
use osg_speech::{
    AudioAsset, ChatterboxSettings, EdgeSettings, F5Settings, GeminiSettings, GttsDomain,
    GttsSettings, LanguageTag, ModelId, NarrationBatch, SegmentId, SpeechBackend, SpeechError,
    SpeechText, SynthesisRequest, SynthesisSettings, VoiceId,
};
use serde::{Deserialize, Serialize};

use super::{
    CHATTERBOX_LANGUAGES, F5_MODEL_IDS, MAX_BATCH_TEXT_BYTES, MAX_CHATTERBOX_TEXT_CHARACTERS,
    MAX_LIFECYCLE_EPOCH, MAX_SEGMENT_TEXT_CHARACTERS, MAX_SEGMENTS,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SpeechBackendRequest {
    F5Tts,
    Chatterbox,
    EdgeTts,
    Gtts,
    GeminiTts,
}

impl SpeechBackendRequest {
    pub(super) const ALL: [Self; 5] = [
        Self::F5Tts,
        Self::Chatterbox,
        Self::EdgeTts,
        Self::Gtts,
        Self::GeminiTts,
    ];

    pub(super) const fn native(self) -> SpeechBackend {
        match self {
            Self::F5Tts => SpeechBackend::F5Tts,
            Self::Chatterbox => SpeechBackend::Chatterbox,
            Self::EdgeTts => SpeechBackend::EdgeTts,
            Self::Gtts => SpeechBackend::Gtts,
            Self::GeminiTts => SpeechBackend::GeminiLive,
        }
    }

    pub(super) const fn package(self) -> SpeechPackageId {
        match self {
            Self::F5Tts => SpeechPackageId::F5Tts,
            Self::Chatterbox => SpeechPackageId::Chatterbox,
            Self::EdgeTts => SpeechPackageId::EdgeTts,
            Self::Gtts => SpeechPackageId::Gtts,
            Self::GeminiTts => SpeechPackageId::GeminiTts,
        }
    }

    pub(super) const fn requires_reference(self) -> bool {
        matches!(self, Self::F5Tts | Self::Chatterbox)
    }

    pub(super) const fn supports_voice_inventory(self) -> bool {
        matches!(self, Self::EdgeTts | Self::Gtts | Self::GeminiTts)
    }

    pub(super) const fn maximum_text_characters(self) -> usize {
        match self {
            Self::Chatterbox => MAX_CHATTERBOX_TEXT_CHARACTERS,
            _ => MAX_SEGMENT_TEXT_CHARACTERS,
        }
    }
}

pub(super) const fn package_to_speech(backend: SpeechPackageId) -> SpeechBackendRequest {
    match backend {
        SpeechPackageId::F5Tts => SpeechBackendRequest::F5Tts,
        SpeechPackageId::Chatterbox => SpeechBackendRequest::Chatterbox,
        SpeechPackageId::EdgeTts => SpeechBackendRequest::EdgeTts,
        SpeechPackageId::Gtts => SpeechBackendRequest::Gtts,
        SpeechPackageId::GeminiTts => SpeechBackendRequest::GeminiTts,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "these independent capability flags are a stable path-free wire contract"
)]
pub(crate) struct SpeechBackendStatus {
    pub(super) backend: SpeechBackendRequest,
    pub(super) epoch: u64,
    pub(super) enabled: bool,
    pub(super) installed: bool,
    pub(super) ready: bool,
    pub(super) warm: bool,
    pub(super) requires_reference: bool,
    pub(super) supports_voice_inventory: bool,
    pub(super) supports_voice_conversion: bool,
    pub(super) requires_credential: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechStatusResponse {
    pub(super) backends: Vec<SpeechBackendStatus>,
    pub(super) max_segments_per_job: usize,
    pub(super) max_batch_text_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechVoiceResponse {
    pub(super) id: String,
    pub(super) display_name: String,
    pub(super) language: String,
    pub(super) gender: SpeechVoiceGenderResponse,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum SpeechVoiceGenderResponse {
    Female,
    Male,
    Neutral,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechProbeResponse {
    pub(super) status: SpeechBackendStatus,
    pub(super) voices: Vec<SpeechVoiceResponse>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechInventoryResponse {
    pub(super) backend: SpeechBackendRequest,
    pub(super) epoch: u64,
    pub(super) enabled: bool,
    pub(super) warm: bool,
    pub(super) voices: Vec<SpeechVoiceResponse>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SpeechSegmentRequest {
    pub(super) id: String,
    pub(super) text: String,
}

impl fmt::Debug for SpeechSegmentRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechSegmentRequest")
            .field("id", &self.id)
            .field("text", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Deserialize)]
#[serde(
    tag = "backend",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum SpeechProfileRequest {
    F5Tts {
        reference_text: Option<String>,
        model: Option<String>,
        speech_rate_milli: u16,
        nfe_steps: u8,
        sway_milli: i16,
        guidance_milli: u16,
        seed: Option<u64>,
        remove_silence: bool,
    },
    Chatterbox {
        language: String,
        exaggeration_milli: u16,
        cfg_weight_milli: u16,
    },
    EdgeTts {
        voice: String,
        rate_percent: i8,
        volume_percent: i8,
        pitch_hz: i8,
    },
    Gtts {
        language: String,
        domain: GttsDomainRequest,
        slow: bool,
    },
    GeminiTts {
        credential_ids: Vec<CredentialId>,
        model: String,
        voice: String,
        language: String,
        max_concurrency: usize,
    },
}

impl fmt::Debug for SpeechProfileRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechProfileRequest")
            .field("backend", &self.backend())
            .field("settings", &"<redacted>")
            .finish()
    }
}

impl SpeechProfileRequest {
    pub(super) const fn backend(&self) -> SpeechBackendRequest {
        match self {
            Self::F5Tts { .. } => SpeechBackendRequest::F5Tts,
            Self::Chatterbox { .. } => SpeechBackendRequest::Chatterbox,
            Self::EdgeTts { .. } => SpeechBackendRequest::EdgeTts,
            Self::Gtts { .. } => SpeechBackendRequest::Gtts,
            Self::GeminiTts { .. } => SpeechBackendRequest::GeminiTts,
        }
    }

    pub(super) fn credential_ids(&self) -> Vec<CredentialId> {
        match self {
            Self::GeminiTts { credential_ids, .. } => credential_ids.clone(),
            _ => Vec::new(),
        }
    }

    pub(super) const fn max_concurrency(&self) -> usize {
        match self {
            Self::GeminiTts {
                max_concurrency, ..
            } => *max_concurrency,
            _ => 1,
        }
    }

    pub(super) fn into_native(self) -> Result<SynthesisSettings, SpeechError> {
        Ok(match self {
            Self::F5Tts {
                reference_text,
                model,
                speech_rate_milli,
                nfe_steps,
                sway_milli,
                guidance_milli,
                seed,
                remove_silence,
            } => {
                if model
                    .as_deref()
                    .is_some_and(|model| !F5_MODEL_IDS.contains(&model))
                {
                    return Err(SpeechError::InvalidOption("unsupported F5 model ID"));
                }
                let settings = match reference_text {
                    Some(text) => F5Settings::new(SpeechText::new(text)?),
                    None => F5Settings::transcribe_reference(),
                };
                let settings = settings
                    .with_speech_rate_milli(speech_rate_milli)?
                    .with_nfe_steps(nfe_steps)?
                    .with_sway_milli(sway_milli)?
                    .with_guidance_milli(guidance_milli)?
                    .with_seed(seed)
                    .with_remove_silence(remove_silence);
                let settings = match model {
                    Some(model) => settings.with_model(ModelId::new(model)?),
                    None => settings,
                };
                SynthesisSettings::F5Tts(settings)
            }
            Self::Chatterbox {
                language,
                exaggeration_milli,
                cfg_weight_milli,
            } => {
                let language = language.to_ascii_lowercase();
                if !CHATTERBOX_LANGUAGES.contains(&language.as_str()) {
                    return Err(SpeechError::InvalidOption(
                        "unsupported Chatterbox language",
                    ));
                }
                SynthesisSettings::Chatterbox(ChatterboxSettings::new(
                    LanguageTag::new(language)?,
                    exaggeration_milli,
                    cfg_weight_milli,
                )?)
            }
            Self::EdgeTts {
                voice,
                rate_percent,
                volume_percent,
                pitch_hz,
            } => SynthesisSettings::EdgeTts(EdgeSettings::new(
                VoiceId::new(voice)?,
                rate_percent,
                volume_percent,
                pitch_hz,
            )?),
            Self::Gtts {
                language,
                domain,
                slow,
            } => SynthesisSettings::Gtts(GttsSettings::new(
                LanguageTag::new(language)?,
                domain.into(),
                slow,
            )),
            Self::GeminiTts {
                model,
                voice,
                language,
                ..
            } => {
                if !matches!(model.as_str(), "gemini-3.1-flash-tts-preview") {
                    return Err(SpeechError::InvalidOption(
                        "unsupported Gemini speech model ID",
                    ));
                }
                SynthesisSettings::GeminiLive(GeminiSettings::new(
                    ModelId::new(model)?,
                    VoiceId::new(voice)?,
                    LanguageTag::new(language)?,
                ))
            }
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum GttsDomainRequest {
    #[serde(rename = "com")]
    Com,
    #[serde(rename = "com.au")]
    ComAu,
    #[serde(rename = "co.uk")]
    CoUk,
    #[serde(rename = "us")]
    Us,
    #[serde(rename = "ca")]
    Ca,
    #[serde(rename = "co.in")]
    CoIn,
    #[serde(rename = "ie")]
    Ie,
    #[serde(rename = "co.za")]
    CoZa,
    #[serde(rename = "com.br")]
    ComBr,
    #[serde(rename = "pt")]
    Pt,
    #[serde(rename = "es")]
    Es,
    #[serde(rename = "com.mx")]
    ComMx,
    #[serde(rename = "fr")]
    Fr,
}

impl From<GttsDomainRequest> for GttsDomain {
    fn from(value: GttsDomainRequest) -> Self {
        match value {
            GttsDomainRequest::Com => Self::Com,
            GttsDomainRequest::ComAu => Self::ComAu,
            GttsDomainRequest::CoUk => Self::CoUk,
            GttsDomainRequest::Us => Self::Us,
            GttsDomainRequest::Ca => Self::Ca,
            GttsDomainRequest::CoIn => Self::CoIn,
            GttsDomainRequest::Ie => Self::Ie,
            GttsDomainRequest::CoZa => Self::CoZa,
            GttsDomainRequest::ComBr => Self::ComBr,
            GttsDomainRequest::Pt => Self::Pt,
            GttsDomainRequest::Es => Self::Es,
            GttsDomainRequest::ComMx => Self::ComMx,
            GttsDomainRequest::Fr => Self::Fr,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SpeechStartRequest {
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) segments: Vec<SpeechSegmentRequest>,
    pub(super) profile: SpeechProfileRequest,
    pub(super) reference_artifact_id: Option<String>,
    pub(super) lifecycle_epoch: u64,
}

impl fmt::Debug for SpeechStartRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechStartRequest")
            .field("project_id", &"<opaque>")
            .field(
                "expected_project_state_version",
                &self.expected_project_state_version,
            )
            .field("segment_count", &self.segments.len())
            .field("profile", &self.profile)
            .field("lifecycle_epoch", &self.lifecycle_epoch)
            .field(
                "reference_artifact_id",
                &self.reference_artifact_id.as_ref().map(|_| "<opaque>"),
            )
            .finish()
    }
}

pub(super) struct ValidatedSpeechStart {
    pub(super) project_id: ProjectId,
    pub(super) expected_project_state_version: u64,
    pub(super) backend: SpeechBackendRequest,
    pub(super) lifecycle_epoch: u64,
    pub(super) requests: Vec<SynthesisRequest>,
    pub(super) reference: Option<AudioAsset>,
    pub(super) credential_ids: Vec<CredentialId>,
    pub(super) max_concurrency: usize,
}

impl SpeechStartRequest {
    pub(super) fn validate(
        self,
        reference: Option<AudioAsset>,
    ) -> Result<ValidatedSpeechStart, SpeechError> {
        if self.segments.is_empty() || self.segments.len() > MAX_SEGMENTS {
            return Err(SpeechError::InvalidInput("invalid narration segment count"));
        }
        let backend = self.profile.backend();
        if self.lifecycle_epoch > MAX_LIFECYCLE_EPOCH {
            return Err(SpeechError::InvalidInput(
                "speech lifecycle epoch is invalid",
            ));
        }
        if self.expected_project_state_version > i64::MAX as u64 {
            return Err(SpeechError::InvalidInput(
                "speech project state version is invalid",
            ));
        }
        if backend.requires_reference() != reference.is_some() {
            return Err(SpeechError::InvalidInput(
                "reference capability does not match the speech backend",
            ));
        }
        let credential_ids = self.profile.credential_ids();
        let max_concurrency = self.profile.max_concurrency();
        if !(1..=10).contains(&max_concurrency) {
            return Err(SpeechError::InvalidInput(
                "narration concurrency is outside the supported range",
            ));
        }
        if backend == SpeechBackendRequest::GeminiTts
            && (credential_ids.is_empty()
                || credential_ids.len() > 10
                || credential_ids
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    != credential_ids.len())
        {
            return Err(SpeechError::InvalidInput(
                "Gemini narration credential pool is invalid",
            ));
        }
        let settings = self.profile.into_native()?;
        let maximum_characters = backend.maximum_text_characters();
        let mut total_bytes = 0_usize;
        let mut requests = Vec::with_capacity(self.segments.len());
        for segment in self.segments {
            if segment.text.chars().take(maximum_characters + 1).count() > maximum_characters {
                return Err(SpeechError::InvalidInput(
                    "narration segment text is too long",
                ));
            }
            total_bytes = total_bytes
                .checked_add(segment.text.len())
                .ok_or(SpeechError::InvalidInput("narration batch is too large"))?;
            if total_bytes > MAX_BATCH_TEXT_BYTES {
                return Err(SpeechError::InvalidInput("narration batch is too large"));
            }
            requests.push(SynthesisRequest::new(
                SegmentId::new(segment.id)?,
                SpeechText::new(segment.text)?,
                settings.clone(),
                reference.clone(),
            )?);
        }
        let requests = NarrationBatch::new(requests)?.into_requests();
        Ok(ValidatedSpeechStart {
            project_id: self.project_id,
            expected_project_state_version: self.expected_project_state_version,
            backend,
            lifecycle_epoch: self.lifecycle_epoch,
            requests,
            reference,
            credential_ids,
            max_concurrency,
        })
    }
}
