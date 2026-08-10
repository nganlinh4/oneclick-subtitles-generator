use std::time::{Duration, SystemTime};

use reqwest::{StatusCode, header::HeaderMap};
use serde_json::Value;

use crate::{ProviderError, RetryPolicy, TransportKind};

pub(crate) fn transport_kind(error: &reqwest::Error) -> TransportKind {
    if error.is_connect() {
        TransportKind::Connect
    } else if error.is_timeout() {
        TransportKind::Timeout
    } else if error.is_decode() {
        TransportKind::Decode
    } else if error.is_body() {
        TransportKind::Body
    } else {
        TransportKind::Other
    }
}

pub(crate) fn retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

pub(crate) fn parse_provider_error(
    status: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
    max_retry_after: Duration,
) -> ProviderError {
    let parsed = serde_json::from_slice::<Value>(body).ok();
    let error = parsed.as_ref().and_then(|value| value.get("error"));
    let api_status = error
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .map(|value| sanitize(value, 128));
    let message = error
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .map_or_else(
            || {
                if body.is_empty() {
                    "empty provider error".to_owned()
                } else {
                    sanitize(&String::from_utf8_lossy(body), 2_048)
                }
            },
            |value| sanitize(value, 2_048),
        );
    let details_retry = error
        .and_then(|value| value.get("details"))
        .and_then(retry_after_from_details);
    let retry_after = retry_after_from_headers(headers)
        .or(details_retry)
        .map(|duration| duration.min(max_retry_after));

    ProviderError {
        http_status: status.as_u16(),
        api_status,
        message,
        retry_after,
        retryable: retryable_status(status),
    }
}

pub(crate) fn retry_delay(
    policy: &RetryPolicy,
    retry_index: u32,
    server_delay: Option<Duration>,
) -> Duration {
    if let Some(delay) = server_delay {
        return delay.min(policy.max_delay);
    }

    let multiplier = 1_u32.checked_shl(retry_index.min(16)).unwrap_or(u32::MAX);
    let base = policy
        .initial_delay
        .saturating_mul(multiplier)
        .min(policy.max_delay);
    let jitter_span = base.mul_f64(f64::from(policy.jitter_percent) / 100.0);
    if jitter_span.is_zero() {
        return base;
    }

    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| u64::from(duration.subsec_nanos()));
    let span_nanos = u64::try_from(jitter_span.as_nanos()).unwrap_or(u64::MAX);
    let jitter_nanos = nanos % span_nanos.saturating_add(1);
    base.saturating_sub(jitter_span / 2)
        .saturating_add(Duration::from_nanos(jitter_nanos))
        .min(policy.max_delay)
}

fn retry_after_from_headers(headers: &HeaderMap) -> Option<Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    if let Ok(seconds) = value.parse::<f64>() {
        return (seconds.is_finite() && seconds >= 0.0).then(|| Duration::from_secs_f64(seconds));
    }
    let at = httpdate::parse_http_date(value).ok()?;
    Some(at.duration_since(SystemTime::now()).unwrap_or_default())
}

fn retry_after_from_details(details: &Value) -> Option<Duration> {
    details.as_array()?.iter().find_map(|detail| {
        let raw = detail.get("retryDelay")?.as_str()?;
        parse_google_duration(raw)
    })
}

fn parse_google_duration(raw: &str) -> Option<Duration> {
    let seconds = raw.strip_suffix('s')?.parse::<f64>().ok()?;
    (seconds.is_finite() && seconds >= 0.0).then(|| Duration::from_secs_f64(seconds))
}

fn sanitize(value: &str, max_chars: usize) -> String {
    let mut clean = value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(max_chars.saturating_add(1))
        .collect::<String>();
    if clean.chars().count() > max_chars {
        clean = clean.chars().take(max_chars).collect::<String>();
        clean.push('…');
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_info_and_status_are_preserved() {
        let error = parse_provider_error(
            StatusCode::TOO_MANY_REQUESTS,
            &HeaderMap::new(),
            br#"{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"2.25s"}]}}"#,
            Duration::from_mins(1),
        );
        assert_eq!(error.api_status.as_deref(), Some("RESOURCE_EXHAUSTED"));
        assert_eq!(error.retry_after, Some(Duration::from_millis(2_250)));
        assert!(error.retryable);
    }

    #[test]
    fn retry_classification_is_narrow() {
        assert!(retryable_status(StatusCode::REQUEST_TIMEOUT));
        assert!(retryable_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(retryable_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(!retryable_status(StatusCode::BAD_REQUEST));
        assert!(!retryable_status(StatusCode::FORBIDDEN));
    }
}
