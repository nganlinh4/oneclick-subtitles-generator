use crate::{DownloadError, Result, SafeFileStem, ValidatedMediaUrl};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};

const MAX_FORMATS: usize = 4_096;
const MAX_SUBTITLES: usize = 512;

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
        let formats = parse_formats(object)?;
        let subtitles = parse_subtitles(object)?;
        Ok(Self {
            title,
            duration_seconds,
            formats,
            subtitles,
            binding: source_binding(url),
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

fn parse_formats(object: &serde_json::Map<String, Value>) -> Result<FormatInventory> {
    let values = object
        .get("formats")
        .and_then(Value::as_array)
        .ok_or(DownloadError::InvalidInventory("formats are missing"))?;
    if values.len() > MAX_FORMATS {
        return Err(DownloadError::InvalidInventory("too many formats"));
    }

    let mut video = Vec::new();
    let mut audio = Vec::new();
    let mut quality_map = BTreeMap::<u32, (bool, bool)>::new();
    let mut seen_ids = HashSet::new();
    for raw in values {
        let Some(format) = raw.as_object() else {
            continue;
        };
        let Some(format_id) = format
            .get("format_id")
            .and_then(Value::as_str)
            .filter(|id| valid_token(id, 64))
        else {
            continue;
        };
        let has_video = codec_present(format.get("vcodec"));
        let has_audio = codec_present(format.get("acodec"));
        if !has_video && !has_audio {
            continue;
        }
        if !seen_ids.insert(format_id) {
            return Err(DownloadError::InvalidInventory("duplicate format ID"));
        }
        let container = format
            .get("ext")
            .and_then(Value::as_str)
            .map_or(FormatContainer::Other, parse_container);
        let size_bytes =
            integer(format.get("filesize")).or_else(|| integer(format.get("filesize_approx")));

        if has_video {
            let height = integer(format.get("height")).and_then(u64_to_u32);
            if let Some(height) = height.filter(|height| *height > 0 && *height <= 16_384) {
                let entry = quality_map.entry(height).or_default();
                if has_audio {
                    entry.0 = true;
                } else {
                    entry.1 = true;
                }
            }
            video.push(VideoFormatOption {
                format_id: format_id.to_owned(),
                container,
                width: integer(format.get("width")).and_then(u64_to_u32),
                height,
                fps_milli: finite_nonnegative(format.get("fps"))
                    .map(|value| round_u32(value * 1_000.0)),
                codec: clean_codec(format.get("vcodec")),
                includes_audio: has_audio,
                size_bytes,
                bitrate_kbps: finite_nonnegative(format.get("tbr")).map(round_u32),
            });
        } else {
            audio.push(AudioFormatOption {
                format_id: format_id.to_owned(),
                container,
                codec: clean_codec(format.get("acodec")),
                size_bytes,
                bitrate_kbps: finite_nonnegative(format.get("abr"))
                    .or_else(|| finite_nonnegative(format.get("tbr")))
                    .map(round_u32),
            });
        }
    }
    if video.is_empty() && audio.is_empty() {
        return Err(DownloadError::InvalidInventory("no usable formats"));
    }
    Ok(FormatInventory {
        video,
        audio,
        qualities: quality_map
            .into_iter()
            .rev()
            .map(|(height, (has_combined, has_video_only))| QualityOption {
                height,
                has_combined,
                has_video_only,
            })
            .collect(),
    })
}

fn parse_subtitles(object: &serde_json::Map<String, Value>) -> Result<Vec<SubtitleTrackOption>> {
    let mut tracks = Vec::new();
    for (field, source) in [
        ("subtitles", SubtitleSource::Manual),
        ("automatic_captions", SubtitleSource::Automatic),
    ] {
        let Some(languages) = object.get(field).and_then(Value::as_object) else {
            continue;
        };
        for (language, entries) in languages {
            if !valid_language(language) {
                continue;
            }
            if tracks.len() >= MAX_SUBTITLES {
                return Err(DownloadError::InvalidInventory("too many subtitle tracks"));
            }
            let mut formats = BTreeSet::new();
            if let Some(entries) = entries.as_array() {
                if entries.len() > 64 {
                    return Err(DownloadError::InvalidInventory(
                        "too many subtitle representations",
                    ));
                }
                for entry in entries {
                    if let Some(extension) = entry.get("ext").and_then(Value::as_str) {
                        formats.insert(parse_subtitle_format(extension));
                    }
                }
            }
            if !formats.is_empty() {
                tracks.push(SubtitleTrackOption {
                    language: language.clone(),
                    source,
                    formats: formats.into_iter().collect(),
                });
            }
        }
    }
    Ok(tracks)
}

fn parse_container(value: &str) -> FormatContainer {
    match value.to_ascii_lowercase().as_str() {
        "mp4" => FormatContainer::Mp4,
        "webm" => FormatContainer::WebM,
        "m4a" => FormatContainer::M4a,
        "mp3" => FormatContainer::Mp3,
        "opus" => FormatContainer::Opus,
        "ogg" => FormatContainer::Ogg,
        "flac" => FormatContainer::Flac,
        "wav" => FormatContainer::Wav,
        _ => FormatContainer::Other,
    }
}

fn parse_subtitle_format(value: &str) -> SubtitleFormat {
    match value.to_ascii_lowercase().as_str() {
        "srt" => SubtitleFormat::Srt,
        "vtt" | "webvtt" => SubtitleFormat::Vtt,
        "ttml" => SubtitleFormat::Ttml,
        "ass" | "ssa" => SubtitleFormat::Ass,
        "lrc" => SubtitleFormat::Lrc,
        "json3" => SubtitleFormat::Json3,
        _ => SubtitleFormat::Other,
    }
}

fn valid_token(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_language(value: &str) -> bool {
    valid_token(value, 35)
}

fn codec_present(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|codec| !codec.is_empty() && !codec.eq_ignore_ascii_case("none"))
}

fn clean_codec(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|codec| valid_token(codec, 32))
        .map(str::to_owned)
}

fn finite_nonnegative(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn integer(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .or_else(|| finite_nonnegative(value).map(round_u64))
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]
fn round_u64(value: f64) -> u64 {
    value.round().clamp(0.0, u64::MAX as f64) as u64
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn round_u32(value: f64) -> u32 {
    value.round().clamp(0.0, f64::from(u32::MAX)) as u32
}

fn u64_to_u32(value: u64) -> Option<u32> {
    u32::try_from(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AddressResolver, UrlPolicy, UrlValidator};
    use std::io;
    use std::net::{IpAddr, Ipv4Addr};

    #[derive(Clone, Debug)]
    struct PublicDns;

    impl AddressResolver for PublicDns {
        fn resolve(&self, _host: &str, _port: u16) -> io::Result<Vec<IpAddr>> {
            Ok(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))])
        }
    }

    fn url(value: &str) -> ValidatedMediaUrl {
        UrlValidator::new(PublicDns, UrlPolicy::SupportedSitesOnly)
            .validate(value)
            .unwrap()
    }

    #[test]
    fn parses_only_path_free_typed_inventory() {
        let json = br#"{
          "title":"../A video", "duration":12.4, "_filename":"C:/secret/raw.mp4",
          "formats":[
            {"format_id":"137","ext":"mp4","width":1920,"height":1080,"fps":29.97,"vcodec":"avc1.640028","acodec":"none","filesize":1000},
            {"format_id":"22","ext":"mp4","height":720,"vcodec":"avc1","acodec":"mp4a","tbr":900},
            {"format_id":"bad/best","ext":"mp4","height":9999,"vcodec":"x","acodec":"none"},
            {"format_id":"140","ext":"m4a","vcodec":"none","acodec":"mp4a.40.2","abr":128}
          ],
          "subtitles":{"en":[{"ext":"vtt","url":"https://secret"}]},
          "automatic_captions":{"ko-KR":[{"ext":"json3"}]},
          "description":"secret description"
        }"#;
        let inventory =
            MediaInventory::from_json(&url("https://youtube.com/watch?v=secret"), json).unwrap();
        assert_eq!(inventory.formats.video.len(), 2);
        assert_eq!(inventory.formats.audio.len(), 1);
        assert_eq!(inventory.formats.qualities[0].height, 1080);
        assert_eq!(inventory.subtitles.len(), 2);
        let serialized = serde_json::to_string(&inventory).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("url"));
        assert!(!serialized.contains("filename"));
        assert!(serialized.contains(r#""formatId":"137""#));
        assert!(serialized.contains(r#""container":"mp4""#));
        assert!(serialized.contains(r#""includesAudio":false"#));
        assert!(serialized.contains(r#""source":"automatic""#));
        let debug = format!("{inventory:?}");
        assert!(!debug.contains("secret"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn selections_are_bound_to_the_inspected_url() {
        let json = br#"{"formats":[{"format_id":"18","ext":"mp4","height":360,"vcodec":"h264","acodec":"aac"}]}"#;
        let first =
            MediaInventory::from_json(&url("https://youtube.com/watch?v=one"), json).unwrap();
        let second =
            MediaInventory::from_json(&url("https://youtube.com/watch?v=two"), json).unwrap();
        assert_ne!(first.binding(), second.binding());
        assert_eq!(
            first.select_format("18").unwrap().binding(),
            first.binding()
        );
        assert!(first.select_format("18/bestaudio").is_err());
    }
}
