//! Size-bounded parsing of provider server messages into forwarded events.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;

use crate::{
    BYTES_PER_SAMPLE, CHANNEL_COUNT, Error, MAX_AUDIO_BYTES_PER_MESSAGE, MAX_AUDIO_CHUNK_BYTES,
    MAX_AUDIO_CHUNKS_PER_MESSAGE, MAX_FILTER_TEXT_CHARS, MAX_PROVIDER_NOTICE_CHARS,
    MAX_SERVER_MESSAGE_BYTES, Result, ServerEvent,
};

pub(crate) fn parse_setup_message(bytes: &[u8]) -> Result<bool> {
    let value = parse_json(bytes)?;
    validate_server_union(&value)?;
    if value.get("setupComplete").is_some() {
        let setup = value.get("setupComplete").ok_or(Error::ProtocolViolation)?;
        return Ok(setup.as_object().is_some_and(serde_json::Map::is_empty));
    }
    Err(Error::ProtocolViolation)
}

pub(crate) fn forward_server_message<F>(bytes: &[u8], on_event: &mut F) -> Result<bool>
where
    F: FnMut(ServerEvent) -> std::result::Result<(), ()>,
{
    let value = parse_json(bytes)?;
    validate_server_union(&value)?;
    if let Some(content) = value.get("serverContent") {
        for pcm in parse_audio_content(content)? {
            on_event(ServerEvent::Audio(pcm)).map_err(|()| Error::OutputClosed)?;
        }
        return Ok(true);
    }
    if let Some(filtered) = value.get("filteredPrompt") {
        let object = filtered.as_object().ok_or(Error::ProtocolViolation)?;
        let text = bounded_string(object.get("text"), MAX_FILTER_TEXT_CHARS)?;
        let reason = bounded_string(object.get("filteredReason"), MAX_PROVIDER_NOTICE_CHARS)?;
        on_event(ServerEvent::FilteredPrompt { text, reason }).map_err(|()| Error::OutputClosed)?;
        return Ok(false);
    }
    if let Some(warning) = value.get("warning") {
        let warning = bounded_string(Some(warning), MAX_PROVIDER_NOTICE_CHARS)?;
        on_event(ServerEvent::Warning(warning)).map_err(|()| Error::OutputClosed)?;
        return Ok(false);
    }
    Err(Error::ProtocolViolation)
}

fn parse_json(bytes: &[u8]) -> Result<Value> {
    if bytes.is_empty() || bytes.len() > MAX_SERVER_MESSAGE_BYTES {
        return Err(Error::ProtocolViolation);
    }
    serde_json::from_slice(bytes).map_err(|_| Error::ProtocolViolation)
}

fn validate_server_union(value: &Value) -> Result<()> {
    let object = value.as_object().ok_or(Error::ProtocolViolation)?;
    if object.len() != 1 {
        return Err(Error::ProtocolViolation);
    }
    match object.keys().next().map(String::as_str) {
        Some("setupComplete" | "serverContent" | "filteredPrompt" | "warning") => Ok(()),
        _ => Err(Error::ProtocolViolation),
    }
}

fn parse_audio_content(content: &Value) -> Result<Vec<Vec<u8>>> {
    let object = content.as_object().ok_or(Error::ProtocolViolation)?;
    if object.keys().any(|key| key != "audioChunks") {
        return Err(Error::ProtocolViolation);
    }
    let chunks = object
        .get("audioChunks")
        .and_then(Value::as_array)
        .ok_or(Error::ProtocolViolation)?;
    if chunks.is_empty() || chunks.len() > MAX_AUDIO_CHUNKS_PER_MESSAGE {
        return Err(Error::ProtocolViolation);
    }
    let mut output = Vec::with_capacity(chunks.len());
    let mut total = 0usize;
    for chunk in chunks {
        let object = chunk.as_object().ok_or(Error::ProtocolViolation)?;
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "data" | "mimeType" | "sourceMetadata"))
        {
            return Err(Error::ProtocolViolation);
        }
        let mime = object
            .get("mimeType")
            .and_then(Value::as_str)
            .ok_or(Error::ProtocolViolation)?;
        validate_pcm_mime(mime)?;
        let encoded = object
            .get("data")
            .and_then(Value::as_str)
            .ok_or(Error::ProtocolViolation)?;
        let max_encoded = MAX_AUDIO_CHUNK_BYTES.div_ceil(3) * 4;
        if encoded.is_empty() || encoded.len() > max_encoded {
            return Err(Error::ProtocolViolation);
        }
        let decoded = STANDARD
            .decode(encoded)
            .map_err(|_| Error::ProtocolViolation)?;
        if decoded.is_empty()
            || decoded.len() > MAX_AUDIO_CHUNK_BYTES
            || decoded.len() % (usize::from(BYTES_PER_SAMPLE) * usize::from(CHANNEL_COUNT)) != 0
        {
            return Err(Error::ProtocolViolation);
        }
        total = total
            .checked_add(decoded.len())
            .ok_or(Error::ProtocolViolation)?;
        if total > MAX_AUDIO_BYTES_PER_MESSAGE {
            return Err(Error::ProtocolViolation);
        }
        output.push(decoded);
    }
    Ok(output)
}

pub(crate) fn validate_pcm_mime(mime: &str) -> Result<()> {
    if mime.len() > 128 || mime.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(Error::ProtocolViolation);
    }
    let mut parts = mime.split(';').map(str::trim);
    if !parts.next().is_some_and(|value| {
        value.eq_ignore_ascii_case("audio/l16") || value.eq_ignore_ascii_case("audio/pcm")
    }) {
        return Err(Error::ProtocolViolation);
    }
    let mut saw_rate = false;
    let mut saw_channels = false;
    for parameter in parts {
        if parameter.eq_ignore_ascii_case("rate=48000") {
            if saw_rate {
                return Err(Error::ProtocolViolation);
            }
            saw_rate = true;
        } else if parameter.eq_ignore_ascii_case("channels=2") {
            if saw_channels {
                return Err(Error::ProtocolViolation);
            }
            saw_channels = true;
        } else {
            return Err(Error::ProtocolViolation);
        }
    }
    if !saw_rate || !saw_channels {
        return Err(Error::ProtocolViolation);
    }
    Ok(())
}

fn bounded_string(value: Option<&Value>, maximum: usize) -> Result<String> {
    let value = value
        .and_then(Value::as_str)
        .ok_or(Error::ProtocolViolation)?;
    if value.chars().count() > maximum || value.bytes().any(|byte| byte == 0) {
        return Err(Error::ProtocolViolation);
    }
    Ok(value.to_owned())
}
