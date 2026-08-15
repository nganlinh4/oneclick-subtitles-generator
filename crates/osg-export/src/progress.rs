//! What an export reports while it runs.
//!
//! Bounded in both senses that matter. Each event carries only small typed numbers — no path, no
//! cue text, no adapter string — so a progress report is as safe to log as an error is. And the
//! number of events is bounded too: progress is quantised to tenths of a percent, so a
//! million-frame export emits at most [`MAX_PROGRESS_REPORTS`] events rather than a million. A
//! progress channel that floods is a progress channel a caller has to rate-limit itself, and every
//! caller would do it differently.

/// Which part of the export a report describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ExportStage {
    /// Frames are being decoded, composed and encoded.
    Composing,
    /// Every frame has been written and the container is being closed.
    Finalizing,
}

/// The most events one export can emit.
///
/// One per tenth of a percent, plus the finalizing report. Independent of the frame count.
pub const MAX_PROGRESS_REPORTS: u32 = 1_002;

/// The finest progress step, in tenths of a percent.
const PERMILLE_FULL: u32 = 1_000;

/// One progress report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportProgress {
    stage: ExportStage,
    frames_done: u32,
    frame_count: u32,
    permille: u16,
}

impl ExportProgress {
    /// Which part of the export this describes.
    #[must_use]
    pub const fn stage(self) -> ExportStage {
        self.stage
    }

    /// How many frames have been encoded.
    #[must_use]
    pub const fn frames_done(self) -> u32 {
        self.frames_done
    }

    /// How many frames the export will encode in total.
    #[must_use]
    pub const fn frame_count(self) -> u32 {
        self.frame_count
    }

    /// Completion in tenths of a percent, `0..=1000`.
    #[must_use]
    pub const fn permille(self) -> u16 {
        self.permille
    }
}

/// Somewhere an export's progress goes.
pub trait ProgressSink {
    /// Receives one report. Called from the export's own thread, so it must not block for long.
    fn report(&mut self, progress: ExportProgress);
}

/// A sink that drops every report, for a caller that does not want any.
#[derive(Debug, Clone, Copy, Default)]
pub struct SilentProgress;

impl ProgressSink for SilentProgress {
    fn report(&mut self, _progress: ExportProgress) {}
}

/// A closure as a sink.
///
/// A wrapper rather than a blanket implementation over `FnMut`, so that [`SilentProgress`] and a
/// caller's own sink type stay unambiguous.
#[derive(Debug, Clone, Copy)]
pub struct ProgressFn<F>(pub F);

impl<F: FnMut(ExportProgress)> ProgressSink for ProgressFn<F> {
    fn report(&mut self, progress: ExportProgress) {
        (self.0)(progress);
    }
}

/// Quantises an export's frame counter into a bounded stream of reports.
pub(crate) struct ProgressReporter<'sink> {
    sink: &'sink mut dyn ProgressSink,
    frame_count: u32,
    last: Option<u16>,
}

impl core::fmt::Debug for ProgressReporter<'_> {
    /// Reports the counter, never the sink: a caller's sink may be anything at all.
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("ProgressReporter")
            .field("frame_count", &self.frame_count)
            .field("last_permille", &self.last)
            .finish_non_exhaustive()
    }
}

impl<'sink> ProgressReporter<'sink> {
    pub(crate) const fn new(sink: &'sink mut dyn ProgressSink, frame_count: u32) -> Self {
        Self {
            sink,
            frame_count,
            last: None,
        }
    }

    /// Reports that `frames_done` frames have been encoded, if the tenth of a percent has moved.
    pub(crate) fn frames(&mut self, frames_done: u32) {
        let permille = permille(frames_done, self.frame_count);
        if self.last == Some(permille) {
            return;
        }
        self.last = Some(permille);
        self.sink.report(ExportProgress {
            stage: ExportStage::Composing,
            frames_done,
            frame_count: self.frame_count,
            permille,
        });
    }

    /// Reports that every frame is written and the container is being closed.
    pub(crate) fn finalizing(&mut self) {
        self.sink.report(ExportProgress {
            stage: ExportStage::Finalizing,
            frames_done: self.frame_count,
            frame_count: self.frame_count,
            permille: u16::try_from(PERMILLE_FULL).unwrap_or(u16::MAX),
        });
    }
}

/// `floor(1000 * done / total)`, clamped, with no floating point anywhere.
fn permille(done: u32, total: u32) -> u16 {
    if total == 0 {
        return u16::try_from(PERMILLE_FULL).unwrap_or(u16::MAX);
    }
    let scaled = u64::from(done) * u64::from(PERMILLE_FULL) / u64::from(total);
    u16::try_from(scaled.min(u64::from(PERMILLE_FULL))).unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests {
    use super::{
        ExportProgress, ExportStage, MAX_PROGRESS_REPORTS, ProgressFn, ProgressReporter,
        ProgressSink, SilentProgress, permille,
    };

    #[derive(Debug, Default)]
    struct Recorder(Vec<ExportProgress>);

    impl ProgressSink for Recorder {
        fn report(&mut self, progress: ExportProgress) {
            self.0.push(progress);
        }
    }

    #[test]
    fn progress_is_integer_and_never_exceeds_full() {
        assert_eq!(permille(0, 90), 0);
        assert_eq!(permille(45, 90), 500);
        assert_eq!(permille(90, 90), 1_000);
        assert_eq!(permille(1, 3), 333);
        // Defensive: a caller that over-counts is clamped rather than reporting past the end.
        assert_eq!(permille(91, 90), 1_000);
        assert_eq!(permille(1, 0), 1_000);
    }

    #[test]
    fn a_million_frame_export_emits_a_bounded_number_of_reports() {
        // The whole reason progress is quantised. One report per frame here would be a million
        // callbacks, which every caller would then have to rate-limit differently.
        let mut recorder = Recorder::default();
        let frames = 1_000_000_u32;
        {
            let mut reporter = ProgressReporter::new(&mut recorder, frames);
            for index in 0..frames {
                reporter.frames(index + 1);
            }
            reporter.finalizing();
        }
        assert!(
            recorder.0.len() <= usize::try_from(MAX_PROGRESS_REPORTS).expect("a small bound"),
            "{} reports is more than the bound of {MAX_PROGRESS_REPORTS}",
            recorder.0.len()
        );
        // One report per tenth of a percent from zero to full, plus the finalizing report: exactly
        // the bound, and independent of the million frames underneath it.
        assert_eq!(
            recorder.0.len(),
            usize::try_from(MAX_PROGRESS_REPORTS).expect("a small bound")
        );

        let first = recorder.0.first().expect("a first report");
        assert_eq!((first.permille(), first.frames_done()), (0, 1));
        let last = recorder.0.last().expect("a last report");
        assert_eq!(last.stage(), ExportStage::Finalizing);
        assert_eq!((last.permille(), last.frames_done()), (1_000, frames));
    }

    #[test]
    fn a_short_export_reports_every_frame_it_moves_on() {
        let mut recorder = Recorder::default();
        {
            let mut reporter = ProgressReporter::new(&mut recorder, 4);
            for index in 0..4 {
                reporter.frames(index + 1);
            }
            reporter.finalizing();
        }
        let permilles: Vec<u16> = recorder
            .0
            .iter()
            .copied()
            .map(ExportProgress::permille)
            .collect();
        assert_eq!(permilles, vec![250, 500, 750, 1_000, 1_000]);
        assert!(
            recorder.0[..4]
                .iter()
                .all(|entry| entry.stage() == ExportStage::Composing)
        );
        assert!(recorder.0.iter().all(|entry| entry.frame_count() == 4));
    }

    #[test]
    fn a_closure_is_a_sink_and_silence_is_one_too() {
        let mut seen = 0_u32;
        {
            let mut sink = ProgressFn(|progress: ExportProgress| seen = progress.frames_done());
            let mut reporter = ProgressReporter::new(&mut sink, 2);
            reporter.frames(2);
        }
        assert_eq!(seen, 2);

        let mut silent = SilentProgress;
        let mut reporter = ProgressReporter::new(&mut silent, 2);
        reporter.frames(1);
        assert!(format!("{reporter:?}").contains("frame_count"));
    }
}
