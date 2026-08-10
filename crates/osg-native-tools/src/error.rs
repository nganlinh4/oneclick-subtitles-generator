use crate::NativeToolId;

pub type Result<T> = std::result::Result<T, NativeToolError>;

/// Sanitized native-tool failures. Paths and download URLs never appear.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum NativeToolError {
    #[error("the native tool request is invalid")]
    InvalidRequest,
    #[error("this native tool has no verified delivery for the current platform")]
    DeliveryUnavailable,
    #[error("another operation is already active for {0}")]
    OperationInProgress(NativeToolId),
    #[error("the native tool operation was cancelled")]
    Cancelled,
    #[error("the native tool download failed")]
    Network,
    #[error("the native tool download is incomplete")]
    IncompleteDownload,
    #[error("the native tool package exceeds its storage limit")]
    StorageLimit,
    #[error("the native tool package failed integrity verification")]
    Integrity,
    #[error("the native tool package is unsafe")]
    UnsafeArchive,
    #[error("the installed native tool is incomplete or modified")]
    InvalidInstall,
    #[error("the native tool is currently in use")]
    RuntimeBusy,
    #[error("the native tool store is unavailable")]
    StoreUnavailable,
    #[error("the embedded native tool catalog is invalid")]
    InvalidCatalog,
}

impl From<std::io::Error> for NativeToolError {
    fn from(_: std::io::Error) -> Self {
        Self::StoreUnavailable
    }
}

impl From<serde_json::Error> for NativeToolError {
    fn from(_: serde_json::Error) -> Self {
        Self::InvalidCatalog
    }
}
