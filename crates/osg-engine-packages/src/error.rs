use crate::{AssetPackageId, EngineId, SpeechPackageId, UiFontPackageId};

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

impl From<osg_delivery_core::Cancelled> for PackageError {
    fn from(_: osg_delivery_core::Cancelled) -> Self {
        Self::Cancelled
    }
}

impl From<osg_delivery_core::DeliveryError> for PackageError {
    fn from(error: osg_delivery_core::DeliveryError) -> Self {
        use osg_delivery_core::DeliveryError;
        match error {
            DeliveryError::Cancelled => Self::Cancelled,
            DeliveryError::InvalidCatalog => Self::InvalidCatalog,
            DeliveryError::StoreUnavailable => Self::StoreUnavailable,
            DeliveryError::InvalidInstall => Self::InvalidInstall,
            DeliveryError::UnsafeArchive => Self::UnsafeArchive,
            DeliveryError::Integrity => Self::ArchiveIntegrity,
            DeliveryError::StorageLimit => Self::StorageLimit,
            DeliveryError::Network => Self::Network,
            DeliveryError::IncompleteDownload => Self::IncompleteDownload,
        }
    }
}

impl From<serde_json::Error> for PackageError {
    fn from(_: serde_json::Error) -> Self {
        Self::InvalidCatalog
    }
}
