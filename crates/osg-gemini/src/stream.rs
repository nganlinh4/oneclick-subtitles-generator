use std::{pin::Pin, sync::Arc};

use async_stream::try_stream;
use bytes::BytesMut;
use futures_util::{Stream, StreamExt};
use reqwest::{Response, StatusCode};
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    Error, GeminiClient, GenerateRequest, GenerateResponse, Model, Result,
    client::{cancellable_sleep, encode_generate_request, read_bounded, validate_generate_request},
    retry::{parse_provider_error, retry_delay, transport_kind},
};

/// A cancellation-aware stream of typed Gemini response chunks.
///
/// The stream owns its concurrency permit. Dropping it therefore releases both
/// the HTTP response and the permit without leaving a background task behind.
pub type GenerateStream = Pin<Box<dyn Stream<Item = Result<GenerateResponse>> + Send + 'static>>;

impl GeminiClient {
    /// Opens `streamGenerateContent` and yields each SSE response exactly once.
    ///
    /// Transient failures may be retried only while opening the HTTP response.
    /// Once a successful streaming response has been accepted, body failures are
    /// returned directly so a retry cannot duplicate already-emitted content.
    pub async fn generate_stream(
        &self,
        request: GenerateRequest,
        cancel: &CancellationToken,
    ) -> Result<GenerateStream> {
        validate_generate_request(&request)?;
        self.wait_for_cooldown(request.model, cancel).await?;
        let permit = self.acquire(cancel).await?;
        let payload = Arc::new(encode_generate_request(&request)?);
        if payload.len() > self.inner.options.max_inline_request_bytes {
            return Err(Error::InlineRequestTooLarge {
                actual_bytes: payload.len(),
                limit_bytes: self.inner.options.max_inline_request_bytes,
            });
        }

        let mut endpoint = self.endpoint(&format!(
            "v1beta/models/{}:streamGenerateContent",
            request.model.api_id()
        ))?;
        endpoint.query_pairs_mut().append_pair("alt", "sse");
        let response = self
            .open_stream_with_retry(&endpoint, &payload, request.model, cancel)
            .await?;
        validate_event_stream_content_type(&response)?;
        self.inner.cooldowns.lock().await.remove(&request.model);

        let timeout = self.inner.options.request_timeout;
        let event_limit = self.inner.options.max_response_bytes;
        let cancel = cancel.clone();
        let output = try_stream! {
            let _permit = permit;
            let mut body = response.bytes_stream();
            let mut decoder = SseDecoder::new(event_limit);
            let deadline = sleep_until(Instant::now() + timeout);
            tokio::pin!(deadline);

            loop {
                let chunk = tokio::select! {
                    () = cancel.cancelled() => Err(Error::Cancelled),
                    () = &mut deadline => Err(Error::Timeout {
                        operation: "stream generation",
                        timeout,
                    }),
                    next = body.next() => Ok(next),
                }?;
                let Some(chunk) = chunk else {
                    for event in decoder.finish()? {
                        match event {
                            DecodedEvent::Response(response) => yield *response,
                            DecodedEvent::Done => return,
                        }
                    }
                    return;
                };
                let chunk = chunk.map_err(|error| Error::Transport(transport_kind(&error)))?;
                for event in decoder.push(&chunk)? {
                    match event {
                        DecodedEvent::Response(response) => yield *response,
                        DecodedEvent::Done => return,
                    }
                }
            }
        };
        Ok(Box::pin(output))
    }

    async fn open_stream_with_retry(
        &self,
        endpoint: &Url,
        payload: &Arc<Vec<u8>>,
        model: Model,
        cancel: &CancellationToken,
    ) -> Result<Response> {
        let mut retry_index = 0;
        loop {
            let request = self
                .authenticated(self.inner.http.post(endpoint.clone()))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header(reqwest::header::ACCEPT, "text/event-stream")
                .body(Arc::clone(payload).as_ref().clone());
            let response = tokio::select! {
                () = cancel.cancelled() => return Err(Error::Cancelled),
                result = tokio::time::timeout(self.inner.options.request_timeout, request.send()) => {
                    match result {
                        Ok(Ok(response)) => response,
                        Ok(Err(error)) => {
                            let error = Error::Transport(transport_kind(&error));
                            if retry_index >= self.inner.options.retry.max_retries {
                                return Err(error);
                            }
                            let delay = retry_delay(&self.inner.options.retry, retry_index, None);
                            cancellable_sleep(delay, cancel).await?;
                            retry_index += 1;
                            continue;
                        }
                        Err(_) => {
                            let error = Error::Timeout {
                                operation: "open stream generation",
                                timeout: self.inner.options.request_timeout,
                            };
                            if retry_index >= self.inner.options.retry.max_retries {
                                return Err(error);
                            }
                            let delay = retry_delay(&self.inner.options.retry, retry_index, None);
                            cancellable_sleep(delay, cancel).await?;
                            retry_index += 1;
                            continue;
                        }
                    }
                }
            };
            if response.status().is_success() {
                return Ok(response);
            }

            let status = response.status();
            let headers = response.headers().clone();
            let (body, _) = tokio::select! {
                () = cancel.cancelled() => return Err(Error::Cancelled),
                result = tokio::time::timeout(
                    self.inner.options.request_timeout,
                    read_bounded(response, self.inner.options.max_error_bytes),
                ) => result.unwrap_or(Err(Error::Timeout {
                    operation: "read stream error",
                    timeout: self.inner.options.request_timeout,
                }))?,
            };
            let mut provider = parse_provider_error(
                status,
                &headers,
                &body,
                self.inner.options.max_server_retry_after,
            );
            let api_key = self.inner.api_key.expose();
            if api_key.len() >= 8 && provider.message.contains(api_key) {
                provider.message = provider.message.replace(api_key, "[REDACTED]");
            }
            let error = Error::Provider(provider);
            if let Error::Provider(provider) = &error
                && provider.http_status == StatusCode::TOO_MANY_REQUESTS.as_u16()
            {
                self.note_cooldown(model, provider.retry_after).await;
            }
            if !error.is_retryable() || retry_index >= self.inner.options.retry.max_retries {
                return Err(error);
            }
            let server_delay = match &error {
                Error::Provider(provider) => provider.retry_after,
                _ => None,
            };
            if server_delay.is_some_and(|delay| delay > self.inner.options.retry.max_delay) {
                return Err(error);
            }
            let delay = retry_delay(&self.inner.options.retry, retry_index, server_delay);
            cancellable_sleep(delay, cancel).await?;
            retry_index += 1;
        }
    }
}

fn validate_event_stream_content_type(response: &Response) -> Result<()> {
    let valid = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"));
    valid
        .then_some(())
        .ok_or(Error::Transport(crate::TransportKind::Decode))
}

#[derive(Debug)]
enum DecodedEvent {
    Response(Box<GenerateResponse>),
    Done,
}

#[derive(Debug)]
struct SseDecoder {
    pending: BytesMut,
    data: Vec<u8>,
    limit: usize,
}

impl SseDecoder {
    fn new(limit: usize) -> Self {
        Self {
            pending: BytesMut::new(),
            data: Vec::new(),
            limit,
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Result<Vec<DecodedEvent>> {
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(newline) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line = self.pending.split_to(newline + 1);
            line.truncate(line.len().saturating_sub(1));
            if line.last() == Some(&b'\r') {
                line.truncate(line.len().saturating_sub(1));
            }
            self.consume_line(&line, &mut events)?;
        }
        if self.pending.len() > self.limit {
            return Err(Error::ResponseTooLarge {
                limit_bytes: self.limit,
            });
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<DecodedEvent>> {
        let mut events = Vec::new();
        if !self.pending.is_empty() {
            let line = self.pending.split().freeze();
            self.consume_line(&line, &mut events)?;
        }
        if let Some(event) = self.finish_event()? {
            events.push(event);
        }
        Ok(events)
    }

    fn consume_line(&mut self, line: &[u8], events: &mut Vec<DecodedEvent>) -> Result<()> {
        if line.is_empty() {
            if let Some(event) = self.finish_event()? {
                events.push(event);
            }
            return Ok(());
        }
        if line.starts_with(b":") {
            return Ok(());
        }
        let (field, value) =
            line.iter()
                .position(|byte| *byte == b':')
                .map_or((line, &[][..]), |colon| {
                    let value = &line[colon + 1..];
                    (&line[..colon], value.strip_prefix(b" ").unwrap_or(value))
                });
        if field == b"data" {
            let separator = usize::from(!self.data.is_empty());
            if self
                .data
                .len()
                .saturating_add(separator)
                .saturating_add(value.len())
                > self.limit
            {
                return Err(Error::ResponseTooLarge {
                    limit_bytes: self.limit,
                });
            }
            if separator == 1 {
                self.data.push(b'\n');
            }
            self.data.extend_from_slice(value);
        }
        Ok(())
    }

    fn finish_event(&mut self) -> Result<Option<DecodedEvent>> {
        if self.data.is_empty() {
            return Ok(None);
        }
        let data = std::mem::take(&mut self.data);
        if data == b"[DONE]" {
            return Ok(Some(DecodedEvent::Done));
        }
        serde_json::from_slice(&data)
            .map(Box::new)
            .map(DecodedEvent::Response)
            .map(Some)
            .map_err(|_| Error::Transport(crate::TransportKind::Decode))
    }
}

#[cfg(test)]
mod tests {
    use super::{DecodedEvent, SseDecoder};
    use crate::{Error, TransportKind};

    #[test]
    fn decoder_handles_fragmented_crlf_multiline_and_done() {
        let mut decoder = SseDecoder::new(1_024);
        let first = decoder
            .push(b": keepalive\r\ndata: {\"candidates\":\r\n")
            .expect("first fragment");
        assert!(first.is_empty());
        let second = decoder
            .push(b"data: [{\"content\":{\"parts\":[{\"text\":\"hello\"}]}}]}\r\n\r\ndata: [DO")
            .expect("second fragment");
        assert_eq!(second.len(), 1);
        let DecodedEvent::Response(response) = &second[0] else {
            panic!("expected response");
        };
        assert_eq!(response.text().as_deref(), Some("hello"));
        let final_events = decoder.push(b"NE]\n\n").expect("done fragment");
        assert!(matches!(final_events.as_slice(), [DecodedEvent::Done]));
    }

    #[test]
    fn decoder_bounds_unterminated_lines_and_rejects_invalid_json() {
        let mut bounded = SseDecoder::new(8);
        assert!(matches!(
            bounded.push(b"data: 123456789"),
            Err(Error::ResponseTooLarge { limit_bytes: 8 })
        ));

        let mut invalid = SseDecoder::new(64);
        assert!(matches!(
            invalid.push(b"data: not-json\n\n"),
            Err(Error::Transport(TransportKind::Decode))
        ));
    }
}
