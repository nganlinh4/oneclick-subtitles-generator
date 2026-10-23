//! Parsing of untrusted yt-dlp inventory JSON into bounded, typed format and subtitle options.

use super::{
    AudioFormatOption, FormatContainer, FormatInventory, QualityOption, SubtitleFormat,
    SubtitleSource, SubtitleTrackOption, VideoFormatOption,
};
use crate::{DownloadError, Result, ValidatedMediaUrl};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};

const MAX_FORMATS: usize = 4_096;
const MAX_SUBTITLES: usize = 512;

pub(super) fn parse_formats(
    url: &ValidatedMediaUrl,
    object: &serde_json::Map<String, Value>,
) -> Result<(FormatInventory, Option<String>)> {
    // The generic extractor in current yt-dlp emits `direct: true` *and* a synthetic one-entry
    // `formats` array. That entry deliberately has no codec metadata because yt-dlp has only
    // inspected the HTTP object, not decoded it. Treating it as an ordinary site inventory drops
    // the entry as unusable and rejects every approved direct MP4 before a download job can exist.
    //
    // The direct marker must therefore win over the presence of `formats`. `parse_direct_mp4`
    // still requires the exact approved URL capability, video media type, and bounded format ID;
    // a hostile supported-site response cannot use this branch to obtain passthrough privileges.
    if object.get("direct").and_then(Value::as_bool) == Some(true) {
        return parse_direct_mp4(url, object)
            .map(|(formats, format_id)| (formats, Some(format_id)));
    }
    let Some(raw_formats) = object.get("formats") else {
        return parse_direct_mp4(url, object)
            .map(|(formats, format_id)| (formats, Some(format_id)));
    };
    let values = raw_formats
        .as_array()
        .ok_or(DownloadError::InvalidInventory("formats are invalid"))?;
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
        let (has_video, has_audio) = codec_presence(url, format);
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
    Ok((
        FormatInventory {
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
        },
        None,
    ))
}

fn codec_presence(
    url: &ValidatedMediaUrl,
    format: &serde_json::Map<String, Value>,
) -> (bool, bool) {
    #[cfg(not(feature = "e2e-automation"))]
    let _ = url;
    #[cfg(feature = "e2e-automation")]
    if url.is_exact_automation_extractor_page()
        && format.get("ext").and_then(Value::as_str) == Some("mp4")
        && integer(format.get("height")).is_some_and(|height| (144..=4_320).contains(&height))
    {
        // yt-dlp's generic HTML extractor intentionally leaves codec metadata unknown. The exact
        // compile-time E2E page owns both tokenized MP4 sources, so its bounded `res` declarations
        // can model combined video rungs without weakening public inventories.
        return (true, true);
    }
    (
        codec_present(format.get("vcodec")),
        codec_present(format.get("acodec")),
    )
}

fn parse_direct_mp4(
    url: &ValidatedMediaUrl,
    object: &serde_json::Map<String, Value>,
) -> Result<(FormatInventory, String)> {
    if object.get("direct").and_then(Value::as_bool) != Some(true) {
        return Err(DownloadError::InvalidInventory("formats are missing"));
    }
    if object.get("_type").and_then(Value::as_str) != Some("video") {
        return Err(DownloadError::InvalidInventory(
            "direct media type is invalid",
        ));
    }
    if !url.allows_direct_mp4_passthrough() {
        return Err(DownloadError::InvalidInventory(
            "direct media passthrough is not approved",
        ));
    }
    let format_id = object
        .get("format_id")
        .and_then(Value::as_str)
        .filter(|id| valid_token(id, 64))
        .ok_or(DownloadError::InvalidInventory(
            "direct format ID is invalid",
        ))?;
    if let Some(raw_formats) = object.get("formats") {
        let synthetic = raw_formats
            .as_array()
            .filter(|formats| formats.len() == 1)
            .and_then(|formats| formats.first())
            .and_then(Value::as_object)
            .ok_or(DownloadError::InvalidInventory(
                "direct formats are invalid",
            ))?;
        if synthetic.get("format_id").and_then(Value::as_str) != Some(format_id) {
            return Err(DownloadError::InvalidInventory(
                "direct formats are invalid",
            ));
        }
        let top_extension = object.get("ext").and_then(Value::as_str);
        let synthetic_extension = synthetic.get("ext").and_then(Value::as_str);
        if top_extension.is_some()
            && synthetic_extension.is_some()
            && top_extension != synthetic_extension
        {
            return Err(DownloadError::InvalidInventory(
                "direct formats are contradictory",
            ));
        }
        if synthetic
            .get("protocol")
            .and_then(Value::as_str)
            .is_some_and(|protocol| !matches!(protocol, "http" | "https"))
            || synthetic.get("vcodec").and_then(Value::as_str) == Some("none")
            || synthetic.get("video_ext").and_then(Value::as_str) == Some("none")
        {
            return Err(DownloadError::InvalidInventory(
                "direct formats are contradictory",
            ));
        }
    }
    let container = object
        .get("ext")
        .and_then(Value::as_str)
        .map_or(FormatContainer::Other, parse_container);
    let format_id = format_id.to_owned();
    Ok((
        FormatInventory {
            video: vec![VideoFormatOption {
                format_id: format_id.clone(),
                container,
                width: None,
                height: None,
                fps_milli: None,
                codec: None,
                // The generic direct result does not expose stream metadata. Treat it as combined so
                // an exact selection never asks yt-dlp to locate a separate audio capability.
                includes_audio: true,
                size_bytes: None,
                bitrate_kbps: None,
            }],
            audio: Vec::new(),
            qualities: Vec::new(),
        },
        format_id,
    ))
}

pub(super) fn parse_subtitles(
    object: &serde_json::Map<String, Value>,
) -> Result<Vec<SubtitleTrackOption>> {
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

pub(super) fn finite_nonnegative(value: Option<&Value>) -> Option<f64> {
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
pub(super) fn round_u64(value: f64) -> u64 {
    value.round().clamp(0.0, u64::MAX as f64) as u64
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn round_u32(value: f64) -> u32 {
    value.round().clamp(0.0, f64::from(u32::MAX)) as u32
}

fn u64_to_u32(value: u64) -> Option<u32> {
    u32::try_from(value).ok()
}
