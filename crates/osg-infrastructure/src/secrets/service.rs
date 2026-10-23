use super::{
    CredentialBackend, CredentialError, CredentialId, CredentialPurpose, CredentialServiceError,
    CredentialSetRequest, CredentialState, CredentialStatus, CredentialStatusReport,
    CredentialStoreAvailability, CredentialVault, KeyringCredentialBackend, credential_last_four,
    validate_credential,
};
use crate::storage::Database;
use std::sync::{Arc, Mutex};

/// Coordinates crash-recoverable database metadata with a secure credential backend.
pub struct CredentialService<B> {
    database: Database,
    vault: CredentialVault<B>,
    mutations: Arc<Mutex<()>>,
}

impl<B> CredentialService<B>
where
    B: CredentialBackend,
{
    #[must_use]
    pub fn new(database: Database, backend: B) -> Self {
        Self {
            database,
            vault: CredentialVault::new(backend),
            mutations: Arc::new(Mutex::new(())),
        }
    }

    /// Creates metadata first, then writes and verifies the secret, then marks it ready.
    ///
    /// A crash after the keyring write leaves a `pending` row which `status` repairs.
    pub fn set(
        &self,
        request: CredentialSetRequest,
    ) -> Result<CredentialStatus, CredentialServiceError> {
        let (purpose, secret) = request.into_parts();
        let _guard = self.lock_mutations()?;
        self.store_unlocked(purpose, &secret)
    }

    fn store_unlocked(
        &self,
        purpose: CredentialPurpose,
        secret: &secrecy::SecretString,
    ) -> Result<CredentialStatus, CredentialServiceError> {
        validate_credential(purpose, secret)?;
        let last4 = credential_last_four(purpose, secret)?;
        match self.vault.availability()? {
            CredentialStoreAvailability::Available => {}
            CredentialStoreAvailability::Locked => return Err(CredentialError::Locked.into()),
            CredentialStoreAvailability::Unavailable => {
                return Err(CredentialError::Unavailable.into());
            }
        }
        let id = CredentialId::new();
        self.database.credential_insert_pending(id, purpose)?;
        if let Err(error) = self.vault.set(id, secret) {
            // A backend can fail after partially writing. Remove the vault entry first;
            // metadata is deleted only when that compensating cleanup is confirmed.
            // If cleanup itself fails, the pending row intentionally remains so a
            // later status pass can reconcile it without orphaning a secret.
            if self.vault.delete(id).is_ok() {
                let _ = self.database.credential_delete(id);
            }
            return Err(error.into());
        }
        Ok(self.database.credential_mark_ready(id, &last4)?)
    }

    /// Creates or atomically replaces a singleton-purpose credential.
    pub fn upsert(
        &self,
        request: CredentialSetRequest,
    ) -> Result<CredentialStatus, CredentialServiceError> {
        let (purpose, secret) = request.into_parts();
        let _guard = self.lock_mutations()?;
        if purpose.allows_multiple() {
            return self.store_unlocked(purpose, &secret);
        }
        validate_credential(purpose, &secret)?;
        let last4 = credential_last_four(purpose, &secret)?;
        let existing = self.database.credential_list(Some(purpose))?;
        let Some(status) = existing.first() else {
            return self.store_unlocked(purpose, &secret);
        };
        if existing.len() != 1 {
            return Err(CredentialError::InvalidCredential.into());
        }
        if self.vault.inspect(status.id)?.is_some() {
            self.vault.replace(status.id, &secret)?;
        } else {
            self.vault.set(status.id, &secret)?;
        }
        Ok(self.database.credential_mark_ready(status.id, &last4)?)
    }

    /// Atomically replaces one explicitly selected credential without exposing its prior value.
    pub fn replace(
        &self,
        id: CredentialId,
        request: CredentialSetRequest,
    ) -> Result<CredentialStatus, CredentialServiceError> {
        let (purpose, secret) = request.into_parts();
        let _guard = self.lock_mutations()?;
        let existing = self.database.credential_get(id)?;
        if existing.purpose != purpose {
            return Err(CredentialError::PurposeMismatch.into());
        }
        validate_credential(purpose, &secret)?;
        let last4 = credential_last_four(purpose, &secret)?;
        match self.vault.availability()? {
            CredentialStoreAvailability::Available => {}
            CredentialStoreAvailability::Locked => return Err(CredentialError::Locked.into()),
            CredentialStoreAvailability::Unavailable => {
                return Err(CredentialError::Unavailable.into());
            }
        }
        self.vault.replace(id, &secret)?;
        Ok(self.database.credential_mark_ready(id, &last4)?)
    }

    /// Deletes the keyring entry before deleting its non-secret metadata.
    ///
    /// If the metadata deletion later fails, a subsequent status pass marks the stale
    /// reference unavailable and a repeated delete remains safe.
    pub fn delete(&self, id: CredentialId) -> Result<bool, CredentialServiceError> {
        let _guard = self.lock_mutations()?;
        self.vault.delete(id)?;
        self.database.credential_delete(id).map_err(Into::into)
    }

    /// Returns metadata and opportunistically reconciles incomplete operations.
    pub fn status(
        &self,
        purpose: Option<CredentialPurpose>,
    ) -> Result<CredentialStatusReport, CredentialServiceError> {
        let _guard = self.lock_mutations()?;
        let mut credentials = self.database.credential_list(purpose)?;
        let store = self.vault.availability()?;
        if store != CredentialStoreAvailability::Available {
            return Ok(CredentialStatusReport { store, credentials });
        }

        for credential in &mut credentials {
            match self.vault.inspect(credential.id)? {
                Some(secret) => {
                    validate_credential(credential.purpose, &secret)?;
                    let last4 = credential_last_four(credential.purpose, &secret)?;
                    if credential.state != CredentialState::Ready
                        || credential.last4.as_deref() != Some(last4.as_str())
                    {
                        *credential = self.database.credential_mark_ready(credential.id, &last4)?;
                    }
                }
                None if credential.state != CredentialState::Unavailable => {
                    *credential = self.database.credential_mark_unavailable(credential.id)?;
                }
                None => {}
            }
        }

        Ok(CredentialStatusReport { store, credentials })
    }

    /// Resolves a secret only for native in-process provider clients.
    ///
    /// The desktop command registry deliberately exposes no corresponding command.
    pub fn resolve(
        &self,
        id: CredentialId,
        expected_purpose: CredentialPurpose,
    ) -> Result<secrecy::SecretString, CredentialServiceError> {
        let status = self.database.credential_get(id)?;
        if status.purpose != expected_purpose {
            return Err(CredentialError::PurposeMismatch.into());
        }
        self.vault.resolve(id).map_err(Into::into)
    }

    #[must_use]
    pub const fn database(&self) -> &Database {
        &self.database
    }

    fn lock_mutations(&self) -> Result<std::sync::MutexGuard<'_, ()>, CredentialServiceError> {
        self.mutations
            .lock()
            .map_err(|_| CredentialError::BackendFailure.into())
    }
}

impl CredentialService<KeyringCredentialBackend> {
    /// Builds the service without probing the platform keyring during application setup.
    #[must_use]
    pub fn platform(database: Database) -> Self {
        Self {
            database,
            vault: CredentialVault::platform(),
            mutations: Arc::new(Mutex::new(())),
        }
    }
}

impl<B> Clone for CredentialService<B>
where
    B: CredentialBackend + Clone,
{
    fn clone(&self) -> Self {
        Self {
            database: self.database.clone(),
            vault: self.vault.clone(),
            mutations: Arc::clone(&self.mutations),
        }
    }
}

impl<B> std::fmt::Debug for CredentialService<B> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CredentialService")
            .field("database", &self.database)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests;
