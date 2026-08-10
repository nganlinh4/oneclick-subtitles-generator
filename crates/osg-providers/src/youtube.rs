use secrecy::{ExposeSecret as _, SecretString};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::bounded::{is_json, read};
use crate::{ProviderClient, ProviderError, Result};

const MAX_RESULTS: u8 = 50;
const MAX_QUERY_CHARACTERS: usize = 500;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TITLE_CHARACTERS: usize = 1_000;
const MAX_DESCRIPTION_CHARACTERS: usize = 50_000;
const MAX_CHANNEL_CHARACTERS: usize = 1_000;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeSearchResult {
    pub id: String,
    pub title: String,
    pub thumbnail: String,
    pub channel: String,
    pub url: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeVideoDetails {
    pub id: String,
    pub title: String,
    pub description: String,
    pub thumbnail: String,
    pub channel: String,
    pub published_at: String,
}

enum Authorization<'a> {
    ApiKey(&'a SecretString),
    OAuth(&'a SecretString),
}

#[derive(Deserialize)]
struct SearchEnvelope {
    #[serde(default)]
    items: Vec<SearchItem>,
}

#[derive(Deserialize)]
struct SearchItem {
    id: SearchId,
    snippet: Snippet,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchId {
    video_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snippet {
    title: String,
    #[serde(default)]
    description: String,
    thumbnails: Thumbnails,
    channel_title: String,
    #[serde(default)]
    published_at: String,
}

#[derive(Deserialize)]
struct Thumbnails {
    default: Option<Thumbnail>,
    high: Option<Thumbnail>,
    medium: Option<Thumbnail>,
}

#[derive(Deserialize)]
struct Thumbnail {
    url: String,
}

#[derive(Deserialize)]
struct VideoEnvelope {
    #[serde(default)]
    items: Vec<VideoItem>,
}

#[derive(Deserialize)]
struct VideoItem {
    id: String,
    snippet: Snippet,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    errors: Vec<ErrorItem>,
}

#[derive(Deserialize)]
struct ErrorItem {
    reason: String,
}

impl ProviderClient {
    pub async fn youtube_search_api_key(
        &self,
        api_key: &SecretString,
        query: &str,
        max_results: u8,
    ) -> Result<Vec<YouTubeSearchResult>> {
        self.youtube_search(Authorization::ApiKey(api_key), query, max_results)
            .await
    }

    pub async fn youtube_search_oauth(
        &self,
        access_token: &SecretString,
        query: &str,
        max_results: u8,
    ) -> Result<Vec<YouTubeSearchResult>> {
        self.youtube_search(Authorization::OAuth(access_token), query, max_results)
            .await
    }

    pub async fn youtube_video_api_key(
        &self,
        api_key: &SecretString,
        video_id: &str,
    ) -> Result<Option<YouTubeVideoDetails>> {
        self.youtube_video(Authorization::ApiKey(api_key), video_id)
            .await
    }

    pub async fn youtube_video_oauth(
        &self,
        access_token: &SecretString,
        video_id: &str,
    ) -> Result<Option<YouTubeVideoDetails>> {
        self.youtube_video(Authorization::OAuth(access_token), video_id)
            .await
    }

    async fn youtube_search(
        &self,
        authorization: Authorization<'_>,
        query: &str,
        max_results: u8,
    ) -> Result<Vec<YouTubeSearchResult>> {
        let query = query.trim();
        if query.is_empty()
            || query.chars().count() > MAX_QUERY_CHARACTERS
            || !(1..=MAX_RESULTS).contains(&max_results)
        {
            return Err(ProviderError::InvalidRequest);
        }
        let mut url = self
            .endpoints
            .youtube_api
            .join("search")
            .map_err(|_| ProviderError::InvalidRequest)?;
        url.query_pairs_mut()
            .append_pair("part", "snippet")
            .append_pair("maxResults", &max_results.to_string())
            .append_pair("q", query)
            .append_pair("type", "video");
        let response = self.send_youtube(url, authorization).await?;
        let envelope: SearchEnvelope = parse_success(&response)?;
        if envelope.items.len() > usize::from(max_results) {
            return Err(ProviderError::InvalidResponse);
        }
        envelope.items.into_iter().map(map_search_item).collect()
    }

    async fn youtube_video(
        &self,
        authorization: Authorization<'_>,
        video_id: &str,
    ) -> Result<Option<YouTubeVideoDetails>> {
        require_video_id(video_id)?;
        let mut url = self
            .endpoints
            .youtube_api
            .join("videos")
            .map_err(|_| ProviderError::InvalidRequest)?;
        url.query_pairs_mut()
            .append_pair("part", "snippet")
            .append_pair("id", video_id);
        let response = self.send_youtube(url, authorization).await?;
        let mut envelope: VideoEnvelope = parse_success(&response)?;
        if envelope.items.len() > 1 {
            return Err(ProviderError::InvalidResponse);
        }
        envelope.items.pop().map(map_video_item).transpose()
    }

    async fn send_youtube(
        &self,
        mut url: Url,
        authorization: Authorization<'_>,
    ) -> Result<crate::bounded::BoundedResponse> {
        let request = match authorization {
            Authorization::ApiKey(key) => {
                if key.expose_secret().is_empty() {
                    return Err(ProviderError::Unauthorized);
                }
                url.query_pairs_mut()
                    .append_pair("key", key.expose_secret());
                self.http.get(url)
            }
            Authorization::OAuth(token) => {
                if token.expose_secret().is_empty() {
                    return Err(ProviderError::AuthenticationRequired);
                }
                self.http.get(url).bearer_auth(token.expose_secret())
            }
        };
        let response = request
            .send()
            .await
            .map_err(|error| map_transport(&error))?;
        let response = read(response, MAX_RESPONSE_BYTES).await?;
        if !is_json(response.content_type.as_deref()) {
            return Err(ProviderError::InvalidResponse);
        }
        if response.status.is_success() {
            return Ok(response);
        }
        Err(map_youtube_error(response.status, &response.bytes))
    }
}

fn parse_success<T: for<'de> Deserialize<'de>>(
    response: &crate::bounded::BoundedResponse,
) -> Result<T> {
    serde_json::from_slice(&response.bytes).map_err(|_| ProviderError::InvalidResponse)
}

fn map_search_item(item: SearchItem) -> Result<YouTubeSearchResult> {
    require_video_id(&item.id.video_id)?;
    validate_snippet(&item.snippet, false)?;
    let thumbnail = item
        .snippet
        .thumbnails
        .default
        .or(item.snippet.thumbnails.medium)
        .or(item.snippet.thumbnails.high)
        .ok_or(ProviderError::InvalidResponse)?;
    require_thumbnail_url(&thumbnail.url)?;
    Ok(YouTubeSearchResult {
        url: format!("https://www.youtube.com/watch?v={}", item.id.video_id),
        id: item.id.video_id,
        title: item.snippet.title,
        thumbnail: thumbnail.url,
        channel: item.snippet.channel_title,
    })
}

fn map_video_item(item: VideoItem) -> Result<YouTubeVideoDetails> {
    require_video_id(&item.id)?;
    validate_snippet(&item.snippet, true)?;
    let thumbnail = item
        .snippet
        .thumbnails
        .high
        .or(item.snippet.thumbnails.medium)
        .or(item.snippet.thumbnails.default)
        .ok_or(ProviderError::InvalidResponse)?;
    require_thumbnail_url(&thumbnail.url)?;
    Ok(YouTubeVideoDetails {
        id: item.id,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail: thumbnail.url,
        channel: item.snippet.channel_title,
        published_at: item.snippet.published_at,
    })
}

fn validate_snippet(snippet: &Snippet, require_details: bool) -> Result<()> {
    if snippet.title.is_empty()
        || snippet.title.chars().count() > MAX_TITLE_CHARACTERS
        || snippet.channel_title.is_empty()
        || snippet.channel_title.chars().count() > MAX_CHANNEL_CHARACTERS
        || snippet.description.chars().count() > MAX_DESCRIPTION_CHARACTERS
        || (require_details && !valid_rfc3339_shape(&snippet.published_at))
    {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(())
}

fn valid_rfc3339_shape(value: &str) -> bool {
    value.len() >= 20
        && value.len() <= 35
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
        && (value.ends_with('Z') || value.contains('+'))
}

pub(crate) fn require_video_id(video_id: &str) -> Result<()> {
    if video_id.len() != 11
        || !video_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ProviderError::InvalidRequest);
    }
    Ok(())
}

pub(crate) fn require_thumbnail_url(value: &str) -> Result<()> {
    let url = Url::parse(value).map_err(|_| ProviderError::InvalidResponse)?;
    let host = url.host_str().ok_or(ProviderError::InvalidResponse)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !(host == "i.ytimg.com" || host.ends_with(".ytimg.com") || host == "yt3.ggpht.com")
    {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(())
}

fn map_youtube_error(status: reqwest::StatusCode, bytes: &[u8]) -> ProviderError {
    let reasons = serde_json::from_slice::<ErrorEnvelope>(bytes)
        .ok()
        .map(|envelope| envelope.error.errors)
        .unwrap_or_default();
    if reasons.iter().any(|item| item.reason == "quotaExceeded") {
        ProviderError::QuotaExceeded
    } else if reasons.iter().any(|item| {
        matches!(
            item.reason.as_str(),
            "accessNotConfigured" | "youtubeSignupRequired"
        )
    }) {
        ProviderError::ApiNotEnabled
    } else if status == reqwest::StatusCode::UNAUTHORIZED {
        ProviderError::AuthenticationRequired
    } else if status == reqwest::StatusCode::FORBIDDEN {
        ProviderError::Unauthorized
    } else {
        ProviderError::InvalidResponse
    }
}

fn map_transport(error: &reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::Timeout
    } else {
        ProviderError::Transport
    }
}

#[cfg(test)]
mod tests {
    use secrecy::SecretString;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    #[tokio::test]
    async fn api_key_search_matches_the_legacy_js_shape() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/youtube/v3/search"))
            .and(query_param("part", "snippet"))
            .and(query_param("maxResults", "5"))
            .and(query_param("q", "rust music"))
            .and(query_param("type", "video"))
            .and(query_param("key", "private-youtube-key"))
            .respond_with(ResponseTemplate::new(200).insert_header("content-type", "application/json").set_body_json(serde_json::json!({
                "items": [{
                    "id": { "videoId": "AbCdEfGhI_1" },
                    "snippet": {
                        "title": "Result title",
                        "description": "",
                        "thumbnails": { "default": { "url": "https://i.ytimg.com/vi/AbCdEfGhI_1/default.jpg" } },
                        "channelTitle": "Channel",
                        "publishedAt": ""
                    }
                }]
            })))
            .mount(&server)
            .await;
        let results = ProviderClient::for_mock(&server)
            .youtube_search_api_key(&SecretString::from("private-youtube-key"), "rust music", 5)
            .await
            .expect("search");
        assert_eq!(
            results,
            vec![YouTubeSearchResult {
                id: "AbCdEfGhI_1".to_owned(),
                title: "Result title".to_owned(),
                thumbnail: "https://i.ytimg.com/vi/AbCdEfGhI_1/default.jpg".to_owned(),
                channel: "Channel".to_owned(),
                url: "https://www.youtube.com/watch?v=AbCdEfGhI_1".to_owned(),
            }]
        );
    }

    #[tokio::test]
    async fn oauth_details_use_authorization_header_and_return_exact_fields() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/youtube/v3/videos"))
            .and(query_param("part", "snippet"))
            .and(query_param("id", "AbCdEfGhI_1"))
            .and(header("authorization", "Bearer private-access-token"))
            .respond_with(ResponseTemplate::new(200).insert_header("content-type", "application/json").set_body_json(serde_json::json!({
                "items": [{
                    "id": "AbCdEfGhI_1",
                    "snippet": {
                        "title": "Details",
                        "description": "Description",
                        "thumbnails": { "high": { "url": "https://i.ytimg.com/vi/AbCdEfGhI_1/hqdefault.jpg" } },
                        "channelTitle": "Channel",
                        "publishedAt": "2026-08-10T00:00:00Z"
                    }
                }]
            })))
            .mount(&server)
            .await;
        let details = ProviderClient::for_mock(&server)
            .youtube_video_oauth(&SecretString::from("private-access-token"), "AbCdEfGhI_1")
            .await
            .expect("details")
            .expect("video");
        assert_eq!(details.title, "Details");
        assert_eq!(details.published_at, "2026-08-10T00:00:00Z");
    }

    #[tokio::test]
    async fn hostile_error_body_is_classified_without_being_reflected() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/youtube/v3/search"))
            .respond_with(ResponseTemplate::new(403).insert_header("content-type", "application/json").set_body_json(serde_json::json!({
                "error": { "message": "private-youtube-key", "errors": [{ "reason": "quotaExceeded" }] }
            })))
            .mount(&server)
            .await;
        let error = ProviderClient::for_mock(&server)
            .youtube_search_api_key(&SecretString::from("private-youtube-key"), "query", 5)
            .await
            .expect_err("quota failure");
        assert_eq!(error, ProviderError::QuotaExceeded);
        assert!(!error.to_string().contains("private-youtube-key"));
    }

    #[tokio::test]
    async fn rejects_a_response_body_above_the_hard_limit() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/youtube/v3/search"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_bytes(vec![b'x'; MAX_RESPONSE_BYTES + 1]),
            )
            .mount(&server)
            .await;

        let error = ProviderClient::for_mock(&server)
            .youtube_search_api_key(&SecretString::from("private-youtube-key"), "query", 5)
            .await
            .expect_err("oversized response");
        assert_eq!(error, ProviderError::InvalidResponse);
    }
}
