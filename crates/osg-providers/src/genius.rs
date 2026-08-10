use std::collections::HashMap;
use std::time::{Duration, Instant};

use dom_query::Document;
use reqwest::header::LOCATION;
use secrecy::{ExposeSecret as _, SecretString};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::bounded::{is_html, is_json, read};
use crate::{ProviderClient, ProviderError, Result};

const MAX_ARTIST_CHARACTERS: usize = 300;
const MAX_SONG_CHARACTERS: usize = 300;
const MAX_SEARCH_BYTES: usize = 512 * 1024;
const MAX_LYRICS_PAGE_BYTES: usize = 3 * 1024 * 1024;
const MAX_LYRICS_BYTES: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const MAX_CACHE_ENTRIES: usize = 64;
const CACHE_TTL: Duration = Duration::from_hours(24);

#[derive(Clone)]
struct CacheEntry {
    value: GeniusLyrics,
    inserted_at: Instant,
}

#[derive(Default)]
pub(crate) struct GeniusCache {
    entries: HashMap<[u8; 32], CacheEntry>,
}

impl GeniusCache {
    pub(crate) fn entry_count(&self) -> usize {
        self.entries.len()
    }

    fn get(&mut self, key: &[u8; 32]) -> Option<GeniusLyrics> {
        self.prune();
        self.entries.get(key).map(|entry| entry.value.clone())
    }

    fn insert(&mut self, key: [u8; 32], value: GeniusLyrics) {
        self.prune();
        if self.entries.len() >= MAX_CACHE_ENTRIES
            && let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.inserted_at)
                .map(|(key, _)| *key)
        {
            self.entries.remove(&oldest);
        }
        self.entries.insert(
            key,
            CacheEntry {
                value,
                inserted_at: Instant::now(),
            },
        );
    }

    fn prune(&mut self) {
        let now = Instant::now();
        self.entries
            .retain(|_, entry| now.duration_since(entry.inserted_at) < CACHE_TTL);
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeniusRequest {
    pub artist: String,
    pub song: String,
    #[serde(default)]
    pub force: bool,
}

impl GeniusRequest {
    fn validate(&self) -> Result<()> {
        if !valid_text(&self.artist, MAX_ARTIST_CHARACTERS)
            || !valid_text(&self.song, MAX_SONG_CHARACTERS)
        {
            return Err(ProviderError::InvalidRequest);
        }
        Ok(())
    }
}

/// Legacy-compatible lyrics payload. The optional artwork URL is validated HTTPS content, never
/// a filesystem path, data URL, or credential-bearing provider URL.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeniusLyrics {
    pub lyrics: String,
    pub album_art_url: Option<String>,
}

#[derive(Deserialize)]
struct SearchEnvelope {
    response: SearchResponse,
}

#[derive(Deserialize)]
struct SearchResponse {
    hits: Vec<SearchHit>,
}

#[derive(Deserialize)]
struct SearchHit {
    result: SearchResult,
}

#[derive(Deserialize)]
struct SearchResult {
    url: String,
    song_art_image_url: Option<String>,
    header_image_url: Option<String>,
}

impl ProviderClient {
    pub async fn genius_lyrics(
        &self,
        access_token: &SecretString,
        request: &GeniusRequest,
    ) -> Result<GeniusLyrics> {
        request.validate()?;
        if access_token.expose_secret().is_empty() {
            return Err(ProviderError::Unauthorized);
        }
        let cache_key = cache_key(request);
        if !request.force
            && let Some(cached) = self
                .genius_cache
                .lock()
                .map_err(|_| ProviderError::Transport)?
                .get(&cache_key)
        {
            return Ok(cached);
        }

        let mut search_url = self.endpoints.genius_search.clone();
        search_url.query_pairs_mut().append_pair(
            "q",
            &format!("{} {}", request.artist.trim(), request.song.trim()),
        );
        let response = self
            .http
            .get(search_url)
            .bearer_auth(access_token.expose_secret())
            .send()
            .await
            .map_err(|error| map_transport(&error))?;
        let response = read(response, MAX_SEARCH_BYTES).await?;
        if response.status == reqwest::StatusCode::UNAUTHORIZED
            || response.status == reqwest::StatusCode::FORBIDDEN
        {
            return Err(ProviderError::Unauthorized);
        }
        if !response.status.is_success() || !is_json(response.content_type.as_deref()) {
            return Err(ProviderError::InvalidResponse);
        }
        let envelope: SearchEnvelope =
            serde_json::from_slice(&response.bytes).map_err(|_| ProviderError::InvalidResponse)?;
        let hit = envelope
            .response
            .hits
            .into_iter()
            .next()
            .ok_or(ProviderError::NotFound)?;
        let song_url = Url::parse(&hit.result.url).map_err(|_| ProviderError::InvalidResponse)?;
        self.require_genius_content_url(&song_url)?;

        let album_art_url = hit
            .result
            .song_art_image_url
            .or(hit.result.header_image_url)
            .map(|value| {
                let url = Url::parse(&value).map_err(|_| ProviderError::InvalidResponse)?;
                require_safe_artwork_url(&url, &self.endpoints.genius_content_origin)?;
                Ok(url.to_string())
            })
            .transpose()?;

        let html = self.fetch_genius_page(song_url.clone()).await?;
        let lyrics = extract_lyrics(&html).unwrap_or_else(|| {
            format!(
                "Lyrics for \"{}\" by {}\n\nCouldn't extract lyrics from Genius.\nPlease visit {} to view the lyrics.",
                request.song.trim(),
                request.artist.trim(),
                song_url
            )
        });
        if lyrics.is_empty() || lyrics.len() > MAX_LYRICS_BYTES {
            return Err(ProviderError::InvalidResponse);
        }
        let result = GeniusLyrics {
            lyrics,
            album_art_url,
        };
        self.genius_cache
            .lock()
            .map_err(|_| ProviderError::Transport)?
            .insert(cache_key, result.clone());
        Ok(result)
    }

    async fn fetch_genius_page(&self, mut url: Url) -> Result<String> {
        for redirect_count in 0..=MAX_REDIRECTS {
            self.require_genius_content_url(&url)?;
            let response = self
                .http
                .get(url.clone())
                .send()
                .await
                .map_err(|error| map_transport(&error))?;
            if response.status().is_redirection() {
                if redirect_count == MAX_REDIRECTS {
                    return Err(ProviderError::InvalidResponse);
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or(ProviderError::InvalidResponse)?;
                url = url
                    .join(location)
                    .map_err(|_| ProviderError::InvalidResponse)?;
                continue;
            }

            let response = read(response, MAX_LYRICS_PAGE_BYTES).await?;
            if !response.status.is_success() || !is_html(response.content_type.as_deref()) {
                return Err(ProviderError::InvalidResponse);
            }
            return String::from_utf8(response.bytes).map_err(|_| ProviderError::InvalidResponse);
        }
        Err(ProviderError::InvalidResponse)
    }

    fn require_genius_content_url(&self, url: &Url) -> Result<()> {
        require_same_content_origin(url, &self.endpoints.genius_content_origin)
    }
}

fn cache_key(request: &GeniusRequest) -> [u8; 32] {
    use sha2::{Digest as _, Sha256};

    let mut hasher = Sha256::new();
    for value in [request.artist.trim(), request.song.trim()] {
        let normalized = value.to_lowercase();
        hasher.update(normalized.len().to_le_bytes());
        hasher.update(normalized.as_bytes());
    }
    hasher.finalize().into()
}

fn valid_text(value: &str, maximum: usize) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= maximum
        && !trimmed
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\t' | '\n' | '\r'))
}

fn map_transport(error: &reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::Timeout
    } else {
        ProviderError::Transport
    }
}

pub(crate) fn require_same_content_origin(url: &Url, configured_origin: &Url) -> Result<()> {
    if url.username().is_empty()
        && url.password().is_none()
        && url.scheme() == configured_origin.scheme()
        && url.host_str() == configured_origin.host_str()
        && url.port_or_known_default() == configured_origin.port_or_known_default()
    {
        Ok(())
    } else {
        Err(ProviderError::InvalidResponse)
    }
}

pub(crate) fn require_safe_artwork_url(url: &Url, configured_origin: &Url) -> Result<()> {
    #[cfg(test)]
    if configured_origin.scheme() == "http" {
        return require_same_content_origin(url, configured_origin);
    }

    #[cfg(not(test))]
    let _ = configured_origin;

    let host = url.host_str().ok_or(ProviderError::InvalidResponse)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !(host == "genius.com" || host.ends_with(".genius.com"))
    {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(())
}

fn extract_lyrics(html: &str) -> Option<String> {
    let document = Document::from(html);
    for selector in [".lyrics", ".song_body-lyrics"] {
        let selection = document.select(selector).first();
        if selection.exists() {
            selection.select("br").replace_with_html("\n");
            if let Some(lyrics) = normalize_lyrics(selection.text().as_ref()) {
                return Some(lyrics);
            }
        }
    }

    let sections = document.select("[data-lyrics-container=\"true\"]");
    if sections.exists() {
        let mut combined = String::new();
        for section in sections.iter() {
            section.select("br").replace_with_html("\n");
            let text = section.text();
            if !text.trim().is_empty() {
                if !combined.is_empty() {
                    combined.push('\n');
                }
                combined.push_str(text.as_ref());
            }
        }
        if let Some(lyrics) = normalize_lyrics(&combined) {
            return Some(lyrics);
        }
    }

    let mut longest = None::<String>;
    for section in document
        .select("[class*=\"lyrics\"], [class*=\"Lyrics\"]")
        .iter()
    {
        section.select("br").replace_with_html("\n");
        if let Some(candidate) = normalize_lyrics(section.text().as_ref())
            && longest
                .as_ref()
                .is_none_or(|current| candidate.len() > current.len())
        {
            longest = Some(candidate);
        }
    }
    longest
}

fn normalize_lyrics(value: &str) -> Option<String> {
    let normalized = value
        .replace("\\n", "\n")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut output = String::with_capacity(normalized.len());
    let mut newline_count = 0_u8;
    for character in normalized.chars() {
        if character == '\n' {
            newline_count = newline_count.saturating_add(1);
            if newline_count <= 2 {
                output.push(character);
            }
        } else {
            newline_count = 0;
            output.push(character);
        }
        if output.len() > MAX_LYRICS_BYTES {
            return None;
        }
    }
    let trimmed = output.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use secrecy::SecretString;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    #[test]
    fn extracts_current_genius_containers_without_merging_lines() {
        let html = r#"<div data-lyrics-container="true">[Verse]<br>Hello &amp; hi<br>World</div><div data-lyrics-container="true">[Chorus]<br>Again</div>"#;
        assert_eq!(
            extract_lyrics(html).as_deref(),
            Some("[Verse]\nHello & hi\nWorld\n[Chorus]\nAgain")
        );
    }

    #[tokio::test]
    async fn searches_with_bearer_and_returns_legacy_shape() {
        let server = MockServer::start().await;
        let song_url = format!("{}/song", server.uri());
        let art_url = format!("{}/art.jpg", server.uri());
        Mock::given(method("GET"))
            .and(path("/genius/search"))
            .and(query_param("q", "Artist Song"))
            .and(header("authorization", "Bearer private-genius-token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_json(serde_json::json!({
                        "response": { "hits": [{ "result": {
                            "url": song_url,
                            "song_art_image_url": art_url,
                            "header_image_url": null
                        }}] }
                    })),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/song"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                r#"<div data-lyrics-container="true">[Verse]<br>First line<br>Second line</div>"#,
                "text/html; charset=utf-8",
            ))
            .mount(&server)
            .await;

        let result = ProviderClient::for_mock(&server)
            .genius_lyrics(
                &SecretString::from("private-genius-token"),
                &GeniusRequest {
                    artist: "Artist".to_owned(),
                    song: "Song".to_owned(),
                    force: false,
                },
            )
            .await
            .expect("lyrics");
        assert_eq!(result.lyrics, "[Verse]\nFirst line\nSecond line");
        assert_eq!(result.album_art_url.as_deref(), Some(art_url.as_str()));
    }

    #[tokio::test]
    async fn rejects_search_supplied_ssrf_url_before_requesting_it() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/genius/search"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_json(serde_json::json!({
                        "response": { "hits": [{ "result": {
                            "url": "http://169.254.169.254/latest/meta-data",
                            "song_art_image_url": null,
                            "header_image_url": null
                        }}] }
                    })),
            )
            .mount(&server)
            .await;
        let result = ProviderClient::for_mock(&server)
            .genius_lyrics(
                &SecretString::from("token"),
                &GeniusRequest {
                    artist: "Artist".to_owned(),
                    song: "Song".to_owned(),
                    force: false,
                },
            )
            .await;
        assert_eq!(result, Err(ProviderError::InvalidResponse));
    }

    #[tokio::test]
    async fn caches_by_normalized_song_and_force_bypasses_the_cache() {
        let server = MockServer::start().await;
        let song_url = format!("{}/song", server.uri());
        Mock::given(method("GET"))
            .and(path("/genius/search"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_json(serde_json::json!({
                        "response": { "hits": [{ "result": {
                            "url": song_url,
                            "song_art_image_url": null,
                            "header_image_url": null
                        }}] }
                    })),
            )
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/song"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(
                r#"<div data-lyrics-container="true">[Verse]<br>Cached</div>"#,
                "text/html",
            ))
            .expect(2)
            .mount(&server)
            .await;

        let client = ProviderClient::for_mock(&server);
        let request = GeniusRequest {
            artist: "Artist".to_owned(),
            song: "Song".to_owned(),
            force: false,
        };
        client
            .genius_lyrics(&SecretString::from("token"), &request)
            .await
            .expect("first fetch");
        client
            .genius_lyrics(
                &SecretString::from("token"),
                &GeniusRequest {
                    artist: " artist ".to_owned(),
                    song: "song".to_owned(),
                    force: false,
                },
            )
            .await
            .expect("normalized cache hit");
        client
            .genius_lyrics(
                &SecretString::from("token"),
                &GeniusRequest {
                    force: true,
                    ..request
                },
            )
            .await
            .expect("forced fetch");
    }
}
