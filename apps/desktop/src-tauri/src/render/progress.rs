//! What a running export tells the `WebView` and the durable job registry.
//!
//! The export's own stream is already bounded — quantised to tenths of a percent, so even a
//! million-frame render emits at most a thousand reports — and this module narrows it once more, to
//! the durable job's own step, so a long render does not write a settings row per tenth of a
//! percent. What survives both filters is a phase change or a real move.
//!
//! Three invariants belong to this file, because `renderService.js` treats a breach of any of them
//! as a protocol error and abandons the render:
//!
//! * **Monotonic.** The fraction never falls, the phase never moves backwards, and the frame counts
//!   never fall within a phase. The export's reporter is monotonic by construction and the mapping
//!   below is order-preserving, so this holds without a clamp.
//! * **Bounded above.** Composing tops out at 95% of the job's progress, publication takes it to
//!   97.5%, and the terminal transition finishes it. Nothing reports a finished job before it is.
//! * **One duration.** Every event carries the frame count the plan resolved, which is the number
//!   the first event carried, because the `WebView` refuses an event that names a different one.
//!
//! It is also the place a render notices it has been cancelled from outside: the job leaving
//! `Running` between two frames stops the export rather than being discovered at the end.

use std::time::Instant;

use osg_domain::{JobId, JobProgress, JobState, JobUpdate};
use osg_export::{ExportProgress, ExportStage, ProgressSink};
use tauri::ipc::Channel;

use crate::background;
use crate::diagnostics;

use super::events::{RenderEvent, RenderPhaseResponse};
use super::export::ExportControl;

/// The most of the job's progress bar composing may claim.
const RENDER_PROGRESS_MAX_BASIS_POINTS: u16 = 9_500;
/// Where publication sits, between the last composed frame and the terminal transition.
pub(super) const PUBLISHING_BASIS_POINTS: u16 = 9_750;
/// The smallest move worth a durable write.
const PROGRESS_STEP_BASIS_POINTS: u16 = 10;
/// Tenths of a percent to millionths, which is the unit the `WebView` reads.
const MILLIONTHS_PER_PERMILLE: u32 = 1_000;

/// One progress report, in the vocabulary the `WebView` reads.
#[derive(Debug, Clone, Copy)]
pub(super) struct RenderProgressReport {
    pub(super) phase: RenderPhaseResponse,
    pub(super) fraction_millionths: u32,
    pub(super) rendered_frames: u32,
    pub(super) encoded_frames: u32,
    pub(super) duration_in_frames: u32,
}

impl RenderProgressReport {
    /// The export's own report, mapped onto the frozen phase vocabulary.
    ///
    /// The native export composes and encodes each frame in one pass, so a frame that has been
    /// rendered has also been encoded: the two counts are deliberately the same number rather than
    /// one being invented to look like a pipeline that no longer exists.
    pub(super) fn from_export(progress: ExportProgress) -> Self {
        let phase = match progress.stage() {
            ExportStage::Finalizing => RenderPhaseResponse::Muxing,
            // Composing, and anything a later export gains: the frame loop is where a stage that
            // does not exist yet would sit, and the sink below clamps the order regardless.
            _ => RenderPhaseResponse::RenderingFrames,
        };
        Self {
            phase,
            fraction_millionths: u32::from(progress.permille()) * MILLIONTHS_PER_PERMILLE,
            rendered_frames: progress.frames_done(),
            encoded_frames: progress.frames_done(),
            duration_in_frames: progress.frame_count(),
        }
    }
}

/// What has already been reported, so a repeat is not reported twice.
#[derive(Debug, Default)]
struct ProgressState {
    basis_points: u16,
    phase: Option<RenderPhaseResponse>,
    logged_bucket: u16,
}

/// The export's progress sink: durable job progress, one channel event, and a bounded log.
pub(super) struct ExportProgressSink {
    jobs: background::DesktopJobs,
    job_id: JobId,
    channel: Channel<RenderEvent>,
    control: ExportControl,
    started: Instant,
    /// The frame count the validated plan resolved, which the first event already named.
    duration_in_frames: u32,
    state: ProgressState,
}

impl std::fmt::Debug for ExportProgressSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExportProgressSink")
            .field("job", &self.job_id)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

impl ExportProgressSink {
    pub(super) fn new(
        jobs: background::DesktopJobs,
        job_id: JobId,
        channel: Channel<RenderEvent>,
        control: ExportControl,
        started: Instant,
        duration_in_frames: u32,
    ) -> Self {
        Self {
            jobs,
            job_id,
            channel,
            control,
            started,
            duration_in_frames,
            state: ProgressState::default(),
        }
    }
}

impl ProgressSink for ExportProgressSink {
    fn report(&mut self, progress: ExportProgress) {
        self.publish(RenderProgressReport::from_export(progress));
    }
}

impl ExportProgressSink {
    /// Records one report durably and emits it, unless it says nothing new.
    ///
    /// Two invariants are enforced here rather than assumed, because the `WebView` abandons a render
    /// that breaches either: the phase never moves backwards, and every event names the one frame
    /// count the first event named. The second matters because the export re-validates the request
    /// against the source itself, and a source that changed underneath the two probes could
    /// otherwise emit a stream describing a different timeline. That export is refused when it
    /// finishes; until then the stream stays consistent.
    fn publish(&mut self, mut report: RenderProgressReport) {
        if let Some(previous) = self.state.phase
            && previous.rank() > report.phase.rank()
        {
            report.phase = previous;
        }
        report.duration_in_frames = self.duration_in_frames;
        report.rendered_frames = report.rendered_frames.min(self.duration_in_frames);
        report.encoded_frames = report.encoded_frames.min(self.duration_in_frames);
        let basis_points = basis_points(report.fraction_millionths);
        let phase_changed = self.state.phase != Some(report.phase);
        if !phase_changed
            && basis_points
                < self
                    .state
                    .basis_points
                    .saturating_add(PROGRESS_STEP_BASIS_POINTS)
        {
            return;
        }
        let Ok(current) = self.jobs.get(self.job_id) else {
            self.control.cancel();
            return;
        };
        // The job leaving `Running` is how a cancellation from anywhere else reaches the export.
        if current.snapshot().state() != JobState::Running {
            self.control.cancel();
            return;
        }
        let job = if basis_points > current.snapshot().progress().basis_points() {
            let Ok(progress_value) = JobProgress::from_basis_points(basis_points) else {
                self.control.cancel();
                return;
            };
            let Ok(ticket) = self
                .jobs
                .apply(self.job_id, JobUpdate::ReportProgress(progress_value))
            else {
                self.control.cancel();
                return;
            };
            ticket.snapshot().clone()
        } else {
            current.snapshot().clone()
        };
        self.state.basis_points = self.state.basis_points.max(basis_points);
        self.state.phase = Some(report.phase);
        self.log(report, basis_points, phase_changed);
        let _ = self.channel.send(RenderEvent::Progress {
            job,
            phase: report.phase,
            fraction_millionths: report.fraction_millionths,
            rendered_frames: report.rendered_frames,
            encoded_frames: report.encoded_frames,
            duration_in_frames: report.duration_in_frames,
        });
    }

    /// One diagnostic per phase change and per five percent, and never more.
    fn log(&mut self, report: RenderProgressReport, basis_points: u16, phase_changed: bool) {
        let bucket = basis_points / 500;
        if !phase_changed && bucket <= self.state.logged_bucket {
            return;
        }
        record_progress(self.job_id, report, basis_points, self.started);
        self.state.logged_bucket = self.state.logged_bucket.max(bucket);
    }
}

/// The job's progress bar position for a fraction of the composing work.
fn basis_points(fraction_millionths: u32) -> u16 {
    u16::try_from(
        u64::from(RENDER_PROGRESS_MAX_BASIS_POINTS) * u64::from(fraction_millionths.min(1_000_000))
            / 1_000_000,
    )
    .unwrap_or(RENDER_PROGRESS_MAX_BASIS_POINTS)
}

/// One `render.progress` diagnostic. Small numbers only: no path, no cue text, no adapter string.
pub(super) fn record_progress(
    job_id: JobId,
    report: RenderProgressReport,
    basis_points: u16,
    started: Instant,
) {
    diagnostics::record(
        "render.progress",
        &[
            ("job", job_id.to_string()),
            ("phase", report.phase.diagnostic_name().to_owned()),
            ("elapsedMs", elapsed_millis(started)),
            ("progressBasisPoints", basis_points.to_string()),
            ("renderedFrames", report.rendered_frames.to_string()),
            ("encodedFrames", report.encoded_frames.to_string()),
            ("durationFrames", report.duration_in_frames.to_string()),
        ],
    );
}

pub(super) fn elapsed_millis(started: Instant) -> String {
    started.elapsed().as_millis().to_string()
}

#[cfg(test)]
mod tests {
    use super::{PUBLISHING_BASIS_POINTS, RENDER_PROGRESS_MAX_BASIS_POINTS, basis_points};

    /// [`ExportProgress`](osg_export::ExportProgress) has no constructor outside its own crate, and
    /// that is right: a report exists because an export produced it. The mapping is therefore
    /// asserted against reports a real export emitted, in `super::super::tests`; what is left here
    /// is the arithmetic, which owns the two bounds the `WebView` enforces.
    #[test]
    fn the_progress_bar_is_bounded_below_publication() {
        assert_eq!(basis_points(0), 0);
        assert_eq!(basis_points(500_000), 4_750);
        assert_eq!(basis_points(1_000_000), RENDER_PROGRESS_MAX_BASIS_POINTS);
        // Defensive: a caller that over-reports is clamped rather than reporting past the end.
        assert_eq!(basis_points(2_000_000), RENDER_PROGRESS_MAX_BASIS_POINTS);
        const { assert!(RENDER_PROGRESS_MAX_BASIS_POINTS < PUBLISHING_BASIS_POINTS) }
        const { assert!(PUBLISHING_BASIS_POINTS < 10_000) }
    }
}
