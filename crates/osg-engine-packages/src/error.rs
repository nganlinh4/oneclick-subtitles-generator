use crate::{AssetPackageId, EngineId, RenderPackageId, SpeechPackageId, UiFontPackageId};

pub type Result<T> = std::result::Result<T, PackageError>;

/// Sanitized package-manager failures. Paths and download URLs never appear.
#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum PackageError {
    #[error("the engine package request is invalid")]
    InvalidRequest,
    #[error("this engine has no verified package for the current platform")]
    DeliveryUnavailable,
    #[error("another package operation is already active for {0}")]
    OperationInProgress(EngineId),
    #[error("another package operation is already active for {0}")]
    SpeechOperationInProgress(SpeechPackageId),
    #[error("another package operation is already active for {0}")]
    RenderOperationInProgress(RenderPackageId),
    #[error("another package operation is already active for {0}")]
    AssetOperationInProgress(AssetPackageId),
    #[error("another package operation is already active for {0}")]
    UiFontOperationInProgress(UiFontPackageId),
    #[error("the package operation was cancelled")]
    Cancelled,
    #[error("the package download failed")]
    Network,
    #[error("the package download cannot be resumed safely")]
    InvalidResume,
    #[error("the package download is incomplete")]
    IncompleteDownload,
    #[error("the package exceeds its storage limit")]
    StorageLimit,
    #[error("there is not enough free disk space for this package")]
    InsufficientSpace,
    #[error("the package archive failed integrity verification")]
    ArchiveIntegrity,
    #[error("the package archive is unsafe")]
    UnsafeArchive,
    #[error("the installed engine package is incomplete or modified")]
    InvalidInstall,
    #[error("the engine package is currently in use")]
    RuntimeBusy,
    #[error("the package store is unavailable")]
    StoreUnavailable,
    #[error("the embedded engine package catalog is invalid")]
    InvalidCatalog,
}

impl From<std::io::Error> for PackageError {
    fn from(_: std::io::Error) -> Self {
        Self::StoreUnavailable
    }
}

impl From<serde_json::Error> for PackageError {
    fn from(_: serde_json::Error) -> Self {
        Self::InvalidCatalog
    }
}

impl From<zip::result::ZipError> for PackageError {
    fn from(_: zip::result::ZipError) -> Self {
        Self::UnsafeArchive
    }
}
