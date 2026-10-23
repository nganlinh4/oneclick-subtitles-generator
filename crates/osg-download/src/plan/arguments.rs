//! yt-dlp argument construction for validated plans and inventory probes. Every argument is a
//! fixed flag or a value derived from a typed capability; nothing is taken from serialized input.

use super::{AudioQuality, DownloadCookies, DownloadPlan, MediaSelection, VideoQuality};
use crate::inventory::source_binding;
use crate::{DownloadError, FfmpegDirectory, Result, SubtitleSource, ValidatedMediaUrl};
use std::ffi::OsString;
use std::path::Path;

impl DownloadPlan {
    pub(crate) fn arguments(
        &self,
        staging_directory: &Path,
        ffmpeg: Option<&FfmpegDirectory>,
    ) -> Result<Vec<OsString>> {
        if source_binding(&self.url) != self.binding {
            return Err(DownloadError::FormatMismatch);
        }
        let ffmpeg = ffmpeg.ok_or(DownloadError::FfmpegRequired)?;
        let mut arguments = base_arguments(&self.cookies);
        let preserve_direct_mp4 = self.direct_mp4_format_id.is_some()
            && matches!(self.media, MediaSelection::Video { .. });
        let output = if preserve_direct_mp4 {
            staging_directory.join("media.mp4")
        } else {
            staging_directory.join("media.%(ext)s")
        };
        arguments.extend([
            OsString::from("--no-simulate"),
            OsString::from("--ffmpeg-location"),
            ffmpeg.path().as_os_str().to_owned(),
            OsString::from("--output"),
            output.into_os_string(),
            OsString::from("--format"),
            OsString::from(self.format_selector()?),
        ]);

        if preserve_direct_mp4 {
            arguments.extend([OsString::from("--fixup"), OsString::from("never")]);
        }

        match self.media {
            MediaSelection::Video { .. } if !preserve_direct_mp4 => {
                arguments.extend([
                    OsString::from("--merge-output-format"),
                    OsString::from("mp4"),
                    OsString::from("--remux-video"),
                    OsString::from("mp4"),
                ]);
            }
            MediaSelection::Video { .. } => {}
            MediaSelection::Audio { format, .. } => {
                arguments.extend([
                    OsString::from("--extract-audio"),
                    OsString::from("--audio-format"),
                    OsString::from(format.extension()),
                    OsString::from("--audio-quality"),
                    OsString::from("192K"),
                ]);
            }
        }

        if let Some(selected) = self.selected_subtitle() {
            arguments.push(OsString::from(match selected.source() {
                SubtitleSource::Manual => "--write-subs",
                SubtitleSource::Automatic => "--write-auto-subs",
            }));
            arguments.extend([
                OsString::from("--sub-langs"),
                OsString::from(selected.language()),
                OsString::from("--sub-format"),
                OsString::from("srt/best"),
                OsString::from("--convert-subs"),
                OsString::from("srt"),
            ]);
        }

        add_progress_arguments(&mut arguments);
        arguments.push(OsString::from("--"));
        arguments.push(OsString::from(self.url.as_str()));
        Ok(arguments)
    }

    fn format_selector(&self) -> Result<String> {
        if let Some(format_id) = &self.direct_mp4_format_id {
            return match &self.media {
                MediaSelection::Video {
                    quality: VideoQuality::Best | VideoQuality::Exact(_),
                }
                | MediaSelection::Audio {
                    quality: AudioQuality::Best,
                    ..
                } => Ok(format_id.clone()),
                MediaSelection::Video {
                    quality: VideoQuality::AtMost(_),
                }
                | MediaSelection::Audio {
                    quality: AudioQuality::Exact(_),
                    ..
                } => Err(DownloadError::FormatMismatch),
            };
        }
        match &self.media {
            MediaSelection::Video {
                quality: VideoQuality::Best,
            } => Ok("bestvideo*+bestaudio/best".to_owned()),
            MediaSelection::Video {
                quality: VideoQuality::AtMost(height),
            } => Ok(format!(
                "bestvideo*[height<={}]+bestaudio/best[height<={}]",
                height.get(),
                height.get()
            )),
            MediaSelection::Video {
                quality: VideoQuality::Exact(selected),
            } => {
                if selected.is_audio() {
                    return Err(DownloadError::FormatMismatch);
                }
                if selected.includes_audio() {
                    Ok(selected.format_id().to_owned())
                } else {
                    Ok(format!("{}+bestaudio/best", selected.format_id()))
                }
            }
            MediaSelection::Audio {
                quality: AudioQuality::Best,
                ..
            } => Ok("bestaudio/best".to_owned()),
            MediaSelection::Audio {
                quality: AudioQuality::Exact(selected),
                ..
            } => {
                if selected.is_audio() {
                    Ok(selected.format_id().to_owned())
                } else {
                    Err(DownloadError::FormatMismatch)
                }
            }
        }
    }
}

pub(crate) fn inventory_arguments(
    url: &ValidatedMediaUrl,
    cookies: impl Into<DownloadCookies>,
) -> Vec<OsString> {
    let cookies = cookies.into();
    let mut arguments = base_arguments(&cookies);
    arguments.extend([
        OsString::from("--dump-single-json"),
        OsString::from("--skip-download"),
        OsString::from("--no-warnings"),
        OsString::from("--"),
        OsString::from(url.as_str()),
    ]);
    arguments
}

fn base_arguments(cookies: &DownloadCookies) -> Vec<OsString> {
    let mut arguments = vec![
        OsString::from("--ignore-config"),
        OsString::from("--no-config-locations"),
        OsString::from("--no-playlist"),
        OsString::from("--no-colors"),
        OsString::from("--newline"),
        OsString::from("--socket-timeout"),
        OsString::from("30"),
        OsString::from("--retries"),
        OsString::from("10"),
        OsString::from("--fragment-retries"),
        OsString::from("10"),
        OsString::from("--extractor-retries"),
        OsString::from("5"),
        // Immediate retries amplify a short source-side throttle. Pace each retry class using
        // yt-dlp's bounded exponential policy so a transient 429 gets time to clear without an
        // unbounded or application-global sleep.
        OsString::from("--retry-sleep"),
        OsString::from("http:exp=1:16"),
        OsString::from("--retry-sleep"),
        OsString::from("fragment:exp=1:16"),
        OsString::from("--retry-sleep"),
        OsString::from("extractor:exp=1:16"),
        OsString::from("--no-overwrites"),
        OsString::from("--no-post-overwrites"),
        OsString::from("--no-mtime"),
        OsString::from("--no-write-comments"),
        OsString::from("--no-exec"),
    ];
    match cookies {
        DownloadCookies::None => arguments.extend([
            OsString::from("--no-cookies"),
            OsString::from("--no-cookies-from-browser"),
        ]),
        DownloadCookies::Browser(source) => arguments.extend([
            OsString::from("--cookies-from-browser"),
            OsString::from(source.yt_dlp_name().expect("browser source is never none")),
        ]),
        #[cfg(feature = "e2e-automation")]
        DownloadCookies::AutomationFile(file) => arguments.extend([
            OsString::from("--cookies"),
            file.path().as_os_str().to_owned(),
            OsString::from("--no-cookies-from-browser"),
        ]),
        #[cfg(feature = "e2e-automation")]
        DownloadCookies::AutomationBrowserProfile(profile) => arguments.extend([
            OsString::from("--no-cookies"),
            OsString::from("--cookies-from-browser"),
            profile.yt_dlp_argument(),
        ]),
    }
    arguments
}

fn add_progress_arguments(arguments: &mut Vec<OsString>) {
    arguments.extend([
        OsString::from("--progress"),
        OsString::from("--progress-delta"),
        OsString::from("0.2"),
        OsString::from("--progress-template"),
        OsString::from(
            "download:OSG_PROGRESS\t%(progress.status)s\t%(progress.downloaded_bytes)s\t%(progress.total_bytes)s\t%(progress.total_bytes_estimate)s\t%(progress.speed)s\t%(progress.eta)s",
        ),
        OsString::from("--progress-template"),
        OsString::from("postprocess:OSG_POSTPROCESS\t%(progress.status)s"),
    ]);
}
