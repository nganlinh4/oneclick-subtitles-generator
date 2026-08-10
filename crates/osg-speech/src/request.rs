use crate::{
    AudioAsset, AudioFormat, LanguageTag, ModelId, Result, SegmentId, SpeechBackend, SpeechError,
    SpeechText, VoiceId,
};
use serde::Serialize;
use std::collections::HashSet;

const MAX_REFERENCE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BATCH_ITEMS: usize = 2_000;
const MAX_BATCH_TEXT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct F5Settings {
    reference_text: Option<SpeechText>,
    model: Option<ModelId>,
    speech_rate_milli: u16,
    nfe_steps: u8,
    sway_milli: i16,
    guidance_milli: u16,
    seed: Option<u64>,
    remove_silence: bool,
}

impl F5Settings {
    #[must_use]
    pub fn new(reference_text: SpeechText) -> Self {
        Self {
            reference_text: Some(reference_text),
            model: None,
            speech_rate_milli: 1_100,
            nfe_steps: 32,
            sway_milli: -1_000,
            guidance_milli: 2_000,
            seed: None,
            remove_silence: true,
        }
    }

    /// Lets the trusted F5 worker transcribe the reference clip before
    /// synthesis, matching the useful legacy behavior for recordings without
    /// supplied reference text.
    #[must_use]
    pub fn transcribe_reference() -> Self {
        Self {
            reference_text: None,
            model: None,
            speech_rate_milli: 1_100,
            nfe_steps: 32,
            sway_milli: -1_000,
            guidance_milli: 2_000,
            seed: None,
            remove_silence: true,
        }
    }

    #[must_use]
    pub fn with_model(mut self, model: ModelId) -> Self {
        self.model = Some(model);
        self
    }

    pub fn with_speech_rate_milli(mut self, value: u16) -> Result<Self> {
        if !(500..=2_000).contains(&value) {
            return Err(SpeechError::InvalidOption(
                "F5 speech rate must be between 0.5x and 2x",
            ));
        }
        self.speech_rate_milli = value;
        Ok(self)
    }

    pub fn with_nfe_steps(mut self, value: u8) -> Result<Self> {
        if !matches!(value, 8 | 16 | 32 | 64) {
            return Err(SpeechError::InvalidOption(
                "F5 NFE steps must be 8, 16, 32, or 64",
            ));
        }
        self.nfe_steps = value;
        Ok(self)
    }

    pub fn with_sway_milli(mut self, value: i16) -> Result<Self> {
        if !(-1_100..=1_700).contains(&value) {
            return Err(SpeechError::InvalidOption(
                "F5 sway must be between -1.1 and 1.7",
            ));
        }
        self.sway_milli = value;
        Ok(self)
    }

    pub fn with_guidance_milli(mut self, value: u16) -> Result<Self> {
        if !(1_000..=5_000).contains(&value) {
            return Err(SpeechError::InvalidOption(
                "F5 guidance must be between 1 and 5",
            ));
        }
        self.guidance_milli = value;
        Ok(self)
    }

    #[must_use]
    pub fn with_seed(mut self, seed: Option<u64>) -> Self {
        self.seed = seed;
        self
    }

    #[must_use]
    pub fn with_remove_silence(mut self, remove: bool) -> Self {
        self.remove_silence = remove;
        self
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatterboxSettings {
    language: LanguageTag,
    exaggeration_milli: u16,
    cfg_weight_milli: u16,
}

impl ChatterboxSettings {
    pub fn new(
        language: LanguageTag,
        exaggeration_milli: u16,
        cfg_weight_milli: u16,
    ) -> Result<Self> {
        if !(250..=2_000).contains(&exaggeration_milli) {
            return Err(SpeechError::InvalidOption(
                "Chatterbox exaggeration must be between 0.25 and 2",
            ));
        }
        if cfg_weight_milli > 1_000 {
            return Err(SpeechError::InvalidOption(
                "Chatterbox CFG weight must be between 0 and 1",
            ));
        }
        Ok(Self {
            language,
            exaggeration_milli,
            cfg_weight_milli,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct EdgeSettings {
    voice: VoiceId,
    rate_percent: i8,
    volume_percent: i8,
    pitch_hz: i8,
}

impl EdgeSettings {
    pub fn new(voice: VoiceId, rate_percent: i8, volume_percent: i8, pitch_hz: i8) -> Result<Self> {
        if !(-100..=100).contains(&rate_percent)
            || !(-100..=100).contains(&volume_percent)
            || !(-100..=100).contains(&pitch_hz)
        {
            return Err(SpeechError::InvalidOption(
                "Edge prosody controls must be between -100 and 100",
            ));
        }
        Ok(Self {
            voice,
            rate_percent,
            volume_percent,
            pitch_hz,
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub enum GttsDomain {
    #[default]
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

impl GttsDomain {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Com => "com",
            Self::ComAu => "com.au",
            Self::CoUk => "co.uk",
            Self::Us => "us",
            Self::Ca => "ca",
            Self::CoIn => "co.in",
            Self::Ie => "ie",
            Self::CoZa => "co.za",
            Self::ComBr => "com.br",
            Self::Pt => "pt",
            Self::Es => "es",
            Self::ComMx => "com.mx",
            Self::Fr => "fr",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct GttsSettings {
    language: LanguageTag,
    domain: GttsDomain,
    slow: bool,
}

impl GttsSettings {
    #[must_use]
    pub fn new(language: LanguageTag, domain: GttsDomain, slow: bool) -> Self {
        Self {
            language,
            domain,
            slow,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct GeminiSettings {
    model: ModelId,
    voice: VoiceId,
    language: LanguageTag,
}

impl GeminiSettings {
    #[must_use]
    pub fn new(model: ModelId, voice: VoiceId, language: LanguageTag) -> Self {
        Self {
            model,
            voice,
            language,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "backend", content = "settings", rename_all = "snake_case")]
pub enum SynthesisSettings {
    F5Tts(F5Settings),
    Chatterbox(ChatterboxSettings),
    EdgeTts(EdgeSettings),
    Gtts(GttsSettings),
    GeminiLive(GeminiSettings),
}

impl SynthesisSettings {
    #[must_use]
    pub fn backend(&self) -> SpeechBackend {
        match self {
            Self::F5Tts(_) => SpeechBackend::F5Tts,
            Self::Chatterbox(_) => SpeechBackend::Chatterbox,
            Self::EdgeTts(_) => SpeechBackend::EdgeTts,
            Self::Gtts(_) => SpeechBackend::Gtts,
            Self::GeminiLive(_) => SpeechBackend::GeminiLive,
        }
    }

    #[must_use]
    pub fn output_format(&self) -> AudioFormat {
        match self {
            Self::F5Tts(_) | Self::Chatterbox(_) | Self::GeminiLive(_) => AudioFormat::Wav,
            Self::EdgeTts(_) | Self::Gtts(_) => AudioFormat::Mp3,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SynthesisRequest {
    segment_id: SegmentId,
    text: SpeechText,
    settings: SynthesisSettings,
    reference: Option<AudioAsset>,
}

impl SynthesisRequest {
    pub fn new(
        segment_id: SegmentId,
        text: SpeechText,
        settings: SynthesisSettings,
        reference: Option<AudioAsset>,
    ) -> Result<Self> {
        let needs_reference = matches!(
            settings,
            SynthesisSettings::F5Tts(_) | SynthesisSettings::Chatterbox(_)
        );
        if needs_reference != reference.is_some() {
            return Err(SpeechError::InvalidInput(if needs_reference {
                "selected backend requires reference audio"
            } else {
                "selected backend does not accept reference audio"
            }));
        }
        if reference
            .as_ref()
            .is_some_and(|asset| asset.bytes() > MAX_REFERENCE_BYTES)
        {
            return Err(SpeechError::InvalidAsset("reference audio exceeds 256 MiB"));
        }
        if matches!(settings, SynthesisSettings::Chatterbox(_)) && text.chars_len() > 300 {
            return Err(SpeechError::InvalidInput(
                "Chatterbox text exceeds 300 characters",
            ));
        }
        Ok(Self {
            segment_id,
            text,
            settings,
            reference,
        })
    }

    #[must_use]
    pub fn segment_id(&self) -> &SegmentId {
        &self.segment_id
    }

    #[must_use]
    pub fn text(&self) -> &SpeechText {
        &self.text
    }

    #[must_use]
    pub fn settings(&self) -> &SynthesisSettings {
        &self.settings
    }

    #[must_use]
    pub fn backend(&self) -> SpeechBackend {
        self.settings.backend()
    }

    #[must_use]
    pub fn output_format(&self) -> AudioFormat {
        self.settings.output_format()
    }

    pub(crate) fn reference(&self) -> Option<&AudioAsset> {
        self.reference.as_ref()
    }
}

#[derive(Clone, Debug)]
pub struct NarrationBatch {
    backend: SpeechBackend,
    requests: Vec<SynthesisRequest>,
    text_bytes: usize,
}

impl NarrationBatch {
    pub fn new(requests: Vec<SynthesisRequest>) -> Result<Self> {
        let Some(first) = requests.first() else {
            return Err(SpeechError::InvalidInput("narration batch is empty"));
        };
        if requests.len() > MAX_BATCH_ITEMS {
            return Err(SpeechError::InvalidInput(
                "narration batch exceeds 2000 items",
            ));
        }
        let backend = first.backend();
        let mut ids = HashSet::with_capacity(requests.len());
        let mut text_bytes = 0_usize;
        for request in &requests {
            if request.backend() != backend {
                return Err(SpeechError::BackendMismatch);
            }
            if !ids.insert(request.segment_id().as_str()) {
                return Err(SpeechError::InvalidInput("duplicate segment ID"));
            }
            text_bytes = text_bytes
                .checked_add(request.text().bytes_len())
                .ok_or(SpeechError::InvalidInput("batch text size overflow"))?;
        }
        if text_bytes > MAX_BATCH_TEXT_BYTES {
            return Err(SpeechError::InvalidInput(
                "narration batch text exceeds 4 MiB",
            ));
        }
        Ok(Self {
            backend,
            requests,
            text_bytes,
        })
    }

    #[must_use]
    pub fn backend(&self) -> SpeechBackend {
        self.backend
    }

    #[must_use]
    pub fn requests(&self) -> &[SynthesisRequest] {
        &self.requests
    }

    #[must_use]
    pub fn text_bytes(&self) -> usize {
        self.text_bytes
    }

    #[must_use]
    pub fn into_requests(self) -> Vec<SynthesisRequest> {
        self.requests
    }
}

#[derive(Clone, Debug)]
pub struct VoiceConversionRequest {
    input: AudioAsset,
    target_voice: AudioAsset,
}

impl VoiceConversionRequest {
    #[must_use]
    pub fn new(input: AudioAsset, target_voice: AudioAsset) -> Self {
        Self {
            input,
            target_voice,
        }
    }

    pub(crate) fn input(&self) -> &AudioAsset {
        &self.input
    }

    pub(crate) fn target_voice(&self) -> &AudioAsset {
        &self.target_voice
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset() -> (tempfile::TempDir, AudioAsset) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("reference.wav");
        std::fs::write(&path, b"RIFFfixtureWAVEdata").unwrap();
        let asset = AudioAsset::from_native_file(&path).unwrap();
        (directory, asset)
    }

    #[test]
    fn backend_specific_reference_rules_are_enforced() {
        let (_directory, reference) = asset();
        let id = SegmentId::new("1").unwrap();
        let text = SpeechText::new("Hello").unwrap();
        let f5 =
            SynthesisSettings::F5Tts(F5Settings::new(SpeechText::new("Reference text").unwrap()));
        assert!(SynthesisRequest::new(id.clone(), text.clone(), f5, None).is_err());
        let edge = SynthesisSettings::EdgeTts(
            EdgeSettings::new(VoiceId::new("en-US-AriaNeural").unwrap(), 0, 0, 0).unwrap(),
        );
        assert!(SynthesisRequest::new(id, text, edge, Some(reference)).is_err());
    }

    #[test]
    fn batch_rejects_duplicate_ids_and_mixed_backends() {
        let edge = |id: &str| {
            SynthesisRequest::new(
                SegmentId::new(id).unwrap(),
                SpeechText::new("Hello").unwrap(),
                SynthesisSettings::EdgeTts(
                    EdgeSettings::new(VoiceId::new("en-US-AriaNeural").unwrap(), 0, 0, 0).unwrap(),
                ),
                None,
            )
            .unwrap()
        };
        assert!(NarrationBatch::new(vec![edge("one"), edge("one")]).is_err());
        assert_eq!(
            NarrationBatch::new(vec![edge("one"), edge("two")])
                .unwrap()
                .text_bytes(),
            10
        );
    }

    #[test]
    fn numeric_controls_are_bounded() {
        let reference = SpeechText::new("Reference").unwrap();
        assert!(
            F5Settings::new(reference.clone())
                .with_nfe_steps(7)
                .is_err()
        );
        assert!(F5Settings::new(reference).with_sway_milli(1_701).is_err());
        assert!(ChatterboxSettings::new(LanguageTag::new("en").unwrap(), 2_001, 500).is_err());
        assert!(EdgeSettings::new(VoiceId::new("voice").unwrap(), 0, 0, 101).is_err());
    }

    #[test]
    fn gtts_domains_serialize_as_provider_domains() {
        assert_eq!(serde_json::to_value(GttsDomain::ComAu).unwrap(), "com.au");
        assert_eq!(serde_json::to_value(GttsDomain::CoUk).unwrap(), "co.uk");
        assert_eq!(serde_json::to_value(GttsDomain::ComMx).unwrap(), "com.mx");
    }

    #[test]
    fn f5_can_request_reference_transcription_without_empty_text() {
        let settings = F5Settings::transcribe_reference();
        assert_eq!(
            serde_json::to_value(settings).unwrap()["reference_text"],
            serde_json::Value::Null
        );
    }
}
