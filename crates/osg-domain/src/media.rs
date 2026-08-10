use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

use crate::AssetId;

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "aac", "ac3", "aiff", "amr", "ape", "au", "caf", "dts", "flac", "m4a", "mka", "mp3", "oga",
    "ogg", "opus", "ra", "wav", "weba", "wma",
];

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "3gp", "3gpp", "avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv",
];

pub const MAX_MEDIA_DISPLAY_NAME_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Audio,
    Video,
}

/// Path-free metadata for a media item known to the application.
///
/// Filesystem locations deliberately live in the infrastructure layer and are
/// resolved by opaque IDs. This value is therefore safe to serialize to the
/// `WebView` and into project revision snapshots.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    id: AssetId,
    display_name: String,
    extension: String,
    size_bytes: u64,
    kind: MediaKind,
}

impl MediaAsset {
    pub fn new(
        display_name: impl Into<String>,
        extension: impl Into<String>,
        size_bytes: u64,
        kind: MediaKind,
    ) -> Result<Self, MediaError> {
        Self::with_id(AssetId::new(), display_name, extension, size_bytes, kind)
    }

    pub fn with_id(
        id: AssetId,
        display_name: impl Into<String>,
        extension: impl Into<String>,
        size_bytes: u64,
        kind: MediaKind,
    ) -> Result<Self, MediaError> {
        let display_name = normalize_display_name(&display_name.into())?;
        let extension = normalize_extension(&extension.into())?;
        let detected_kind = media_kind_for_extension(&extension)
            .ok_or_else(|| MediaError::UnsupportedExtension(extension.clone()))?;
        if detected_kind != kind {
            return Err(MediaError::KindMismatch {
                extension,
                expected: detected_kind,
                received: kind,
            });
        }
        if size_bytes == 0 {
            return Err(MediaError::EmptyAsset);
        }

        Ok(Self {
            id,
            display_name,
            extension,
            size_bytes,
            kind,
        })
    }

    #[must_use]
    pub const fn id(&self) -> AssetId {
        self.id
    }

    #[must_use]
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    #[must_use]
    pub fn extension(&self) -> &str {
        &self.extension
    }

    #[must_use]
    pub const fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    #[must_use]
    pub const fn kind(&self) -> MediaKind {
        self.kind
    }
}

impl<'de> Deserialize<'de> for MediaAsset {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawMediaAsset {
            id: AssetId,
            display_name: String,
            extension: String,
            size_bytes: u64,
            kind: MediaKind,
        }

        let raw = RawMediaAsset::deserialize(deserializer)?;
        Self::with_id(
            raw.id,
            raw.display_name,
            raw.extension,
            raw.size_bytes,
            raw.kind,
        )
        .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MediaError {
    #[error("media display name cannot be blank")]
    BlankDisplayName,
    #[error("media display name cannot contain control characters")]
    InvalidDisplayName,
    #[error(
        "media display name is too long: {actual_chars} characters exceeds the {max_chars} character limit"
    )]
    DisplayNameTooLong {
        max_chars: usize,
        actual_chars: usize,
    },
    #[error("media extension cannot be blank")]
    BlankExtension,
    #[error("media extension `{0}` is not supported")]
    UnsupportedExtension(String),
    #[error(
        "media extension `.{extension}` identifies {expected:?}, but the asset was marked {received:?}"
    )]
    KindMismatch {
        extension: String,
        expected: MediaKind,
        received: MediaKind,
    },
    #[error("media asset cannot be empty")]
    EmptyAsset,
}

fn normalize_display_name(value: &str) -> Result<String, MediaError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(MediaError::BlankDisplayName);
    }
    if value.chars().any(char::is_control) {
        return Err(MediaError::InvalidDisplayName);
    }
    let actual_chars = value.chars().count();
    if actual_chars > MAX_MEDIA_DISPLAY_NAME_CHARS {
        return Err(MediaError::DisplayNameTooLong {
            max_chars: MAX_MEDIA_DISPLAY_NAME_CHARS,
            actual_chars,
        });
    }
    Ok(value.to_owned())
}

fn normalize_extension(value: &str) -> Result<String, MediaError> {
    let normalized = value.trim().trim_start_matches('.').to_ascii_lowercase();
    if normalized.is_empty() {
        return Err(MediaError::BlankExtension);
    }
    Ok(normalized)
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
    use uuid::{Uuid, Version};

    use super::{MediaAsset, MediaError, MediaKind, media_kind_for_extension};

    #[test]
    fn extension_lookup_is_case_insensitive() {
        assert_eq!(media_kind_for_extension(".MP4"), Some(MediaKind::Video));
        assert_eq!(media_kind_for_extension("FlAc"), Some(MediaKind::Audio));
        assert_eq!(media_kind_for_extension("3gpp"), Some(MediaKind::Video));
        assert_eq!(media_kind_for_extension("mka"), Some(MediaKind::Audio));
        assert_eq!(media_kind_for_extension("weba"), Some(MediaKind::Audio));
        assert_eq!(media_kind_for_extension("txt"), None);
    }

    #[test]
    fn new_assets_are_canonical_and_time_sortable() {
        let asset =
            MediaAsset::new(" example.MP4 ", ".MP4", 42, MediaKind::Video).expect("valid asset");

        assert_eq!(asset.id().as_uuid().get_version(), Some(Version::SortRand));
        assert_eq!(asset.display_name(), "example.MP4");
        assert_eq!(asset.extension(), "mp4");
    }

    #[test]
    fn invalid_or_inconsistent_assets_are_rejected_at_every_boundary() {
        assert_eq!(
            MediaAsset::new("clip.mp4", "mp4", 0, MediaKind::Video),
            Err(MediaError::EmptyAsset)
        );
        assert!(matches!(
            MediaAsset::new("clip.mp4", "mp4", 1, MediaKind::Audio),
            Err(MediaError::KindMismatch { .. })
        ));

        let legacy_id = Uuid::new_v4();
        let json = format!(
            r#"{{"id":"{legacy_id}","displayName":"clip.mp4","extension":"mp4","sizeBytes":1,"kind":"video"}}"#
        );
        assert!(serde_json::from_str::<MediaAsset>(&json).is_err());
    }

    #[test]
    fn serialized_assets_round_trip_without_paths() {
        let asset = MediaAsset::new("clip.mp4", "mp4", 42, MediaKind::Video).expect("valid asset");
        let json = serde_json::to_string(&asset).expect("serializable asset");
        let restored: MediaAsset = serde_json::from_str(&json).expect("valid asset snapshot");

        assert_eq!(restored, asset);
        assert!(!json.contains("path"));
    }
}
