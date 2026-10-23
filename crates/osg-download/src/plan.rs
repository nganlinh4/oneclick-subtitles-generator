mod arguments;

pub(crate) use arguments::inventory_arguments;

use crate::inventory::source_binding;
use crate::{
    DownloadDestination, DownloadError, MediaInventory, Result, SafeFileStem, SelectedFormat,
    SelectedSubtitle, ValidatedMediaUrl,
};
use serde::Serialize;
#[cfg(feature = "e2e-automation")]
use std::ffi::OsString;
use std::fmt;
#[cfg(feature = "e2e-automation")]
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserCookieSource {
    #[default]
    None,
    Chrome,
    Chromium,
    Edge,
    Firefox,
    Brave,
    Safari,
    Vivaldi,
    Opera,
    Whale,
}

impl BrowserCookieSource {
    fn yt_dlp_name(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Chrome => Some("chrome"),
            Self::Chromium => Some("chromium"),
            Self::Edge => Some("edge"),
            Self::Firefox => Some("firefox"),
            Self::Brave => Some("brave"),
            Self::Safari => Some("safari"),
            Self::Vivaldi => Some("vivaldi"),
            Self::Opera => Some("opera"),
            Self::Whale => Some("whale"),
        }
    }
}

#[cfg(feature = "e2e-automation")]
#[derive(Clone, PartialEq, Eq)]
pub struct AutomationCookieFile(PathBuf);

#[cfg(feature = "e2e-automation")]
impl AutomationCookieFile {
    pub fn new(path: &Path, fixture_root: &Path) -> Result<Self> {
        let root_status = std::fs::symlink_metadata(fixture_root)
            .map_err(|_| DownloadError::InvalidOption("automation fixture root is unavailable"))?;
        let file_status = std::fs::symlink_metadata(path)
            .map_err(|_| DownloadError::InvalidOption("automation cookie file is unavailable"))?;
        if root_status.file_type().is_symlink()
            || !root_status.is_dir()
            || file_status.file_type().is_symlink()
            || !file_status.is_file()
            || file_status.len() == 0
            || file_status.len() > 64 * 1024
        {
            return Err(DownloadError::InvalidOption(
                "automation cookie file is invalid",
            ));
        }
        let root = fixture_root
            .canonicalize()
            .map_err(|_| DownloadError::InvalidOption("automation fixture root is unavailable"))?;
        let input = root
            .join("input")
            .canonicalize()
            .map_err(|_| DownloadError::InvalidOption("automation fixture input is unavailable"))?;
        let file = path
            .canonicalize()
            .map_err(|_| DownloadError::InvalidOption("automation cookie file is unavailable"))?;
        if !input.starts_with(&root) || !file.starts_with(&input) || file == input {
            return Err(DownloadError::InvalidOption(
                "automation cookie file escaped its fixture input",
            ));
        }
        Ok(Self(file))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

#[cfg(feature = "e2e-automation")]
impl fmt::Debug for AutomationCookieFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AutomationCookieFile(<redacted>)")
    }
}

#[cfg(feature = "e2e-automation")]
#[derive(Clone, PartialEq, Eq)]
pub struct AutomationBrowserProfile {
    browser: BrowserCookieSource,
    path: PathBuf,
}

#[cfg(feature = "e2e-automation")]
impl AutomationBrowserProfile {
    pub fn new(browser: BrowserCookieSource, path: &Path, fixture_root: &Path) -> Result<Self> {
        if browser == BrowserCookieSource::None {
            return Err(DownloadError::InvalidOption(
                "automation browser profile has no browser",
            ));
        }
        let root_status = std::fs::symlink_metadata(fixture_root)
            .map_err(|_| DownloadError::InvalidOption("automation fixture root is unavailable"))?;
        let profile_status = std::fs::symlink_metadata(path).map_err(|_| {
            DownloadError::InvalidOption("automation browser profile is unavailable")
        })?;
        if root_status.file_type().is_symlink()
            || !root_status.is_dir()
            || profile_status.file_type().is_symlink()
            || !profile_status.is_dir()
        {
            return Err(DownloadError::InvalidOption(
                "automation browser profile is invalid",
            ));
        }
        let root = fixture_root
            .canonicalize()
            .map_err(|_| DownloadError::InvalidOption("automation fixture root is unavailable"))?;
        let input = root
            .join("input")
            .canonicalize()
            .map_err(|_| DownloadError::InvalidOption("automation fixture input is unavailable"))?;
        let profile = path.canonicalize().map_err(|_| {
            DownloadError::InvalidOption("automation browser profile is unavailable")
        })?;
        if !input.starts_with(&root) || !profile.starts_with(&input) || profile == input {
            return Err(DownloadError::InvalidOption(
                "automation browser profile escaped its fixture input",
            ));
        }
        Ok(Self {
            browser,
            path: profile,
        })
    }

    fn yt_dlp_argument(&self) -> OsString {
        let mut argument = OsString::from(
            self.browser
                .yt_dlp_name()
                .expect("automation browser profile is never none"),
        );
        argument.push(":");
        argument.push(self.path.as_os_str());
        argument
    }
}

#[cfg(feature = "e2e-automation")]
impl fmt::Debug for AutomationBrowserProfile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AutomationBrowserProfile")
            .field("browser", &self.browser)
            .field("path", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum DownloadCookies {
    #[default]
    None,
    Browser(BrowserCookieSource),
    #[cfg(feature = "e2e-automation")]
    AutomationFile(AutomationCookieFile),
    #[cfg(feature = "e2e-automation")]
    AutomationBrowserProfile(AutomationBrowserProfile),
}

impl From<BrowserCookieSource> for DownloadCookies {
    fn from(value: BrowserCookieSource) -> Self {
        if value == BrowserCookieSource::None {
            Self::None
        } else {
            Self::Browser(value)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct VideoHeight(u16);

impl VideoHeight {
    pub fn new(height: u16) -> Result<Self> {
        if (144..=4_320).contains(&height) {
            Ok(Self(height))
        } else {
            Err(DownloadError::InvalidOption(
                "video height must be between 144 and 4320",
            ))
        }
    }

    #[must_use]
    pub fn get(self) -> u16 {
        self.0
    }
}

#[derive(Clone, Debug)]
pub enum VideoQuality {
    Best,
    AtMost(VideoHeight),
    Exact(SelectedFormat),
}

#[derive(Clone, Debug)]
pub enum AudioQuality {
    Best,
    Exact(SelectedFormat),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioDownloadFormat {
    Mp3,
    M4a,
    Flac,
    Wav,
}

impl AudioDownloadFormat {
    pub(crate) fn extension(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
            Self::Flac => "flac",
            Self::Wav => "wav",
        }
    }
}

#[derive(Clone, Debug)]
pub enum MediaSelection {
    Video {
        quality: VideoQuality,
    },
    Audio {
        quality: AudioQuality,
        format: AudioDownloadFormat,
    },
}

#[derive(Clone, Debug, Default)]
pub enum SubtitleSelection {
    #[default]
    None,
    Selected(SelectedSubtitle),
}

/// Fully validated native download request. It owns capabilities rather than
/// accepting paths, selectors, or command arguments from serialized input.
#[derive(Clone)]
pub struct DownloadPlan {
    url: ValidatedMediaUrl,
    binding: [u8; 32],
    title: SafeFileStem,
    duration_seconds: Option<u64>,
    destination: DownloadDestination,
    media: MediaSelection,
    subtitle: SubtitleSelection,
    cookies: DownloadCookies,
    direct_mp4_format_id: Option<String>,
}

impl DownloadPlan {
    pub fn new(
        url: ValidatedMediaUrl,
        inventory: &MediaInventory,
        destination: DownloadDestination,
        media: MediaSelection,
        subtitle: SubtitleSelection,
        cookies: impl Into<DownloadCookies>,
    ) -> Result<Self> {
        let binding = source_binding(&url);
        if inventory.binding() != binding {
            return Err(DownloadError::FormatMismatch);
        }
        match &media {
            MediaSelection::Video {
                quality: VideoQuality::Exact(selected),
            } => {
                if selected.binding() != binding || selected.is_audio() {
                    return Err(DownloadError::FormatMismatch);
                }
            }
            MediaSelection::Audio {
                quality: AudioQuality::Exact(selected),
                ..
            } if selected.binding() != binding || !selected.is_audio() => {
                return Err(DownloadError::FormatMismatch);
            }
            _ => {}
        }
        if let SubtitleSelection::Selected(selected) = &subtitle
            && selected.binding() != binding
        {
            return Err(DownloadError::SubtitleMismatch);
        }
        let direct_mp4_format_id = inventory.direct_mp4_format_id();
        if direct_mp4_format_id.is_some()
            && matches!(
                &media,
                MediaSelection::Video {
                    quality: VideoQuality::AtMost(_)
                }
            )
        {
            return Err(DownloadError::InvalidOption(
                "direct media has no bounded video height",
            ));
        }
        if let Some(direct_format_id) = direct_mp4_format_id {
            match &media {
                MediaSelection::Video {
                    quality: VideoQuality::Exact(selected),
                } if selected.format_id() != direct_format_id => {
                    return Err(DownloadError::FormatMismatch);
                }
                MediaSelection::Audio {
                    quality: AudioQuality::Exact(_),
                    ..
                } => return Err(DownloadError::FormatMismatch),
                _ => {}
            }
        }

        Ok(Self {
            url,
            binding,
            title: inventory.title.clone(),
            duration_seconds: inventory.duration_seconds,
            destination,
            media,
            subtitle,
            cookies: cookies.into(),
            direct_mp4_format_id: direct_mp4_format_id.map(str::to_owned),
        })
    }

    pub(crate) fn url(&self) -> &ValidatedMediaUrl {
        &self.url
    }

    pub(crate) fn destination(&self) -> &DownloadDestination {
        &self.destination
    }

    pub(crate) fn title(&self) -> &SafeFileStem {
        &self.title
    }

    pub(crate) fn duration_seconds(&self) -> Option<u64> {
        self.duration_seconds
    }

    pub(crate) fn media_extension(&self) -> &'static str {
        match self.media {
            MediaSelection::Video { .. } => "mp4",
            MediaSelection::Audio { format, .. } => format.extension(),
        }
    }

    pub(crate) fn selected_subtitle(&self) -> Option<&SelectedSubtitle> {
        match &self.subtitle {
            SubtitleSelection::None => None,
            SubtitleSelection::Selected(selected) => Some(selected),
        }
    }
}

impl fmt::Debug for DownloadPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DownloadPlan")
            .field("url", &self.url)
            .field("title", &self.title)
            .field("duration_seconds", &self.duration_seconds)
            .field("destination", &self.destination)
            .field("media", &self.media)
            .field("subtitle", &self.subtitle)
            .field("cookies", &self.cookies)
            .field("direct_mp4_format_id", &self.direct_mp4_format_id)
            .field("binding", &"<redacted>")
            .finish()
    }
}

#[cfg(test)]
mod tests;
