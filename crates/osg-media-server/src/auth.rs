//! Host, origin, and capability-token checks for the loopback boundary.

use crate::request::HttpRequest;
use crate::{MAX_ORIGIN_BYTES, ServerContext};

pub(crate) fn valid_host(context: &ServerContext, request: &HttpRequest) -> bool {
    request.unique_header("host").is_ok_and(|host| {
        host.is_some_and(|host| {
            host.eq_ignore_ascii_case(&format!("127.0.0.1:{}", context.port))
                || host.eq_ignore_ascii_case(&format!("localhost:{}", context.port))
        })
    })
}

pub(crate) fn valid_token(
    context: &ServerContext,
    request: &HttpRequest,
    token_header: Option<&str>,
) -> bool {
    if token_header.is_some_and(|value| secure_eq(value, &context.token)) {
        return true;
    }
    request
        .target
        .split_once('?')
        .map(|(_, query)| query)
        .into_iter()
        .flat_map(|query| query.split('&'))
        .filter_map(|pair| pair.split_once('='))
        .any(|(key, value)| key == "token" && secure_eq(value, &context.token))
}

pub(crate) fn secure_eq(candidate: &str, expected: &str) -> bool {
    let candidate = candidate.as_bytes();
    let expected = expected.as_bytes();
    let mut difference = candidate.len() ^ expected.len();
    for (index, expected_byte) in expected.iter().enumerate() {
        difference |= usize::from(candidate.get(index).copied().unwrap_or(0) ^ expected_byte);
    }
    difference == 0
}

pub(crate) fn valid_configured_origin(origin: &str) -> bool {
    !origin.is_empty()
        && origin.len() <= MAX_ORIGIN_BYTES
        && origin.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}
