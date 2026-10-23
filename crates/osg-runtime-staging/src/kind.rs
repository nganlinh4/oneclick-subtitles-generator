//! Closed staging kinds and the exact entry/journal names each one may own.

use serde::{Deserialize, Serialize};

use crate::JOURNAL_PREFIX;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StagingKind {
    Download,
    Render,
    SpeechJob,
    SpeechWorkerCache,
    AsrJob,
    AsrWorkerCache,
    MediaExport,
    NativeToolDownload,
    NativeToolExtraction,
    NativeToolQuarantine,
    EnginePackageInstall,
    EnginePackageAdoption,
    EnginePackageQuarantine,
    MediaBlobSession,
    MediaPipelineJob,
}

impl StagingKind {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Download => "download",
            Self::Render => "render",
            Self::SpeechJob => "speech-job",
            Self::SpeechWorkerCache => "speech-worker-cache",
            Self::AsrJob => "asr-job",
            Self::AsrWorkerCache => "asr-worker-cache",
            Self::MediaExport => "media-export",
            Self::NativeToolDownload => "native-tool-download",
            Self::NativeToolExtraction => "native-tool-extraction",
            Self::NativeToolQuarantine => "native-tool-quarantine",
            Self::EnginePackageInstall => "engine-package-install",
            Self::EnginePackageAdoption => "engine-package-adoption",
            Self::EnginePackageQuarantine => "engine-package-quarantine",
            Self::MediaBlobSession => "media-blob-session",
            Self::MediaPipelineJob => "media-pipeline-job",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "download" => Some(Self::Download),
            "render" => Some(Self::Render),
            "speech-job" => Some(Self::SpeechJob),
            "speech-worker-cache" => Some(Self::SpeechWorkerCache),
            "asr-job" => Some(Self::AsrJob),
            "asr-worker-cache" => Some(Self::AsrWorkerCache),
            "media-export" => Some(Self::MediaExport),
            "native-tool-download" => Some(Self::NativeToolDownload),
            "native-tool-extraction" => Some(Self::NativeToolExtraction),
            "native-tool-quarantine" => Some(Self::NativeToolQuarantine),
            "engine-package-install" => Some(Self::EnginePackageInstall),
            "engine-package-adoption" => Some(Self::EnginePackageAdoption),
            "engine-package-quarantine" => Some(Self::EnginePackageQuarantine),
            "media-blob-session" => Some(Self::MediaBlobSession),
            "media-pipeline-job" => Some(Self::MediaPipelineJob),
            _ => None,
        }
    }

    pub(crate) const fn entry_type(self) -> EntryType {
        match self {
            Self::Download
            | Self::Render
            | Self::SpeechJob
            | Self::SpeechWorkerCache
            | Self::AsrJob
            | Self::AsrWorkerCache
            | Self::NativeToolDownload
            | Self::NativeToolExtraction
            | Self::NativeToolQuarantine
            | Self::EnginePackageInstall
            | Self::EnginePackageAdoption
            | Self::EnginePackageQuarantine
            | Self::MediaBlobSession
            | Self::MediaPipelineJob => EntryType::Directory,
            Self::MediaExport => EntryType::File,
        }
    }

    pub(crate) fn entry_name(self, nonce: &str) -> String {
        match self {
            Self::Download => format!(".osg-download-attempt-{nonce}"),
            Self::Render => format!(".osg-render-{nonce}"),
            Self::SpeechJob => format!(".osg-speech-job-{nonce}"),
            Self::SpeechWorkerCache => format!(".osg-speech-worker-cache-{nonce}"),
            Self::AsrJob => format!(".osg-asr-job-{nonce}"),
            Self::AsrWorkerCache => format!(".osg-asr-worker-cache-{nonce}"),
            Self::MediaExport => format!(".osg-export-{nonce}.part"),
            Self::NativeToolDownload => format!(".osg-native-tool-download-{nonce}"),
            Self::NativeToolExtraction => format!(".osg-native-tool-extraction-{nonce}"),
            Self::NativeToolQuarantine => format!(".osg-native-tool-quarantine-{nonce}"),
            Self::EnginePackageInstall => format!(".osg-engine-package-install-{nonce}"),
            Self::EnginePackageAdoption => format!(".osg-engine-package-adoption-{nonce}"),
            Self::EnginePackageQuarantine => format!(".osg-engine-package-quarantine-{nonce}"),
            Self::MediaBlobSession => format!("session-{nonce}"),
            Self::MediaPipelineJob => format!(".osg-media-pipeline-job-{nonce}"),
        }
    }

    pub(crate) fn journal_name(self, nonce: &str) -> String {
        format!("{JOURNAL_PREFIX}{}-{nonce}.json", self.label())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum EntryType {
    Directory,
    File,
}
