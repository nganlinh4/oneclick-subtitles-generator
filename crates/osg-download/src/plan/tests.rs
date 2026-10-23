use super::*;
use crate::{AddressResolver, FfmpegDirectory, SubtitleSource, UrlPolicy, UrlValidator};
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
    let arguments = inventory_arguments(&url, DownloadCookies::AutomationBrowserProfile(authority));
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
        AutomationBrowserProfile::new(BrowserCookieSource::Chrome, &outside, root.path(),).is_err()
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
    let destination = DownloadDestination::from_native_directory(directory.path(), "clip").unwrap();
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
