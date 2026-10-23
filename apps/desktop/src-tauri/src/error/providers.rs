//! Engine-package, credential and provider error mapping.

use osg_infrastructure::secrets::{CredentialError, CredentialServiceError};
use osg_providers::ProviderError;

use super::CommandError;

impl From<osg_engine_packages::PackageError> for CommandError {
    fn from(error: osg_engine_packages::PackageError) -> Self {
        use osg_engine_packages::PackageError;

        let (code, message) = match error {
            PackageError::InvalidRequest => (
                "invalidEnginePackageRequest",
                "The engine package request is invalid.",
            ),
            PackageError::DeliveryUnavailable => (
                "packageUnavailable",
                "No verified package is available for this engine and platform.",
            ),
            PackageError::OperationInProgress(_)
            | PackageError::SpeechOperationInProgress(_)
            | PackageError::AssetOperationInProgress(_)
            | PackageError::UiFontOperationInProgress(_) => (
                "packageOperationInProgress",
                "Another engine package operation is already active.",
            ),
            PackageError::Cancelled => (
                "enginePackageCancelled",
                "The engine package operation was cancelled.",
            ),
            PackageError::Network => (
                "packageNetwork",
                "The verified engine package could not be downloaded.",
            ),
            PackageError::InvalidResume | PackageError::IncompleteDownload => (
                "packageDownloadInvalid",
                "The engine package download is incomplete or cannot be resumed safely.",
            ),
            PackageError::StorageLimit => (
                "packageStorageLimit",
                "The engine package exceeds the application storage limit.",
            ),
            PackageError::InsufficientSpace => (
                "packageInsufficientSpace",
                "There is not enough free disk space for this engine package.",
            ),
            PackageError::ArchiveIntegrity | PackageError::UnsafeArchive => (
                "packageIntegrity",
                "The engine package failed integrity or archive safety checks.",
            ),
            PackageError::InvalidInstall => (
                "packageInstallInvalid",
                "The installed engine package is incomplete or was modified.",
            ),
            PackageError::RuntimeBusy => (
                "engineRuntimeBusy",
                "The engine package is currently in use.",
            ),
            PackageError::StoreUnavailable => {
                ("packageStorage", "The engine package store is unavailable.")
            }
            PackageError::InvalidCatalog => (
                "packageCatalogInvalid",
                "The embedded engine package catalog is invalid.",
            ),
        };
        Self {
            code,
            message: message.to_owned(),
        }
    }
}

impl From<CredentialError> for CommandError {
    fn from(error: CredentialError) -> Self {
        let code = match error {
            CredentialError::Unavailable => "credentialStoreUnavailable",
            CredentialError::Locked => "credentialStoreLocked",
            CredentialError::NotFound => "credentialNotFound",
            CredentialError::InvalidCredential => "invalidCredential",
            CredentialError::PurposeMismatch => "credentialPurposeMismatch",
            CredentialError::EmptySecret => "emptyCredential",
            CredentialError::VerificationFailed => "credentialVerificationFailed",
            CredentialError::BackendFailure => "credentialStoreFailure",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<ProviderError> for CommandError {
    fn from(error: ProviderError) -> Self {
        let (code, message) = match error {
            ProviderError::InvalidRequest => {
                ("invalidProviderRequest", "The provider request is invalid.")
            }
            ProviderError::InvalidResponse => (
                "invalidProviderResponse",
                "The provider returned invalid or excessive data.",
            ),
            ProviderError::Timeout => (
                "providerTimeout",
                "The provider request exceeded its safe time limit.",
            ),
            ProviderError::Transport => (
                "providerNetwork",
                "The provider request could not be completed.",
            ),
            ProviderError::Unauthorized => (
                "providerCredentialRejected",
                "The provider rejected the configured credential.",
            ),
            ProviderError::AuthenticationRequired => (
                "youtubeAuthenticationRequired",
                "YouTube authentication is required.",
            ),
            ProviderError::QuotaExceeded => (
                "youtubeQuotaExceeded",
                "The YouTube quota has been exceeded.",
            ),
            ProviderError::ApiNotEnabled => (
                "youtubeApiNotEnabled",
                "The YouTube Data API is not enabled for this project.",
            ),
            ProviderError::NotFound => (
                "providerResultNotFound",
                "No matching provider result was found.",
            ),
            ProviderError::OAuthDenied => (
                "oauthDenied",
                "The YouTube authorization request was denied.",
            ),
            ProviderError::OAuthBusy => (
                "oauthBusy",
                "Another YouTube authorization request is already active.",
            ),
            ProviderError::OAuthCancelled => (
                "oauthCancelled",
                "The YouTube authorization request was cancelled.",
            ),
            ProviderError::OAuthExpired => {
                ("oauthExpired", "The YouTube authorization request expired.")
            }
            ProviderError::BrowserOpen => (
                "oauthBrowserUnavailable",
                "The system browser could not be opened for YouTube authorization.",
            ),
        };
        Self::fixed(code, message)
    }
}

impl From<CredentialServiceError> for CommandError {
    fn from(error: CredentialServiceError) -> Self {
        match error {
            CredentialServiceError::Credential(error) => error.into(),
            CredentialServiceError::Database(error) => error.into(),
        }
    }
}

impl From<osg_gemini::Error> for CommandError {
    fn from(error: osg_gemini::Error) -> Self {
        use osg_gemini::Error;

        let (code, message) = match error {
            Error::Cancelled => ("geminiCancelled", "The Gemini operation was cancelled."),
            Error::InvalidConfig(_) | Error::InvalidRequest(_) => (
                "invalidGeminiRequest",
                "The Gemini request or configuration is invalid.",
            ),
            Error::UnsupportedMimeType(_) => (
                "unsupportedGeminiMedia",
                "Gemini does not support this media format.",
            ),
            Error::InlineRequestTooLarge { .. } | Error::UploadTooLarge { .. } => (
                "geminiMediaTooLarge",
                "The media is too large for the configured Gemini request limits.",
            ),
            Error::Io { .. } => (
                "geminiMediaUnavailable",
                "The selected media file is no longer available.",
            ),
            Error::Transport(_) | Error::UploadOutcomeUnknown => (
                "geminiNetwork",
                "Gemini could not be reached reliably. Check the connection and try again.",
            ),
            Error::Timeout { .. } => (
                "geminiTimeout",
                "Gemini did not finish within the configured time limit.",
            ),
            Error::Provider(provider) => match provider.http_status {
                400 => (
                    "geminiRequestRejected",
                    "Gemini rejected the request. Review the selected model and request settings.",
                ),
                404 => (
                    "geminiModelUnavailable",
                    "The selected Gemini model is not available for this operation.",
                ),
                401 | 403 => (
                    "geminiCredentialRejected",
                    "Gemini rejected the selected credential.",
                ),
                429 => (
                    "geminiRateLimited",
                    "Gemini is rate limited or out of quota. Try another configured key or wait.",
                ),
                _ => ("geminiProvider", "Gemini could not complete the operation."),
            },
            Error::CooldownActive { .. } => (
                "geminiRateLimited",
                "The selected Gemini model is cooling down after a rate limit.",
            ),
            Error::UploadProtocol(_) | Error::FileProcessingFailed { .. } => (
                "geminiUpload",
                "Gemini could not process the uploaded media.",
            ),
            Error::ResponseTooLarge { .. } => (
                "geminiResponseTooLarge",
                "The Gemini response exceeded the safe application limit.",
            ),
            Error::NoTextOutput => ("geminiNoText", "Gemini returned no usable text output."),
            Error::IncompleteTextOutput { .. } => (
                "geminiIncompleteOutput",
                "Gemini stopped before completing the response. Retry or use shorter request windows.",
            ),
            Error::NoImageOutput => (
                "geminiNoImage",
                "Gemini returned no usable generated image.",
            ),
            Error::InvalidImageOutput => (
                "geminiInvalidImage",
                "Gemini returned malformed generated image data.",
            ),
            Error::ImageOutputBlocked => (
                "geminiImageBlocked",
                "Gemini blocked the requested generated image.",
            ),
        };
        Self {
            code,
            message: message.to_owned(),
        }
    }
}
