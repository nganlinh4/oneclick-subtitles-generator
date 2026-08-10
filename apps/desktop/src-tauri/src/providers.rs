use std::{fmt, time::SystemTime};

use futures_util::StreamExt as _;

use osg_infrastructure::secrets::{
    CredentialId, CredentialPurpose, CredentialSetRequest, CredentialState,
    CredentialStoreAvailability,
};
use osg_media_server::{
    MAX_PROVIDER_IMAGE_REGISTRY_BYTES, MediaServer, MediaServerError, RegisteredMedia,
};
use osg_providers::{
    GeniusRequest, OAuthTokenSet, ProviderImage, YouTubeOAuthClient, YouTubeSearchResult,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt as _;

use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

const DEFAULT_MAX_RESULTS: u8 = 5;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum YouTubeAuthentication {
    ApiKey {
        credential_id: CredentialId,
    },
    Oauth {
        client_credential_id: CredentialId,
        token_credential_id: CredentialId,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct YouTubeSearchRequest {
    authentication: YouTubeAuthentication,
    query: String,
    #[serde(default = "default_max_results")]
    max_results: u8,
}

const fn default_max_results() -> u8 {
    DEFAULT_MAX_RESULTS
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct YouTubeVideoRequest {
    authentication: YouTubeAuthentication,
    video_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct YouTubeOAuthStatus {
    authenticated: bool,
    expires_at_unix_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeniusLyricsResponse {
    lyrics: String,
    album_art_url: Option<String>,
}

impl fmt::Debug for GeniusLyricsResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeniusLyricsResponse")
            .field("lyrics", &"<redacted>")
            .field(
                "album_art_url",
                &self.album_art_url.as_ref().map(|_| "<capability>"),
            )
            .finish()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct YouTubeSearchResponse {
    id: String,
    title: String,
    thumbnail: String,
    channel: String,
    url: String,
}

impl fmt::Debug for YouTubeSearchResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("YouTubeSearchResponse")
            .field("id", &self.id)
            .field("thumbnail", &"<capability>")
            .finish_non_exhaustive()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct YouTubeVideoResponse {
    id: String,
    title: String,
    description: String,
    thumbnail: String,
    channel: String,
    published_at: String,
}

impl fmt::Debug for YouTubeVideoResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("YouTubeVideoResponse")
            .field("id", &self.id)
            .field("thumbnail", &"<capability>")
            .finish_non_exhaustive()
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and deserializes command arguments by value"
)]
pub(crate) async fn genius_lyrics(
    state: State<'_, DesktopState>,
    credential_id: CredentialId,
    request: GeniusRequest,
) -> CommandResult<GeniusLyricsResponse> {
    let token =
        resolve_credential(&state, credential_id, CredentialPurpose::GeniusAccessToken).await?;
    let result = state
        .providers
        .genius_lyrics(&token, &request)
        .await
        .map_err(CommandError::from)?;
    let album_art_url = if let Some(url) = result.album_art_url {
        match state.providers.fetch_genius_artwork(&url).await {
            Ok(image) => Some(register_provider_image(&state.media_server, image)?.playback_url),
            Err(_) => None,
        }
    } else {
        None
    };
    Ok(GeniusLyricsResponse {
        lyrics: result.lyrics,
        album_art_url,
    })
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and deserializes command arguments by value"
)]
pub(crate) async fn youtube_search(
    state: State<'_, DesktopState>,
    request: YouTubeSearchRequest,
) -> CommandResult<Vec<YouTubeSearchResponse>> {
    let results = match request.authentication {
        YouTubeAuthentication::ApiKey { credential_id } => {
            let key =
                resolve_credential(&state, credential_id, CredentialPurpose::YouTubeApiKey).await?;
            state
                .providers
                .youtube_search_api_key(&key, &request.query, request.max_results)
                .await
                .map_err(CommandError::from)
        }
        YouTubeAuthentication::Oauth {
            client_credential_id,
            token_credential_id,
        } => {
            let (client, tokens) =
                resolve_oauth(&state, client_credential_id, token_credential_id).await?;
            let tokens = refresh_if_needed(&state, &client, tokens).await?;
            state
                .providers
                .youtube_search_oauth(tokens.access_token(), &request.query, request.max_results)
                .await
                .map_err(CommandError::from)
        }
    }?;
    localize_youtube_search_results(&state.providers, &state.media_server, results).await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and deserializes command arguments by value"
)]
pub(crate) async fn youtube_video_details(
    state: State<'_, DesktopState>,
    request: YouTubeVideoRequest,
) -> CommandResult<Option<YouTubeVideoResponse>> {
    let details = match request.authentication {
        YouTubeAuthentication::ApiKey { credential_id } => {
            let key =
                resolve_credential(&state, credential_id, CredentialPurpose::YouTubeApiKey).await?;
            state
                .providers
                .youtube_video_api_key(&key, &request.video_id)
                .await
                .map_err(CommandError::from)
        }
        YouTubeAuthentication::Oauth {
            client_credential_id,
            token_credential_id,
        } => {
            let (client, tokens) =
                resolve_oauth(&state, client_credential_id, token_credential_id).await?;
            let tokens = refresh_if_needed(&state, &client, tokens).await?;
            state
                .providers
                .youtube_video_oauth(tokens.access_token(), &request.video_id)
                .await
                .map_err(CommandError::from)
        }
    }?;
    let Some(details) = details else {
        return Ok(None);
    };
    let image = state
        .providers
        .fetch_youtube_image(&details.thumbnail)
        .await?;
    let thumbnail = register_provider_image(&state.media_server, image)?.playback_url;
    Ok(Some(YouTubeVideoResponse {
        id: details.id,
        title: details.title,
        description: details.description,
        thumbnail,
        channel: details.channel,
        published_at: details.published_at,
    }))
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and deserializes command arguments by value"
)]
pub(crate) async fn youtube_thumbnail(
    state: State<'_, DesktopState>,
    video_id: String,
) -> CommandResult<String> {
    let image = state
        .providers
        .fetch_default_youtube_thumbnail(&video_id)
        .await?;
    Ok(register_provider_image(&state.media_server, image)?.playback_url)
}

async fn localize_youtube_search_results(
    providers: &osg_providers::ProviderClient,
    media_server: &MediaServer,
    results: Vec<YouTubeSearchResult>,
) -> CommandResult<Vec<YouTubeSearchResponse>> {
    let mut pending =
        futures_util::stream::iter(results.into_iter().enumerate().map(|(index, result)| {
            let providers = providers.clone();
            async move {
                let image = providers.fetch_youtube_image(&result.thumbnail).await?;
                Ok::<_, osg_providers::ProviderError>((index, result, image))
            }
        }))
        .buffer_unordered(4);
    let mut fetched = Vec::new();
    let mut aggregate_bytes = 0_usize;
    while let Some(item) = pending.next().await {
        let (index, result, image) = item?;
        aggregate_bytes = aggregate_bytes
            .checked_add(image.len())
            .filter(|total| *total <= MAX_PROVIDER_IMAGE_REGISTRY_BYTES)
            .ok_or(MediaServerError::RegistryFull)?;
        fetched.push((index, result, image));
    }
    fetched.sort_unstable_by_key(|(index, _, _)| *index);

    let mut ordered_results = Vec::with_capacity(fetched.len());
    let mut image_batch = Vec::with_capacity(fetched.len());
    for (_, result, image) in fetched {
        let (mime_type, bytes) = image.into_parts();
        ordered_results.push(result);
        image_batch.push((mime_type.to_owned(), bytes));
    }
    let registered = media_server.register_images(image_batch)?;
    Ok(ordered_results
        .into_iter()
        .zip(registered)
        .map(|(result, image)| YouTubeSearchResponse {
            id: result.id,
            title: result.title,
            thumbnail: image.playback_url,
            channel: result.channel,
            url: result.url,
        })
        .collect())
}

fn register_provider_image(
    media_server: &MediaServer,
    image: ProviderImage,
) -> CommandResult<RegisteredMedia> {
    let (mime_type, bytes) = image.into_parts();
    media_server
        .register_image(mime_type, bytes)
        .map_err(CommandError::from)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects AppHandle and State as owned command extractors"
)]
pub(crate) async fn youtube_oauth_authorize(
    app: AppHandle,
    state: State<'_, DesktopState>,
    client_credential_id: CredentialId,
) -> CommandResult<YouTubeOAuthStatus> {
    let secret = resolve_credential(
        &state,
        client_credential_id,
        CredentialPurpose::YouTubeOauthClient,
    )
    .await?;
    let client = YouTubeOAuthClient::from_vault_secret(&secret)?;
    let tokens = state
        .youtube_oauth
        .authorize(&state.providers, &client, move |url| {
            app.opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(|_| osg_providers::ProviderError::BrowserOpen)
        })
        .await?;
    persist_oauth_tokens(&state, &tokens).await?;
    Ok(YouTubeOAuthStatus {
        authenticated: true,
        expires_at_unix_ms: Some(tokens.expires_at_unix_ms()),
    })
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) fn youtube_oauth_cancel(state: State<'_, DesktopState>) -> CommandResult<bool> {
    state.youtube_oauth.cancel().map_err(Into::into)
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn youtube_oauth_status(
    state: State<'_, DesktopState>,
) -> CommandResult<YouTubeOAuthStatus> {
    let credentials = state.credentials.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        credentials.status(Some(CredentialPurpose::YouTubeOauthToken))
    })
    .await
    .map_err(|_| CommandError::internal("the OAuth status task stopped unexpectedly"))??;
    if report.store != CredentialStoreAvailability::Available {
        return Ok(YouTubeOAuthStatus {
            authenticated: false,
            expires_at_unix_ms: None,
        });
    }
    let Some(status) = report
        .credentials
        .into_iter()
        .find(|status| status.state == CredentialState::Ready)
    else {
        return Ok(YouTubeOAuthStatus {
            authenticated: false,
            expires_at_unix_ms: None,
        });
    };
    let secret =
        resolve_credential(&state, status.id, CredentialPurpose::YouTubeOauthToken).await?;
    let tokens = OAuthTokenSet::from_vault_secret(&secret)?;
    Ok(YouTubeOAuthStatus {
        authenticated: true,
        expires_at_unix_ms: Some(tokens.expires_at_unix_ms()),
    })
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn youtube_oauth_clear(state: State<'_, DesktopState>) -> CommandResult<bool> {
    let credentials = state.credentials.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let delete_purpose = |purpose| {
            let report = credentials.status(Some(purpose))?;
            let mut removed = false;
            for credential in report.credentials {
                removed |= credentials.delete(credential.id)?;
            }
            Ok::<_, osg_infrastructure::secrets::CredentialServiceError>(removed)
        };
        // Attempt both independent keyring removals even if one fails, so "clear OAuth" cannot
        // leave the other secret behind merely because the first OS-store operation faulted.
        let token = delete_purpose(CredentialPurpose::YouTubeOauthToken);
        let client = delete_purpose(CredentialPurpose::YouTubeOauthClient);
        match (token, client) {
            (Ok(token_removed), Ok(client_removed)) => Ok(token_removed || client_removed),
            (Err(error), _) | (_, Err(error)) => Err(error),
        }
    })
    .await
    .map_err(|_| CommandError::internal("the OAuth clear task stopped unexpectedly"))?
    .map_err(Into::into)
}

async fn resolve_credential(
    state: &DesktopState,
    id: CredentialId,
    purpose: CredentialPurpose,
) -> CommandResult<secrecy::SecretString> {
    let credentials = state.credentials.clone();
    tauri::async_runtime::spawn_blocking(move || credentials.resolve(id, purpose))
        .await
        .map_err(|_| CommandError::internal("the credential resolution task stopped unexpectedly"))?
        .map_err(Into::into)
}

async fn resolve_oauth(
    state: &DesktopState,
    client_id: CredentialId,
    token_id: CredentialId,
) -> CommandResult<(YouTubeOAuthClient, OAuthTokenSet)> {
    let (client, tokens) = tokio::try_join!(
        resolve_credential(state, client_id, CredentialPurpose::YouTubeOauthClient),
        resolve_credential(state, token_id, CredentialPurpose::YouTubeOauthToken),
    )?;
    Ok((
        YouTubeOAuthClient::from_vault_secret(&client)?,
        OAuthTokenSet::from_vault_secret(&tokens)?,
    ))
}

async fn refresh_if_needed(
    state: &DesktopState,
    client: &YouTubeOAuthClient,
    tokens: OAuthTokenSet,
) -> CommandResult<OAuthTokenSet> {
    if !tokens.needs_refresh(SystemTime::now()) {
        return Ok(tokens);
    }
    let refreshed = state
        .providers
        .refresh_youtube_oauth(client, tokens)
        .await?;
    persist_oauth_tokens(state, &refreshed).await?;
    Ok(refreshed)
}

async fn persist_oauth_tokens(state: &DesktopState, tokens: &OAuthTokenSet) -> CommandResult<()> {
    let request = CredentialSetRequest::from_secret(
        CredentialPurpose::YouTubeOauthToken,
        tokens.to_vault_secret()?,
    );
    let credentials = state.credentials.clone();
    tauri::async_runtime::spawn_blocking(move || credentials.upsert(request))
        .await
        .map_err(|_| CommandError::internal("the OAuth vault task stopped unexpectedly"))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_inputs_reject_unknown_fields_and_legacy_tokens() {
        assert!(
            serde_json::from_str::<YouTubeSearchRequest>(
                r#"{"authentication":{"kind":"apiKey","credentialId":"01989aaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"},"query":"music","maxResults":5,"apiKey":"secret"}"#,
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<YouTubeVideoRequest>(
                r#"{"authentication":{"kind":"oauth","accessToken":"secret"},"videoId":"AbCdEfGhI_1"}"#,
            )
            .is_err()
        );
    }

    #[test]
    fn oauth_status_serializes_only_safe_fields() {
        let value = serde_json::to_value(YouTubeOAuthStatus {
            authenticated: true,
            expires_at_unix_ms: Some(1_800_000_000_000),
        })
        .expect("serialize status");
        assert_eq!(
            value,
            serde_json::json!({
                "authenticated": true,
                "expiresAtUnixMs": 1_800_000_000_000_u64
            })
        );
    }
}
