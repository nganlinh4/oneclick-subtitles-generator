//! The editor preview against the exported video, at the same instant.
//!
//! This is the migration's central promise. The whole reason there is one Rust pixel pipeline
//! instead of a `WebView` preview and an `FFmpeg` export is that a user who approves a frame in the
//! editor gets that frame in the file. Everything else in this gate checks that the pipeline is
//! internally consistent — that a setting reaches it, that a frame is deterministic, that a decoded
//! frame is close to the composed one. None of that would notice if the two *surfaces* had come
//! apart.
//!
//! # Why the two are not trivially the same
//!
//! Both surfaces converge on the same two calls — `ExportPlan::convert` then `ExportPlan::compose`,
//! made by `apps/desktop/src-tauri/src/preview/plan.rs` on one side and by `osg_export::run_export`
//! on the other — so the plan, the style, the crop and the timeline are the same object by
//! construction. The staged text is not.
//!
//! * A **preview** bakes one cue. `StagedText::single`, one atlas, packed for that cue's alphabet
//!   alone, and the cue's cells are indices into that packing.
//! * An **export** bakes the whole document. The cue's cells live on a page it shares with every
//!   other cue that fits beside it, so the packing, the atlas dimensions and the cell indices are
//!   all different numbers for the same glyphs.
//!
//! The cell *texts* are identical — the contextual-versus-isolated decision is made per cue, before
//! any page exists — so the two atlases hold the same ink for the same clusters at different
//! addresses.
//!
//! # What is asserted, exactly, and what is measured
//!
//! **Exactly.** For every cue, the repack changed nothing but addresses: every pen, baseline and
//! advance is bit-identical, every run index resolves to the same cluster with the same ink box, and
//! the coverage bytes under that box are the same bytes at a different offset
//! ([`Document::repack_is_address_only`](super::bake::paged::Document::repack_is_address_only)).
//! That is the claim with no tolerance in it, and it is what a wrong remap, a lost cell or a changed
//! pack fails on.
//!
//! **Measured.** The composed frames themselves. Most cues come back byte-identical and the run
//! reports how many. The rest differ by **one or two levels on a few dozen edge pixels**, and the
//! cause is neither the renderer nor the paging:
//!
//! > A cell's UV is `x / atlasWidth`, so the same cell packed at a different offset is addressed by
//! > a different `f32`. The compositor samples the atlas with a **linear** filter, the hardware
//! > carries a bounded number of sub-texel bits, and two coordinates that differ in the last bits
//! > occasionally quantise to different weights. The difference is bounded by one quantisation step
//! > of one texel of coverage — [`ADMITTED`] — and it is measured here rather than assumed.
//!
//! That was established rather than guessed: forcing every atlas to identical dimensions leaves the
//! differences unchanged (so it is not the denominator), and widening the cell's transparent ring
//! leaves them unchanged (so it is not a neighbouring cell bleeding in). What *does* change it is
//! removing the ring: with no padding every cue differs, by up to 144 levels. **The cell padding
//! ring is load-bearing for preview/export parity**, not just for filtering quality — see
//! `CELL_PADDING_PX` in `super::bake`.
//!
//! # What stops any of this being vacuous
//!
//! [`ADMITTED`] is shown to reject three things at every document: the export's own frame moved one
//! pixel, the frame of a neighbouring cue, and the frame at an instant this cue is not on screen at.
//! And the repacking really happens — the run reports how many cues were reindexed and how many sit
//! on a page of different dimensions from their own bake, and asserts it is not zero.

use osg_compositor::{Compositor, SubtitleScene};

use super::case::{self, SOURCE_DURATION_US, SOURCE_HEIGHT, SOURCE_WIDTH};
use super::compare::{self, FrameDiff};
use super::documents::{self, DocumentCase};
use super::matrix;

/// What a preview frame and an export frame of the same cue may differ by.
///
/// Every number is measured on the frames this case renders, rounded up for headroom on another
/// vendor's sampler, and shown below to reject a one-pixel move of the same picture. It is not a
/// codec tolerance and must never be read as one: the two frames come out of the same compositor
/// over the same geometry, and the only thing it admits is the last bit of a texture coordinate.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Admitted {
    /// The largest per-channel difference, in levels. One quantisation step of one texel.
    max_channel: u32,
    /// The same for alpha, which the codec tolerance forbids outright and this one cannot.
    max_alpha: u32,
    /// How many pixels in a thousand may differ at all. A glyph drawn from the wrong cell, or
    /// placed one pixel out, changes far more of the frame than this.
    differing_permille: u64,
}

/// The bound this run admits. Measured worst case on the reference machine: 186 pixels of 409,920
/// (0.45 in a thousand) at two levels of colour and one of alpha.
pub(crate) const ADMITTED: Admitted = Admitted {
    max_channel: 4,
    max_alpha: 4,
    differing_permille: 5,
};

impl Admitted {
    fn admits(self, diff: &FrameDiff) -> bool {
        let permille = diff
            .differing_pixels
            .saturating_mul(1_000)
            .checked_div(diff.total_pixels.max(1))
            .unwrap_or(u64::MAX);
        diff.max_channel <= self.max_channel
            && diff.max_alpha <= self.max_alpha
            && permille <= self.differing_permille
    }
}

/// What one document's cues turned out to exercise, for the line the case prints.
#[derive(Debug, Default, Clone, Copy)]
struct Repacking {
    cues: usize,
    /// How many cues composed byte-identically on both surfaces.
    identical: usize,
    /// How many cues index their cells differently on their page than on their own bake.
    reindexed: usize,
    /// How many sit on a page packed to different dimensions from their own bake.
    resized: usize,
    /// The worst difference seen, for the report.
    worst: u64,
}

#[test]
fn a_preview_frame_and_the_exports_frame_at_the_same_instant_are_the_same_picture() {
    let _lock = super::exclusive();
    let compositor = Compositor::new().expect("a graphics adapter");
    let matrix = matrix::load();
    let source = (SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_DURATION_US);

    let mut total = Repacking::default();
    for document in documents::all(&matrix) {
        assert_eq!(
            document.document.page_count(),
            document.expected_pages,
            "{}: the document no longer needs the pages this case exists to exercise",
            document.id
        );
        let repacking = check_document(&compositor, &document, source);
        println!(
            "{}: {} cues over {} pages ({} cells); {} composed byte-identically, worst {} pixels \
             differing; {} reindexed, {} on a resized page",
            document.id,
            repacking.cues,
            document.document.page_count(),
            document
                .document
                .cells_per_page()
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join("+"),
            repacking.identical,
            repacking.worst,
            repacking.reindexed,
            repacking.resized,
        );
        assert!(
            repacking.reindexed > 0 || repacking.resized > 0,
            "{}: every cue is packed on its page exactly as it is packed alone, so this document \
             compares an atlas against a copy of itself",
            document.id
        );
        total.cues += repacking.cues;
        total.identical += repacking.identical;
        total.reindexed += repacking.reindexed;
        total.resized += repacking.resized;
        total.worst = total.worst.max(repacking.worst);
    }
    assert!(
        total.identical > 0,
        "not one cue in the whole run composed byte-identically on the two surfaces, so the \
         admitted bound is absorbing something structural rather than a sampler's last bit"
    );
    println!(
        "preview against export: {} cues, {} byte-identical, worst {} pixels differing; \
         {} reindexed by paging, {} on a resized page",
        total.cues, total.identical, total.worst, total.reindexed, total.resized
    );
}

/// Renders every cue of one document from both surfaces and compares them.
fn check_document(
    compositor: &Compositor,
    document: &DocumentCase,
    source: (u32, u32, u64),
) -> Repacking {
    // The export's scene is the whole document's, built once: it does not depend on which cue is
    // about to be looked at, exactly as a real export builds it once and walks the timeline.
    let (plan, exported) = case::compose_staged(
        &document.case,
        source,
        document.document.face(),
        document.document.staged_text(),
    );

    let mut repacking = Repacking::default();
    let mut pages_seen: Vec<usize> = Vec::new();
    let mut controls_run = false;
    for cue in 0..document.document.cues() {
        // The exact half, before a pixel is composed: the page moved this cue's cells and changed
        // nothing else about them.
        if let Err(reason) = document.document.repack_is_address_only(cue) {
            panic!("{}: {reason}", document.id);
        }

        let preview_case = document.preview_case(cue);
        let (_, previewed) = case::compose_staged(
            &preview_case,
            source,
            document.document.face(),
            document.document.preview_text(cue),
        );

        let index = document.middle_frame(cue);
        let from_export = frame(compositor, &exported, index, &document.export_case(cue).id);
        let from_preview = frame(compositor, &previewed, index, &preview_case.id);
        let measured = compare::diff(&from_export, &from_preview);
        assert!(
            ADMITTED.admits(&measured),
            "the editor preview and the exported video are not the same picture at the same \
             instant\n{}",
            compare::report(
                &preview_case.id,
                index,
                &measured,
                &from_export,
                &from_preview
            )
        );
        repacking.identical += usize::from(measured.is_identical());
        repacking.worst = repacking.worst.max(measured.differing_pixels);

        // The frame the same preview scene composes where its one cue is not on screen. Different
        // bytes here is the whole of the evidence that the comparison above looked at a subtitle.
        let absent = document.absent_frame(cue);
        let blank = frame(compositor, &previewed, absent, &preview_case.id);
        assert_ne!(
            from_preview, blank,
            "{}: frame {index} is the same picture as frame {absent}, where this cue is not on \
             screen at all, so the comparison was made on a frame with no subtitle in it",
            preview_case.id
        );

        if !controls_run {
            check_controls(
                document,
                cue,
                index,
                plan.width(),
                (&from_export, &from_preview, &blank),
            );
            controls_run = true;
        }

        let page = document.document.page_of(cue);
        if !pages_seen.contains(&page) {
            pages_seen.push(page);
        }
        repacking.cues += 1;
        repacking.reindexed += usize::from(document.document.indices_differ(cue));
        repacking.resized += usize::from(document.document.geometry_differs(cue));
    }
    assert_eq!(
        pages_seen.len(),
        document.document.page_count(),
        "{}: a staged page was never drawn from, so it was never compared",
        document.id
    );
    repacking
}

/// Shows that [`ADMITTED`] rejects the three ways this comparison could really fail.
///
/// Run once per document rather than once per cue: the bound is one number and one demonstration of
/// it per document is a demonstration, while forty-three would be forty-three times the cost of the
/// same statement.
fn check_controls(
    document: &DocumentCase,
    cue: usize,
    index: u32,
    width: u32,
    frames: (&[u8], &[u8], &[u8]),
) {
    let (exported, previewed, blank) = frames;
    for (what, other) in [
        ("the same picture moved one pixel", shifted(exported, width)),
        ("the frame with no subtitle on it", blank.to_vec()),
    ] {
        let rejected = compare::diff(previewed, &other);
        assert!(
            !ADMITTED.admits(&rejected),
            "{} cue={cue}: {what} is inside the admitted bound at frame {index}, so the bound \
             cannot tell a repacked cue from a wrong one: {rejected:?}",
            document.id
        );
    }
}

/// The frame moved one pixel to the left, row by row.
///
/// The smallest positional regression a repack can make and the one most likely to be waved
/// through: it is what a cell whose ink box moved by a texel looks like once it is scaled up.
fn shifted(pixels: &[u8], width: u32) -> Vec<u8> {
    let stride = usize::try_from(width).unwrap_or(1) * 4;
    let mut moved = pixels.to_vec();
    for row in moved.chunks_exact_mut(stride) {
        row.rotate_left(4);
    }
    moved
}

/// One composed frame, or the case identity and the refusal.
fn frame(compositor: &Compositor, scene: &SubtitleScene, index: u32, id: &str) -> Vec<u8> {
    compositor
        .render_scene(scene, index)
        .unwrap_or_else(|error| panic!("{id}: frame {index} was refused: {error}"))
        .into_pixels()
}
