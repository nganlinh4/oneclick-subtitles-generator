//! Loopback OAuth flow tests against a local mock endpoint.

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
