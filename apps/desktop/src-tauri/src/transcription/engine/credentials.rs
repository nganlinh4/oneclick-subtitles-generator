//! Resolves the ready Gemini credential pool and builds one bounded client per key.

use std::sync::Arc;

use osg_gemini::{ApiKey, GeminiClient, GeminiClientBuilder};
use osg_infrastructure::secrets::{CredentialId, CredentialPurpose, CredentialState};
use secrecy::{ExposeSecret, SecretString};

use crate::background;
use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

fn no_ready_key() -> CommandError {
    CommandError::invalid_input(
        "No ready Gemini API key found. Please configure an API key in Settings.",
    )
}

/// Every ready Gemini key, the preferred one first. Only the preferred key's resolution failure
/// is fatal; other unreadable keys are skipped.
pub(super) async fn ready_gemini_secrets(
    state: &DesktopState,
    preferred: Option<CredentialId>,
) -> CommandResult<Vec<SecretString>> {
    let credentials = state.credentials.clone();
    background::run_blocking("credential resolution", move || {
        let report = credentials.status(Some(CredentialPurpose::GeminiApiKey))?;
        let mut ready_ids = report
            .credentials
            .into_iter()
            .filter(|credential| credential.state == CredentialState::Ready)
            .map(|credential| credential.id)
            .collect::<Vec<_>>();
        if let Some(preferred) = preferred {
            ready_ids.retain(|id| *id != preferred);
            ready_ids.insert(0, preferred);
        }
        let mut secrets = Vec::with_capacity(ready_ids.len());
        for (index, id) in ready_ids.into_iter().enumerate() {
            match credentials.resolve(id, CredentialPurpose::GeminiApiKey) {
                Ok(secret) => secrets.push(secret),
                Err(error) if index == 0 => return Err(CommandError::from(error)),
                Err(_) => {}
            }
        }
        if secrets.is_empty() {
            return Err(no_ready_key());
        }
        Ok(secrets)
    })
    .await
}

pub(super) fn gemini_clients(
    secrets: Vec<SecretString>,
    sessions_per_credential: usize,
) -> CommandResult<Vec<Arc<GeminiClient>>> {
    secrets
        .into_iter()
        .map(|secret| {
            let api_key = ApiKey::new(secret.expose_secret().to_owned())?;
            Ok(Arc::new(
                GeminiClientBuilder::new(api_key)
                    .max_concurrent_requests(sessions_per_credential)
                    .build()?,
            ))
        })
        .collect()
}
