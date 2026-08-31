use crate::inventory::source_binding;
use crate::{
    DownloadDestination, DownloadError, FfmpegDirectory, MediaInventory, Result, SafeFileStem,
    SelectedFormat, SelectedSubtitle, SubtitleSource, ValidatedMediaUrl,
};
use serde::Serialize;
use std::ffi::OsString;
use std::fmt;
use std::path::Path;
#[cfg(feature = "e2e-automation")]
use std::path::PathBuf;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AddressResolver, SubtitleSource, UrlPolicy, UrlValidator};
    use std::io;
    use std::net::{IpAddr, Ipv4Addr};

    #[derive(Clone, Debug)]
    struct PublicDns;

    impl AddressResolver for PublicDns {
        fn resolve(&self, _host: &str, _port: u16) -> io::Result<Vec<IpAddr>> {
            Ok(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))])
        }
    }

    fn inspected() -> (ValidatedMediaUrl, MediaInventory) {
        let url = UrlValidator::new(PublicDns, UrlPolicy::SupportedSitesOnly)
            .validate("https://youtube.com/watch?v=x;$(hostile)")
            .unwrap();
        let json = br#"{"title":"clip","formats":[{"format_id":"137","height":1080,"vcodec":"h264","acodec":"none"},{"format_id":"140","vcodec":"none","acodec":"aac"}],"subtitles":{"en":[{"ext":"vtt"}]}}"#;
        let inventory = MediaInventory::from_json(&url, json).unwrap();
        (url, inventory)
    }

    #[cfg(feature = "e2e-automation")]
    #[test]
    fn automation_cookie_file_is_input_bounded_and_path_redacted() {
        let root = tempfile::tempdir().expect("fixture root");
        let input = root.path().join("input");
        std::fs::create_dir(&input).expect("fixture input");
        let cookie = input.join("cookies.txt");
        std::fs::write(&cookie, b"# Netscape HTTP Cookie File\n").expect("cookie fixture");
        let authority = AutomationCookieFile::new(&cookie, root.path()).expect("cookie authority");
        let debug = format!("{authority:?}");
        assert!(!debug.contains(root.path().to_string_lossy().as_ref()));
        assert!(debug.contains("redacted"));

        let (url, _) = inspected();
        let arguments = inventory_arguments(&url, DownloadCookies::AutomationFile(authority));
        let cookie_index = arguments
            .iter()
            .position(|argument| argument == "--cookies")
            .expect("cookie-file argument");
        assert_eq!(arguments[cookie_index + 1], cookie.canonicalize().unwrap());
        assert!(
            arguments
                .iter()
                .any(|argument| argument == "--no-cookies-from-browser")
        );

        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, b"# Netscape HTTP Cookie File\n").expect("outside fixture");
        assert!(AutomationCookieFile::new(&outside, root.path()).is_err());
    }

    #[cfg(feature = "e2e-automation")]
    #[test]
    fn automation_browser_profile_is_input_bounded_and_path_redacted() {
        let root = tempfile::tempdir().expect("fixture root");
        let input = root.path().join("input");
        let profile = input.join("browser-profile").join("Default");
        std::fs::create_dir_all(&profile).expect("browser profile");
        let authority =
            AutomationBrowserProfile::new(BrowserCookieSource::Chrome, &profile, root.path())
                .expect("browser authority");
        let debug = format!("{authority:?}");
        assert!(!debug.contains(root.path().to_string_lossy().as_ref()));
        assert!(debug.contains("redacted"));

        let (url, _) = inspected();
        let arguments =
            inventory_arguments(&url, DownloadCookies::AutomationBrowserProfile(authority));
        let browser_index = arguments
            .iter()
            .position(|argument| argument == "--cookies-from-browser")
            .expect("browser-profile argument");
        let mut expected = OsString::from("chrome:");
        expected.push(profile.canonicalize().unwrap());
        assert_eq!(arguments[browser_index + 1], expected);
        assert!(arguments.iter().any(|argument| argument == "--no-cookies"));

        let outside = root.path().join("outside-profile");
        std::fs::create_dir(&outside).expect("outside profile");
        assert!(
            AutomationBrowserProfile::new(BrowserCookieSource::Chrome, &outside, root.path(),)
                .is_err()
        );
    }

    fn direct_mp4() -> (ValidatedMediaUrl, MediaInventory) {
        let url = UrlValidator::new(PublicDns, UrlPolicy::SupportedSitesOnly)
            .validate(
                "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/\
                 osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
            )
            .unwrap();
        let inventory = MediaInventory::from_json(
            &url,
            br#"{"title":"direct","direct":true,"_type":"video","format_id":"0","ext":"unknown_video"}"#,
        )
        .unwrap();
        (url, inventory)
    }

    #[test]
    fn hostile_url_is_one_final_argument_after_separator() {
        let (url, _) = inspected();
        let arguments = inventory_arguments(&url, BrowserCookieSource::None);
        assert_eq!(arguments[arguments.len() - 2], "--");
        assert_eq!(arguments.last().unwrap(), url.as_str());
        assert_eq!(
            arguments
                .iter()
                .filter(|argument| argument.to_string_lossy().contains("$(hostile)"))
                .count(),
            1
        );
    }

    #[test]
    fn browser_cookie_source_can_only_emit_a_closed_browser_name() {
        let (url, _) = inspected();
        let arguments = inventory_arguments(&url, BrowserCookieSource::Chrome);
        let cookie_index = arguments
            .iter()
            .position(|argument| argument == "--cookies-from-browser")
            .unwrap();
        assert_eq!(arguments[cookie_index + 1], "chrome");
        assert!(!arguments[cookie_index + 1].to_string_lossy().contains(':'));

        let without_cookies = inventory_arguments(&url, BrowserCookieSource::None);
        assert!(
            without_cookies
                .iter()
                .any(|argument| argument == "--no-cookies")
        );
        assert!(
            without_cookies
                .iter()
                .any(|argument| argument == "--no-cookies-from-browser")
        );
    }

    #[test]
    fn every_network_operation_uses_bounded_paced_retries() {
        let (url, _) = inspected();
        let arguments = inventory_arguments(&url, BrowserCookieSource::None);
        let values_after = |name: &str| {
            arguments
                .iter()
                .enumerate()
                .filter(|(_, argument)| *argument == name)
                .map(|(index, _)| arguments[index + 1].to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };

        assert_eq!(values_after("--retries"), ["10"]);
        assert_eq!(values_after("--fragment-retries"), ["10"]);
        assert_eq!(values_after("--extractor-retries"), ["5"]);
        assert_eq!(
            values_after("--retry-sleep"),
            ["http:exp=1:16", "fragment:exp=1:16", "extractor:exp=1:16",]
        );
    }

    #[test]
    fn plan_rejects_capabilities_from_another_inventory() {
        let (url, inventory) = inspected();
        let other_url = UrlValidator::new(PublicDns, UrlPolicy::SupportedSitesOnly)
            .validate("https://youtube.com/watch?v=other")
            .unwrap();
        let other = MediaInventory::from_json(
            &other_url,
            br#"{"formats":[{"format_id":"137","height":1080,"vcodec":"h264","acodec":"none"}]}"#,
        )
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let destination =
            DownloadDestination::from_native_directory(directory.path(), "clip").unwrap();
        let error = DownloadPlan::new(
            url,
            &inventory,
            destination,
            MediaSelection::Video {
                quality: VideoQuality::Exact(other.select_format("137").unwrap()),
            },
            SubtitleSelection::None,
            BrowserCookieSource::None,
        )
        .unwrap_err();
        assert!(matches!(error, DownloadError::FormatMismatch));
    }

    #[test]
    fn direct_mp4_plan_forces_exact_output_and_omits_byte_mutating_remux() {
        let (url, inventory) = direct_mp4();
        let output = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        let plan = DownloadPlan::new(
            url,
            &inventory,
            DownloadDestination::from_native_directory(output.path(), "direct").unwrap(),
            MediaSelection::Video {
                quality: VideoQuality::Best,
            },
            SubtitleSelection::None,
            BrowserCookieSource::None,
        )
        .unwrap();
        let ffmpeg = FfmpegDirectory::from_executable(&std::env::current_exe().unwrap()).unwrap();
        let arguments = plan.arguments(staging.path(), Some(&ffmpeg)).unwrap();
        let output_index = arguments
            .iter()
            .position(|argument| argument == "--output")
            .unwrap();
        assert_eq!(
            arguments[output_index + 1],
            staging.path().join("media.mp4")
        );
        let format_index = arguments
            .iter()
            .position(|argument| argument == "--format")
            .unwrap();
        assert_eq!(arguments[format_index + 1], "0");
        assert!(!arguments.iter().any(|argument| argument == "--remux-video"));
        let fixup_index = arguments
            .iter()
            .position(|argument| argument == "--fixup")
            .unwrap();
        assert_eq!(arguments[fixup_index + 1], "never");
        assert!(
            !arguments
                .iter()
                .any(|argument| argument == "--merge-output-format")
        );
        assert!(
            !arguments
                .iter()
                .any(|argument| argument.to_string_lossy().contains("%(ext)s"))
        );
    }

    #[test]
    fn direct_mp4_exact_selection_must_match_and_uses_the_inspected_id() {
        let (url, inventory) = direct_mp4();
        let selected = inventory.select_format("0").unwrap();
        let output = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        let plan = DownloadPlan::new(
            url,
            &inventory,
            DownloadDestination::from_native_directory(output.path(), "direct").unwrap(),
            MediaSelection::Video {
                quality: VideoQuality::Exact(selected),
            },
            SubtitleSelection::None,
            BrowserCookieSource::None,
        )
        .unwrap();
        let ffmpeg = FfmpegDirectory::from_executable(&std::env::current_exe().unwrap()).unwrap();
        let arguments = plan.arguments(staging.path(), Some(&ffmpeg)).unwrap();
        let format_index = arguments
            .iter()
            .position(|argument| argument == "--format")
            .unwrap();
        assert_eq!(arguments[format_index + 1], "0");

        let (url, direct_inventory) = direct_mp4();
        let other_inventory = MediaInventory::from_json(
            &url,
            br#"{"formats":[{"format_id":"other","vcodec":"h264","acodec":"aac"}]}"#,
        )
        .unwrap();
        let destination = tempfile::tempdir().unwrap();
        let mismatch = DownloadPlan::new(
            url.clone(),
            &direct_inventory,
            DownloadDestination::from_native_directory(destination.path(), "direct").unwrap(),
            MediaSelection::Video {
                quality: VideoQuality::Exact(other_inventory.select_format("other").unwrap()),
            },
            SubtitleSelection::None,
            BrowserCookieSource::None,
        )
        .unwrap_err();
        assert!(matches!(mismatch, DownloadError::FormatMismatch));

        let audio_inventory = MediaInventory::from_json(
            &url,
            br#"{"formats":[{"format_id":"audio","vcodec":"none","acodec":"aac"}]}"#,
        )
        .unwrap();
        let destination = tempfile::tempdir().unwrap();
        let mismatch = DownloadPlan::new(
            url,
            &direct_inventory,
            DownloadDestination::from_native_directory(destination.path(), "direct").unwrap(),
            MediaSelection::Audio {
                quality: AudioQuality::Exact(audio_inventory.select_format("audio").unwrap()),
                format: AudioDownloadFormat::Mp3,
            },
            SubtitleSelection::None,
            BrowserCookieSource::None,
        )
        .unwrap_err();
        assert!(matches!(mismatch, DownloadError::FormatMismatch));
    }

    #[test]
    fn direct_mp4_rejects_height_selection_that_inventory_cannot_prove() {
        let (url, inventory) = direct_mp4();
        let output = tempfile::tempdir().unwrap();
        let error = DownloadPlan::new(
            url,
            &inventory,
            DownloadDestination::from_native_directory(output.path(), "direct").unwrap(),
            MediaSelection::Video {
                quality: VideoQuality::AtMost(VideoHeight::new(360).unwrap()),
            },
            SubtitleSelection::None,
            BrowserCookieSource::None,
        )
        .unwrap_err();
        assert!(matches!(error, DownloadError::InvalidOption(_)));
    }

    #[test]
    fn subtitle_capability_is_selected_from_inventory() {
        let (_, inventory) = inspected();
        let subtitle = inventory
            .select_subtitle("en", SubtitleSource::Manual)
            .unwrap();
        assert_eq!(subtitle.language(), "en");
    }
}
