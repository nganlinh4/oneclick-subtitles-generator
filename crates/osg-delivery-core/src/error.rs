pub type Result<T> = std::result::Result<T, DeliveryError>;

/// Sanitized primitive failures. Each store maps these onto its own public error type.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum DeliveryError {
    #[error("the operation was cancelled")]
    Cancelled,
    #[error("the declared path or catalog entry is invalid")]
    InvalidCatalog,
    #[error("the store is unavailable")]
    StoreUnavailable,
    #[error("the installed tree is incomplete or modified")]
    InvalidInstall,
    #[error("the archive is unsafe")]
    UnsafeArchive,
    #[error("the content failed integrity verification")]
    Integrity,
    #[error("the content exceeds its storage limit")]
    StorageLimit,
    #[error("the download failed")]
    Network,
    #[error("the download is incomplete")]
    IncompleteDownload,
}

impl From<osg_process::Cancelled> for DeliveryError {
    fn from(_: osg_process::Cancelled) -> Self {
        Self::Cancelled
    }
}
