use std::fmt;

use url::Url;

use crate::bounded::read;
use crate::genius::require_safe_artwork_url;
use crate::youtube::{require_thumbnail_url, require_video_id};
use crate::{ProviderClient, ProviderError, Result};

const MAX_PROVIDER_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// A bounded, signature-validated provider image that has not crossed the native boundary.
#[derive(Clone, Eq, PartialEq)]
pub struct ProviderImage {
    mime_type: &'static str,
    bytes: Vec<u8>,
}

impl ProviderImage {
    #[must_use]
    pub fn into_parts(self) -> (&'static str, Vec<u8>) {
        (self.mime_type, self.bytes)
    }

    #[must_use]
    pub const fn mime_type(&self) -> &'static str {
        self.mime_type
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

impl fmt::Debug for ProviderImage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderImage")
            .field("mime_type", &self.mime_type)
            .field("bytes", &format_args!("[{} BYTES]", self.bytes.len()))
            .finish()
    }
}

impl ProviderClient {
    pub async fn fetch_genius_artwork(&self, value: &str) -> Result<ProviderImage> {
        let url = Url::parse(value).map_err(|_| ProviderError::InvalidResponse)?;
        require_safe_artwork_url(&url, &self.endpoints.genius_content_origin)?;
        self.fetch_image(url).await
    }

    pub async fn fetch_youtube_image(&self, value: &str) -> Result<ProviderImage> {
        let url = Url::parse(value).map_err(|_| ProviderError::InvalidResponse)?;
        self.require_youtube_image_url(&url)?;
        self.fetch_image(url).await
    }

    pub async fn fetch_default_youtube_thumbnail(&self, video_id: &str) -> Result<ProviderImage> {
        require_video_id(video_id)?;
        let url = self
            .endpoints
            .youtube_image_origin
            .join(&format!("vi/{video_id}/0.jpg"))
            .map_err(|_| ProviderError::InvalidRequest)?;
        self.require_youtube_image_url(&url)?;
        self.fetch_image(url).await
    }

    fn require_youtube_image_url(&self, url: &Url) -> Result<()> {
        #[cfg(test)]
        if self.endpoints.youtube_image_origin.scheme() == "http" {
            return crate::genius::require_same_content_origin(
                url,
                &self.endpoints.youtube_image_origin,
            );
        }

        #[cfg(not(test))]
        let _ = &self.endpoints.youtube_image_origin;

        require_thumbnail_url(url.as_str())
    }

    async fn fetch_image(&self, url: Url) -> Result<ProviderImage> {
        let response = self.http.get(url).send().await.map_err(|error| {
            if error.is_timeout() {
                ProviderError::Timeout
            } else {
                ProviderError::Transport
            }
        })?;
        let response = read(response, MAX_PROVIDER_IMAGE_BYTES).await?;
        if !response.status.is_success() {
            return Err(ProviderError::InvalidResponse);
        }
        let mime_type = canonical_image_mime(response.content_type.as_deref(), &response.bytes)
            .ok_or(ProviderError::InvalidResponse)?;
        Ok(ProviderImage {
            mime_type,
            bytes: response.bytes,
        })
    }
}

fn canonical_image_mime(content_type: Option<&str>, bytes: &[u8]) -> Option<&'static str> {
    let content_type = content_type?.split(';').next()?.trim();
    match content_type {
        "image/jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => Some("image/jpeg"),
        "image/png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Some("image/png"),
        "image/webp"
            if bytes.len() >= 12
                && bytes.starts_with(b"RIFF")
                && bytes.get(8..12) == Some(b"WEBP") =>
        {
            Some("image/webp")
        }
        "image/gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => {
            Some("image/gif")
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    #[tokio::test]
    async fn fetches_only_bounded_raster_content_from_the_configured_origin() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/youtube-images/vi/AbCdEfGhI_1/0.jpg"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "image/jpeg")
                    .set_body_bytes(b"\xff\xd8\xffsafe-image".to_vec()),
            )
            .mount(&server)
            .await;
        let client = ProviderClient::for_mock(&server);
        let image = client
            .fetch_default_youtube_thumbnail("AbCdEfGhI_1")
            .await
            .expect("provider image");
        assert_eq!(image.mime_type(), "image/jpeg");
        assert_eq!(image.len(), 13);
        assert!(!format!("{image:?}").contains("safe-image"));
    }

    #[tokio::test]
    async fn rejects_hostile_content_types_signatures_redirects_and_declared_sizes() {
        let cases = [
            (
                "/youtube-images/mismatch",
                ResponseTemplate::new(200)
                    .insert_header("content-type", "image/jpeg")
                    .set_body_bytes(b"\x89PNG\r\n\x1a\nnot-jpeg".to_vec()),
            ),
            (
                "/youtube-images/svg",
                ResponseTemplate::new(200)
                    .insert_header("content-type", "image/svg+xml")
                    .set_body_string("<svg><script>1</script></svg>"),
            ),
            (
                "/youtube-images/redirect",
                ResponseTemplate::new(302).insert_header("location", "https://example.invalid/"),
            ),
            (
                "/youtube-images/oversized",
                ResponseTemplate::new(200)
                    .insert_header("content-type", "image/png")
                    .set_body_bytes({
                        let mut bytes = vec![0_u8; MAX_PROVIDER_IMAGE_BYTES + 1];
                        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
                        bytes
                    }),
            ),
        ];
        let server = MockServer::start().await;
        for (path_value, response) in cases {
            Mock::given(method("GET"))
                .and(path(path_value))
                .respond_with(response)
                .mount(&server)
                .await;
        }
        let client = ProviderClient::for_mock(&server);
        for suffix in ["mismatch", "svg", "redirect", "oversized"] {
            let url = format!("{}/youtube-images/{suffix}", server.uri());
            assert_eq!(
                client.fetch_youtube_image(&url).await,
                Err(ProviderError::InvalidResponse)
            );
        }
    }

    #[test]
    fn production_allowlists_reject_credentials_ports_and_unrelated_hosts() {
        let client = ProviderClient::new().expect("provider client");
        for value in [
            "https://example.invalid/image.jpg",
            "https://user:secret@i.ytimg.com/image.jpg",
            "https://i.ytimg.com:444/image.jpg",
            "http://i.ytimg.com/image.jpg",
            "https://i.ytimg.com.evil.invalid/image.jpg",
        ] {
            let url = Url::parse(value).expect("test URL");
            assert_eq!(
                client.require_youtube_image_url(&url),
                Err(ProviderError::InvalidResponse)
            );
        }
        for value in [
            "https://example.invalid/image.jpg",
            "https://genius.com.evil.invalid/image.jpg",
            "data:image/png;base64,AA==",
        ] {
            let url = Url::parse(value).expect("test URL");
            assert_eq!(
                require_safe_artwork_url(&url, &client.endpoints.genius_content_origin),
                Err(ProviderError::InvalidResponse)
            );
        }
    }
}
