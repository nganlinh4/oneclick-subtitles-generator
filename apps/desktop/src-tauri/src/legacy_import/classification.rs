//! Setting and artifact classification: native, transient, project-scoped and location-bearing values.

use std::collections::BTreeMap;

use serde_json::Value;

use super::{PROJECT_SCOPED_SETTING_KEYS, TRANSIENT_SETTING_KEYS};

pub(super) fn string_value<'a>(values: &'a BTreeMap<String, Value>, key: &str) -> Option<&'a str> {
    values.get(key).and_then(Value::as_str)
}

pub(super) fn is_native_setting_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

pub(super) fn contains_location_bearing_value(value: &Value) -> bool {
    match value {
        Value::String(text) => {
            if looks_like_location(text) {
                return true;
            }
            let trimmed = text.trim();
            if !matches!(trimmed.as_bytes().first(), Some(b'{' | b'[')) {
                return false;
            }
            serde_json::from_str::<Value>(trimmed)
                .is_ok_and(|nested| contains_location_bearing_value(&nested))
        }
        Value::Array(values) => values.iter().any(contains_location_bearing_value),
        Value::Object(values) => values
            .iter()
            .any(|(key, nested)| is_location_field(key) || contains_location_bearing_value(nested)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn is_location_field(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized == "thumbnail"
        || ["url", "uri", "path", "directory", "location"]
            .iter()
            .any(|suffix| normalized.ends_with(suffix))
}

fn looks_like_location(value: &str) -> bool {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower.contains("://")
        || ["blob:", "data:", "file:", "tauri:", "osg-native:"]
            .iter()
            .any(|prefix| lower.starts_with(prefix))
        || trimmed.starts_with('/')
        || trimmed.starts_with("\\\\")
        || (trimmed.len() >= 3
            && trimmed.as_bytes()[0].is_ascii_alphabetic()
            && trimmed.as_bytes()[1] == b':'
            && matches!(trimmed.as_bytes()[2], b'/' | b'\\'))
}

pub(crate) fn is_transient_setting_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace('-', "_");
    TRANSIENT_SETTING_KEYS.contains(&normalized.as_str())
        || normalized.starts_with("current_")
        || normalized.starts_with("gemini_file_")
        || normalized.starts_with("oauth_")
        || normalized.ends_with("_cache")
        || normalized.ends_with("_result")
        || normalized.ends_with("_timestamp")
        || normalized.ends_with("_in_progress")
        || normalized.ends_with("_directory")
        || normalized.ends_with("_location")
        || normalized.ends_with("_path")
        || normalized.ends_with("_uri")
        || normalized.ends_with("_url")
}

pub(crate) fn is_project_scoped_setting_key(key: &str) -> bool {
    PROJECT_SCOPED_SETTING_KEYS.contains(&key)
}

pub(super) fn is_importable_extension(extension: &str) -> bool {
    matches!(
        extension,
        "3gp"
            | "aac"
            | "aiff"
            | "ass"
            | "avi"
            | "flac"
            | "gif"
            | "jpeg"
            | "jpg"
            | "json"
            | "lrc"
            | "m4a"
            | "m4v"
            | "mkv"
            | "mov"
            | "mp3"
            | "mp4"
            | "ogg"
            | "opus"
            | "png"
            | "srt"
            | "ssa"
            | "txt"
            | "vtt"
            | "wav"
            | "webm"
            | "webp"
            | "wmv"
            | "zip"
    )
}

pub(super) fn artifact_kind(relative_path: &str) -> &'static str {
    if relative_path.starts_with("subtitles/") {
        "legacySubtitle"
    } else if relative_path.starts_with("narration/reference/") {
        "legacyReferenceAudio"
    } else if relative_path.starts_with("narration/") {
        "legacyNarration"
    } else if relative_path.starts_with("videos/rendered/")
        || relative_path.starts_with("output/")
        || relative_path.starts_with("video-renderer/server/output/")
    {
        "legacyRenderedMedia"
    } else if relative_path.starts_with("videos/lyrics/") {
        "legacyLyrics"
    } else if relative_path.contains("/album_art/")
        || relative_path.starts_with("public/videos/album_art/")
    {
        "legacyAlbumArt"
    } else {
        "legacyMedia"
    }
}
