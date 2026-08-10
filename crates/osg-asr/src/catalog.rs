use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
pub enum AsrEngineId {
    #[serde(rename = "parakeet")]
    Parakeet,
    #[serde(rename = "faster-whisper-turbo")]
    FasterWhisperTurbo,
    #[serde(rename = "faster-whisper-large-v3")]
    FasterWhisperLargeV3,
    #[serde(rename = "qwen3-asr-1.7b")]
    Qwen3Asr1_7b,
    #[serde(rename = "qwen3-asr-0.6b")]
    Qwen3Asr0_6b,
}

impl AsrEngineId {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Parakeet => "parakeet",
            Self::FasterWhisperTurbo => "faster-whisper-turbo",
            Self::FasterWhisperLargeV3 => "faster-whisper-large-v3",
            Self::Qwen3Asr1_7b => "qwen3-asr-1.7b",
            Self::Qwen3Asr0_6b => "qwen3-asr-0.6b",
        }
    }

    #[must_use]
    pub const fn runtime(self) -> AsrRuntimeKind {
        match self {
            Self::Parakeet => AsrRuntimeKind::Onnx,
            Self::FasterWhisperTurbo | Self::FasterWhisperLargeV3 => AsrRuntimeKind::CTranslate2,
            Self::Qwen3Asr1_7b | Self::Qwen3Asr0_6b => AsrRuntimeKind::PyTorch,
        }
    }

    #[must_use]
    pub const fn supports_forced_language(self) -> bool {
        !matches!(self, Self::Parakeet)
    }

    #[must_use]
    pub const fn needs_aligner(self) -> bool {
        matches!(self, Self::Qwen3Asr1_7b | Self::Qwen3Asr0_6b)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AsrRuntimeKind {
    Onnx,
    CTranslate2,
    PyTorch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrEngineInfo {
    pub id: AsrEngineId,
    pub label: &'static str,
    pub runtime: AsrRuntimeKind,
    pub supports_forced_language: bool,
    pub requires_aligner: bool,
}

const CATALOG: [AsrEngineInfo; 5] = [
    AsrEngineInfo {
        id: AsrEngineId::Parakeet,
        label: "NVIDIA Parakeet TDT 0.6B V3",
        runtime: AsrRuntimeKind::Onnx,
        supports_forced_language: false,
        requires_aligner: false,
    },
    AsrEngineInfo {
        id: AsrEngineId::FasterWhisperTurbo,
        label: "Faster-Whisper Turbo",
        runtime: AsrRuntimeKind::CTranslate2,
        supports_forced_language: true,
        requires_aligner: false,
    },
    AsrEngineInfo {
        id: AsrEngineId::FasterWhisperLargeV3,
        label: "Faster-Whisper Large-v3",
        runtime: AsrRuntimeKind::CTranslate2,
        supports_forced_language: true,
        requires_aligner: false,
    },
    AsrEngineInfo {
        id: AsrEngineId::Qwen3Asr1_7b,
        label: "Qwen3-ASR 1.7B",
        runtime: AsrRuntimeKind::PyTorch,
        supports_forced_language: true,
        requires_aligner: true,
    },
    AsrEngineInfo {
        id: AsrEngineId::Qwen3Asr0_6b,
        label: "Qwen3-ASR 0.6B",
        runtime: AsrRuntimeKind::PyTorch,
        supports_forced_language: true,
        requires_aligner: true,
    },
];

#[must_use]
pub const fn catalog() -> &'static [AsrEngineInfo] {
    &CATALOG
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_preserves_every_legacy_local_engine() {
        let ids = catalog()
            .iter()
            .map(|engine| engine.id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), 5);
        for expected in [
            "parakeet",
            "faster-whisper-turbo",
            "faster-whisper-large-v3",
            "qwen3-asr-1.7b",
            "qwen3-asr-0.6b",
        ] {
            assert!(ids.contains(expected));
        }
    }

    #[test]
    fn aligner_and_language_capabilities_are_honest() {
        assert!(!AsrEngineId::Parakeet.supports_forced_language());
        assert!(AsrEngineId::Qwen3Asr1_7b.needs_aligner());
        assert!(!AsrEngineId::FasterWhisperTurbo.needs_aligner());
    }
}
