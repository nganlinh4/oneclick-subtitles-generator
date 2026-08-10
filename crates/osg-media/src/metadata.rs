use crate::{MediaError, Result};
use serde::{Deserialize, Serialize};

const MAX_TEXT_FIELD: usize = 96;
const MAX_DURATION_SECONDS: i64 = 1_000_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct FrameRate {
    pub numerator: u32,
    pub denominator: u32,
}

impl FrameRate {
    #[must_use]
    pub fn as_f64(self) -> f64 {
        f64::from(self.numerator) / f64::from(self.denominator)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    Video,
    Audio,
    Subtitle,
    Data,
    Attachment,
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Disposition {
    pub default: bool,
    pub attached_picture: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VideoMetadata {
    pub width: u32,
    pub height: u32,
    pub pixel_format: Option<String>,
    pub frame_rate: Option<FrameRate>,
    pub rotation_degrees: i16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AudioMetadata {
    pub sample_rate_hz: Option<u32>,
    pub channels: Option<u16>,
    pub channel_layout: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MediaStream {
    pub index: u32,
    pub kind: StreamKind,
    pub codec: Option<String>,
    pub profile: Option<String>,
    pub duration_us: Option<u64>,
    pub bit_rate_bps: Option<u64>,
    pub disposition: Disposition,
    pub video: Option<VideoMetadata>,
    pub audio: Option<AudioMetadata>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FormatMetadata {
    pub containers: Vec<String>,
    pub duration_us: Option<u64>,
    pub start_time_us: Option<i64>,
    pub size_bytes: Option<u64>,
    pub bit_rate_bps: Option<u64>,
    pub probe_score: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MediaMetadata {
    pub format: FormatMetadata,
    pub streams: Vec<MediaStream>,
    pub primary_video_stream: Option<u32>,
    pub primary_audio_stream: Option<u32>,
}

impl MediaMetadata {
    #[must_use]
    pub fn duration_us(&self) -> Option<u64> {
        self.format.duration_us.or_else(|| {
            self.streams
                .iter()
                .filter_map(|stream| stream.duration_us)
                .max()
        })
    }

    #[must_use]
    pub fn primary_video(&self) -> Option<&MediaStream> {
        let index = self.primary_video_stream?;
        self.streams.iter().find(|stream| stream.index == index)
    }

    #[must_use]
    pub fn primary_audio(&self) -> Option<&MediaStream> {
        let index = self.primary_audio_stream?;
        self.streams.iter().find(|stream| stream.index == index)
    }
}

pub fn parse_ffprobe_json(json: &[u8]) -> Result<MediaMetadata> {
    let raw: RawProbe = serde_json::from_slice(json).map_err(MediaError::ProbeJson)?;
    let raw_streams = raw.streams.unwrap_or_default();
    let streams = raw_streams
        .iter()
        .enumerate()
        .map(|(position, stream)| convert_stream(stream, position))
        .collect::<Vec<_>>();

    if streams.len() > 1_024 {
        return Err(MediaError::InvalidProbe("too many streams"));
    }

    let primary_video_stream = choose_primary(&streams, StreamKind::Video, true);
    let primary_audio_stream = choose_primary(&streams, StreamKind::Audio, false);
    let raw_format = raw.format.unwrap_or_default();
    let format = FormatMetadata {
        containers: parse_containers(raw_format.format_name.as_deref()),
        duration_us: parse_duration(raw_format.duration.as_deref()),
        start_time_us: parse_signed_duration(raw_format.start_time.as_deref()),
        size_bytes: parse_integer(raw_format.size.as_deref()),
        bit_rate_bps: parse_integer(raw_format.bit_rate.as_deref()),
        probe_score: raw_format.probe_score.filter(|score| *score <= 100),
    };

    Ok(MediaMetadata {
        format,
        streams,
        primary_video_stream,
        primary_audio_stream,
    })
}

fn convert_stream(raw: &RawStream, position: usize) -> MediaStream {
    let index = raw
        .index
        .unwrap_or_else(|| u32::try_from(position).unwrap_or(u32::MAX));
    let kind = match raw.codec_type.as_deref() {
        Some("video") => StreamKind::Video,
        Some("audio") => StreamKind::Audio,
        Some("subtitle") => StreamKind::Subtitle,
        Some("data") => StreamKind::Data,
        Some("attachment") => StreamKind::Attachment,
        _ => StreamKind::Unknown,
    };
    let disposition = Disposition {
        default: raw
            .disposition
            .as_ref()
            .and_then(|value| value.default)
            .is_some_and(|value| value != 0),
        attached_picture: raw
            .disposition
            .as_ref()
            .and_then(|value| value.attached_pic)
            .is_some_and(|value| value != 0),
    };
    let video = if kind == StreamKind::Video {
        match (raw.width, raw.height) {
            (Some(width), Some(height)) if width > 0 && height > 0 => Some(VideoMetadata {
                width,
                height,
                pixel_format: sanitized(raw.pix_fmt.as_deref(), true),
                frame_rate: parse_rate(
                    raw.avg_frame_rate
                        .as_deref()
                        .or(raw.r_frame_rate.as_deref()),
                ),
                rotation_degrees: parse_rotation(raw),
            }),
            _ if !disposition.attached_picture => None,
            _ => None,
        }
    } else {
        None
    };
    let audio = (kind == StreamKind::Audio).then(|| AudioMetadata {
        sample_rate_hz: parse_integer(raw.sample_rate.as_deref())
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0),
        channels: raw.channels.and_then(|value| u16::try_from(value).ok()),
        channel_layout: sanitized(raw.channel_layout.as_deref(), false),
    });

    MediaStream {
        index,
        kind,
        codec: sanitized(raw.codec_name.as_deref(), true),
        profile: sanitized(raw.profile.as_deref(), false),
        duration_us: parse_duration(raw.duration.as_deref()),
        bit_rate_bps: parse_integer(raw.bit_rate.as_deref()),
        disposition,
        video,
        audio,
    }
}

fn choose_primary(streams: &[MediaStream], kind: StreamKind, ignore_art: bool) -> Option<u32> {
    let candidates = streams
        .iter()
        .filter(|stream| stream.kind == kind)
        .filter(|stream| !ignore_art || !stream.disposition.attached_picture);
    candidates
        .clone()
        .find(|stream| stream.disposition.default)
        .or_else(|| candidates.into_iter().next())
        .map(|stream| stream.index)
}

fn parse_containers(value: Option<&str>) -> Vec<String> {
    let mut containers = Vec::new();
    for value in value.unwrap_or_default().split(',') {
        if let Some(value) = sanitized(Some(value), true)
            && !containers.contains(&value)
        {
            containers.push(value);
        }
    }
    containers.truncate(16);
    containers
}

fn sanitized(value: Option<&str>, lowercase: bool) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.len() > MAX_TEXT_FIELD {
        return None;
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || " ._+:/()-".contains(character))
    {
        return None;
    }
    Some(if lowercase {
        value.to_ascii_lowercase()
    } else {
        value.to_owned()
    })
}

fn parse_duration(value: Option<&str>) -> Option<u64> {
    let microseconds = parse_decimal_microseconds(value?)?;
    u64::try_from(microseconds).ok()
}

fn parse_signed_duration(value: Option<&str>) -> Option<i64> {
    parse_decimal_microseconds(value?)
}

fn parse_integer(value: Option<&str>) -> Option<u64> {
    value?.parse().ok()
}

fn parse_rate(value: Option<&str>) -> Option<FrameRate> {
    let value = value?;
    let (numerator, denominator) = value.split_once('/').unwrap_or((value, "1"));
    let mut numerator = numerator.parse::<u32>().ok()?;
    let mut denominator = denominator.parse::<u32>().ok()?;
    if numerator == 0 || denominator == 0 {
        return None;
    }
    let divisor = gcd(numerator, denominator);
    numerator /= divisor;
    denominator /= divisor;
    (u64::from(numerator) <= u64::from(denominator).saturating_mul(1_000)).then_some(FrameRate {
        numerator,
        denominator,
    })
}

fn gcd(mut left: u32, mut right: u32) -> u32 {
    while right != 0 {
        (left, right) = (right, left % right);
    }
    left.max(1)
}

fn parse_decimal_microseconds(value: &str) -> Option<i64> {
    let value = value.trim();
    let (negative, value) = value
        .strip_prefix('-')
        .map_or((false, value), |value| (true, value));
    let value = value.strip_prefix('+').unwrap_or(value);
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let seconds = whole.parse::<i64>().ok()?;
    if seconds > MAX_DURATION_SECONDS {
        return None;
    }
    let mut fraction_us = 0_i64;
    for index in 0..6 {
        fraction_us *= 10;
        fraction_us += i64::from(
            fraction
                .as_bytes()
                .get(index)
                .copied()
                .unwrap_or(b'0')
                .saturating_sub(b'0'),
        );
    }
    if fraction
        .as_bytes()
        .get(6)
        .is_some_and(|digit| *digit >= b'5')
    {
        fraction_us += 1;
    }
    let total = seconds.checked_mul(1_000_000)?.checked_add(fraction_us)?;
    Some(if negative { -total } else { total })
}

fn parse_rotation(raw: &RawStream) -> i16 {
    let rotation = raw
        .side_data_list
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find_map(|value| value.rotation)
        .or_else(|| {
            raw.tags
                .as_ref()
                .and_then(|tags| tags.rotate.as_deref())
                .and_then(|value| value.parse::<i32>().ok())
        })
        .unwrap_or_default();
    let normalized = ((rotation % 360) + 360) % 360;
    i16::try_from(normalized).unwrap_or_default()
}

#[derive(Debug, Default, Deserialize)]
struct RawProbe {
    streams: Option<Vec<RawStream>>,
    format: Option<RawFormat>,
}

#[derive(Debug, Default, Deserialize)]
struct RawFormat {
    format_name: Option<String>,
    duration: Option<String>,
    start_time: Option<String>,
    size: Option<String>,
    bit_rate: Option<String>,
    probe_score: Option<u8>,
}

#[derive(Debug, Deserialize)]
struct RawStream {
    index: Option<u32>,
    codec_type: Option<String>,
    codec_name: Option<String>,
    profile: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    pix_fmt: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    duration: Option<String>,
    bit_rate: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    channel_layout: Option<String>,
    disposition: Option<RawDisposition>,
    tags: Option<RawTags>,
    side_data_list: Option<Vec<RawSideData>>,
}

#[derive(Debug, Deserialize)]
struct RawDisposition {
    default: Option<i32>,
    attached_pic: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct RawTags {
    rotate: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawSideData {
    rotation: Option<i32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
      "streams": [
        {"index":0,"codec_type":"video","codec_name":"h264","profile":"High","width":1920,"height":1080,"pix_fmt":"yuv420p","avg_frame_rate":"30000/1001","duration":"12.345","bit_rate":"4000000","disposition":{"default":1,"attached_pic":0},"tags":{"rotate":"-90"}},
        {"index":1,"codec_type":"audio","codec_name":"aac","profile":"LC","sample_rate":"48000","channels":2,"channel_layout":"stereo","duration":"12.3","bit_rate":"192000","disposition":{"default":1,"attached_pic":0}}
      ],
      "format":{"filename":"C:/private/secret.mp4","format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"12.345","start_time":"0.000000","size":"123456","bit_rate":"8000000","probe_score":100,"tags":{"comment":"private"}}
    }"#;

    #[test]
    fn probe_parser_is_typed_and_path_free() {
        let metadata = parse_ffprobe_json(FIXTURE.as_bytes()).unwrap();
        assert_eq!(metadata.primary_video_stream, Some(0));
        assert_eq!(metadata.primary_audio_stream, Some(1));
        assert_eq!(metadata.duration_us(), Some(12_345_000));
        let video = metadata.primary_video().unwrap().video.as_ref().unwrap();
        assert_eq!(video.frame_rate.unwrap().numerator, 30_000);
        assert_eq!(video.rotation_degrees, 270);

        let serialized = serde_json::to_string(&metadata).unwrap();
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("filename"));
        assert!(!serialized.contains("comment"));
    }

    #[test]
    fn invalid_numeric_values_are_ignored() {
        let metadata = parse_ffprobe_json(
            br#"{"streams":[],"format":{"duration":"NaN","size":"not-a-number"}}"#,
        )
        .unwrap();
        assert_eq!(metadata.format.duration_us, None);
        assert_eq!(metadata.format.size_bytes, None);
    }

    #[test]
    fn attached_cover_art_is_not_primary_video() {
        let metadata = parse_ffprobe_json(
            br#"{"streams":[{"index":2,"codec_type":"video","codec_name":"mjpeg","width":500,"height":500,"disposition":{"attached_pic":1}}]}"#,
        )
        .unwrap();
        assert_eq!(metadata.primary_video_stream, None);
    }
}
