use crate::plan::inventory_arguments;
use crate::process::{
    DOWNLOAD_STDOUT_LIMIT, INVENTORY_STDOUT_LIMIT, ProcessOutput, ProcessRequest, run,
};
use crate::{
    AddressResolver, BrowserCookieSource, DownloadError, DownloadPlan, FfmpegDirectory,
    MediaInventory, ResolvedJsRuntime, ResolvedYtDlp, Result, RunControl, SystemResolver,
    UrlPolicy, UrlValidator, ValidatedMediaUrl, YtDlpResolver, YtDlpSearch,
};
use serde::Serialize;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

const VERSION_STDOUT_LIMIT: usize = 64 * 1024;
const MINIMUM_DENO_MAJOR: u64 = 2;
const MINIMUM_DENO_MINOR: u64 = 3;

#[derive(Clone)]
pub struct DownloadEngine<R = SystemResolver> {
    binary: ResolvedYtDlp,
    validator: UrlValidator<R>,
    ffmpeg: Option<FfmpegDirectory>,
    js_runtime: Option<ResolvedJsRuntime>,
}

impl DownloadEngine<SystemResolver> {
    pub fn resolve(search: YtDlpSearch, policy: UrlPolicy) -> Result<Self> {
        Ok(Self::new(
            YtDlpResolver::new(search).resolve()?,
            UrlValidator::system(policy),
        ))
    }
}

impl<R: AddressResolver> DownloadEngine<R> {
    #[must_use]
    pub fn new(binary: ResolvedYtDlp, validator: UrlValidator<R>) -> Self {
        Self {
            binary,
            validator,
            ffmpeg: None,
            js_runtime: None,
        }
    }

    #[must_use]
    pub fn with_ffmpeg(mut self, ffmpeg: FfmpegDirectory) -> Self {
        self.ffmpeg = Some(ffmpeg);
        self
    }

    #[must_use]
    pub fn with_js_runtime(mut self, runtime: ResolvedJsRuntime) -> Self {
        self.js_runtime = Some(runtime);
        self
    }

    pub fn validate_url(&self, value: &str) -> Result<ValidatedMediaUrl> {
        self.validator.validate(value)
    }

    pub fn version(&self, control: &RunControl) -> Result<ToolVersion> {
        let output = run(ProcessRequest {
            binary: self.binary.path(),
            arguments: vec![
                OsString::from("--ignore-config"),
                OsString::from("--version"),
            ],
            control,
            stdout_limit: VERSION_STDOUT_LIMIT,
        })?;
        require_success(&output)?;
        let line = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_owned();
        if line.is_empty()
            || line.len() > 64
            || !line
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        {
            return Err(DownloadError::InvalidInventory(
                "yt-dlp returned an invalid version",
            ));
        }
        Ok(ToolVersion(line))
    }

    /// Verifies that the configured native `Deno` capability is executable and
    /// new enough for `yt-dlp`'s external JavaScript challenge solver.
    pub fn javascript_runtime_version(&self, control: &RunControl) -> Result<ToolVersion> {
        let runtime = self
            .js_runtime
            .as_ref()
            .ok_or(DownloadError::JavaScriptRuntimeNotFound)?;
        let output = run(ProcessRequest {
            binary: runtime.path(),
            arguments: vec![OsString::from("--version")],
            control,
            stdout_limit: VERSION_STDOUT_LIMIT,
        })?;
        require_success(&output)?;
        parse_deno_version(&output.stdout)
    }

    pub fn inspect(
        &self,
        url: &ValidatedMediaUrl,
        cookies: BrowserCookieSource,
        control: &RunControl,
    ) -> Result<MediaInventory> {
        self.validator.revalidate(url)?;
        let arguments = self.with_js_runtime_arguments(inventory_arguments(url, cookies));
        let output = run(ProcessRequest {
            binary: self.binary.path(),
            arguments,
            control,
            stdout_limit: INVENTORY_STDOUT_LIMIT,
        })?;
        require_success(&output)?;
        MediaInventory::from_json(url, &output.stdout)
    }

    pub fn download(&self, plan: &DownloadPlan, control: &RunControl) -> Result<DownloadResult> {
        self.validator.revalidate(plan.url())?;
        let media_path = plan.destination().output_path(plan.media_extension());
        let subtitle_path = plan
            .selected_subtitle()
            .map(|subtitle| plan.destination().subtitle_path(subtitle.language()));
        ensure_absent(&media_path)?;
        if let Some(path) = &subtitle_path {
            ensure_absent(path)?;
        }

        let staging = tempfile::Builder::new()
            .prefix(".osg-download-")
            .tempdir_in(plan.destination().directory())
            .map_err(DownloadError::Publish)?;
        let arguments =
            self.with_js_runtime_arguments(plan.arguments(staging.path(), self.ffmpeg.as_ref())?);
        let output = run(ProcessRequest {
            binary: self.binary.path(),
            arguments,
            control,
            stdout_limit: DOWNLOAD_STDOUT_LIMIT,
        })?;
        require_success(&output)?;

        let media_source = staging
            .path()
            .join(format!("media.{}", plan.media_extension()));
        let media_bytes = verify_artifact(&media_source)?;
        let subtitle_source = plan.selected_subtitle().map(|subtitle| {
            staging
                .path()
                .join(format!("media.{}.srt", subtitle.language()))
        });
        let subtitle_bytes = subtitle_source
            .as_deref()
            .map(verify_artifact)
            .transpose()?;

        // Repeat after the potentially long-running child to close the race
        // between the early no-clobber check and publication.
        ensure_absent(&media_path)?;
        if let Some(path) = &subtitle_path {
            ensure_absent(path)?;
        }

        publish_noclobber(&media_source, &media_path)?;
        if let (Some(source), Some(destination)) = (&subtitle_source, &subtitle_path)
            && let Err(error) = publish_noclobber(source, destination)
        {
            let _ = fs::remove_file(&media_path);
            return Err(error);
        }

        let media_filename = plan
            .destination()
            .stem()
            .with_extension(plan.media_extension())
            .to_string_lossy()
            .into_owned();
        let subtitle_filename = plan.selected_subtitle().map(|subtitle| {
            format!(
                "{}.{}.srt",
                plan.destination().stem().as_str(),
                subtitle.language()
            )
        });
        Ok(DownloadResult {
            summary: DownloadSummary {
                title: plan.title().clone(),
                duration_seconds: plan.duration_seconds(),
                media_filename,
                media_bytes,
                subtitle_filename,
                subtitle_bytes,
                subtitle_language: plan
                    .selected_subtitle()
                    .map(|subtitle| subtitle.language().to_owned()),
            },
            media_path,
            subtitle_path,
        })
    }

    fn with_js_runtime_arguments(&self, arguments: Vec<OsString>) -> Vec<OsString> {
        let Some(runtime) = &self.js_runtime else {
            return arguments;
        };
        let mut runtime_value = OsString::from("deno:");
        runtime_value.push(runtime.path().as_os_str());
        let mut result = Vec::with_capacity(arguments.len() + 2);
        result.push(OsString::from("--js-runtimes"));
        result.push(runtime_value);
        result.extend(arguments);
        result
    }
}

fn parse_deno_version(stdout: &[u8]) -> Result<ToolVersion> {
    let output = String::from_utf8_lossy(stdout);
    let line = output.lines().next().unwrap_or_default().trim();
    let mut fields = line.split_ascii_whitespace();
    if fields.next() != Some("deno") {
        return Err(DownloadError::InvalidJavaScriptRuntime(
            "version output is invalid",
        ));
    }
    let version = fields
        .next()
        .ok_or(DownloadError::InvalidJavaScriptRuntime(
            "version output is invalid",
        ))?;
    if version.len() > 32
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        return Err(DownloadError::InvalidJavaScriptRuntime(
            "version output is invalid",
        ));
    }
    let components = version
        .split('.')
        .map(str::parse::<u64>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| DownloadError::InvalidJavaScriptRuntime("version output is invalid"))?;
    if components.len() != 3
        || components[0] < MINIMUM_DENO_MAJOR
        || (components[0] == MINIMUM_DENO_MAJOR && components[1] < MINIMUM_DENO_MINOR)
    {
        return Err(DownloadError::InvalidJavaScriptRuntime(
            "version is unsupported",
        ));
    }
    Ok(ToolVersion(version.to_owned()))
}

impl<R: AddressResolver> fmt::Debug for DownloadEngine<R> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DownloadEngine")
            .field("binary", &self.binary)
            .field("validator", &self.validator)
            .field("ffmpeg", &self.ffmpeg)
            .field("js_runtime", &self.js_runtime)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ToolVersion(String);

impl ToolVersion {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSummary {
    pub title: crate::SafeFileStem,
    pub duration_seconds: Option<u64>,
    pub media_filename: String,
    pub media_bytes: u64,
    pub subtitle_filename: Option<String>,
    pub subtitle_bytes: Option<u64>,
    pub subtitle_language: Option<String>,
}

pub struct DownloadResult {
    summary: DownloadSummary,
    media_path: PathBuf,
    subtitle_path: Option<PathBuf>,
}

impl DownloadResult {
    #[must_use]
    pub fn summary(&self) -> &DownloadSummary {
        &self.summary
    }

    #[must_use]
    pub fn media_path(&self) -> &Path {
        &self.media_path
    }

    #[must_use]
    pub fn subtitle_path(&self) -> Option<&Path> {
        self.subtitle_path.as_deref()
    }
}

impl fmt::Debug for DownloadResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DownloadResult")
            .field("summary", &self.summary)
            .field("media_path", &"<redacted>")
            .field(
                "subtitle_path",
                &self.subtitle_path.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

fn require_success(output: &ProcessOutput) -> Result<()> {
    let _bounded_diagnostic_bytes = output.stderr_tail.len();
    if output.stdout_truncated {
        return Err(DownloadError::OutputLimit);
    }
    if !output.status.success() {
        return Err(DownloadError::ProcessFailed {
            code: output.status.code(),
        });
    }
    Ok(())
}

fn verify_artifact(path: &Path) -> Result<u64> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DownloadError::MissingArtifact)?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err(DownloadError::MissingArtifact);
    }
    Ok(metadata.len())
}

fn ensure_absent(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(DownloadError::OutputExists),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(DownloadError::Publish(error)),
    }
}

fn publish_noclobber(source: &Path, destination: &Path) -> Result<()> {
    match fs::hard_link(source, destination) {
        Ok(()) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(DownloadError::OutputExists);
        }
        Err(_) => {}
    }

    // Filesystems such as FAT may not support hard links. Copy into another
    // same-directory temporary file, sync it, then atomically persist without
    // replacing an existing destination.
    let parent = destination
        .parent()
        .ok_or(DownloadError::InvalidDestination("output has no parent"))?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".osg-publish-")
        .tempfile_in(parent)
        .map_err(DownloadError::Publish)?;
    let mut input = fs::File::open(source).map_err(DownloadError::Publish)?;
    std::io::copy(&mut input, temporary.as_file_mut()).map_err(DownloadError::Publish)?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(DownloadError::Publish)?;
    temporary.persist_noclobber(destination).map_or_else(
        |error| {
            if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                Err(DownloadError::OutputExists)
            } else {
                Err(DownloadError::Publish(error.error))
            }
        },
        |_| Ok(()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::test_support::mock_binary;
    use crate::{
        AddressResolver, AudioDownloadFormat, AudioQuality, BrowserCookieSource,
        DownloadDestination, JsRuntimeResolver, JsRuntimeSearch, MediaSelection, SubtitleSelection,
        SubtitleSource, VideoQuality,
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
        assert!(
            !format!("{engine:?}").contains(runtime_directory.path().to_string_lossy().as_ref())
        );
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
}
