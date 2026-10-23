mod backend;
mod error;
mod service;

use std::{fmt, str::FromStr};

pub use backend::{CredentialBackend, KeyringCredentialBackend, SessionCredentialBackend};
pub use error::{
    CredentialError, CredentialServiceError, InvalidCredentialId, InvalidCredentialProvider,
    InvalidCredentialPurpose, InvalidCredentialState,
};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Deserializer, Serialize, de};
pub use service::CredentialService;
use uuid::{Uuid, Version};

pub const CREDENTIAL_SERVICE: &str = "com.subtitlesgenerator.app.credentials";
const CREDENTIAL_ACCOUNT_PREFIX: &str = "credential/";
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;

/// An opaque, time-sortable identifier for one credential.
///
/// This identifier is safe to persist and expose to the UI. Credential values are
/// stored separately in the operating-system credential store.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct CredentialId(Uuid);

impl CredentialId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(id: Uuid) -> Result<Self, InvalidCredentialId> {
        if id.get_version() == Some(Version::SortRand) {
            Ok(Self(id))
        } else {
            Err(InvalidCredentialId::Version)
        }
    }

    #[must_use]
    pub const fn as_uuid(self) -> Uuid {
        self.0
    }

    pub(crate) fn account(self) -> String {
        format!("{CREDENTIAL_ACCOUNT_PREFIX}{}", self.0.hyphenated())
    }
}

impl Default for CredentialId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for CredentialId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for CredentialId {
    type Err = InvalidCredentialId;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::from_uuid(Uuid::parse_str(value)?)
    }
}

impl<'de> Deserialize<'de> for CredentialId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let id = Uuid::deserialize(deserializer)?;
        Self::from_uuid(id).map_err(de::Error::custom)
    }
}

/// A provider accepted by the native credential API.
///
/// Keeping this closed rather than accepting arbitrary strings prevents typo-created
/// credential namespaces and gives database rows a stable long-term meaning.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum CredentialProvider {
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "genius")]
    Genius,
    #[serde(rename = "youtube")]
    YouTube,
}

impl CredentialProvider {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::Genius => "genius",
            Self::YouTube => "youtube",
        }
    }
}

impl fmt::Display for CredentialProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for CredentialProvider {
    type Err = InvalidCredentialProvider;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "gemini" => Ok(Self::Gemini),
            "genius" => Ok(Self::Genius),
            "youtube" => Ok(Self::YouTube),
            _ => Err(InvalidCredentialProvider),
        }
    }
}

/// The exact use permitted for a native credential.
///
/// Provider is deliberately derived from this closed value. A credential reference
/// therefore cannot silently change meaning as more integrations are added to a
/// provider family.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum CredentialPurpose {
    #[serde(rename = "geminiApiKey")]
    GeminiApiKey,
    #[serde(rename = "geniusAccessToken")]
    GeniusAccessToken,
    #[serde(rename = "youtubeApiKey")]
    YouTubeApiKey,
    #[serde(rename = "youtubeOauthClient")]
    YouTubeOauthClient,
    #[serde(rename = "youtubeOauthToken")]
    YouTubeOauthToken,
}

impl CredentialPurpose {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GeminiApiKey => "gemini_api_key",
            Self::GeniusAccessToken => "genius_access_token",
            Self::YouTubeApiKey => "youtube_api_key",
            Self::YouTubeOauthClient => "youtube_oauth_client",
            Self::YouTubeOauthToken => "youtube_oauth_token",
        }
    }

    #[must_use]
    pub const fn provider(self) -> CredentialProvider {
        match self {
            Self::GeminiApiKey => CredentialProvider::Gemini,
            Self::GeniusAccessToken => CredentialProvider::Genius,
            Self::YouTubeApiKey | Self::YouTubeOauthClient | Self::YouTubeOauthToken => {
                CredentialProvider::YouTube
            }
        }
    }

    #[must_use]
    pub const fn allows_multiple(self) -> bool {
        matches!(self, Self::GeminiApiKey)
    }
}

impl fmt::Display for CredentialPurpose {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for CredentialPurpose {
    type Err = InvalidCredentialPurpose;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "gemini_api_key" => Ok(Self::GeminiApiKey),
            "genius_access_token" => Ok(Self::GeniusAccessToken),
            "youtube_api_key" => Ok(Self::YouTubeApiKey),
            "youtube_oauth_client" => Ok(Self::YouTubeOauthClient),
            "youtube_oauth_token" => Ok(Self::YouTubeOauthToken),
            _ => Err(InvalidCredentialPurpose),
        }
    }
}

/// Durable reconciliation state for a credential reference.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialState {
    /// Metadata exists but the keyring write has not yet been verified and finalized.
    Pending,
    /// The keyring value was round-trip verified.
    Ready,
    /// Metadata exists, but an available keyring no longer contains the value.
    Unavailable,
}

impl CredentialState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Unavailable => "unavailable",
        }
    }
}

impl FromStr for CredentialState {
    type Err = InvalidCredentialState;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pending" => Ok(Self::Pending),
            "ready" => Ok(Self::Ready),
            "unavailable" => Ok(Self::Unavailable),
            _ => Err(InvalidCredentialState),
        }
    }
}

/// UI-safe credential metadata. This type cannot carry a credential value.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub id: CredentialId,
    pub purpose: CredentialPurpose,
    provider: CredentialProvider,
    pub state: CredentialState,
    pub last4: Option<String>,
}

impl CredentialStatus {
    #[must_use]
    pub(crate) const fn pending(id: CredentialId, purpose: CredentialPurpose) -> Self {
        Self {
            id,
            purpose,
            provider: purpose.provider(),
            state: CredentialState::Pending,
            last4: None,
        }
    }

    #[must_use]
    pub const fn provider(&self) -> CredentialProvider {
        self.provider
    }

    pub(crate) const fn from_parts(
        id: CredentialId,
        purpose: CredentialPurpose,
        state: CredentialState,
        last4: Option<String>,
    ) -> Self {
        Self {
            id,
            purpose,
            provider: purpose.provider(),
            state,
            last4,
        }
    }
}

/// Current accessibility of the operating-system credential store.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialStoreAvailability {
    Available,
    Locked,
    Unavailable,
}

/// A status response that remains useful when a platform keyring is locked or missing.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatusReport {
    pub store: CredentialStoreAvailability,
    pub credentials: Vec<CredentialStatus>,
}

/// Secret-bearing command input.
///
/// It intentionally implements neither `Debug` nor `Serialize`, which prevents a
/// credential from being returned over IPC or included in ordinary diagnostic output.
#[allow(
    missing_debug_implementations,
    reason = "secret-bearing values must not be included in diagnostic output"
)]
struct CredentialSecret(SecretString);

impl CredentialSecret {
    #[must_use]
    fn new(value: String) -> Self {
        Self(SecretString::from(value))
    }

    fn into_inner(self) -> SecretString {
        self.0
    }
}

impl<'de> Deserialize<'de> for CredentialSecret {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self::new)
    }
}

/// Typed input for creating another provider credential.
///
/// There is deliberately no optional identifier: every set operation creates a new
/// `UUIDv7` reference, allowing multiple Gemini keys without overwrite ambiguity.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(
    missing_debug_implementations,
    reason = "secret-bearing command inputs must not be included in diagnostic output"
)]
pub struct CredentialSetRequest {
    purpose: CredentialPurpose,
    secret: CredentialSecret,
}

impl CredentialSetRequest {
    #[must_use]
    pub fn new(purpose: CredentialPurpose, secret: String) -> Self {
        Self {
            purpose,
            secret: CredentialSecret::new(secret),
        }
    }

    /// Builds a native-only request without converting an already protected value back to a
    /// caller-visible string.
    #[must_use]
    pub fn from_secret(purpose: CredentialPurpose, secret: SecretString) -> Self {
        Self {
            purpose,
            secret: CredentialSecret(secret),
        }
    }

    fn into_parts(self) -> (CredentialPurpose, SecretString) {
        (self.purpose, self.secret.into_inner())
    }
}

/// Safe low-level access to credentials held by a selected backend.
pub struct CredentialVault<B> {
    backend: B,
}

impl<B> CredentialVault<B>
where
    B: CredentialBackend,
{
    #[must_use]
    pub const fn new(backend: B) -> Self {
        Self { backend }
    }

    pub fn availability(&self) -> Result<CredentialStoreAvailability, CredentialError> {
        match self.backend.ensure_available() {
            Ok(()) => Ok(CredentialStoreAvailability::Available),
            Err(CredentialError::Locked) => Ok(CredentialStoreAvailability::Locked),
            Err(CredentialError::Unavailable) => Ok(CredentialStoreAvailability::Unavailable),
            Err(error) => Err(error),
        }
    }

    pub fn set(&self, id: CredentialId, secret: &SecretString) -> Result<(), CredentialError> {
        validate_secret(secret)?;

        self.backend.ensure_available()?;
        let account = id.account();
        self.backend.set(CREDENTIAL_SERVICE, &account, secret)?;

        let stored =
            self.backend
                .get(CREDENTIAL_SERVICE, &account)
                .map_err(|error| match error {
                    CredentialError::Unavailable | CredentialError::Locked => error,
                    _ => CredentialError::VerificationFailed,
                })?;
        if stored.expose_secret() != secret.expose_secret() {
            let _ = self.backend.delete(CREDENTIAL_SERVICE, &account);
            return Err(CredentialError::VerificationFailed);
        }

        Ok(())
    }

    /// Replaces one value and restores the previous value if write verification fails.
    pub fn replace(&self, id: CredentialId, secret: &SecretString) -> Result<(), CredentialError> {
        validate_secret(secret)?;
        self.backend.ensure_available()?;
        let account = id.account();
        let previous = self.backend.get(CREDENTIAL_SERVICE, &account)?;
        let write_result = self.backend.set(CREDENTIAL_SERVICE, &account, secret);
        let verified = write_result.is_ok()
            && self
                .backend
                .get(CREDENTIAL_SERVICE, &account)
                .is_ok_and(|stored| stored.expose_secret() == secret.expose_secret());
        if verified {
            return Ok(());
        }

        let restored = self
            .backend
            .set(CREDENTIAL_SERVICE, &account, &previous)
            .and_then(|()| self.backend.get(CREDENTIAL_SERVICE, &account))
            .is_ok_and(|stored| stored.expose_secret() == previous.expose_secret());
        if !restored {
            return Err(CredentialError::VerificationFailed);
        }
        Err(write_result
            .err()
            .unwrap_or(CredentialError::VerificationFailed))
    }

    /// Resolves a credential for an in-process provider adapter.
    ///
    /// This is intentionally not exposed as a Tauri command.
    pub fn resolve(&self, id: CredentialId) -> Result<SecretString, CredentialError> {
        self.backend.ensure_available()?;
        self.backend.get(CREDENTIAL_SERVICE, &id.account())
    }

    fn inspect(&self, id: CredentialId) -> Result<Option<SecretString>, CredentialError> {
        self.backend.ensure_available()?;
        match self.backend.get(CREDENTIAL_SERVICE, &id.account()) {
            Ok(secret) => Ok(Some(secret)),
            Err(CredentialError::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn delete(&self, id: CredentialId) -> Result<(), CredentialError> {
        self.backend.ensure_available()?;
        match self.backend.delete(CREDENTIAL_SERVICE, &id.account()) {
            Ok(()) | Err(CredentialError::NotFound) => Ok(()),
            Err(error) => Err(error),
        }
    }

    #[must_use]
    pub const fn backend(&self) -> &B {
        &self.backend
    }
}

impl CredentialVault<KeyringCredentialBackend> {
    /// Creates the platform vault without touching the keyring.
    ///
    /// Availability is checked lazily by commands, so a missing Linux Secret Service
    /// or a locked desktop session never prevents the application from launching.
    #[must_use]
    pub const fn platform() -> Self {
        Self::new(KeyringCredentialBackend::new())
    }
}

impl<B> Clone for CredentialVault<B>
where
    B: CredentialBackend + Clone,
{
    fn clone(&self) -> Self {
        Self::new(self.backend.clone())
    }
}

impl<B> fmt::Debug for CredentialVault<B> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialVault")
            .finish_non_exhaustive()
    }
}

fn last_four(secret: &str) -> String {
    let start = secret
        .char_indices()
        .rev()
        .nth(3)
        .map_or(0, |(index, _)| index);
    secret[start..].to_owned()
}

fn credential_last_four(
    purpose: CredentialPurpose,
    secret: &SecretString,
) -> Result<String, CredentialError> {
    let value = secret.expose_secret();
    match purpose {
        CredentialPurpose::YouTubeOauthClient => {
            let client = parse_youtube_oauth_client(value)?;
            Ok(last_four(client.client_secret))
        }
        CredentialPurpose::YouTubeOauthToken => {
            let token = parse_youtube_oauth_token(value)?;
            Ok(last_four(token.refresh_token))
        }
        CredentialPurpose::GeminiApiKey
        | CredentialPurpose::GeniusAccessToken
        | CredentialPurpose::YouTubeApiKey => Ok(last_four(value)),
    }
}

fn validate_credential(
    purpose: CredentialPurpose,
    secret: &SecretString,
) -> Result<(), CredentialError> {
    validate_secret(secret)?;
    match purpose {
        CredentialPurpose::YouTubeOauthClient => {
            let _ = parse_youtube_oauth_client(secret.expose_secret())?;
        }
        CredentialPurpose::YouTubeOauthToken => {
            let _ = parse_youtube_oauth_token(secret.expose_secret())?;
        }
        CredentialPurpose::GeminiApiKey
        | CredentialPurpose::GeniusAccessToken
        | CredentialPurpose::YouTubeApiKey => {}
    }
    Ok(())
}

fn validate_secret(secret: &SecretString) -> Result<(), CredentialError> {
    let length = secret.expose_secret().len();
    if length == 0 {
        Err(CredentialError::EmptySecret)
    } else if length > MAX_CREDENTIAL_BYTES {
        Err(CredentialError::InvalidCredential)
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YoutubeOauthClient<'a> {
    client_id: &'a str,
    client_secret: &'a str,
}

fn parse_youtube_oauth_client(value: &str) -> Result<YoutubeOauthClient<'_>, CredentialError> {
    let client: YoutubeOauthClient<'_> =
        serde_json::from_str(value).map_err(|_| CredentialError::InvalidCredential)?;
    if client.client_id.trim().is_empty() || client.client_secret.trim().is_empty() {
        return Err(CredentialError::InvalidCredential);
    }
    Ok(client)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YoutubeOauthToken<'a> {
    access_token: &'a str,
    refresh_token: &'a str,
    expires_at_unix_ms: u64,
}

fn parse_youtube_oauth_token(value: &str) -> Result<YoutubeOauthToken<'_>, CredentialError> {
    let token: YoutubeOauthToken<'_> =
        serde_json::from_str(value).map_err(|_| CredentialError::InvalidCredential)?;
    if token.access_token.is_empty()
        || token.refresh_token.is_empty()
        || token.expires_at_unix_ms == 0
        || token.access_token.chars().any(char::is_control)
        || token.refresh_token.chars().any(char::is_control)
    {
        return Err(CredentialError::InvalidCredential);
    }
    Ok(token)
}

#[cfg(test)]
mod tests;
