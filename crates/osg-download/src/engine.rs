use crate::plan::inventory_arguments;
use crate::process::{
    DOWNLOAD_STDOUT_LIMIT, INVENTORY_STDOUT_LIMIT, ProcessOutput, ProcessRequest, run,
};
use crate::{
    AddressResolver, DownloadCookies, DownloadError, DownloadPlan, FfmpegDirectory, MediaInventory,
    ProcessFailureKind, ResolvedJsRuntime, ResolvedYtDlp, Result, RunControl, SystemResolver,
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

    /// Resolves the same native engine with a compile-time-hidden exact loopback allow-list.
    #[cfg(feature = "e2e-automation")]
    pub fn resolve_with_exact_automation_urls(
        search: YtDlpSearch,
        policy: UrlPolicy,
        values: &[String],
    ) -> Result<Self> {
        Ok(Self::new(
            YtDlpResolver::new(search).resolve()?,
            UrlValidator::system_with_exact_automation_urls(policy, values)?,
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
        cookies: impl Into<DownloadCookies>,
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
    if output.stdout_truncated {
        return Err(DownloadError::OutputLimit);
    }
    if !output.status.success() {
        return Err(DownloadError::ProcessFailed {
            code: output.status.code(),
            kind: classify_process_failure(&output.stderr_tail),
        });
    }
    Ok(())
}

fn classify_process_failure(stderr: &[u8]) -> ProcessFailureKind {
    let message = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    let contains_any = |patterns: &[&str]| patterns.iter().any(|pattern| message.contains(pattern));

    if contains_any(&[
        "sign in to confirm",
        "login required",
        "log in to",
        "authentication required",
        "cookies are required",
        "use --cookies",
        "this video is private",
        "members-only",
        "age-restricted",
    ]) {
        ProcessFailureKind::AuthenticationRequired
    } else if contains_any(&["http error 429", "too many requests", "rate limit"]) {
        ProcessFailureKind::RateLimited
    } else if contains_any(&[
        "requested format is not available",
        "requested format not available",
        "format selection failed",
    ]) {
        ProcessFailureKind::FormatUnavailable
    } else if contains_any(&[
        "video unavailable",
        "this video is unavailable",
        "has been removed",
        "not available in your country",
        "geo-restricted",
        "copyright claim",
        "private video",
    ]) {
        ProcessFailureKind::SourceUnavailable
    } else if contains_any(&[
        "postprocessing:",
        "post-processing:",
        "ffmpeg exited",
        "ffprobe exited",
        "conversion failed",
        "unable to merge",
        "error while opening encoder",
    ]) {
        ProcessFailureKind::PostProcessing
    } else if contains_any(&[
        "http error 403",
        "http error 5",
        "unable to download",
        "connection reset",
        "connection refused",
        "name resolution",
        "network is unreachable",
        "timed out",
        "certificate verify failed",
        "temporary failure",
    ]) {
        ProcessFailureKind::Network
    } else if contains_any(&[
        "extractor error",
        "signature solving failed",
        "signature extraction failed",
        "challenge solving failed",
        "nsig extraction failed",
        "no video formats found",
        "unsupported url",
        "please report this issue",
    ]) {
        ProcessFailureKind::Extractor
    } else {
        ProcessFailureKind::Unknown
    }
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
mod tests;
