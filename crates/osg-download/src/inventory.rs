mod parse;

use crate::{DownloadError, Result, SafeFileStem, ValidatedMediaUrl};
use parse::{finite_nonnegative, parse_formats, parse_subtitles, round_u64};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FormatContainer {
    Mp4,
    WebM,
    M4a,
    Mp3,
    Opus,
    Ogg,
    Flac,
    Wav,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFormatOption {
    pub format_id: String,
    pub container: FormatContainer,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps_milli: Option<u32>,
    pub codec: Option<String>,
    pub includes_audio: bool,
    pub size_bytes: Option<u64>,
    pub bitrate_kbps: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFormatOption {
    pub format_id: String,
    pub container: FormatContainer,
    pub codec: Option<String>,
    pub size_bytes: Option<u64>,
    pub bitrate_kbps: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityOption {
    pub height: u32,
    pub has_combined: bool,
    pub has_video_only: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatInventory {
    pub video: Vec<VideoFormatOption>,
    pub audio: Vec<AudioFormatOption>,
    pub qualities: Vec<QualityOption>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SubtitleSource {
    Manual,
    Automatic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SubtitleFormat {
    Srt,
    Vtt,
    Ttml,
    Ass,
    Lrc,
    Json3,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrackOption {
    pub language: String,
    pub source: SubtitleSource,
    pub formats: Vec<SubtitleFormat>,
}

/// Sanitized information from one `--dump-single-json` response. Network URLs,
/// source paths, thumbnails, descriptions, comments, and extractor internals
/// are deliberately discarded.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInventory {
    pub title: SafeFileStem,
    pub duration_seconds: Option<u64>,
    pub formats: FormatInventory,
    pub subtitles: Vec<SubtitleTrackOption>,
    #[serde(skip)]
    binding: [u8; 32],
    #[serde(skip)]
    direct_mp4_format_id: Option<String>,
}

impl std::fmt::Debug for MediaInventory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MediaInventory")
            .field("title", &self.title)
            .field("duration_seconds", &self.duration_seconds)
            .field("formats", &self.formats)
            .field("subtitles", &self.subtitles)
            .field("binding", &"<redacted>")
            .field("direct_mp4_format_id", &self.direct_mp4_format_id)
            .finish()
    }
}

impl MediaInventory {
    pub(crate) fn from_json(url: &ValidatedMediaUrl, json: &[u8]) -> Result<Self> {
        let value: Value = serde_json::from_slice(json).map_err(DownloadError::InventoryJson)?;
        let object = value.as_object().ok_or(DownloadError::InvalidInventory(
            "top level must be an object",
        ))?;

        let title = object
            .get("title")
            .and_then(Value::as_str)
            .map_or_else(|| SafeFileStem::new("download"), SafeFileStem::new);
        let duration_seconds = finite_nonnegative(object.get("duration")).map(round_u64);
        let (formats, direct_mp4_format_id) = parse_formats(url, object)?;
        let subtitles = parse_subtitles(object)?;
        Ok(Self {
            title,
            duration_seconds,
            formats,
            subtitles,
            binding: source_binding(url),
            direct_mp4_format_id,
        })
    }

    /// Creates a non-deserializable capability for an exact inspected format.
    pub fn select_format(&self, format_id: &str) -> Result<SelectedFormat> {
        if let Some(format) = self
            .formats
            .video
            .iter()
            .find(|format| format.format_id == format_id)
        {
            return Ok(SelectedFormat {
                binding: self.binding,
                format_id: format.format_id.clone(),
                kind: SelectedFormatKind::Video {
                    includes_audio: format.includes_audio,
                },
            });
        }
        if let Some(format) = self
            .formats
            .audio
            .iter()
            .find(|format| format.format_id == format_id)
        {
            return Ok(SelectedFormat {
                binding: self.binding,
                format_id: format.format_id.clone(),
                kind: SelectedFormatKind::Audio,
            });
        }
        Err(DownloadError::InvalidOption("unknown format"))
    }

    pub fn select_subtitle(
        &self,
        language: &str,
        source: SubtitleSource,
    ) -> Result<SelectedSubtitle> {
        let track = self
            .subtitles
            .iter()
            .find(|track| track.language == language && track.source == source)
            .ok_or(DownloadError::InvalidOption("unknown subtitle track"))?;
        Ok(SelectedSubtitle {
            binding: self.binding,
            language: track.language.clone(),
            source,
        })
    }

    pub(crate) fn binding(&self) -> [u8; 32] {
        self.binding
    }

    pub(crate) fn direct_mp4_format_id(&self) -> Option<&str> {
        self.direct_mp4_format_id.as_deref()
    }
}

#[derive(Clone)]
pub struct SelectedFormat {
    binding: [u8; 32],
    format_id: String,
    kind: SelectedFormatKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SelectedFormatKind {
    Video { includes_audio: bool },
    Audio,
}

impl SelectedFormat {
    #[must_use]
    pub fn format_id(&self) -> &str {
        &self.format_id
    }

    pub(crate) fn binding(&self) -> [u8; 32] {
        self.binding
    }

    pub(crate) fn is_audio(&self) -> bool {
        self.kind == SelectedFormatKind::Audio
    }

    pub(crate) fn includes_audio(&self) -> bool {
        matches!(
            self.kind,
            SelectedFormatKind::Video {
                includes_audio: true
            }
        )
    }
}

impl std::fmt::Debug for SelectedFormat {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SelectedFormat")
            .field("format_id", &self.format_id)
            .field("kind", &self.kind)
            .field("binding", &"<redacted>")
            .finish()
    }
}

#[derive(Clone)]
pub struct SelectedSubtitle {
    binding: [u8; 32],
    language: String,
    source: SubtitleSource,
}

impl SelectedSubtitle {
    #[must_use]
    pub fn language(&self) -> &str {
        &self.language
    }

    #[must_use]
    pub fn source(&self) -> SubtitleSource {
        self.source
    }

    pub(crate) fn binding(&self) -> [u8; 32] {
        self.binding
    }
}

impl std::fmt::Debug for SelectedSubtitle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SelectedSubtitle")
            .field("language", &self.language)
            .field("source", &self.source)
            .field("binding", &"<redacted>")
            .finish()
    }
}

pub(crate) fn source_binding(url: &ValidatedMediaUrl) -> [u8; 32] {
    Sha256::digest(url.as_str().as_bytes()).into()
}

#[cfg(test)]
mod tests;
