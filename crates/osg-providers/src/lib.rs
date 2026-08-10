//! Bounded backend-only provider integrations.
//!
//! This crate intentionally exposes neither generic HTTP primitives nor secret-bearing response
//! types. Provider URLs are fixed, credentials are accepted as [`secrecy::SecretString`] values,
//! and all public errors are sanitized.

mod bounded;
mod error;
mod genius;
mod image;
mod oauth;
mod youtube;

use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub use error::{ProviderError, Result};
pub use genius::{GeniusLyrics, GeniusRequest};
pub use image::ProviderImage;
pub use oauth::{OAuthCoordinator, OAuthTokenSet, YouTubeOAuthClient};
use reqwest::redirect::Policy;
use url::Url;
pub use youtube::{YouTubeSearchResult, YouTubeVideoDetails};

const USER_AGENT: &str = concat!("oneclick-subtitles-generator/", env!("CARGO_PKG_VERSION"));

#[derive(Clone, Debug)]
struct Endpoints {
    genius_search: Url,
    genius_content_origin: Url,
    youtube_api: Url,
    youtube_image_origin: Url,
    oauth_authorize: Url,
    oauth_token: Url,
}

impl Endpoints {
    fn production() -> Result<Self> {
        Ok(Self {
            genius_search: parse_constant("https://api.genius.com/search")?,
            genius_content_origin: parse_constant("https://genius.com/")?,
            youtube_api: parse_constant("https://www.googleapis.com/youtube/v3/")?,
            youtube_image_origin: parse_constant("https://i.ytimg.com/")?,
            oauth_authorize: parse_constant("https://accounts.google.com/o/oauth2/v2/auth")?,
            oauth_token: parse_constant("https://oauth2.googleapis.com/token")?,
        })
    }
}

fn parse_constant(value: &str) -> Result<Url> {
    Url::parse(value).map_err(|_| ProviderError::InvalidRequest)
}

/// Reusable native provider client with fixed time, redirect, and connection bounds.
#[derive(Clone)]
pub struct ProviderClient {
    http: reqwest::Client,
    endpoints: Endpoints,
    genius_cache: Arc<Mutex<genius::GeniusCache>>,
}

impl ProviderClient {
    pub fn new() -> Result<Self> {
        Self::with_endpoints(Endpoints::production()?)
    }

    fn with_endpoints(endpoints: Endpoints) -> Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(25))
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(2)
            .redirect(Policy::none())
            .user_agent(USER_AGENT)
            .build()
            .map_err(|_| ProviderError::Transport)?;
        Ok(Self {
            http,
            endpoints,
            genius_cache: Arc::new(Mutex::new(genius::GeniusCache::default())),
        })
    }
}

impl fmt::Debug for ProviderClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderClient")
            .field("endpoints", &self.endpoints)
            .field(
                "cached_genius_entries",
                &self
                    .genius_cache
                    .lock()
                    .map_or(0, |cache| cache.entry_count()),
            )
            .finish_non_exhaustive()
    }
}

impl Default for ProviderClient {
    fn default() -> Self {
        Self::new().expect("fixed provider endpoints and TLS configuration must be valid")
    }
}

#[cfg(test)]
impl ProviderClient {
    fn for_mock(server: &wiremock::MockServer) -> Self {
        let root = Url::parse(&format!("{}/", server.uri())).expect("mock URL");
        Self::with_endpoints(Endpoints {
            genius_search: root.join("genius/search").expect("search URL"),
            genius_content_origin: root.clone(),
            youtube_api: root.join("youtube/v3/").expect("YouTube URL"),
            youtube_image_origin: root.join("youtube-images/").expect("image URL"),
            oauth_authorize: root.join("oauth/authorize").expect("authorize URL"),
            oauth_token: root.join("oauth/token").expect("token URL"),
        })
        .expect("mock provider client")
    }
}
