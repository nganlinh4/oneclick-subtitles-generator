use futures_util::StreamExt as _;
use reqwest::{Response, StatusCode, header::CONTENT_LENGTH};

use crate::{ProviderError, Result};

pub(crate) struct BoundedResponse {
    pub(crate) status: StatusCode,
    pub(crate) content_type: Option<String>,
    pub(crate) bytes: Vec<u8>,
}

pub(crate) async fn read(response: Response, maximum: usize) -> Result<BoundedResponse> {
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(ProviderError::InvalidResponse);
    }

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_ascii_lowercase);
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ProviderError::Transport)?;
        if bytes
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > maximum)
        {
            return Err(ProviderError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(BoundedResponse {
        status,
        content_type,
        bytes,
    })
}

pub(crate) fn is_json(content_type: Option<&str>) -> bool {
    content_type.is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|mime| mime.trim() == "application/json")
    })
}

pub(crate) fn is_html(content_type: Option<&str>) -> bool {
    content_type.is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|mime| matches!(mime.trim(), "text/html" | "application/xhtml+xml"))
    })
}
