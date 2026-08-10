use thiserror::Error;

use crate::storage::DatabaseError;

/// Failures surfaced by a secure credential backend.
///
/// This error deliberately discards backend payloads because some keyring errors can
/// carry the bytes that failed to decode.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum CredentialError {
    #[error("the operating-system credential store is unavailable")]
    Unavailable,
    #[error("the operating-system credential store is locked or access was denied")]
    Locked,
    #[error("the credential does not exist")]
    NotFound,
    #[error("the credential store rejected the credential")]
    InvalidCredential,
    #[error("the credential cannot be used for the requested purpose")]
    PurposeMismatch,
    #[error("a credential cannot be empty")]
    EmptySecret,
    #[error("the credential write could not be verified")]
    VerificationFailed,
    #[error("the credential backend failed")]
    BackendFailure,
}

/// A provider value outside the native credential API's closed set.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("unsupported credential provider")]
pub struct InvalidCredentialProvider;

/// A purpose value outside the native credential API's closed set.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("unsupported credential purpose")]
pub struct InvalidCredentialPurpose;

/// An identifier which is not a valid `UUIDv7` credential reference.
#[derive(Debug, Error)]
pub enum InvalidCredentialId {
    #[error("invalid credential identifier: {0}")]
    Uuid(#[from] uuid::Error),
    #[error("credential identifiers must be UUIDv7 values")]
    Version,
}

/// A credential lifecycle value not produced by a supported database migration.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("unsupported credential state")]
pub struct InvalidCredentialState;

/// Failures from the coordinated metadata/keyring credential service.
#[derive(Debug, Error)]
pub enum CredentialServiceError {
    #[error(transparent)]
    Credential(#[from] CredentialError),
    #[error(transparent)]
    Database(#[from] DatabaseError),
}
