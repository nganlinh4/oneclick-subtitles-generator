use super::*;
use crate::process::test_support::mock_binary;
use crate::{
    AddressResolver, AudioDownloadFormat, AudioQuality, BrowserCookieSource, DownloadDestination,
    JsRuntimeResolver, JsRuntimeSearch, MediaSelection, SubtitleSelection, SubtitleSource,
    VideoQuality,
};
use std::io;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[derive(Clone, Debug)]
struct PublicDns;

impl AddressResolver for PublicDns {
    fn resolve(&self, _host: &str, _port: u16) -> io::Result<Vec<IpAddr>> {
        Ok(vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))])
    }
}

#[test]
fn process_failure_classification_is_closed_and_actionable() {
    for (stderr, expected) in [
        (
            "ERROR: Sign in to confirm you are not a bot",
            ProcessFailureKind::AuthenticationRequired,
        ),
        (
            "ERROR: HTTP Error 429: Too Many Requests",
            ProcessFailureKind::RateLimited,
        ),
        (
            "ERROR: Requested format is not available",
            ProcessFailureKind::FormatUnavailable,
        ),
        (
            "ERROR: This video is unavailable",
            ProcessFailureKind::SourceUnavailable,
        ),
        (
            "ERROR: ffmpeg exited with code 1",
            ProcessFailureKind::PostProcessing,
        ),
        (
            "ERROR: unable to download video data: HTTP Error 403",
            ProcessFailureKind::Network,
        ),
        (
            "WARNING: signature solving failed; no video formats found",
            ProcessFailureKind::Extractor,
        ),
        ("ERROR: opaque future failure", ProcessFailureKind::Unknown),
    ] {
        assert_eq!(classify_process_failure(stderr.as_bytes()), expected);
    }
}

#[test]
fn process_failure_kind_never_retains_raw_downloader_text() {
    let private = "ERROR: unable to download https://private.example/token to C:/Users/me";
    let kind = classify_process_failure(private.as_bytes());
    let debug = format!("{kind:?}");
    assert_eq!(kind, ProcessFailureKind::Network);
    assert!(!debug.contains("private"));
    assert!(!debug.contains("Users"));
}

fn engine(ffmpeg_directory: &tempfile::TempDir) -> DownloadEngine<PublicDns> {
    let mock = mock_binary();
    let ffmpeg_path = ffmpeg_directory.path().join(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    });
    fs::copy(mock.path(), &ffmpeg_path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&ffmpeg_path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    DownloadEngine::new(
        mock,
        UrlValidator::new(PublicDns, UrlPolicy::SupportedSitesOnly),
    )
    .with_ffmpeg(FfmpegDirectory::new(ffmpeg_directory.path()).unwrap())
}

#[test]
fn configured_js_runtime_is_one_native_only_argument() {
    let ffmpeg = tempfile::tempdir().unwrap();
    let runtime_directory = tempfile::tempdir().unwrap();
    let runtime_path =
        runtime_directory
            .path()
            .join(if cfg!(windows) { "deno.exe" } else { "deno" });
    fs::copy(mock_binary().path(), &runtime_path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&runtime_path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let runtime =
        JsRuntimeResolver::new(JsRuntimeSearch::default().configured(runtime_path.clone()))
            .resolve()
            .unwrap();
    let engine = engine(&ffmpeg).with_js_runtime(runtime);
    let control = RunControl::new(Duration::from_secs(5)).unwrap();
    assert_eq!(
        engine
            .javascript_runtime_version(&control)
            .unwrap()
            .as_str(),
        "2.9.5"
    );
    let arguments = engine.with_js_runtime_arguments(vec![OsString::from("--version")]);

    assert_eq!(arguments[0], "--js-runtimes");
    let mut expected = OsString::from("deno:");
    expected.push(fs::canonicalize(runtime_path).unwrap());
    assert_eq!(arguments[1], expected);
    assert_eq!(arguments[2], "--version");
    assert!(!format!("{engine:?}").contains(runtime_directory.path().to_string_lossy().as_ref()));
}

#[test]
fn javascript_runtime_version_rejects_old_or_hostile_output() {
    assert!(matches!(
        parse_deno_version(b"deno 2.2.9\nv8 0\n"),
        Err(DownloadError::InvalidJavaScriptRuntime(_))
    ));
    assert!(matches!(
        parse_deno_version(b"2.9.5\n"),
        Err(DownloadError::InvalidJavaScriptRuntime(_))
    ));
    assert_eq!(
        parse_deno_version(b"deno 3.0.0 (stable, release)\n")
            .unwrap()
            .as_str(),
        "3.0.0"
    );
}

#[test]
fn mock_inventory_and_version_need_no_installed_ytdlp() {
    let ffmpeg = tempfile::tempdir().unwrap();
    let engine = engine(&ffmpeg);
    let control = RunControl::new(Duration::from_secs(5)).unwrap();
    assert_eq!(engine.version(&control).unwrap().as_str(), "2026.08.10");
    let url = engine
        .validate_url("https://youtube.com/watch?v=fixture")
        .unwrap();
    let inventory = engine
        .inspect(&url, BrowserCookieSource::None, &control)
        .unwrap();
    assert_eq!(inventory.formats.video.len(), 1);
    assert_eq!(inventory.formats.audio.len(), 1);
    assert_eq!(inventory.title.as_str(), "Mock _ title");
}

#[test]
fn publishes_media_and_selected_subtitle_without_clobbering() {
    let ffmpeg = tempfile::tempdir().unwrap();
    let engine = engine(&ffmpeg);
    let control = RunControl::new(Duration::from_secs(5)).unwrap();
    let url = engine
        .validate_url("https://youtube.com/watch?v=fixture")
        .unwrap();
    let inventory = engine
        .inspect(&url, BrowserCookieSource::None, &control)
        .unwrap();
    let output = tempfile::tempdir().unwrap();
    let destination =
        DownloadDestination::from_native_directory(output.path(), "My / clip").unwrap();
    let subtitle = inventory
        .select_subtitle("en", SubtitleSource::Manual)
        .unwrap();
    let plan = DownloadPlan::new(
        url,
        &inventory,
        destination,
        MediaSelection::Video {
            quality: VideoQuality::Best,
        },
        SubtitleSelection::Selected(subtitle),
        BrowserCookieSource::None,
    )
    .unwrap();
    let plan_debug = format!("{plan:?}");
    assert!(!plan_debug.contains("fixture"));
    assert!(!plan_debug.contains(output.path().to_string_lossy().as_ref()));
    let result = engine.download(&plan, &control).unwrap();
    assert_eq!(fs::read(result.media_path()).unwrap(), b"mock-media");
    assert!(result.subtitle_path().unwrap().is_file());
    assert_eq!(result.summary().media_filename, "My _ clip.mp4");
    assert!(!format!("{result:?}").contains(output.path().to_string_lossy().as_ref()));
    assert_eq!(fs::read_dir(output.path()).unwrap().count(), 2);

    let error = engine.download(&plan, &control).unwrap_err();
    assert!(matches!(error, DownloadError::OutputExists));
    assert_eq!(fs::read(result.media_path()).unwrap(), b"mock-media");
}

#[test]
fn direct_mp4_process_preserves_source_bytes_without_remux() {
    let ffmpeg = tempfile::tempdir().unwrap();
    let engine = engine(&ffmpeg);
    let control = RunControl::new(Duration::from_secs(5)).unwrap();
    let url = engine
        .validate_url(
            "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/\
             osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        )
        .unwrap();
    let inventory = engine
        .inspect(&url, BrowserCookieSource::None, &control)
        .unwrap();
    assert_eq!(inventory.direct_mp4_format_id(), Some("0"));
    let output = tempfile::tempdir().unwrap();
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
    let result = engine.download(&plan, &control).unwrap();
    assert_eq!(fs::read(result.media_path()).unwrap(), b"mock-direct-media");
    assert_eq!(result.summary().media_filename, "direct.mp4");
}

#[test]
fn direct_mp4_audio_uses_the_inspected_format_before_native_extraction() {
    let ffmpeg = tempfile::tempdir().unwrap();
    let engine = engine(&ffmpeg);
    let control = RunControl::new(Duration::from_secs(5)).unwrap();
    let url = engine
        .validate_url(
            "https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/\
             osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4",
        )
        .unwrap();
    let inventory = engine
        .inspect(&url, BrowserCookieSource::None, &control)
        .unwrap();
    let output = tempfile::tempdir().unwrap();
    let plan = DownloadPlan::new(
        url,
        &inventory,
        DownloadDestination::from_native_directory(output.path(), "direct-audio").unwrap(),
        MediaSelection::Audio {
            quality: AudioQuality::Best,
            format: AudioDownloadFormat::Mp3,
        },
        SubtitleSelection::None,
        BrowserCookieSource::None,
    )
    .unwrap();
    let result = engine.download(&plan, &control).unwrap();
    assert_eq!(fs::read(result.media_path()).unwrap(), b"mock-direct-audio");
    assert_eq!(result.summary().media_filename, "direct-audio.mp3");
}

#[test]
fn publishes_typed_audio_selection() {
    let ffmpeg = tempfile::tempdir().unwrap();
    let engine = engine(&ffmpeg);
    let control = RunControl::new(Duration::from_secs(5)).unwrap();
    let url = engine
        .validate_url("https://youtube.com/watch?v=audio")
        .unwrap();
    let inventory = engine
        .inspect(&url, BrowserCookieSource::None, &control)
        .unwrap();
    let selected = inventory.select_format("140").unwrap();
    let output = tempfile::tempdir().unwrap();
    let plan = DownloadPlan::new(
        url,
        &inventory,
        DownloadDestination::from_native_directory(output.path(), "audio").unwrap(),
        MediaSelection::Audio {
            quality: AudioQuality::Exact(selected),
            format: AudioDownloadFormat::Mp3,
        },
        SubtitleSelection::None,
        BrowserCookieSource::None,
    )
    .unwrap();
    let result = engine.download(&plan, &control).unwrap();
    assert_eq!(result.summary().media_filename, "audio.mp3");
    assert_eq!(fs::read(result.media_path()).unwrap(), b"mock-media");
}

#[derive(Clone, Debug)]
struct RebindingDns(Arc<AtomicUsize>);

impl AddressResolver for RebindingDns {
    fn resolve(&self, _host: &str, _port: u16) -> io::Result<Vec<IpAddr>> {
        let call = self.0.fetch_add(1, Ordering::SeqCst);
        Ok(vec![if call == 0 {
            IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))
        } else {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        }])
    }
}

#[test]
fn dns_is_revalidated_immediately_before_launch() {
    let engine = DownloadEngine::new(
        mock_binary(),
        UrlValidator::new(
            RebindingDns(Arc::new(AtomicUsize::new(0))),
            UrlPolicy::SupportedSitesOnly,
        ),
    );
    let url = engine
        .validate_url("https://youtube.com/watch?v=rebind")
        .unwrap();
    let control = RunControl::new(Duration::from_secs(5)).unwrap();
    assert!(matches!(
        engine.inspect(&url, BrowserCookieSource::None, &control),
        Err(DownloadError::NonPublicAddress)
    ));
}
