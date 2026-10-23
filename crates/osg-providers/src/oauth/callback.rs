//! Parsing of the single HTTP request the browser sends to the loopback OAuth redirect.
//!
//! The parser is deliberately narrow: one `GET /oauth2callback` over HTTP/1.1 to the exact
//! loopback host and port that was registered, with exactly one `state` and either one `code` or
//! one `error`. Anything else is rejected without echoing the request.

use secrecy::SecretString;
use url::Url;

use crate::{ProviderError, Result};

/// The read loop stops before another read once this much has arrived.
pub(super) const MAX_CALLBACK_HEADER_BYTES: usize = 8 * 1024;
/// Size of one read from the callback socket.
pub(super) const CALLBACK_READ_CHUNK: usize = 1024;
const MAX_CODE_BYTES: usize = 4096;
const MAX_ERROR_BYTES: usize = 256;

pub(super) enum CallbackValues {
    Code(SecretString),
    Denied,
}

pub(super) fn parse_callback(
    request: &[u8],
    port: u16,
    expected_state: &str,
) -> Result<CallbackValues> {
    if request.len() > MAX_CALLBACK_HEADER_BYTES + CALLBACK_READ_CHUNK {
        return Err(ProviderError::InvalidResponse);
    }
    let request = std::str::from_utf8(request).map_err(|_| ProviderError::InvalidResponse)?;
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
    if host != Some(expected_host.as_str()) || !target.starts_with('/') {
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
                if denied || value.is_empty() || value.len() > MAX_ERROR_BYTES {
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
    if code.is_empty() || code.len() > MAX_CODE_BYTES || code.chars().any(char::is_control) {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(CallbackValues::Code(SecretString::from(code)))
}

#[cfg(test)]
mod tests {
    use secrecy::ExposeSecret as _;

    use super::*;

    const PORT: u16 = 49_152;
    const STATE: &str = "expected-state";

    fn request(target: &str, headers: &str) -> Vec<u8> {
        format!("GET {target} HTTP/1.1\r\n{headers}\r\n").into_bytes()
    }

    fn host() -> String {
        format!("Host: 127.0.0.1:{PORT}\r\n")
    }

    fn outcome(bytes: &[u8]) -> Option<String> {
        match parse_callback(bytes, PORT, STATE) {
            Ok(CallbackValues::Code(code)) => Some(format!("code:{}", code.expose_secret())),
            Ok(CallbackValues::Denied) => Some("denied".to_owned()),
            Err(_) => None,
        }
    }

    #[test]
    fn accepted_callbacks() {
        let cases = [
            ("/oauth2callback?code=abc&state=expected-state", "code:abc"),
            (
                "/oauth2callback?state=expected-state&code=a%2Fb+c",
                "code:a/b c",
            ),
            (
                "/oauth2callback?code=abc&state=expected-state&scope=x&scope=y",
                "code:abc",
            ),
            (
                "/oauth2callback?error=access_denied&state=expected-state",
                "denied",
            ),
        ];
        for (target, expected) in cases {
            assert_eq!(
                outcome(&request(target, &host())).as_deref(),
                Some(expected),
                "{target}"
            );
        }
        let lower_case_host = format!("host:   127.0.0.1:{PORT}  \r\nConnection: close\r\n");
        assert_eq!(
            outcome(&request(
                "/oauth2callback?code=abc&state=expected-state",
                &lower_case_host
            ))
            .as_deref(),
            Some("code:abc")
        );
    }

    #[test]
    fn rejected_hosts_and_paths() {
        let target = "/oauth2callback?code=abc&state=expected-state";
        let header_cases = [
            String::new(),
            "Host: localhost\r\n".to_owned(),
            format!("Host: localhost:{PORT}\r\n"),
            format!("Host: 127.0.0.1:{}\r\n", PORT + 1),
            format!("Host: 127.0.0.1:{PORT}\r\nHost: 127.0.0.1:{PORT}\r\n"),
            format!("Host: 127.0.0.1:{PORT}\r\nmalformed header\r\n"),
        ];
        for headers in header_cases {
            assert!(outcome(&request(target, &headers)).is_none(), "{headers:?}");
        }
        for target in [
            "/other?code=abc&state=expected-state",
            "/oauth2callback/extra?code=abc&state=expected-state",
            "http://127.0.0.1/oauth2callback?code=abc&state=expected-state",
            "@evil.example/oauth2callback?code=abc&state=expected-state",
            "*",
        ] {
            assert!(outcome(&request(target, &host())).is_none(), "{target}");
        }
    }

    #[test]
    fn rejected_parameters() {
        let long_code = format!(
            "/oauth2callback?state=expected-state&code={}",
            "c".repeat(4097)
        );
        let long_error = format!(
            "/oauth2callback?state=expected-state&error={}",
            "e".repeat(257)
        );
        let targets = [
            "/oauth2callback?code=abc",
            "/oauth2callback?code=abc&state=wrong",
            "/oauth2callback?code=abc&state=expected-state&state=expected-state",
            "/oauth2callback?code=abc&code=def&state=expected-state",
            "/oauth2callback?error=a&error=b&state=expected-state",
            "/oauth2callback?error=&state=expected-state",
            "/oauth2callback?error=access_denied&code=abc&state=expected-state",
            "/oauth2callback?state=expected-state",
            "/oauth2callback?code=&state=expected-state",
            "/oauth2callback?code=a%0Ab&state=expected-state",
            long_code.as_str(),
            long_error.as_str(),
        ];
        for target in targets {
            assert!(
                outcome(&request(target, &host())).is_none(),
                "{}",
                &target[..target.len().min(80)]
            );
        }
    }

    #[test]
    fn rejected_request_lines_and_bytes() {
        let host = host();
        let cases: Vec<Vec<u8>> = vec![
            Vec::new(),
            b"\r\n\r\n".to_vec(),
            format!("POST /oauth2callback?code=abc&state=expected-state HTTP/1.1\r\n{host}\r\n")
                .into_bytes(),
            format!("GET /oauth2callback?code=abc&state=expected-state HTTP/1.0\r\n{host}\r\n")
                .into_bytes(),
            format!(
                "GET /oauth2callback?code=abc&state=expected-state HTTP/1.1 extra\r\n{host}\r\n"
            )
            .into_bytes(),
            format!("GET  /oauth2callback?code=abc&state=expected-state HTTP/1.1\r\n{host}\r\n")
                .into_bytes(),
            format!("GET\r\n{host}\r\n").into_bytes(),
            b"GET /oauth2callback?code=\xff&state=expected-state HTTP/1.1\r\n\r\n".to_vec(),
        ];
        for bytes in cases {
            assert!(
                outcome(&bytes).is_none(),
                "{:?}",
                String::from_utf8_lossy(&bytes)
            );
        }

        let padding = format!(
            "X-Pad: {}\r\n",
            "p".repeat(MAX_CALLBACK_HEADER_BYTES + CALLBACK_READ_CHUNK)
        );
        let oversized = request(
            "/oauth2callback?code=abc&state=expected-state",
            &format!("{host}{padding}"),
        );
        assert!(oversized.len() > MAX_CALLBACK_HEADER_BYTES + CALLBACK_READ_CHUNK);
        assert!(outcome(&oversized).is_none());
    }
}
