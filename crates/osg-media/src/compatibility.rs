use crate::MediaMetadata;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatibilityProfile {
    /// Conservative baseline for Windows `WebView2`, macOS `WKWebView`, and
    /// Linux `WebKitGTK`. HEVC is intentionally not assumed to exist.
    #[default]
    PortableWebView,
    /// Reproduces the old application's codec choices for migration analysis.
    /// This is not recommended as the default for new projects.
    LegacyDesktop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversionAction {
    Direct,
    Remux,
    TranscodeAudio,
    TranscodeVideo,
    TranscodeAll,
    Reject,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueSeverity {
    Information,
    Warning,
    Required,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum IssueKind {
    NoPlayableStream,
    UnsupportedContainer { containers: Vec<String> },
    UnsupportedVideoCodec { codec: Option<String> },
    UnsupportedAudioCodec { codec: Option<String> },
    ProblematicAudioProfile { profile: String },
    UnsupportedPixelFormat { pixel_format: String },
    AudioPrecedesVideo,
    MissingDuration,
    LegacyHevcAssumption,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CompatibilityIssue {
    pub severity: IssueSeverity,
    pub issue: IssueKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CompatibilityDecision {
    pub profile: CompatibilityProfile,
    pub action: ConversionAction,
    pub issues: Vec<CompatibilityIssue>,
}

impl CompatibilityDecision {
    #[must_use]
    #[allow(clippy::too_many_lines)]
    pub fn analyze(metadata: &MediaMetadata, profile: CompatibilityProfile) -> Self {
        let video = metadata.primary_video();
        let audio = metadata.primary_audio();
        let mut issues = Vec::new();
        if video.is_none() && audio.is_none() {
            issues.push(issue(IssueSeverity::Required, IssueKind::NoPlayableStream));
            return Self {
                profile,
                action: ConversionAction::Reject,
                issues,
            };
        }

        let mp4_family = metadata.format.containers.iter().any(|container| {
            matches!(
                container.as_str(),
                "mov" | "mp4" | "m4a" | "3gp" | "3g2" | "mj2"
            )
        });
        let audio_only_container = video.is_none()
            && metadata.format.containers.iter().any(|container| {
                matches!(
                    container.as_str(),
                    "mp3" | "wav" | "flac" | "ogg" | "matroska" | "webm" | "m4a" | "mp4"
                )
            });
        let container_ok = if video.is_some() {
            mp4_family
        } else {
            audio_only_container
        };
        let mut needs_remux = false;
        let mut needs_video = false;
        let mut needs_audio = false;

        if !container_ok {
            needs_remux = true;
            issues.push(issue(
                IssueSeverity::Required,
                IssueKind::UnsupportedContainer {
                    containers: metadata.format.containers.clone(),
                },
            ));
        }

        if let Some(video) = video {
            let codec = video.codec.as_deref();
            let video_supported = match profile {
                CompatibilityProfile::PortableWebView => codec == Some("h264"),
                CompatibilityProfile::LegacyDesktop => {
                    matches!(codec, Some("h264" | "hevc" | "h265"))
                }
            };
            if !video_supported {
                needs_video = true;
                issues.push(issue(
                    IssueSeverity::Required,
                    IssueKind::UnsupportedVideoCodec {
                        codec: video.codec.clone(),
                    },
                ));
            } else if profile == CompatibilityProfile::LegacyDesktop
                && matches!(codec, Some("hevc" | "h265"))
            {
                issues.push(issue(
                    IssueSeverity::Warning,
                    IssueKind::LegacyHevcAssumption,
                ));
            }

            if let Some(pixel_format) = video
                .video
                .as_ref()
                .and_then(|details| details.pixel_format.as_deref())
                && !matches!(pixel_format, "yuv420p" | "yuvj420p" | "nv12")
            {
                needs_video = true;
                issues.push(issue(
                    IssueSeverity::Required,
                    IssueKind::UnsupportedPixelFormat {
                        pixel_format: pixel_format.to_owned(),
                    },
                ));
            }
        }

        if let Some(audio) = audio {
            let supported = if video.is_some() {
                matches!(audio.codec.as_deref(), Some("aac" | "mp3"))
            } else {
                matches!(
                    audio.codec.as_deref(),
                    Some("aac" | "mp3" | "pcm_s16le" | "pcm_s24le" | "flac" | "opus" | "vorbis")
                )
            };
            if !supported {
                needs_audio = true;
                issues.push(issue(
                    IssueSeverity::Required,
                    IssueKind::UnsupportedAudioCodec {
                        codec: audio.codec.clone(),
                    },
                ));
            }
            if audio
                .profile
                .as_deref()
                .is_some_and(|profile| profile.to_ascii_lowercase().contains("he-aac"))
            {
                needs_audio = true;
                issues.push(issue(
                    IssueSeverity::Required,
                    IssueKind::ProblematicAudioProfile {
                        profile: audio.profile.clone().unwrap_or_default(),
                    },
                ));
            }
        }

        if let (Some(video), Some(audio)) = (video, audio)
            && audio.index < video.index
        {
            needs_remux = true;
            issues.push(issue(
                IssueSeverity::Required,
                IssueKind::AudioPrecedesVideo,
            ));
        }
        if metadata.duration_us().is_none() {
            issues.push(issue(
                IssueSeverity::Information,
                IssueKind::MissingDuration,
            ));
        }

        let action = match (needs_video, needs_audio, needs_remux) {
            (true, true, _) => ConversionAction::TranscodeAll,
            (true, false, _) => ConversionAction::TranscodeVideo,
            (false, true, _) => ConversionAction::TranscodeAudio,
            (false, false, true) => ConversionAction::Remux,
            (false, false, false) => ConversionAction::Direct,
        };
        Self {
            profile,
            action,
            issues,
        }
    }
}

fn issue(severity: IssueSeverity, issue: IssueKind) -> CompatibilityIssue {
    CompatibilityIssue { severity, issue }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_ffprobe_json;

    fn metadata(video: &str, audio: &str, format: &str) -> MediaMetadata {
        parse_ffprobe_json(
            format!(
                r#"{{"streams":[{{"index":0,"codec_type":"video","codec_name":"{video}","width":1920,"height":1080,"pix_fmt":"yuv420p"}},{{"index":1,"codec_type":"audio","codec_name":"{audio}"}}],"format":{{"format_name":"{format}","duration":"5"}}}}"#
            )
            .as_bytes(),
        )
        .unwrap()
    }

    #[test]
    fn portable_profile_does_not_repeat_legacy_hevc_mistake() {
        let metadata = metadata("hevc", "aac", "mov,mp4");
        assert_eq!(
            CompatibilityDecision::analyze(&metadata, CompatibilityProfile::PortableWebView).action,
            ConversionAction::TranscodeVideo
        );
        assert_eq!(
            CompatibilityDecision::analyze(&metadata, CompatibilityProfile::LegacyDesktop).action,
            ConversionAction::Direct
        );
    }

    #[test]
    fn compatible_h264_aac_mp4_is_direct() {
        let decision = CompatibilityDecision::analyze(
            &metadata("h264", "aac", "mov,mp4"),
            CompatibilityProfile::PortableWebView,
        );
        assert_eq!(decision.action, ConversionAction::Direct);
    }

    #[test]
    fn video_and_audio_incompatibility_requests_one_transcode() {
        let decision = CompatibilityDecision::analyze(
            &metadata("vp9", "vorbis", "webm"),
            CompatibilityProfile::PortableWebView,
        );
        assert_eq!(decision.action, ConversionAction::TranscodeAll);
    }

    #[test]
    fn old_audio_first_problem_becomes_remux() {
        let metadata = parse_ffprobe_json(
            br#"{"streams":[{"index":0,"codec_type":"audio","codec_name":"aac"},{"index":1,"codec_type":"video","codec_name":"h264","width":1280,"height":720,"pix_fmt":"yuv420p"}],"format":{"format_name":"mp4","duration":"2"}}"#,
        )
        .unwrap();
        assert_eq!(
            CompatibilityDecision::analyze(&metadata, CompatibilityProfile::PortableWebView).action,
            ConversionAction::Remux
        );
    }
}
