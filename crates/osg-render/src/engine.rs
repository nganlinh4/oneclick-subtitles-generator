use std::ffi::{OsStr, OsString};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use blake3::Hasher;
use command_group::{CommandGroup, GroupChild};
use same_file::Handle;
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::protocol::{
    MAX_WORKER_MESSAGE_BYTES, WorkerFailureCode, WorkerPhase, read_json_frame, write_json_frame,
};
use crate::{
    PROTOCOL_VERSION, RenderError, RenderPlan, RenderRuntime, Result, WorkerMessage,
    WorkerRenderRequest,
};

const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_BUNDLE_ENTRIES: usize = 200_000;
const MAX_BUNDLE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_FFMPEG_STDOUT_LINE_BYTES: usize = 4 * 1024;
const MAX_WORKER_MESSAGES: usize = 200_000;
const MIN_RENDER_OUTPUT_BYTES: u64 = 32;
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(20);
const READER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RENDER_TIMEOUT: Duration = Duration::from_hours(25);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, Default)]
pub struct RenderCancellationToken(Arc<AtomicBool>);

impl RenderCancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderPhase {
    Staging,
    ExtractingFrames,
    ExtractingAudio,
    LoadingComposition,
    RenderingFrames,
    Encoding,
    Muxing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderProgress {
    pub phase: RenderPhase,
    pub fraction_millionths: u32,
    pub rendered_frames: u32,
    pub encoded_frames: u32,
    pub duration_in_frames: u32,
}

#[derive(Clone)]
pub struct RenderProgressSink(Arc<dyn Fn(RenderProgress) + Send + Sync>);

impl RenderProgressSink {
    pub fn new(callback: impl Fn(RenderProgress) + Send + Sync + 'static) -> Self {
        Self(Arc::new(callback))
    }

    fn emit(&self, progress: RenderProgress) {
        (self.0)(progress);
    }
}

impl std::fmt::Debug for RenderProgressSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RenderProgressSink(<callback>)")
    }
}

#[derive(Clone, Debug)]
pub struct RenderRunControl {
    timeout: Duration,
    cancellation: RenderCancellationToken,
    progress: Option<RenderProgressSink>,
}

impl RenderRunControl {
    pub fn new(timeout: Duration) -> Result<Self> {
        if timeout.is_zero() || timeout > MAX_RENDER_TIMEOUT {
            return Err(RenderError::InvalidRequest);
        }
        Ok(Self {
            timeout,
            cancellation: RenderCancellationToken::default(),
            progress: None,
        })
    }

    #[must_use]
    pub fn with_cancellation(mut self, cancellation: RenderCancellationToken) -> Self {
        self.cancellation = cancellation;
        self
    }

    #[must_use]
    pub fn with_progress(mut self, progress: RenderProgressSink) -> Self {
        self.progress = Some(progress);
        self
    }

    #[must_use]
    pub fn cancellation(&self) -> RenderCancellationToken {
        self.cancellation.clone()
    }
}

#[derive(Clone)]
struct VerifiedInput {
    path: PathBuf,
    size_bytes: u64,
    content_hash: [u8; 32],
    extension: String,
}

impl std::fmt::Debug for VerifiedInput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VerifiedInput")
            .field("path", &"<redacted>")
            .field("size_bytes", &self.size_bytes)
            .field("content_hash", &"<redacted>")
            .field("extension", &self.extension)
            .finish()
    }
}

#[derive(Clone)]
pub struct NativeRenderInputs {
    source: VerifiedInput,
    narration: Option<VerifiedInput>,
    ffmpeg: PathBuf,
    staging_root: PathBuf,
}

impl NativeRenderInputs {
    pub fn new(
        source_path: PathBuf,
        source_size_bytes: u64,
        source_content_hash: [u8; 32],
        source_extension: impl Into<String>,
        ffmpeg: PathBuf,
        staging_root: PathBuf,
    ) -> Result<Self> {
        let source = VerifiedInput::new(
            source_path,
            source_size_bytes,
            source_content_hash,
            &source_extension.into(),
        )?;
        if ffmpeg.as_os_str().is_empty() || staging_root.as_os_str().is_empty() {
            return Err(RenderError::InvalidRequest);
        }
        Ok(Self {
            source,
            narration: None,
            ffmpeg,
            staging_root,
        })
    }

    pub fn with_narration(
        mut self,
        path: PathBuf,
        size_bytes: u64,
        content_hash: [u8; 32],
        extension: impl Into<String>,
    ) -> Result<Self> {
        self.narration = Some(VerifiedInput::new(
            path,
            size_bytes,
            content_hash,
            &extension.into(),
        )?);
        Ok(self)
    }
}

impl std::fmt::Debug for NativeRenderInputs {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeRenderInputs")
            .field("source", &self.source)
            .field("narration", &self.narration)
            .field("ffmpeg", &"<redacted>")
            .field("staging_root", &"<redacted>")
            .finish()
    }
}

impl VerifiedInput {
    fn new(
        path: PathBuf,
        size_bytes: u64,
        content_hash: [u8; 32],
        extension: &str,
    ) -> Result<Self> {
        if path.as_os_str().is_empty()
            || size_bytes == 0
            || !valid_extension(extension)
            || content_hash == [0_u8; 32]
        {
            return Err(RenderError::InvalidRequest);
        }
        Ok(Self {
            path,
            size_bytes,
            content_hash,
            extension: extension.to_ascii_lowercase(),
        })
    }
}

pub struct PreparedRender {
    staging: TempDir,
    output: PathBuf,
    size_bytes: u64,
    content_hash: [u8; 32],
    width: u32,
    height: u32,
    fps: u16,
    duration_in_frames: u32,
}

impl PreparedRender {
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.output
    }

    #[must_use]
    pub const fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    #[must_use]
    pub const fn content_hash(&self) -> &[u8; 32] {
        &self.content_hash
    }

    #[must_use]
    pub const fn width(&self) -> u32 {
        self.width
    }

    #[must_use]
    pub const fn height(&self) -> u32 {
        self.height
    }

    #[must_use]
    pub const fn fps(&self) -> u16 {
        self.fps
    }

    #[must_use]
    pub const fn duration_in_frames(&self) -> u32 {
        self.duration_in_frames
    }
}

impl std::fmt::Debug for PreparedRender {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedRender")
            .field("staging", &"<redacted>")
            .field("output", &"<redacted>")
            .field("size_bytes", &self.size_bytes)
            .field("content_hash", &"<redacted>")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("fps", &self.fps)
            .field("duration_in_frames", &self.duration_in_frames)
            .finish()
    }
}

impl Drop for PreparedRender {
    fn drop(&mut self) {
        let _ = self.staging.path();
    }
}

#[derive(Clone, Debug)]
pub struct RenderEngine {
    runtime: RenderRuntime,
}

impl RenderEngine {
    #[must_use]
    pub const fn new(runtime: RenderRuntime) -> Self {
        Self { runtime }
    }

    pub fn render(
        &self,
        plan: &RenderPlan,
        inputs: &NativeRenderInputs,
        control: &RenderRunControl,
    ) -> Result<PreparedRender> {
        if control.cancellation.is_cancelled() {
            return Err(RenderError::Cancelled);
        }
        self.runtime.verify_execution_payload()?;
        validate_executable(&inputs.ffmpeg)?;
        let staging_root = prepare_staging_root(&inputs.staging_root)?;
        let staging = tempfile::Builder::new()
            .prefix("render-")
            .tempdir_in(staging_root)
            .map_err(|_| RenderError::StagingUnavailable)?;
        let bundle = staging.path().join("bundle");
        clone_bundle(&self.runtime, &bundle, &control.cancellation)?;
        let media_directory = bundle.join("job-media");
        fs::create_dir(&media_directory).map_err(|_| RenderError::StagingUnavailable)?;

        emit_progress(control, RenderPhase::Staging, 0, 0, 0, plan.duration_frames);
        let staged_source = media_directory.join(format!("source.{}", inputs.source.extension));
        copy_verified_input(
            &inputs.source,
            &staged_source,
            &control.cancellation,
            RenderError::SourceChanged,
        )?;
        let staged_narration = inputs
            .narration
            .as_ref()
            .map(|narration| {
                let destination =
                    media_directory.join(format!("narration.{}", narration.extension));
                copy_verified_input(
                    narration,
                    &destination,
                    &control.cancellation,
                    RenderError::NarrationChanged,
                )?;
                Ok::<PathBuf, RenderError>(destination)
            })
            .transpose()?;
        emit_progress(
            control,
            RenderPhase::Staging,
            50_000,
            0,
            0,
            plan.duration_frames,
        );

        let frames_directory = media_directory.join("frames");
        fs::create_dir(&frames_directory).map_err(|_| RenderError::StagingUnavailable)?;
        let audio = media_directory.join("source-audio.aac");
        extract_frames(
            &inputs.ffmpeg,
            &staged_source,
            &frames_directory,
            plan,
            staging.path(),
            control,
        )?;
        let actual_frames = validate_frame_sequence(&frames_directory)?;
        extract_audio(
            &inputs.ffmpeg,
            &staged_source,
            &audio,
            plan,
            staging.path(),
            control,
        )?;
        validate_regular_file(&audio, 1, RenderError::MediaPreparationFailed)?;

        let output = staging.path().join("rendered-video.mp4");
        let narration_url = staged_narration
            .as_ref()
            .and(inputs.narration.as_ref())
            .map(|narration| format!("job-media/narration.{}", narration.extension));
        let input_props = build_input_props(plan, narration_url.as_deref())?;
        let request = WorkerRenderRequest {
            protocol_version: PROTOCOL_VERSION,
            request_type: "render",
            serve_url: native_path_string(&bundle)?,
            browser_executable: native_path_string(self.runtime.browser())?,
            renderer_root: native_path_string(self.runtime.renderer_root())?,
            binaries_directory: native_path_string(self.runtime.binaries())?,
            output_location: native_path_string(&output)?,
            composition_id: "subtitled-video",
            input_props,
            width: plan.width,
            height: plan.height,
            fps: plan.settings.frame_rate.value(),
            duration_in_frames: actual_frames,
        };
        let reported_bytes = run_worker(&self.runtime, &request, staging.path(), control)?;
        let (size_bytes, content_hash) = validate_render_output(&output, reported_bytes)?;
        Ok(PreparedRender {
            staging,
            output,
            size_bytes,
            content_hash,
            width: plan.width,
            height: plan.height,
            fps: plan.settings.frame_rate.value(),
            duration_in_frames: actual_frames,
        })
    }
}

fn valid_extension(value: &str) -> bool {
    !value.is_empty() && value.len() <= 16 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn prepare_staging_root(path: &Path) -> Result<&Path> {
    fs::create_dir_all(path).map_err(|_| RenderError::StagingUnavailable)?;
    validate_path_chain_no_links(path, RenderError::StagingUnavailable)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| RenderError::StagingUnavailable)?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return Err(RenderError::StagingUnavailable);
    }
    Ok(path)
}

fn clone_bundle(
    runtime: &RenderRuntime,
    destination: &Path,
    cancellation: &RenderCancellationToken,
) -> Result<()> {
    let source = runtime.bundle();
    let root = fs::canonicalize(source).map_err(|_| RenderError::RuntimeUnavailable)?;
    let metadata = fs::symlink_metadata(&root).map_err(|_| RenderError::RuntimeUnavailable)?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        return Err(RenderError::RuntimeUnavailable);
    }
    fs::create_dir(destination).map_err(|_| RenderError::StagingUnavailable)?;
    let mut pending = vec![(root.clone(), destination.to_owned())];
    let mut entries = 0_usize;
    let mut copied_files = 0_usize;
    let mut bytes = 0_u64;
    while let Some((source_directory, destination_directory)) = pending.pop() {
        for entry in fs::read_dir(&source_directory).map_err(|_| RenderError::RuntimeUnavailable)? {
            if cancellation.is_cancelled() {
                return Err(RenderError::Cancelled);
            }
            entries = entries
                .checked_add(1)
                .ok_or(RenderError::RuntimeUnavailable)?;
            if entries > MAX_BUNDLE_ENTRIES {
                return Err(RenderError::RuntimeUnavailable);
            }
            let entry = entry.map_err(|_| RenderError::RuntimeUnavailable)?;
            let source_path = entry.path();
            let metadata =
                fs::symlink_metadata(&source_path).map_err(|_| RenderError::RuntimeUnavailable)?;
            if is_link_or_reparse(&metadata) {
                return Err(RenderError::RuntimeUnavailable);
            }
            let destination_path = destination_directory.join(entry.file_name());
            if metadata.is_dir() {
                fs::create_dir(&destination_path).map_err(|_| RenderError::StagingUnavailable)?;
                pending.push((source_path, destination_path));
            } else if metadata.is_file() {
                bytes = bytes
                    .checked_add(metadata.len())
                    .filter(|total| *total <= MAX_BUNDLE_BYTES)
                    .ok_or(RenderError::RuntimeUnavailable)?;
                copy_stable_file(
                    &source_path,
                    &destination_path,
                    metadata.len(),
                    None,
                    cancellation,
                    RenderError::RuntimeUnavailable,
                )?;
                runtime.verify_copied_bundle_file(&source_path, &destination_path)?;
                copied_files = copied_files
                    .checked_add(1)
                    .ok_or(RenderError::RuntimeUnavailable)?;
            } else {
                return Err(RenderError::RuntimeUnavailable);
            }
        }
    }
    if copied_files != runtime.bundle_file_count() {
        return Err(RenderError::RuntimeUnavailable);
    }
    Ok(())
}

fn copy_verified_input(
    input: &VerifiedInput,
    destination: &Path,
    cancellation: &RenderCancellationToken,
    changed: RenderError,
) -> Result<()> {
    copy_stable_file(
        &input.path,
        destination,
        input.size_bytes,
        Some(input.content_hash),
        cancellation,
        changed,
    )
}

fn copy_stable_file(
    source: &Path,
    destination: &Path,
    expected_bytes: u64,
    expected_hash: Option<[u8; 32]>,
    cancellation: &RenderCancellationToken,
    changed: RenderError,
) -> Result<()> {
    validate_path_chain_no_links(source, changed)?;
    let metadata = fs::symlink_metadata(source).map_err(|_| changed)?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) || metadata.len() != expected_bytes {
        return Err(changed);
    }
    let source_file = File::open(source).map_err(|_| changed)?;
    let mut source_handle = Handle::from_file(source_file).map_err(|_| changed)?;
    let mut destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| RenderError::StagingUnavailable)?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut hasher = Hasher::new();
    let mut copied = 0_u64;
    loop {
        if cancellation.is_cancelled() {
            return Err(RenderError::Cancelled);
        }
        let count = source_handle
            .as_file_mut()
            .read(&mut buffer)
            .map_err(|_| changed)?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(u64::try_from(count).map_err(|_| changed)?)
            .ok_or(changed)?;
        if copied > expected_bytes {
            return Err(changed);
        }
        hasher.update(&buffer[..count]);
        destination_file
            .write_all(&buffer[..count])
            .map_err(|_| RenderError::StagingUnavailable)?;
    }
    destination_file
        .sync_all()
        .map_err(|_| RenderError::StagingUnavailable)?;
    let current_handle = Handle::from_path(source).map_err(|_| changed)?;
    let current_metadata = source_handle.as_file().metadata().map_err(|_| changed)?;
    if copied != expected_bytes
        || current_metadata.len() != expected_bytes
        || source_handle != current_handle
        || expected_hash.is_some_and(|expected| expected != *hasher.finalize().as_bytes())
    {
        return Err(changed);
    }
    Ok(())
}

fn extract_frames(
    ffmpeg: &Path,
    source: &Path,
    frames: &Path,
    plan: &RenderPlan,
    working_directory: &Path,
    control: &RenderRunControl,
) -> Result<()> {
    let output = frames.join("%06d.png");
    let args = vec![
        OsString::from("-nostdin"),
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-y"),
        OsString::from("-ss"),
        OsString::from(micros_to_seconds(plan.trim_start_us)),
        OsString::from("-to"),
        OsString::from(micros_to_seconds(plan.trim_end_us)),
        OsString::from("-i"),
        source.as_os_str().to_owned(),
        OsString::from("-vf"),
        OsString::from(format!("fps={}", plan.settings.frame_rate.value())),
        OsString::from("-compression_level"),
        OsString::from("1"),
        OsString::from("-progress"),
        OsString::from("pipe:1"),
        output.as_os_str().to_owned(),
    ];
    run_ffmpeg(
        ffmpeg,
        &args,
        working_directory,
        control,
        FfmpegProgressRange {
            phase: RenderPhase::ExtractingFrames,
            base_fraction: 50_000,
            end_fraction: 300_000,
            duration_in_frames: plan.duration_frames,
        },
    )
}

fn extract_audio(
    ffmpeg: &Path,
    source: &Path,
    output: &Path,
    plan: &RenderPlan,
    working_directory: &Path,
    control: &RenderRunControl,
) -> Result<()> {
    let args = vec![
        OsString::from("-nostdin"),
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-y"),
        OsString::from("-ss"),
        OsString::from(micros_to_seconds(plan.trim_start_us)),
        OsString::from("-to"),
        OsString::from(micros_to_seconds(plan.trim_end_us)),
        OsString::from("-i"),
        source.as_os_str().to_owned(),
        OsString::from("-vn"),
        OsString::from("-c:a"),
        OsString::from("aac"),
        OsString::from("-b:a"),
        OsString::from("256k"),
        OsString::from("-progress"),
        OsString::from("pipe:1"),
        output.as_os_str().to_owned(),
    ];
    run_ffmpeg(
        ffmpeg,
        &args,
        working_directory,
        control,
        FfmpegProgressRange {
            phase: RenderPhase::ExtractingAudio,
            base_fraction: 300_000,
            end_fraction: 350_000,
            duration_in_frames: plan.duration_frames,
        },
    )
}

#[derive(Clone, Copy)]
struct FfmpegProgressRange {
    phase: RenderPhase,
    base_fraction: u32,
    end_fraction: u32,
    duration_in_frames: u32,
}

fn run_ffmpeg(
    executable: &Path,
    args: &[OsString],
    working_directory: &Path,
    control: &RenderRunControl,
    progress: FfmpegProgressRange,
) -> Result<()> {
    if control.cancellation.is_cancelled() {
        return Err(RenderError::Cancelled);
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_fixed_environment(&mut command, working_directory)?;
    let mut child = KillOnDrop::new(spawn_group(
        &mut command,
        RenderError::MediaPreparationFailed,
    )?);
    let stdout = child
        .inner()
        .stdout
        .take()
        .ok_or(RenderError::MediaPreparationFailed)?;
    let stderr = child
        .inner()
        .stderr
        .take()
        .ok_or(RenderError::MediaPreparationFailed)?;
    let sink = control.progress.clone();
    let stdout_thread = std::thread::spawn(move || {
        read_ffmpeg_progress(
            stdout,
            sink.as_ref(),
            progress.phase,
            progress.base_fraction,
            progress.end_fraction,
            progress.duration_in_frames,
        )
    });
    let stderr_thread = std::thread::spawn(move || drain(stderr));
    let status = wait_for_process(&mut child, control)?;
    join_io(stdout_thread)?;
    join_io(stderr_thread)?;
    if !status.success() {
        return Err(RenderError::MediaPreparationFailed);
    }
    emit_progress(
        control,
        progress.phase,
        progress.end_fraction,
        progress.duration_in_frames,
        0,
        progress.duration_in_frames,
    );
    Ok(())
}

fn read_ffmpeg_progress(
    reader: impl Read,
    sink: Option<&RenderProgressSink>,
    phase: RenderPhase,
    base_fraction: u32,
    end_fraction: u32,
    duration_in_frames: u32,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::with_capacity(256);
    loop {
        line.clear();
        let read = reader
            .by_ref()
            .take(u64::try_from(MAX_FFMPEG_STDOUT_LINE_BYTES).unwrap_or(u64::MAX))
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok(());
        }
        if !line.ends_with(b"\n") && line.len() == MAX_FFMPEG_STDOUT_LINE_BYTES {
            return Err(std::io::Error::other("invalid ffmpeg progress line"));
        }
        let Some(value) = line.strip_prefix(b"frame=") else {
            continue;
        };
        let frame = std::str::from_utf8(value)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .unwrap_or(0)
            .min(duration_in_frames);
        let span = end_fraction.saturating_sub(base_fraction);
        let fraction = if duration_in_frames == 0 {
            base_fraction
        } else {
            base_fraction.saturating_add(
                u32::try_from(u64::from(span) * u64::from(frame) / u64::from(duration_in_frames))
                    .unwrap_or(span),
            )
        };
        if let Some(sink) = sink {
            sink.emit(RenderProgress {
                phase,
                fraction_millionths: fraction,
                rendered_frames: frame,
                encoded_frames: 0,
                duration_in_frames,
            });
        }
    }
}

fn build_input_props(plan: &RenderPlan, narration_url: Option<&str>) -> Result<Value> {
    let lyrics = plan
        .lyrics
        .iter()
        .map(|lyric| {
            json!({
                "start": micros_to_f64_seconds(lyric.start_us),
                "end": micros_to_f64_seconds(lyric.end_us),
                "text": lyric.text,
            })
        })
        .collect::<Vec<_>>();
    let customization =
        serde_json::to_value(&plan.customization).map_err(|_| RenderError::InvalidRequest)?;
    let crop = serde_json::to_value(&plan.crop).map_err(|_| RenderError::InvalidRequest)?;
    let mut props = json!({
        "audioUrl": "job-media/source-audio.aac",
        "lyrics": lyrics,
        "metadata": {
            "videoType": "Subtitled Video",
            "resolution": plan.settings.resolution,
            "frameRate": plan.settings.frame_rate,
            "originalAudioVolume": plan.settings.original_audio_volume,
            "narrationVolume": plan.settings.narration_volume,
            "trimStart": micros_to_f64_seconds(plan.trim_start_us),
            "trimEnd": micros_to_f64_seconds(plan.trim_end_us),
            "subtitleCustomization": customization,
            "cropSettings": crop,
            "fontStylesheetUrl": "fonts/fonts.css",
        },
        "isVideoFile": true,
        "framesPathUrl": "job-media/frames",
        "extractedAudioUrl": "job-media/source-audio.aac",
    });
    if let Some(narration_url) = narration_url {
        props["narrationUrl"] = Value::String(narration_url.to_owned());
    }
    Ok(props)
}

#[allow(
    clippy::too_many_lines,
    reason = "the supervised worker lifecycle is kept as one ownership transaction"
)]
fn run_worker(
    runtime: &RenderRuntime,
    request: &WorkerRenderRequest,
    working_directory: &Path,
    control: &RenderRunControl,
) -> Result<u64> {
    if control.cancellation.is_cancelled() {
        return Err(RenderError::Cancelled);
    }
    let mut command = Command::new(runtime.node());
    command
        .arg(native_process_path(runtime.worker())?)
        .arg("--stdio-v1")
        .current_dir(working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_fixed_environment(&mut command, working_directory)?;
    command.env("NODE_ENV", "production");
    let mut child = KillOnDrop::new(spawn_group(&mut command, RenderError::WorkerFailed)?);
    let mut stdin = child
        .inner()
        .stdin
        .take()
        .ok_or(RenderError::WorkerFailed)?;
    write_json_frame(&mut stdin, request, crate::MAX_PROTOCOL_FRAME_BYTES)?;
    drop(stdin);
    let stdout = child
        .inner()
        .stdout
        .take()
        .ok_or(RenderError::WorkerFailed)?;
    let stderr = child
        .inner()
        .stderr
        .take()
        .ok_or(RenderError::WorkerFailed)?;
    let (sender, receiver) = mpsc::sync_channel(128);
    let reader_thread = std::thread::spawn(move || read_worker_messages(stdout, &sender));
    let stderr_thread = std::thread::spawn(move || drain(stderr));
    let started = Instant::now();
    let mut validator = WorkerValidator::new(request.duration_in_frames);
    let status = loop {
        while let Ok(event) = receiver.try_recv() {
            match event {
                WorkerReaderEvent::Message(message) => {
                    if validator.accept(&message, control).is_err() {
                        return terminate_worker(
                            &mut child,
                            reader_thread,
                            stderr_thread,
                            RenderError::InvalidWorkerProtocol,
                        );
                    }
                }
                WorkerReaderEvent::Failed => {
                    return terminate_worker(
                        &mut child,
                        reader_thread,
                        stderr_thread,
                        RenderError::InvalidWorkerProtocol,
                    );
                }
                WorkerReaderEvent::Eof => validator.saw_eof = true,
            }
        }
        if let Some(status) = child.try_wait().map_err(|_| RenderError::WorkerFailed)? {
            child.mark_reaped();
            break status;
        }
        if control.cancellation.is_cancelled() {
            return terminate_worker(
                &mut child,
                reader_thread,
                stderr_thread,
                RenderError::Cancelled,
            );
        }
        if started.elapsed() >= control.timeout {
            return terminate_worker(
                &mut child,
                reader_thread,
                stderr_thread,
                RenderError::TimedOut,
            );
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    };
    let drain_deadline = Instant::now() + READER_SHUTDOWN_TIMEOUT;
    while !validator.saw_eof {
        match receiver.recv_timeout(PROCESS_POLL_INTERVAL) {
            Ok(WorkerReaderEvent::Message(message)) => {
                if validator.accept(&message, control).is_err() {
                    let _ = join_reader(reader_thread);
                    let _ = join_io(stderr_thread);
                    return Err(RenderError::InvalidWorkerProtocol);
                }
            }
            Ok(WorkerReaderEvent::Eof) => validator.saw_eof = true,
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < drain_deadline => {}
            Ok(WorkerReaderEvent::Failed)
            | Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {
                let _ = join_reader(reader_thread);
                let _ = join_io(stderr_thread);
                return Err(RenderError::InvalidWorkerProtocol);
            }
        }
    }
    let reader_result = join_reader(reader_thread)?;
    join_io(stderr_thread)?;
    if reader_result.is_err() {
        return Err(RenderError::InvalidWorkerProtocol);
    }
    validator.finish(status, control)
}

enum WorkerReaderEvent {
    Message(WorkerMessage),
    Failed,
    Eof,
}

fn read_worker_messages(
    mut reader: impl Read,
    sender: &mpsc::SyncSender<WorkerReaderEvent>,
) -> Result<()> {
    for _ in 0..MAX_WORKER_MESSAGES {
        match read_json_frame::<WorkerMessage>(&mut reader, MAX_WORKER_MESSAGE_BYTES) {
            Ok(Some(message)) => sender
                .send(WorkerReaderEvent::Message(message))
                .map_err(|_| RenderError::InvalidWorkerProtocol)?,
            Ok(None) => {
                let _ = sender.send(WorkerReaderEvent::Eof);
                return Ok(());
            }
            Err(_) => {
                let _ = sender.send(WorkerReaderEvent::Failed);
                return Err(RenderError::InvalidWorkerProtocol);
            }
        }
    }
    let _ = sender.send(WorkerReaderEvent::Failed);
    Err(RenderError::InvalidWorkerProtocol)
}

struct WorkerValidator {
    duration_in_frames: u32,
    ready: bool,
    terminal: Option<std::result::Result<u64, WorkerFailureCode>>,
    last_fraction: u32,
    last_rendered: u32,
    last_encoded: u32,
    last_phase: u8,
    saw_eof: bool,
}

impl WorkerValidator {
    const fn new(duration_in_frames: u32) -> Self {
        Self {
            duration_in_frames,
            ready: false,
            terminal: None,
            last_fraction: 0,
            last_rendered: 0,
            last_encoded: 0,
            last_phase: 0,
            saw_eof: false,
        }
    }

    fn accept(&mut self, message: &WorkerMessage, control: &RenderRunControl) -> Result<()> {
        if self.saw_eof || self.terminal.is_some() {
            return Err(RenderError::InvalidWorkerProtocol);
        }
        match *message {
            WorkerMessage::Ready { protocol_version } => {
                if self.ready || protocol_version != PROTOCOL_VERSION {
                    return Err(RenderError::InvalidWorkerProtocol);
                }
                self.ready = true;
                emit_progress(
                    control,
                    RenderPhase::LoadingComposition,
                    350_000,
                    0,
                    0,
                    self.duration_in_frames,
                );
            }
            WorkerMessage::Progress {
                fraction_millionths,
                rendered_frames,
                encoded_frames,
                duration_in_frames,
                phase,
            } => {
                let phase_number = worker_phase_number(phase);
                if !self.ready
                    || duration_in_frames != self.duration_in_frames
                    || fraction_millionths > 1_000_000
                    || fraction_millionths < self.last_fraction
                    || rendered_frames > duration_in_frames
                    || rendered_frames < self.last_rendered
                    || encoded_frames > duration_in_frames
                    || encoded_frames < self.last_encoded
                    || phase_number < self.last_phase
                {
                    return Err(RenderError::InvalidWorkerProtocol);
                }
                self.last_fraction = fraction_millionths;
                self.last_rendered = rendered_frames;
                self.last_encoded = encoded_frames;
                self.last_phase = phase_number;
                let scaled = 350_000_u32.saturating_add(
                    u32::try_from(630_000_u64 * u64::from(fraction_millionths) / 1_000_000)
                        .unwrap_or(630_000),
                );
                emit_progress(
                    control,
                    map_worker_phase(phase),
                    scaled,
                    rendered_frames,
                    encoded_frames,
                    duration_in_frames,
                );
            }
            WorkerMessage::Completed { output_bytes } => {
                if !self.ready || output_bytes < MIN_RENDER_OUTPUT_BYTES {
                    return Err(RenderError::InvalidWorkerProtocol);
                }
                self.terminal = Some(Ok(output_bytes));
            }
            WorkerMessage::Failed { code } => {
                if !self.ready {
                    return Err(RenderError::InvalidWorkerProtocol);
                }
                self.terminal = Some(Err(code));
            }
        }
        Ok(())
    }

    fn finish(self, status: ExitStatus, control: &RenderRunControl) -> Result<u64> {
        if !self.saw_eof || !self.ready {
            return Err(RenderError::InvalidWorkerProtocol);
        }
        match self.terminal {
            Some(Ok(bytes)) if status.success() => {
                emit_progress(
                    control,
                    RenderPhase::Muxing,
                    980_000,
                    self.duration_in_frames,
                    self.duration_in_frames,
                    self.duration_in_frames,
                );
                Ok(bytes)
            }
            Some(Err(WorkerFailureCode::Cancelled)) if control.cancellation.is_cancelled() => {
                Err(RenderError::Cancelled)
            }
            Some(Err(_) | Ok(_)) | None => Err(RenderError::WorkerFailed),
        }
    }
}

fn worker_phase_number(phase: WorkerPhase) -> u8 {
    match phase {
        WorkerPhase::LoadingComposition => 1,
        WorkerPhase::RenderingFrames => 2,
        WorkerPhase::Encoding => 3,
        WorkerPhase::Muxing => 4,
    }
}

fn map_worker_phase(phase: WorkerPhase) -> RenderPhase {
    match phase {
        WorkerPhase::LoadingComposition => RenderPhase::LoadingComposition,
        WorkerPhase::RenderingFrames => RenderPhase::RenderingFrames,
        WorkerPhase::Encoding => RenderPhase::Encoding,
        WorkerPhase::Muxing => RenderPhase::Muxing,
    }
}

fn validate_frame_sequence(directory: &Path) -> Result<u32> {
    let mut names = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| RenderError::MediaPreparationFailed)? {
        let entry = entry.map_err(|_| RenderError::MediaPreparationFailed)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| RenderError::MediaPreparationFailed)?;
        if !metadata.is_file() || is_link_or_reparse(&metadata) || metadata.len() == 0 {
            return Err(RenderError::MediaPreparationFailed);
        }
        names.push(entry.file_name());
    }
    names.sort_unstable();
    if names.is_empty() || names.len() > 1_000_000 {
        return Err(RenderError::MediaPreparationFailed);
    }
    for (index, name) in names.iter().enumerate() {
        let expected = format!("{:06}.png", index + 1);
        if name != OsStr::new(&expected) {
            return Err(RenderError::MediaPreparationFailed);
        }
    }
    u32::try_from(names.len()).map_err(|_| RenderError::MediaPreparationFailed)
}

fn validate_render_output(path: &Path, reported_bytes: u64) -> Result<(u64, [u8; 32])> {
    let metadata =
        validate_regular_file(path, MIN_RENDER_OUTPUT_BYTES, RenderError::InvalidOutput)?;
    if metadata.len() != reported_bytes {
        return Err(RenderError::InvalidOutput);
    }
    let mut file = File::open(path).map_err(|_| RenderError::InvalidOutput)?;
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|_| RenderError::InvalidOutput)?;
    let box_bytes = u64::from(u32::from_be_bytes(
        header[..4]
            .try_into()
            .map_err(|_| RenderError::InvalidOutput)?,
    ));
    if &header[4..8] != b"ftyp" || box_bytes < 8 || box_bytes > metadata.len() {
        return Err(RenderError::InvalidOutput);
    }
    let mut hasher = Hasher::new();
    hasher.update(&header);
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| RenderError::InvalidOutput)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok((metadata.len(), *hasher.finalize().as_bytes()))
}

fn validate_regular_file(path: &Path, minimum: u64, error: RenderError) -> Result<Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(|_| error)?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) || metadata.len() < minimum {
        return Err(error);
    }
    Ok(metadata)
}

fn validate_executable(path: &Path) -> Result<()> {
    validate_path_chain_no_links(path, RenderError::RuntimeUnavailable)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| RenderError::RuntimeUnavailable)?;
    if !metadata.is_file() || is_link_or_reparse(&metadata) {
        return Err(RenderError::RuntimeUnavailable);
    }
    #[cfg(windows)]
    if !path
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Err(RenderError::RuntimeUnavailable);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(RenderError::RuntimeUnavailable);
        }
    }
    Ok(())
}

fn native_path_string(path: &Path) -> Result<String> {
    native_process_path(path)?
        .into_string()
        .ok()
        .filter(|value| !value.is_empty() && value.len() <= 32 * 1024)
        .ok_or(RenderError::StagingUnavailable)
}

fn native_process_path(path: &Path) -> Result<OsString> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(RenderError::StagingUnavailable);
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};

        let encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
        let unc_prefix = r"\\?\UNC\".encode_utf16().collect::<Vec<_>>();
        if let Some(relative) = encoded.strip_prefix(unc_prefix.as_slice()) {
            let mut normalized = r"\\".encode_utf16().collect::<Vec<_>>();
            normalized.extend_from_slice(relative);
            return Ok(OsString::from_wide(&normalized));
        }
        let extended_prefix = r"\\?\".encode_utf16().collect::<Vec<_>>();
        if let Some(relative) = encoded.strip_prefix(extended_prefix.as_slice()) {
            return Ok(OsString::from_wide(relative));
        }
    }
    Ok(path.as_os_str().to_owned())
}

fn micros_to_seconds(value: u64) -> String {
    format!("{}.{:06}", value / 1_000_000, value % 1_000_000)
}

#[allow(
    clippy::cast_precision_loss,
    reason = "microsecond values are capped at 24 hours and exactly fit in f64 integer precision"
)]
fn micros_to_f64_seconds(value: u64) -> f64 {
    value as f64 / 1_000_000.0
}

fn emit_progress(
    control: &RenderRunControl,
    phase: RenderPhase,
    fraction_millionths: u32,
    rendered_frames: u32,
    encoded_frames: u32,
    duration_in_frames: u32,
) {
    if let Some(sink) = &control.progress {
        sink.emit(RenderProgress {
            phase,
            fraction_millionths,
            rendered_frames,
            encoded_frames,
            duration_in_frames,
        });
    }
}

fn apply_fixed_environment(command: &mut Command, staging: &Path) -> Result<()> {
    command.env_clear();
    let temporary = staging.join("tmp");
    let home = staging.join("home");
    fs::create_dir_all(&temporary).map_err(|_| RenderError::StagingUnavailable)?;
    fs::create_dir_all(&home).map_err(|_| RenderError::StagingUnavailable)?;
    command
        .env("HOME", &home)
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("TMPDIR", &temporary)
        .env("TMP", &temporary)
        .env("TEMP", &temporary)
        .env("NO_PROXY", "*")
        .env("no_proxy", "*");
    for name in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    Ok(())
}

fn spawn_group(command: &mut Command, error: RenderError) -> Result<GroupChild> {
    #[cfg(windows)]
    let result = command
        .group()
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    #[cfg(not(windows))]
    let result = command.group_spawn();
    result.map_err(|_| error)
}

fn validate_path_chain_no_links(path: &Path, error: RenderError) -> Result<()> {
    if !path.is_absolute() {
        return Err(error);
    }
    let mut cursor = PathBuf::new();
    for component in path.components() {
        cursor.push(component.as_os_str());
        if matches!(component, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        let metadata = fs::symlink_metadata(&cursor).map_err(|_| error)?;
        if is_link_or_reparse(&metadata) {
            return Err(error);
        }
    }
    Ok(())
}

struct KillOnDrop {
    child: GroupChild,
    reaped: bool,
}

impl KillOnDrop {
    const fn new(child: GroupChild) -> Self {
        Self {
            child,
            reaped: false,
        }
    }

    fn inner(&mut self) -> &mut std::process::Child {
        self.child.inner()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    fn terminate_and_wait(&mut self) {
        if self.child.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        self.reaped = true;
    }

    const fn mark_reaped(&mut self) {
        self.reaped = true;
    }
}

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if !self.reaped && self.child.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn wait_for_process(child: &mut KillOnDrop, control: &RenderRunControl) -> Result<ExitStatus> {
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| RenderError::MediaPreparationFailed)?
        {
            child.mark_reaped();
            return Ok(status);
        }
        if control.cancellation.is_cancelled() {
            child.terminate_and_wait();
            return Err(RenderError::Cancelled);
        }
        if started.elapsed() >= control.timeout {
            child.terminate_and_wait();
            return Err(RenderError::TimedOut);
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn terminate_worker(
    child: &mut KillOnDrop,
    reader: JoinHandle<Result<()>>,
    stderr: JoinHandle<std::io::Result<()>>,
    error: RenderError,
) -> Result<u64> {
    child.terminate_and_wait();
    let deadline = Instant::now() + READER_SHUTDOWN_TIMEOUT;
    while !reader.is_finished() && Instant::now() < deadline {
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    }
    let _ = reader.join();
    let _ = stderr.join();
    Err(error)
}

fn join_reader(thread: JoinHandle<Result<()>>) -> Result<Result<()>> {
    thread
        .join()
        .map_err(|_| RenderError::InvalidWorkerProtocol)
}

fn join_io(thread: JoinHandle<std::io::Result<()>>) -> Result<()> {
    thread.join().map_err(|_| RenderError::Io)??;
    Ok(())
}

fn drain(mut reader: impl Read) -> std::io::Result<()> {
    let mut buffer = [0_u8; 8 * 1024];
    while reader.read(&mut buffer)? != 0 {}
    Ok(())
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::protocol::write_json_frame;

    #[test]
    fn worker_validator_rejects_progress_regression_and_extra_terminal_messages() {
        let control = RenderRunControl::new(Duration::from_secs(1)).expect("control");
        let mut validator = WorkerValidator::new(10);
        validator
            .accept(
                &WorkerMessage::Ready {
                    protocol_version: PROTOCOL_VERSION,
                },
                &control,
            )
            .expect("ready");
        validator
            .accept(
                &WorkerMessage::Progress {
                    fraction_millionths: 500_000,
                    rendered_frames: 5,
                    encoded_frames: 0,
                    duration_in_frames: 10,
                    phase: WorkerPhase::RenderingFrames,
                },
                &control,
            )
            .expect("progress");
        assert!(
            validator
                .accept(
                    &WorkerMessage::Progress {
                        fraction_millionths: 499_999,
                        rendered_frames: 5,
                        encoded_frames: 0,
                        duration_in_frames: 10,
                        phase: WorkerPhase::RenderingFrames,
                    },
                    &control,
                )
                .is_err()
        );

        let mut validator = WorkerValidator::new(10);
        validator
            .accept(
                &WorkerMessage::Ready {
                    protocol_version: PROTOCOL_VERSION,
                },
                &control,
            )
            .expect("ready");
        validator
            .accept(&WorkerMessage::Completed { output_bytes: 100 }, &control)
            .expect("complete");
        assert!(
            validator
                .accept(&WorkerMessage::Completed { output_bytes: 100 }, &control)
                .is_err()
        );
    }

    #[test]
    fn framed_reader_rejects_unknown_fields_in_known_messages() {
        let mut bytes = Vec::new();
        write_json_frame(
            &mut bytes,
            &json!({"type":"ready","protocolVersion":1,"path":"secret"}),
            1_024,
        )
        .expect("frame");
        assert!(read_json_frame::<WorkerMessage>(&mut Cursor::new(bytes), 1_024).is_err());
    }

    #[test]
    fn verified_copy_detects_content_and_identity_changes() {
        let directory = tempfile::tempdir().expect("directory");
        let source = directory.path().join("source.bin");
        let destination = directory.path().join("destination.bin");
        fs::write(&source, b"first").expect("source");
        let input = VerifiedInput::new(source, 5, *blake3::hash(b"other").as_bytes(), "bin")
            .expect("input");
        assert!(matches!(
            copy_verified_input(
                &input,
                &destination,
                &RenderCancellationToken::default(),
                RenderError::SourceChanged,
            ),
            Err(RenderError::SourceChanged)
        ));
    }

    #[test]
    fn output_validation_requires_an_mp4_file_type_box() {
        let directory = tempfile::tempdir().expect("directory");
        let output = directory.path().join("output.mp4");
        fs::write(&output, [0_u8; 64]).expect("output");
        assert!(matches!(
            validate_render_output(&output, 64),
            Err(RenderError::InvalidOutput)
        ));
        let mut valid = vec![0_u8; 64];
        valid[..4].copy_from_slice(&24_u32.to_be_bytes());
        valid[4..8].copy_from_slice(b"ftyp");
        fs::write(&output, valid).expect("output");
        assert!(validate_render_output(&output, 64).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn node_process_paths_drop_only_the_windows_extended_length_prefix() {
        assert_eq!(
            native_process_path(Path::new(r"\\?\C:\managed\worker.mjs")).expect("drive path"),
            OsString::from(r"C:\managed\worker.mjs")
        );
        assert_eq!(
            native_process_path(Path::new(r"\\?\UNC\server\share\worker.mjs")).expect("UNC path"),
            OsString::from(r"\\server\share\worker.mjs")
        );
        assert_eq!(
            native_process_path(Path::new(r"C:\managed\worker.mjs")).expect("ordinary path"),
            OsString::from(r"C:\managed\worker.mjs")
        );
        assert!(native_process_path(Path::new("worker.mjs")).is_err());
    }
}
