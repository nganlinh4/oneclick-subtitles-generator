//! Media server, media, native-tool, render, pipeline and ASR error mapping.

use osg_media_server::MediaServerError;

use super::CommandError;

impl From<MediaServerError> for CommandError {
    fn from(error: MediaServerError) -> Self {
        let code = match &error {
            MediaServerError::InvalidPath | MediaServerError::EmptyFile => "invalidPath",
            MediaServerError::RegistryFull => "mediaRegistryFull",
            MediaServerError::Bind(_)
            | MediaServerError::Thread(_)
            | MediaServerError::InvalidOrigin
            | MediaServerError::RegistryUnavailable => "mediaServer",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<osg_media::MediaError> for CommandError {
    fn from(error: osg_media::MediaError) -> Self {
        use osg_media::MediaError;

        let (code, message) = match error {
            MediaError::BinaryNotFound(_) | MediaError::InvalidBinary { .. } => (
                "mediaToolsUnavailable",
                "The bundled media tools are unavailable or invalid.",
            ),
            MediaError::InvalidPath { .. } => (
                "invalidMediaLocation",
                "The selected media file is unavailable or invalid.",
            ),
            MediaError::InvalidOption(_) | MediaError::UnsupportedConversion => (
                "invalidMediaOperation",
                "The requested media operation is not supported.",
            ),
            MediaError::TimedOut { .. } => (
                "mediaTimeout",
                "The media operation exceeded its safe time limit.",
            ),
            MediaError::Cancelled(_) => ("mediaCancelled", "The media operation was cancelled."),
            MediaError::OutputExists => (
                "mediaOutputExists",
                "The media output already exists and was not overwritten.",
            ),
            MediaError::MissingArtifact => (
                "mediaArtifactMissing",
                "The media tool did not produce a valid output artifact.",
            ),
            MediaError::InvalidProbe(_)
            | MediaError::ProbeJson(_)
            | MediaError::InvalidWaveform(_) => (
                "invalidMediaMetadata",
                "The media metadata or waveform output is invalid.",
            ),
            MediaError::Spawn { .. }
            | MediaError::ProcessIo { .. }
            | MediaError::ProcessFailed { .. }
            | MediaError::OutputLimit { .. }
            | MediaError::Finalize(_) => (
                "mediaToolFailure",
                "The native media tool could not complete the operation.",
            ),
        };
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

impl From<osg_native_tools::NativeToolError> for CommandError {
    fn from(error: osg_native_tools::NativeToolError) -> Self {
        use osg_native_tools::NativeToolError;

        match error {
            NativeToolError::InvalidRequest => Self::fixed(
                "invalidNativeToolRequest",
                "The native tool request is invalid.",
            ),
            NativeToolError::DeliveryUnavailable => Self::fixed(
                "nativeToolUnavailable",
                "No reviewed native tool delivery is available for this platform.",
            ),
            NativeToolError::OperationInProgress(_) => Self::fixed(
                "nativeToolBusy",
                "Another native tool operation is already running.",
            ),
            NativeToolError::Cancelled => Self::fixed(
                "nativeToolCancelled",
                "The native tool operation was cancelled.",
            ),
            NativeToolError::RuntimeBusy => Self::fixed(
                "nativeToolInUse",
                "Wait for the current media operation to finish, then retry the tool change.",
            ),
            NativeToolError::HttpStatus(status) => Self {
                code: "nativeToolHttpFailed",
                message: format!(
                    "The native tool server returned HTTP {status}. Please retry later."
                ),
            },
            NativeToolError::IncompleteDownload => Self::fixed(
                "nativeToolIncompleteDownload",
                "The native tool download did not match its expected length.",
            ),
            NativeToolError::Network | NativeToolError::StorageLimit => Self::fixed(
                "nativeToolDownloadFailed",
                "The verified native tool package could not be downloaded.",
            ),
            NativeToolError::Integrity | NativeToolError::UnsafeArchive => Self::fixed(
                "nativeToolIntegrityFailed",
                "The native tool package failed integrity or archive verification.",
            ),
            NativeToolError::InvalidInstall => Self::fixed(
                "nativeToolInstallModified",
                "The native tool installation is incomplete or locally modified.",
            ),
            NativeToolError::StoreUnavailable | NativeToolError::InvalidCatalog => Self::fixed(
                "nativeToolStorage",
                "The verified native tool store is unavailable.",
            ),
        }
    }
}

impl From<osg_render::RenderError> for CommandError {
    fn from(error: osg_render::RenderError) -> Self {
        use osg_render::RenderError;

        match error {
            RenderError::InvalidRequest => Self::fixed(
                "invalidRenderRequest",
                "The video render request is invalid.",
            ),
        }
    }
}

impl From<osg_media_pipeline::PipelineError> for CommandError {
    fn from(error: osg_media_pipeline::PipelineError) -> Self {
        use osg_media_pipeline::PipelineError;

        match error {
            PipelineError::Media(error) => error.into(),
            PipelineError::MissingAudio => Self::fixed(
                "mediaMissingAudio",
                "The selected media does not contain an audio stream.",
            ),
            PipelineError::NoPlayableStream => Self::fixed(
                "mediaNotPlayable",
                "The selected media does not contain a playable audio or video stream.",
            ),
            PipelineError::InvalidClipRange => Self::fixed(
                "invalidMediaRange",
                "The requested clip range is outside the selected media.",
            ),
            PipelineError::StagingUnavailable => Self::fixed(
                "mediaStagingUnavailable",
                "The native media staging area is unavailable or inconsistent.",
            ),
        }
    }
}

impl From<osg_asr::AsrError> for CommandError {
    fn from(error: osg_asr::AsrError) -> Self {
        use osg_asr::AsrError;

        let (code, message) = match error {
            AsrError::InvalidOption(_)
            | AsrError::LanguageUnsupported
            | AsrError::LanguageUnavailable => (
                "invalidAsrRequest",
                "The requested ASR options are not supported by this engine.",
            ),
            AsrError::InvalidAudio => (
                "invalidAsrAudio",
                "The selected media could not be normalized for transcription.",
            ),
            AsrError::InvalidRuntime => (
                "asrRuntimeUnavailable",
                "This local ASR engine is not installed or its runtime is incomplete.",
            ),
            AsrError::Cancelled => ("asrCancelled", "The ASR operation was cancelled."),
            AsrError::TimedOut(_) => (
                "asrTimeout",
                "The ASR operation exceeded its safe time limit.",
            ),
            AsrError::InvalidOutput | AsrError::Protocol(_) | AsrError::OutputLimit => (
                "invalidAsrOutput",
                "The ASR worker returned invalid or excessive transcription data.",
            ),
            AsrError::Spawn(_)
            | AsrError::ProcessIo { .. }
            | AsrError::WorkerFailed(_)
            | AsrError::Synchronization => (
                "asrWorkerFailure",
                "The local ASR worker could not complete the transcription.",
            ),
        };
        Self {
            code,
            message: message.to_owned(),
        }
    }
}
