//! The engine: a validated request and its staged text become a finished `MP4`.
//!
//! This is the whole of what `render_start` does at run time: it reaches
//! [`osg_export::run_export`], the crate where every parity decision the migration owns is applied.
//!
//! Three properties are structural rather than incidental, and each one is why the corresponding
//! step is written the way it is:
//!
//! * **Nothing half-written survives.** The output is written inside a [`TempDir`] this function
//!   owns, and the encoder refuses to open over an existing file and removes its own partial
//!   container. A cancelled, failed or timed-out export therefore leaves nothing anywhere that
//!   could be mistaken for a finished render, and the successful one is copied into the artifact
//!   store before the directory is dropped.
//! * **The length is the timeline's.** [`osg_export`] takes the frame count from the plan rather
//!   than from however many frames a decode produced, and the summary is checked against the same
//!   number the progress stream already told the `WebView`. A file of another length is refused, not
//!   published.
//! * **Cancellation is prompt.** The export checks its signal twice per frame, so a cancel takes
//!   effect within one frame rather than at the end of a phase.

use std::fmt;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use osg_export::{ExportCancel, ExportJob, ProgressSink, StagedText, run_export};
use osg_infrastructure::storage::ContentHash;
use osg_render::RenderRequest;
use tempfile::TempDir;

use crate::error::{CommandError, CommandResult};

use super::refusal;

/// The name the export writes inside its own staging directory.
const OUTPUT_FILE_NAME: &str = "render.mp4";

/// How long one export may run before it is stopped.
///
/// The same limit the managed worker ran under. It is a guard against a wedged pipeline, not a
/// performance budget: a legitimate multi-hour export of a long timeline finishes far inside it.
pub(crate) const RENDER_TIMEOUT: Duration = Duration::from_hours(24);

/// The stop signal for one export, and why it stopped.
///
/// One flag would not be enough: a timeout raises the same cancellation the user's own cancel does,
/// and the two are different outcomes — a cancelled job is a cancelled job, and a timed-out one is a
/// failure the user did not ask for. The second flag is what keeps them apart.
#[derive(Clone, Debug, Default)]
pub(crate) struct ExportControl {
    cancel: ExportCancel,
    timed_out: Arc<AtomicBool>,
}

impl ExportControl {
    /// Stops the export at its next frame boundary.
    pub(crate) fn cancel(&self) {
        self.cancel.cancel();
    }

    /// Stops the export and records that the time limit, not a user, stopped it.
    pub(crate) fn time_out(&self) {
        self.timed_out.store(true, Ordering::Release);
        self.cancel.cancel();
    }

    /// Whether the export has been stopped, for any reason.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// Whether the export was stopped by the time limit rather than by a cancellation.
    pub(crate) fn is_timed_out(&self) -> bool {
        self.timed_out.load(Ordering::Acquire)
    }

    /// Whether a user's cancellation, rather than the time limit, stopped this export.
    pub(crate) fn is_user_cancelled(&self) -> bool {
        self.is_cancelled() && !self.is_timed_out()
    }

    /// The signal the export loop itself polls.
    fn token(&self) -> ExportCancel {
        self.cancel.clone()
    }
}

/// Everything one export needs that the command already resolved.
///
/// The paths are trusted, resolved locations that never cross the `WebView` boundary: they are
/// consumed here and never appear in an event, a refusal or a `Debug` rendering.
pub(crate) struct NativeExportInputs {
    /// The request the `WebView` sent, revalidated against the source by the export itself.
    pub(crate) request: RenderRequest,
    /// The source video, which is also the original-audio source.
    pub(crate) source: PathBuf,
    /// The narration track, when the project has one.
    pub(crate) narration: Option<PathBuf>,
    /// Where this export may create its own staging directory.
    pub(crate) staging_root: PathBuf,
    /// The output frame rate the validated plan resolved.
    pub(crate) fps: u16,
    /// The frame count the validated plan resolved, which is the length the file must have.
    pub(crate) duration_in_frames: u32,
}

impl fmt::Debug for NativeExportInputs {
    /// Redacted on purpose: these inputs hold three filesystem locations.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeExportInputs")
            .field("lyrics", &self.request.lyrics.len())
            .field("has_narration", &self.narration.is_some())
            .field("fps", &self.fps)
            .field("duration_in_frames", &self.duration_in_frames)
            .finish_non_exhaustive()
    }
}

/// A finished export, still in its own staging directory.
///
/// Holding one means the file exists, is the length the timeline named, and has been measured. It
/// is removed when this value is dropped, so the only way it outlives the job is to be copied into
/// the artifact store first.
pub(crate) struct NativeExport {
    staging: TempDir,
    output: PathBuf,
    size_bytes: u64,
    content_hash: [u8; 32],
    width: u32,
    height: u32,
    fps: u16,
    duration_in_frames: u32,
}

impl NativeExport {
    pub(crate) fn path(&self) -> &Path {
        &self.output
    }

    pub(crate) const fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    pub(crate) const fn content_hash(&self) -> &[u8; 32] {
        &self.content_hash
    }

    pub(crate) const fn width(&self) -> u32 {
        self.width
    }

    pub(crate) const fn height(&self) -> u32 {
        self.height
    }

    pub(crate) const fn fps(&self) -> u16 {
        self.fps
    }

    pub(crate) const fn duration_in_frames(&self) -> u32 {
        self.duration_in_frames
    }

    /// Gives up the staging directory, removing the exported file.
    ///
    /// Explicit as well as automatic: the publication path drops this the moment the copy is
    /// verified, rather than holding a second copy of a large file until the job's task unwinds.
    pub(crate) fn discard(self) {
        drop(self.staging);
    }
}

impl fmt::Debug for NativeExport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeExport")
            .field("output", &"<redacted>")
            .field("size_bytes", &self.size_bytes)
            .field("content_hash", &"<redacted>")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("fps", &self.fps)
            .field("duration_in_frames", &self.duration_in_frames)
            // The staging directory is a filesystem location, so it is not among the fields.
            .finish_non_exhaustive()
    }
}

/// Runs one export to completion, reporting through `progress`.
///
/// Blocking: it decodes, composes and encodes on the calling thread, which is why the command runs
/// it on a blocking task.
///
/// # Errors
/// Returns [`refusal::staging_unavailable`] when the export cannot claim a directory of its own,
/// [`refusal::cancelled`] or [`refusal::timed_out`] when it was stopped, [`refusal::output_invalid`]
/// when the finished file is not the length the timeline named, and otherwise the pipeline's own
/// typed refusal. Every one of them leaves no output behind.
pub(crate) fn run(
    inputs: NativeExportInputs,
    text: StagedText,
    control: &ExportControl,
    progress: &mut dyn ProgressSink,
) -> CommandResult<NativeExport> {
    let NativeExportInputs {
        request,
        source,
        narration,
        staging_root,
        fps,
        duration_in_frames,
    } = inputs;
    let staging = TempDir::new_in(&staging_root).map_err(|_| refusal::staging_unavailable())?;
    let output = staging.path().join(OUTPUT_FILE_NAME);

    let summary = run_export(
        ExportJob {
            request,
            source: source.as_path(),
            narration: narration.as_deref(),
            output: output.as_path(),
            text,
            cancel: control.token(),
        },
        progress,
    )
    .map_err(|error| stopped(control).unwrap_or_else(|| refusal::from_export(&error)))?;

    // The length is the timeline's, and the `WebView` was told that number before the first frame
    // was drawn. A file of another length is refused rather than published under it.
    if summary.frames() != duration_in_frames || summary.file_bytes() == 0 {
        return Err(refusal::output_invalid());
    }
    let (size_bytes, content_hash) = measure(&output)?;
    if size_bytes != summary.file_bytes() {
        return Err(refusal::output_invalid());
    }
    Ok(NativeExport {
        staging,
        output,
        size_bytes,
        content_hash,
        width: summary.width(),
        height: summary.height(),
        fps,
        duration_in_frames,
    })
}

/// The refusal a stop signal implies, or `None` when nothing stopped this export.
///
/// Asked before the pipeline's own error is classified, because a decode that fails *because* the
/// source was released on cancellation must still be reported as a cancellation.
fn stopped(control: &ExportControl) -> Option<CommandError> {
    if control.is_timed_out() {
        Some(refusal::timed_out())
    } else if control.is_cancelled() {
        Some(refusal::cancelled())
    } else {
        None
    }
}

/// The finished file's size and content hash, read once.
///
/// The same hash the artifact store addresses content by, computed here so the publication step can
/// prove that what it copied is what the export wrote.
fn measure(output: &Path) -> CommandResult<(u64, [u8; 32])> {
    let file = File::open(output).map_err(|_| refusal::output_invalid())?;
    let size_bytes = file
        .metadata()
        .map(|metadata| metadata.len())
        .map_err(|_| refusal::output_invalid())?;
    let hash =
        ContentHash::digest_reader(BufReader::new(file)).map_err(|_| refusal::output_invalid())?;
    Ok((size_bytes, *hash.as_bytes()))
}
