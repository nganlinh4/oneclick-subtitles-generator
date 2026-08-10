use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex},
};

use keyring::{Entry, Error as KeyringError};
use secrecy::{ExposeSecret, SecretString};

use super::CredentialError;

/// Storage operations required by the credential vault.
///
/// Implementations must keep values in secure platform storage or memory only. A
/// filesystem/plaintext implementation is intentionally not provided.
pub trait CredentialBackend: Send + Sync {
    fn ensure_available(&self) -> Result<(), CredentialError>;
    fn set(
        &self,
        service: &str,
        account: &str,
        secret: &SecretString,
    ) -> Result<(), CredentialError>;
    fn get(&self, service: &str, account: &str) -> Result<SecretString, CredentialError>;
    fn delete(&self, service: &str, account: &str) -> Result<(), CredentialError>;
}

impl<T> CredentialBackend for Arc<T>
where
    T: CredentialBackend + ?Sized,
{
    fn ensure_available(&self) -> Result<(), CredentialError> {
        (**self).ensure_available()
    }

    fn set(
        &self,
        service: &str,
        account: &str,
        secret: &SecretString,
    ) -> Result<(), CredentialError> {
        (**self).set(service, account, secret)
    }

    fn get(&self, service: &str, account: &str) -> Result<SecretString, CredentialError> {
        (**self).get(service, account)
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), CredentialError> {
        (**self).delete(service, account)
    }
}

/// The native Windows Credential Manager, macOS Keychain, or Linux Secret Service.
#[derive(Clone, Copy, Debug, Default)]
pub struct KeyringCredentialBackend;

impl KeyringCredentialBackend {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    fn entry(service: &str, account: &str) -> Result<Entry, CredentialError> {
        Entry::new(service, account).map_err(|error| map_keyring_error(&error))
    }
}

impl CredentialBackend for KeyringCredentialBackend {
    fn ensure_available(&self) -> Result<(), CredentialError> {
        match Entry::store_status() {
            Ok(()) => Ok(()),
            Err(KeyringError::NoStorageAccess(_)) => Err(CredentialError::Locked),
            Err(_) => Err(CredentialError::Unavailable),
        }
    }

    fn set(
        &self,
        service: &str,
        account: &str,
        secret: &SecretString,
    ) -> Result<(), CredentialError> {
        Self::entry(service, account)?
            .set_password(secret.expose_secret())
            .map_err(|error| map_keyring_error(&error))
    }

    fn get(&self, service: &str, account: &str) -> Result<SecretString, CredentialError> {
        Self::entry(service, account)?
            .get_password()
            .map(SecretString::from)
            .map_err(|error| map_keyring_error(&error))
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), CredentialError> {
        Self::entry(service, account)?
            .delete_credential()
            .map_err(|error| map_keyring_error(&error))
    }
}

/// An ephemeral backend for guest sessions and deterministic tests.
///
/// Credentials are zeroized when replaced, deleted, or when this backend is dropped.
/// They are never persisted to disk.
#[derive(Default)]
pub struct SessionCredentialBackend {
    credentials: Mutex<HashMap<(String, String), SecretString>>,
}

impl SessionCredentialBackend {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl fmt::Debug for SessionCredentialBackend {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionCredentialBackend")
            .finish_non_exhaustive()
    }
}

impl CredentialBackend for SessionCredentialBackend {
    fn ensure_available(&self) -> Result<(), CredentialError> {
        Ok(())
    }

    fn set(
        &self,
        service: &str,
        account: &str,
        secret: &SecretString,
    ) -> Result<(), CredentialError> {
        let mut credentials = self
            .credentials
            .lock()
            .map_err(|_| CredentialError::BackendFailure)?;
        credentials.insert((service.to_owned(), account.to_owned()), secret.clone());
        Ok(())
    }

    fn get(&self, service: &str, account: &str) -> Result<SecretString, CredentialError> {
        let credentials = self
            .credentials
            .lock()
            .map_err(|_| CredentialError::BackendFailure)?;
        credentials
            .get(&(service.to_owned(), account.to_owned()))
            .cloned()
            .ok_or(CredentialError::NotFound)
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), CredentialError> {
        let mut credentials = self
            .credentials
            .lock()
            .map_err(|_| CredentialError::BackendFailure)?;
        credentials
            .remove(&(service.to_owned(), account.to_owned()))
            .map(|_| ())
            .ok_or(CredentialError::NotFound)
    }
}

fn map_keyring_error(error: &KeyringError) -> CredentialError {
    match error {
        KeyringError::NoStorageAccess(_) => CredentialError::Locked,
        KeyringError::NoEntry => CredentialError::NotFound,
        KeyringError::NoDefaultStore | KeyringError::NotSupportedByStore(_) => {
            CredentialError::Unavailable
        }
        KeyringError::Invalid(parameter, _) if parameter == "platform" => {
            CredentialError::Unavailable
        }
        KeyringError::Invalid(_, _) | KeyringError::TooLong(_, _) => {
            CredentialError::InvalidCredential
        }
        _ => CredentialError::BackendFailure,
    }
}
