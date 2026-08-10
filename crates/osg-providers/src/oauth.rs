use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use getrandom::fill as fill_random;
use secrecy::{ExposeSecret as _, SecretString};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{Instant, timeout, timeout_at};
use tokio_util::sync::CancellationToken;
use url::Url;
use zeroize::{Zeroize as _, Zeroizing};

use crate::bounded::{is_json, read};
use crate::{ProviderClient, ProviderError, Result};

const OAUTH_SCOPE: &str = "https://www.googleapis.com/auth/youtube.readonly";
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_mins(3);
const CALLBACK_IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CALLBACK_ATTEMPTS: usize = 8;
const MAX_CALLBACK_HEADER_BYTES: usize = 8 * 1024;
const MAX_TOKEN_RESPONSE_BYTES: usize = 512 * 1024;
const TOKEN_REFRESH_BUFFER_MS: u64 = 5 * 60 * 1_000;
const MAX_TOKEN_CHARACTERS: usize = 16 * 1024;

/// Parsed client registration held entirely in native secret memory.
#[allow(
    missing_debug_implementations,
    reason = "OAuth client credentials must never enter diagnostics"
)]
pub struct YouTubeOAuthClient {
    client_id: SecretString,
    client_secret: SecretString,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientPayload {
    client_id: String,
    client_secret: String,
}

impl Drop for ClientPayload {
    fn drop(&mut self) {
        self.client_id.zeroize();
        self.client_secret.zeroize();
    }
}

impl YouTubeOAuthClient {
    pub fn from_vault_secret(secret: &SecretString) -> Result<Self> {
        let mut payload: ClientPayload = serde_json::from_str(secret.expose_secret())
            .map_err(|_| ProviderError::InvalidRequest)?;
        if !valid_secret_text(&payload.client_id) || !valid_secret_text(&payload.client_secret) {
            return Err(ProviderError::InvalidRequest);
        }
        Ok(Self {
            client_id: SecretString::from(std::mem::take(&mut payload.client_id)),
            client_secret: SecretString::from(std::mem::take(&mut payload.client_secret)),
        })
    }
}

/// Access/refresh token set. This type deliberately implements neither `Debug` nor `Serialize`.
#[allow(
    missing_debug_implementations,
    reason = "OAuth tokens must never enter diagnostics"
)]
pub struct OAuthTokenSet {
    access_token: SecretString,
    refresh_token: SecretString,
    expires_at_unix_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenVaultPayload {
    access_token: String,
    refresh_token: String,
    expires_at_unix_ms: u64,
}

impl Drop for TokenVaultPayload {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

impl OAuthTokenSet {
    pub fn from_vault_secret(secret: &SecretString) -> Result<Self> {
        let mut payload: TokenVaultPayload = serde_json::from_str(secret.expose_secret())
            .map_err(|_| ProviderError::InvalidRequest)?;
        if !valid_secret_text(&payload.access_token)
            || !valid_secret_text(&payload.refresh_token)
            || payload.expires_at_unix_ms == 0
        {
            return Err(ProviderError::InvalidRequest);
        }
        Ok(Self {
            access_token: SecretString::from(std::mem::take(&mut payload.access_token)),
            refresh_token: SecretString::from(std::mem::take(&mut payload.refresh_token)),
            expires_at_unix_ms: payload.expires_at_unix_ms,
        })
    }

    pub fn to_vault_secret(&self) -> Result<SecretString> {
        // Serialize only borrowed string primitives into short-lived zeroizing buffers. The
        // secret-bearing token types themselves deliberately implement no `Serialize` surface.
        let access = Zeroizing::new(
            serde_json::to_string(self.access_token.expose_secret())
                .map_err(|_| ProviderError::InvalidResponse)?,
        );
        let refresh = Zeroizing::new(
            serde_json::to_string(self.refresh_token.expose_secret())
                .map_err(|_| ProviderError::InvalidResponse)?,
        );
        Ok(SecretString::from(format!(
            r#"{{"accessToken":{},"refreshToken":{},"expiresAtUnixMs":{}}}"#,
            access.as_str(),
            refresh.as_str(),
            self.expires_at_unix_ms
        )))
    }

    #[must_use]
    pub const fn expires_at_unix_ms(&self) -> u64 {
        self.expires_at_unix_ms
    }

    #[must_use]
    pub fn access_token(&self) -> &SecretString {
        &self.access_token
    }

    #[must_use]
    pub fn needs_refresh(&self, now: SystemTime) -> bool {
        let now_ms = unix_millis(now).unwrap_or(u64::MAX);
        now_ms
            .checked_add(TOKEN_REFRESH_BUFFER_MS)
            .is_none_or(|buffered| buffered >= self.expires_at_unix_ms)
    }
}

#[derive(Deserialize)]
struct TokenEndpointResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    expires_in: u64,
    #[serde(default)]
    token_type: String,
}

impl Drop for TokenEndpointResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

struct ActiveAuthorization {
    id: [u8; 16],
    cancellation: CancellationToken,
}

impl fmt::Debug for ActiveAuthorization {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActiveAuthorization")
            .finish_non_exhaustive()
    }
}

/// Serializes OAuth attempts and provides an explicit native cancellation boundary.
#[derive(Clone, Default)]
pub struct OAuthCoordinator {
    active: Arc<Mutex<Option<ActiveAuthorization>>>,
}

impl fmt::Debug for OAuthCoordinator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OAuthCoordinator")
            .field(
                "active",
                &self.active.lock().is_ok_and(|active| active.is_some()),
            )
            .finish()
    }
}

impl OAuthCoordinator {
    pub async fn authorize<F>(
        &self,
        providers: &ProviderClient,
        client: &YouTubeOAuthClient,
        open_system_browser: F,
    ) -> Result<OAuthTokenSet>
    where
        F: FnOnce(&Url) -> Result<()> + Send,
    {
        let cancellation = CancellationToken::new();
        let mut id = [0_u8; 16];
        fill_random(&mut id).map_err(|_| ProviderError::Transport)?;
        {
            let mut active = self.active.lock().map_err(|_| ProviderError::Transport)?;
            if active.is_some() {
                return Err(ProviderError::OAuthBusy);
            }
            *active = Some(ActiveAuthorization {
                id,
                cancellation: cancellation.clone(),
            });
        }

        let result = providers
            .authorize_youtube_oauth(client, cancellation, open_system_browser)
            .await;
        if let Ok(mut active) = self.active.lock()
            && active.as_ref().is_some_and(|current| current.id == id)
        {
            active.take();
        }
        result
    }

    pub fn cancel(&self) -> Result<bool> {
        let active = self
            .active
            .lock()
            .map_err(|_| ProviderError::Transport)?
            .take();
        if let Some(active) = active {
            active.cancellation.cancel();
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

impl ProviderClient {
    async fn authorize_youtube_oauth<F>(
        &self,
        client: &YouTubeOAuthClient,
        cancellation: CancellationToken,
        open_system_browser: F,
    ) -> Result<OAuthTokenSet>
    where
        F: FnOnce(&Url) -> Result<()> + Send,
    {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| ProviderError::Transport)?;
        let address = listener
            .local_addr()
            .map_err(|_| ProviderError::Transport)?;
        if !address.ip().is_loopback() {
            return Err(ProviderError::Transport);
        }
        let redirect_uri = format!("http://127.0.0.1:{}/oauth2callback", address.port());
        let state = random_urlsafe(32)?;
        let verifier = SecretString::from(random_urlsafe(32)?);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.expose_secret().as_bytes()));
        let authorization_url = self.authorization_url(client, &redirect_uri, &state, &challenge);
        open_system_browser(&authorization_url).map_err(|_| ProviderError::BrowserOpen)?;

        let callback = wait_for_callback(&listener, address.port(), &state, &cancellation).await?;
        let token = self
            .exchange_authorization_code(
                client,
                callback.code.expose_secret(),
                &redirect_uri,
                verifier.expose_secret(),
            )
            .await;
        respond_to_browser(callback.stream, token.is_ok()).await;
        token
    }

    fn authorization_url(
        &self,
        client: &YouTubeOAuthClient,
        redirect_uri: &str,
        state: &str,
        challenge: &str,
    ) -> Url {
        let mut url = self.endpoints.oauth_authorize.clone();
        url.query_pairs_mut()
            .append_pair("client_id", client.client_id.expose_secret())
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", OAUTH_SCOPE)
            .append_pair("access_type", "offline")
            .append_pair("include_granted_scopes", "true")
            .append_pair("prompt", "consent")
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state);
        url
    }

    async fn exchange_authorization_code(
        &self,
        client: &YouTubeOAuthClient,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
    ) -> Result<OAuthTokenSet> {
        let parameters = [
            ("client_id", client.client_id.expose_secret()),
            ("client_secret", client.client_secret.expose_secret()),
            ("code", code),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ];
        let response = self
            .http
            .post(self.endpoints.oauth_token.clone())
            .form(&parameters)
            .send()
            .await
            .map_err(|error| map_transport(&error))?;
        parse_token_response(response, None).await
    }

    pub async fn refresh_youtube_oauth(
        &self,
        client: &YouTubeOAuthClient,
        tokens: OAuthTokenSet,
    ) -> Result<OAuthTokenSet> {
        let parameters = [
            ("client_id", client.client_id.expose_secret()),
            ("client_secret", client.client_secret.expose_secret()),
            ("refresh_token", tokens.refresh_token.expose_secret()),
            ("grant_type", "refresh_token"),
        ];
        let response = self
            .http
            .post(self.endpoints.oauth_token.clone())
            .form(&parameters)
            .send()
            .await
            .map_err(|error| map_transport(&error))?;
        parse_token_response(response, Some(tokens.refresh_token.expose_secret())).await
    }
}

struct Callback {
    code: SecretString,
    stream: TcpStream,
}

async fn wait_for_callback(
    listener: &TcpListener,
    port: u16,
    expected_state: &str,
    cancellation: &CancellationToken,
) -> Result<Callback> {
    let deadline = Instant::now() + AUTHORIZATION_TIMEOUT;
    for _ in 0..MAX_CALLBACK_ATTEMPTS {
        let accepted = tokio::select! {
            () = cancellation.cancelled() => return Err(ProviderError::OAuthCancelled),
            result = timeout_at(deadline, listener.accept()) => {
                result.map_err(|_| ProviderError::OAuthExpired)?
            }
        };
        let (mut stream, address) = accepted.map_err(|_| ProviderError::Transport)?;
        if !address.ip().is_loopback() {
            continue;
        }
        match read_callback(&mut stream, port, expected_state).await {
            Ok(CallbackValues::Code(code)) => return Ok(Callback { code, stream }),
            Ok(CallbackValues::Denied) => {
                respond_to_browser(stream, false).await;
                return Err(ProviderError::OAuthDenied);
            }
            Err(_) => respond_to_browser(stream, false).await,
        }
    }
    Err(ProviderError::InvalidResponse)
}

enum CallbackValues {
    Code(SecretString),
    Denied,
}

async fn read_callback(
    stream: &mut TcpStream,
    port: u16,
    expected_state: &str,
) -> Result<CallbackValues> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(1024));
    loop {
        if bytes.len() >= MAX_CALLBACK_HEADER_BYTES {
            return Err(ProviderError::InvalidResponse);
        }
        let mut buffer = [0_u8; 1024];
        let count = timeout(CALLBACK_IO_TIMEOUT, stream.read(&mut buffer))
            .await
            .map_err(|_| ProviderError::Timeout)?
            .map_err(|_| ProviderError::Transport)?;
        if count == 0 {
            return Err(ProviderError::InvalidResponse);
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let request =
        std::str::from_utf8(bytes.as_slice()).map_err(|_| ProviderError::InvalidResponse)?;
    let mut lines = request.split("\r\n");
    let mut request_line = lines
        .next()
        .ok_or(ProviderError::InvalidResponse)?
        .split(' ');
    if request_line.next() != Some("GET") {
        return Err(ProviderError::InvalidResponse);
    }
    let target = request_line.next().ok_or(ProviderError::InvalidResponse)?;
    if request_line.next() != Some("HTTP/1.1") || request_line.next().is_some() {
        return Err(ProviderError::InvalidResponse);
    }
    let expected_host = format!("127.0.0.1:{port}");
    let mut host = None;
    for line in lines.take_while(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(ProviderError::InvalidResponse)?;
        if name.eq_ignore_ascii_case("host") && host.replace(value.trim()).is_some() {
            return Err(ProviderError::InvalidResponse);
        }
    }
    if host != Some(expected_host.as_str()) {
        return Err(ProviderError::InvalidResponse);
    }
    let parsed = Url::parse(&format!("http://{expected_host}{target}"))
        .map_err(|_| ProviderError::InvalidResponse)?;
    if parsed.path() != "/oauth2callback" {
        return Err(ProviderError::InvalidResponse);
    }
    let mut state = None;
    let mut code = None;
    let mut denied = false;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "state" => {
                if state.replace(value.into_owned()).is_some() {
                    return Err(ProviderError::InvalidResponse);
                }
            }
            "code" => {
                if code.replace(value.into_owned()).is_some() {
                    return Err(ProviderError::InvalidResponse);
                }
            }
            "error" => {
                if denied || value.is_empty() || value.len() > 256 {
                    return Err(ProviderError::InvalidResponse);
                }
                denied = true;
            }
            _ => {}
        }
    }
    if state.as_deref() != Some(expected_state) {
        return Err(ProviderError::InvalidResponse);
    }
    if denied && code.is_some() {
        return Err(ProviderError::InvalidResponse);
    }
    if denied {
        return Ok(CallbackValues::Denied);
    }
    let code = code.ok_or(ProviderError::InvalidResponse)?;
    if code.is_empty() || code.len() > 4096 || code.chars().any(char::is_control) {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(CallbackValues::Code(SecretString::from(code)))
}

async fn respond_to_browser(mut stream: TcpStream, success: bool) {
    let title = if success {
        "Authorization complete"
    } else {
        "Authorization failed"
    };
    let body = format!(
        "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><meta charset=\"utf-8\"><title>{title}</title></head><body><p>{title}. You can close this window and return to the app.</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n{}",
        if success { "200 OK" } else { "400 Bad Request" },
        body.len(),
        body
    );
    let _ = timeout(CALLBACK_IO_TIMEOUT, stream.write_all(response.as_bytes())).await;
    let _ = stream.shutdown().await;
}

async fn parse_token_response(
    response: reqwest::Response,
    existing_refresh_token: Option<&str>,
) -> Result<OAuthTokenSet> {
    let mut response = read(response, MAX_TOKEN_RESPONSE_BYTES).await?;
    if response.status == reqwest::StatusCode::UNAUTHORIZED
        || response.status == reqwest::StatusCode::BAD_REQUEST
    {
        response.bytes.zeroize();
        return Err(ProviderError::AuthenticationRequired);
    }
    if !response.status.is_success() || !is_json(response.content_type.as_deref()) {
        response.bytes.zeroize();
        return Err(ProviderError::InvalidResponse);
    }
    let parsed = serde_json::from_slice::<TokenEndpointResponse>(&response.bytes);
    response.bytes.zeroize();
    let mut payload = parsed.map_err(|_| ProviderError::InvalidResponse)?;
    if !valid_secret_text(&payload.access_token)
        || !(payload.token_type.is_empty() || payload.token_type.eq_ignore_ascii_case("bearer"))
        || !(1..=86_400).contains(&payload.expires_in)
    {
        return Err(ProviderError::InvalidResponse);
    }
    let refresh = if payload.refresh_token.is_empty() {
        existing_refresh_token
            .ok_or(ProviderError::InvalidResponse)?
            .to_owned()
    } else {
        std::mem::take(&mut payload.refresh_token)
    };
    if !valid_secret_text(&refresh) {
        return Err(ProviderError::InvalidResponse);
    }
    let now = unix_millis(SystemTime::now())?;
    let expires_at_unix_ms = now
        .checked_add(
            payload
                .expires_in
                .checked_mul(1_000)
                .ok_or(ProviderError::InvalidResponse)?,
        )
        .ok_or(ProviderError::InvalidResponse)?;
    Ok(OAuthTokenSet {
        access_token: SecretString::from(std::mem::take(&mut payload.access_token)),
        refresh_token: SecretString::from(refresh),
        expires_at_unix_ms,
    })
}

fn random_urlsafe(bytes: usize) -> Result<String> {
    let mut random = vec![0_u8; bytes];
    fill_random(&mut random).map_err(|_| ProviderError::Transport)?;
    let encoded = URL_SAFE_NO_PAD.encode(&random);
    random.zeroize();
    Ok(encoded)
}

fn valid_secret_text(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_TOKEN_CHARACTERS
        && !value.chars().any(char::is_control)
}

fn unix_millis(time: SystemTime) -> Result<u64> {
    u64::try_from(
        time.duration_since(UNIX_EPOCH)
            .map_err(|_| ProviderError::InvalidResponse)?
            .as_millis(),
    )
    .map_err(|_| ProviderError::InvalidResponse)
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
    use std::time::Duration;

    use secrecy::SecretString;
    use static_assertions::assert_not_impl_any;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    assert_not_impl_any!(OAuthTokenSet: fmt::Debug, serde::Serialize);
    assert_not_impl_any!(TokenVaultPayload: fmt::Debug, serde::Serialize);
    assert_not_impl_any!(YouTubeOAuthClient: fmt::Debug, serde::Serialize);

    fn oauth_client() -> YouTubeOAuthClient {
        YouTubeOAuthClient::from_vault_secret(&SecretString::from(
            r#"{"clientId":"private-client-id","clientSecret":"private-client-secret"}"#,
        ))
        .expect("OAuth client")
    }

    #[tokio::test]
    async fn loopback_flow_uses_pkce_state_and_returns_vault_only_tokens() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/oauth/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_json(serde_json::json!({
                        "access_token": "private-access-token",
                        "refresh_token": "private-refresh-token",
                        "expires_in": 3600,
                        "token_type": "Bearer"
                    })),
            )
            .mount(&server)
            .await;
        let providers = ProviderClient::for_mock(&server);
        let coordinator = OAuthCoordinator::default();
        let tokens = coordinator
            .authorize(&providers, &oauth_client(), |authorization_url| {
                assert_eq!(
                    authorization_url
                        .query_pairs()
                        .find(|(key, _)| key == "code_challenge_method")
                        .map(|(_, value)| value.into_owned())
                        .as_deref(),
                    Some("S256")
                );
                let redirect_uri = authorization_url
                    .query_pairs()
                    .find(|(key, _)| key == "redirect_uri")
                    .map(|(_, value)| value.into_owned())
                    .expect("redirect URI");
                let state = authorization_url
                    .query_pairs()
                    .find(|(key, _)| key == "state")
                    .map(|(_, value)| value.into_owned())
                    .expect("state");
                tokio::spawn(async move {
                    let redirect = Url::parse(&redirect_uri).expect("redirect URL");
                    let port = redirect.port().expect("ephemeral port");
                    let mut stream = TcpStream::connect(("127.0.0.1", port))
                        .await
                        .expect("connect callback");
                    stream
                        .write_all(
                            format!(
                                "GET /oauth2callback?code=authorization-code&state={state} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
                            )
                            .as_bytes(),
                        )
                        .await
                        .expect("callback");
                    let mut response = Vec::new();
                    stream.read_to_end(&mut response).await.expect("response");
                    assert!(response.starts_with(b"HTTP/1.1 200"));
                });
                Ok(())
            })
            .await
            .expect("OAuth flow");
        let vault = tokens.to_vault_secret().expect("vault payload");
        let reparsed = OAuthTokenSet::from_vault_secret(&vault).expect("parse vault payload");
        assert_eq!(
            reparsed.access_token().expose_secret(),
            "private-access-token"
        );
        assert!(reparsed.expires_at_unix_ms() > unix_millis(SystemTime::now()).unwrap());
    }

    #[tokio::test]
    async fn active_loopback_flow_can_be_cancelled_without_waiting_for_timeout() {
        let server = MockServer::start().await;
        let providers = ProviderClient::for_mock(&server);
        let coordinator = OAuthCoordinator::default();
        let task_coordinator = coordinator.clone();
        let task = tokio::spawn(async move {
            task_coordinator
                .authorize(&providers, &oauth_client(), |_| Ok(()))
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(coordinator.cancel().expect("cancel"));
        assert!(matches!(
            task.await.expect("join"),
            Err(ProviderError::OAuthCancelled)
        ));
    }

    #[tokio::test]
    async fn loopback_callback_rejects_a_mismatched_state_before_code_exchange() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind callback");
        let port = listener.local_addr().expect("callback address").port();
        let writer = tokio::spawn(async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port))
                .await
                .expect("connect callback");
            stream
                .write_all(
                    format!(
                        "GET /oauth2callback?code=authorization-code&state=wrong HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("send callback");
        });
        let (mut stream, _) = listener.accept().await.expect("accept callback");

        assert!(matches!(
            read_callback(&mut stream, port, "expected").await,
            Err(ProviderError::InvalidResponse)
        ));
        writer.await.expect("callback writer");
    }

    #[test]
    fn token_and_client_debug_surfaces_are_absent_and_coordinator_is_safe() {
        let coordinator = OAuthCoordinator::default();
        assert!(!format!("{coordinator:?}").contains("token"));
        let secret = SecretString::from(
            r#"{"accessToken":"private-access","refreshToken":"private-refresh","expiresAtUnixMs":9999999999999}"#,
        );
        let token = OAuthTokenSet::from_vault_secret(&secret).expect("token");
        assert_eq!(token.access_token().expose_secret(), "private-access");
    }
}
