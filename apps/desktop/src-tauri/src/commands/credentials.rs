//! Credential vault commands; values never cross back over IPC except by explicit reveal.

use osg_infrastructure::secrets::{
    CredentialId, CredentialPurpose, CredentialSetRequest, CredentialStatus, CredentialStatusReport,
};
use secrecy::ExposeSecret;
use tauri::State;

use crate::background;
use crate::error::CommandResult;
use crate::state::DesktopState;

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn credential_set(
    state: State<'_, DesktopState>,
    request: CredentialSetRequest,
) -> CommandResult<CredentialStatus> {
    let credentials = state.credentials.clone();
    background::run_blocking("store credential", move || credentials.set(request)).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn credential_upsert(
    state: State<'_, DesktopState>,
    request: CredentialSetRequest,
) -> CommandResult<CredentialStatus> {
    let credentials = state.credentials.clone();
    background::run_blocking("upsert credential", move || credentials.upsert(request)).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn credential_replace(
    state: State<'_, DesktopState>,
    id: CredentialId,
    request: CredentialSetRequest,
) -> CommandResult<CredentialStatus> {
    let credentials = state.credentials.clone();
    background::run_blocking("replace credential", move || {
        credentials.replace(id, request)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn credential_reveal(
    state: State<'_, DesktopState>,
    id: CredentialId,
) -> CommandResult<String> {
    let credentials = state.credentials.clone();
    background::run_blocking("reveal credential", move || {
        credentials.resolve(id, CredentialPurpose::GeminiApiKey)
    })
    .await
    .map(|secret| secret.expose_secret().to_owned())
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn credential_delete(
    state: State<'_, DesktopState>,
    id: CredentialId,
) -> CommandResult<bool> {
    let credentials = state.credentials.clone();
    background::run_blocking("delete credential", move || credentials.delete(id)).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn credential_status(
    state: State<'_, DesktopState>,
    purpose: Option<CredentialPurpose>,
) -> CommandResult<CredentialStatusReport> {
    let credentials = state.credentials.clone();
    background::run_blocking("read credential status", move || {
        credentials.status(purpose)
    })
    .await
}
