//! The typewriter reveal: how much of a staged run is on screen yet.
//!
//! # The two decisions, stated rather than discovered
//!
//! **It cuts at a cluster boundary, not at a UTF-16 code unit.** The shipped renderer reveals
//! `text.substring(0, floor(text.length * progress))`, which counts UTF-16 code units and can
//! therefore split a surrogate pair — half an emoji, drawn as whatever the browser makes of a lone
//! surrogate. This crate cannot reproduce that even in principle: the atlas is rasterized per
//! grapheme cluster, so half a cluster has no cell and no ink. So the reveal counts the same UTF-16
//! units, from [`typewriter_utf16_length`], and then draws whole cells: a cell appears once **all**
//! of its code units are revealed. On text that stays inside the basic plane the two are identical,
//! which is every shipped preset's example text; on an astral cluster ours reveals the character
//! one frame later than the shipped renderer revealed half of it.
//!
//! **The measure is the laid-out run, not the source string.** The reveal is proportional to the
//! cells the layout placed, so it is monotonic and reaches exactly nothing at zero and exactly
//! everything at one. The shipped renderer measured the raw string, which also counts the newlines
//! it then rendered as line breaks and is unaffected by a case transform that changes length. Both
//! differences move the reveal by at most a cluster or two on text that has hard line breaks or a
//! length-changing uppercase, and the alternative — counting units the run does not draw — would
//! make a partially revealed frame depend on characters that are not on screen.
//!
//! # What is deliberately not reproduced
//!
//! The shipped background box wraps the revealed text, so it grows as the text appears. Reproducing
//! that would mean re-measuring and re-wrapping the prefix, which is a second layout — the thing
//! this wave exists to remove. The box here is the full run's box from the first frame.
//!
//! The reveal is driven by the **raw** fade progress, not the eased one: `getTypewriterText` takes
//! `animationProgress` where `getAnimationTransform` takes `easedProgress`, and reproducing the
//! easing here would make every cue type at the wrong speed.

use osg_scene::animation::typewriter_utf16_length;
use osg_scene::glyph::GlyphAtlasDescriptor;

use crate::run::CueRun;

/// How many of a run's cells are revealed at `progress`, in draw order.
///
/// `progress` is the cue's own fade-in progress, unclamped and unchecked:
/// [`typewriter_utf16_length`] fails closed on anything that is not a finite fraction.
pub(crate) fn revealed_cells(atlas: &GlyphAtlasDescriptor, run: &CueRun, progress: f64) -> usize {
    let lengths = || {
        run.lines()
            .iter()
            .flat_map(|line| line.glyphs().iter())
            .map(|index| cluster_utf16_len(atlas, *index))
    };
    let revealed = typewriter_utf16_length(lengths().sum(), progress);

    let mut used = 0_usize;
    let mut cells = 0_usize;
    for length in lengths() {
        match used.checked_add(length) {
            Some(next) if next <= revealed => used = next,
            _ => break,
        }
        cells += 1;
    }
    cells
}

/// One cell's length in UTF-16 code units, which is what the shipped truncation counted.
fn cluster_utf16_len(atlas: &GlyphAtlasDescriptor, index: u32) -> usize {
    usize::try_from(index)
        .ok()
        .and_then(|index| atlas.glyphs().get(index))
        .map_or(0, |cell| cell.cluster.encode_utf16().count())
}
