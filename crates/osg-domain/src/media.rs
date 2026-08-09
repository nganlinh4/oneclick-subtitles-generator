use serde::Serialize;
use uuid::Uuid;

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "wma",
];

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Audio,
    Video,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: Uuid,
    pub display_name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub kind: MediaKind,
}

impl MediaAsset {
    #[must_use]
    pub fn new(display_name: String, extension: String, size_bytes: u64, kind: MediaKind) -> Self {
        Self {
            id: Uuid::new_v4(),
            display_name,
            extension,
            size_bytes,
            kind,
        }
    }
}

#[must_use]
pub fn media_kind_for_extension(extension: &str) -> Option<MediaKind> {
    let normalized = extension.trim_start_matches('.').to_ascii_lowercase();
    if AUDIO_EXTENSIONS.contains(&normalized.as_str()) {
        Some(MediaKind::Audio)
    } else if VIDEO_EXTENSIONS.contains(&normalized.as_str()) {
        Some(MediaKind::Video)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{MediaKind, media_kind_for_extension};

    #[test]
    fn extension_lookup_is_case_insensitive() {
        assert_eq!(media_kind_for_extension(".MP4"), Some(MediaKind::Video));
        assert_eq!(media_kind_for_extension("FlAc"), Some(MediaKind::Audio));
        assert_eq!(media_kind_for_extension("txt"), None);
    }
}
