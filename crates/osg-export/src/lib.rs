//! Turns a validated OSG render request into a finished `MP4`.
//!
//! This is the stage that makes the native renderer runnable. Everything it needs already exists
//! and none of it is reimplemented here:
//!
//! | Crate | What it owns |
//! | --- | --- |
//! | `osg-render` | The validated `RenderRequest` the `WebView` already sends. |
//! | `osg-scene` | Exact rational time, cue selection, easing, animation, layout, colour, the scene contract, the glyph-atlas mirror. |
//! | `osg-compositor` | Composition over a video underlay, with crop, flip and canvas backfill. |
//! | `osg-decode` | Frame-exact source decoding through the operating system's own codecs. |
//! | `osg-encode` | `H.264`/`AAC` `MP4`, full-range `BT.709`, correctly timed. |
//! | `osg-audio` | Deterministic decode, resample, fold-down and mix. |
//!
//! What this crate adds is the conversion and the loop.
//!
//! # The conversion is the point
//!
//! [`ExportPlan::convert`] is the single place every parity decision in
//! `src/platform/renderParityLedger.js` that this stage owns is applied, which is what makes those
//! decisions reviewable in one directory instead of scattered through a renderer. Two of them are
//! deliberate visible changes the ledger already records:
//!
//! * **`trimStart`.** The shipped renderer trims the video but passes cue timestamps absolute and
//!   never rebases them, so any `trimStart` above zero shifts every subtitle in the exported file.
//!   Here the scene timeline starts at zero and a cue at absolute `t` lands at `t - trimStart`, so
//!   subtitles land where the editor showed them. The narration track is trimmed by the same
//!   window, because it is generated from the same absolute cue times.
//! * **`DURATION_SOURCE`.** The shipped renderer takes the final duration from however many frames
//!   extraction happened to produce. Here it comes from the timeline:
//!   [`ExportPlan::frame_count`] is `ceil((trimEnd - trimStart) * fps)` and it is the frame count
//!   of the scene, the decoder's grid, the encoder configuration and the audio mix. A source that
//!   ends first is a reported truncation, not a shorter file.
//!
//! Two more are settled in the same directory and are not visible changes:
//!
//! * **`aspectRatio`.** The output frame is derived once, from the resolution height and the crop
//!   region, and the persisted `crop.aspectRatio` is deliberately not read — the editor's
//!   aspect-ratio buttons reshape the crop rectangle instead of writing that field, so the ratio is
//!   already a property of the rectangle and reading it again would apply it twice.
//! * **`canvasBgColor`.** An export carries no alpha, so the canvas backfill is opaque before a
//!   frame is composed: an unset backfill composites onto [`EXPORT_CANVAS_GROUND`], and a colour
//!   carrying alpha is refused before the source is even opened rather than encoded darker than it
//!   previewed.
//!
//! # Determinism
//!
//! The same request produces the same frames. Encoded bytes are not bit-reproducible — hardware
//! encoders differ between vendors and driver versions — so the contract binds the composited
//! frames, which is what [`FrameRenderer`] produces and what the suite asserts on.
//!
//! # Progress and cancellation
//!
//! Progress is a bounded stream of typed events: quantised to tenths of a percent, so a
//! million-frame export emits at most [`MAX_PROGRESS_REPORTS`] of them, and carrying only small
//! numbers. Cancellation is checked twice per frame rather than once per phase, and a cancelled
//! export leaves no output: the encoder refuses to open over an existing file and removes its own
//! partial container.
//!
//! # Failure
//!
//! Every failure is a typed [`ExportError`] that carries no path, no credential and no subtitle
//! text. A missing font, an atlas that cannot support cell-advance layout, an unreadable source and
//! a full volume are each their own variant.
//!
//! The crate contains no `unsafe` code, in line with the workspace's `unsafe_code = "forbid"`.
//!
//! ```no_run
//! use osg_export::{ExportCancel, ExportJob, SilentProgress, run_export};
//! # use std::path::Path;
//! # fn main() -> Result<(), osg_export::ExportError> {
//! # fn staged() -> (osg_render::RenderRequest, osg_export::StagedText) { unimplemented!() }
//! let (request, text) = staged();
//! let summary = run_export(
//!     ExportJob {
//!         request,
//!         source: Path::new(r"C:\media\opaque-id.mp4"),
//!         narration: None,
//!         output: Path::new(r"C:\exports\opaque-id.mp4"),
//!         text,
//!         cancel: ExportCancel::new(),
//!     },
//!     &mut SilentProgress,
//! )?;
//! println!("{} frames", summary.frames());
//! # Ok(())
//! # }
//! ```

mod cancel;
mod convert;
mod error;
mod frames;
mod media;
mod progress;
mod run;
mod stage;

pub use cancel::ExportCancel;
pub use convert::{
    AUDIO_BITRATE_KBPS, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE_HZ, AudioPlan, EXPORT_CANVAS_GROUND,
    ExportPlan, primary_font_family,
};
pub use error::ExportError;
pub use frames::FrameRenderer;
pub use progress::{
    ExportProgress, ExportStage, MAX_PROGRESS_REPORTS, ProgressFn, ProgressSink, SilentProgress,
};
pub use run::{ExportJob, ExportSummary, probe_source, run_export};
pub use stage::StagedText;
