//! The multi-cue documents the paging cases are built from.
//!
//! Everything else in this gate renders **one** cue: the matrix is a table of presets, fields, texts
//! and output shapes, and one cue is enough to judge any of them. Paging is the one thing one cue
//! cannot show. A page is a property of a whole cue list — which cues share an alphabet, which share
//! a resolved alignment, where the cell budget runs out — so the cases that exercise it need
//! documents rather than lines, and the matrix does not carry documents.
//!
//! So the cue lists are built here, from a stated rule rather than from invented prose:
//!
//! * The **matrix's own texts**, one per cue, where a document only needs several distinct lines.
//! * A **run of a Unicode block**, where a document has to be large enough to fill a page. Korean
//!   syllables are the case `glyphAtlasPaging.js` names first, and they are the case a Latin
//!   document can never reach: the alphabet keeps growing with the track instead of saturating.
//!
//! Timing is uniform and deliberately coarse: one cue every [`CUE_STEP_US`], which is exactly three
//! frames at [`FRAME_RATE`], with both fade windows at zero. That makes each cue's **middle frame**
//! unambiguously its own — no fade window from a neighbour reaches it, and `active_cue_at`'s
//! first-match-wins rule cannot hand the frame to an earlier cue — which is what lets a frame of the
//! whole document be compared against the same frame of one cue on its own.

use osg_render::SubtitleCustomization;
use serde_json::{Value, json};

use super::bake::paged::Document;
use super::case::{self, Case};
use super::matrix::ParityMatrix;
use super::sweep;

/// How long one cue holds. Three frames at [`FRAME_RATE`], so a cue's middle frame is inside it
/// with a whole frame of clearance on each side.
pub(crate) const CUE_STEP_US: u64 = 100_000;
/// The rate every paging case runs at.
pub(crate) const FRAME_RATE: u16 = 30;
/// How many frames one cue occupies. Held as its own constant and checked against the two above by
/// [`the_cue_grid_is_whole_frames`], so the frame arithmetic below is arithmetic rather than a hope.
pub(crate) const FRAMES_PER_CUE: u64 = 3;
/// Which of a cue's three frames is compared: the middle one.
const MIDDLE_FRAME: u64 = 1;

/// A document, the case that renders it, and how many pages it is claimed to need.
#[derive(Debug)]
pub(crate) struct DocumentCase {
    /// The case identity, carrying the document's name and never a line of its text.
    pub(crate) id: String,
    pub(crate) case: Case,
    pub(crate) document: Document,
    /// Asserted rather than reported: a case that quietly stopped needing two pages would still
    /// pass every comparison below and would be testing the single-page shape twice.
    pub(crate) expected_pages: usize,
    /// The lines this document's cues carry, kept only to build the one-cue preview requests.
    texts: Vec<String>,
}

impl DocumentCase {
    /// The frame index in the middle of cue `cue`.
    pub(crate) fn middle_frame(&self, cue: usize) -> u32 {
        assert!(
            cue < self.document.cues(),
            "{}: cue {cue} is not one this document carries",
            self.id
        );
        let index = u64::try_from(cue).unwrap_or(0) * FRAMES_PER_CUE + MIDDLE_FRAME;
        u32::try_from(index).expect("a bounded frame index")
    }

    /// A frame index this cue is **not** on screen at, for proving its own frame was not blank.
    ///
    /// The first frame of a neighbouring cue. A preview stages one cue and nothing else, so at an
    /// instant outside that cue's window it composes the picture with no subtitle at all — which is
    /// the comparison that turns "the two frames agree" into "the two frames agree and carry a cue".
    pub(crate) fn absent_frame(&self, cue: usize) -> u32 {
        let neighbour = if cue == 0 {
            self.document.cues() - 1
        } else {
            0
        };
        self.middle_frame(neighbour)
    }

    /// The case a **preview** of cue `cue` would send: the same settings, that cue alone.
    ///
    /// The one cue keeps its own absolute times, so the conversion rebases it onto exactly the
    /// instant the whole document put it at and the two timelines name the same frames.
    pub(crate) fn preview_case(&self, cue: usize) -> Case {
        let mut preview = self.case.clone();
        preview.id = format!("{} cue={cue} preview", self.id);
        preview.lyrics = Some(json!([one_cue(cue, &self.texts[cue])]));
        preview
    }

    /// The whole document's case, named for one cue so a failure says which one.
    pub(crate) fn export_case(&self, cue: usize) -> Case {
        let mut export = self.case.clone();
        export.id = format!("{} cue={cue} export", self.id);
        export
    }
}

/// One cue's wire form: the `k`th slot of the uniform grid.
pub(crate) fn one_cue(cue: usize, text: &str) -> Value {
    let index = u64::try_from(cue).unwrap_or(0);
    json!({
        "id": format!("cue-{cue}"),
        "startUs": index * CUE_STEP_US,
        "endUs": (index + 1) * CUE_STEP_US,
        "text": text,
    })
}

/// Assembles a document case from its lines and the customization they are baked with.
fn build(
    id: &str,
    texts: Vec<String>,
    customization: Value,
    resolution: &str,
    expected_pages: usize,
) -> DocumentCase {
    let window_us = u64::try_from(texts.len()).unwrap_or(1) * CUE_STEP_US;
    let lyrics: Vec<Value> = texts
        .iter()
        .enumerate()
        .map(|(cue, text)| one_cue(cue, text))
        .collect();
    let mut case = Case::new(
        id.to_owned(),
        customization,
        texts[0].clone(),
        resolution,
        FRAME_RATE,
    );
    case.lyrics = Some(Value::Array(lyrics));
    case.window_us = Some(window_us);
    let typed: SubtitleCustomization = case.typed_customization();
    let document = Document::bake(&texts, &typed);
    DocumentCase {
        id: id.to_owned(),
        case,
        document,
        expected_pages,
        texts,
    }
}

/// The customization every paging case starts from: the matrix defaults, with three changes.
///
/// * **Both fade windows at zero**, so a cue is on screen for exactly its own window and no
///   neighbour's fade reaches the frame being compared.
/// * **A large font size**, so the cue covers an unmistakable number of pixels and the comparison is
///   about glyphs rather than about a few antialiased edges.
/// * Whatever the individual document needs on top, applied by the caller.
fn base(matrix: &ParityMatrix) -> Value {
    let mut customization = sweep::defaults(matrix);
    for (field, value) in [
        ("fadeInDuration", json!(0)),
        ("fadeOutDuration", json!(0)),
        ("fontSize", json!(96)),
    ] {
        customization = case::with_field(&customization, field, &value);
    }
    customization
}

/// `count` lines of `per_cue` consecutive characters from `first`, in words of four.
///
/// The words are what makes the line wrap, so a paging document exercises the multi-line path as
/// well as the multi-page one. The block is walked without repeating, so cue `k+1` introduces
/// `per_cue` cells the page has never seen — which is the shape that fills a page, and the shape a
/// Latin track never has.
fn block_lines(first: u32, count: usize, per_cue: usize) -> Vec<String> {
    let mut lines = Vec::with_capacity(count);
    let mut code = first;
    for _ in 0..count {
        let mut line = String::new();
        for position in 0..per_cue {
            if position > 0 && position.is_multiple_of(4) {
                line.push(' ');
            }
            line.push(char::from_u32(code).expect("a character inside the chosen block"));
            code += 1;
        }
        lines.push(line);
    }
    lines
}

/// The first Hangul syllable. The block holds 11,172, so a document can outgrow a page in it.
const HANGUL_FIRST: u32 = 0xAC00;
/// The first Arabic letter used here. `0x0621..=0x064A` is letters and tatweel, none of which the
/// stand-in's cluster rule treats as a combining mark.
const ARABIC_FIRST: u32 = 0x0621;
/// The first Arabic diacritic, which the cluster rule *does* join to the letter before it.
const ARABIC_MARK_FIRST: u32 = 0x064B;

/// How many cues the paging document carries, and how many syllables each one introduces.
///
/// 45 new cells a cue against a 1,024-cell page: the twenty-third cue is the one that cannot fit, so
/// the document is two pages and the split is a property of the budget rather than of a number
/// chosen to produce two. The test asserts the page count, so a change to either bound is a failure
/// rather than a silent slide back to one page.
const PAGED_CUES: usize = 25;
const PAGED_CELLS_PER_CUE: usize = 45;

/// A document of `count` cues on the uniform grid, cycling the matrix's own nine lines.
///
/// For the cases that need a document but are not about paging — the trim case, which needs cues
/// that draw *distinguishably* different pictures so a frame at one instant cannot be confused with
/// a frame at another, and needs them from the frozen input rather than invented.
#[cfg(windows)]
pub(crate) fn cycled(
    matrix: &ParityMatrix,
    id: &str,
    count: usize,
    resolution: &str,
) -> DocumentCase {
    let texts: Vec<String> = (0..count)
        .map(|cue| matrix.texts[cue % matrix.texts.len()].text.clone())
        .collect();
    // Nine scripts between them still hold far fewer than a page of distinct cells, so this is a
    // one-page document by arithmetic rather than by hope — and the assertion says so.
    build(id, texts, base(matrix), resolution, 1)
}

/// Every document the paging cases render.
pub(crate) fn all(matrix: &ParityMatrix) -> Vec<DocumentCase> {
    vec![
        latin(matrix),
        korean_pages(matrix),
        arabic_rtl(matrix),
        mixed_directions(matrix),
        cursive_marks(matrix),
    ]
}

/// Four of the matrix's own lines, whose alphabets fit one page between them.
fn latin(matrix: &ParityMatrix) -> DocumentCase {
    let texts = ["latin", "vietnamese", "long-word", "dense"]
        .into_iter()
        .map(|id| matrix.text(id).text.clone())
        .collect();
    build("doc=latin", texts, base(matrix), "480p", 1)
}

/// A Korean document large enough that one atlas cannot hold its alphabet.
fn korean_pages(matrix: &ParityMatrix) -> DocumentCase {
    build(
        "doc=korean-pages",
        block_lines(HANGUL_FIRST, PAGED_CUES, PAGED_CELLS_PER_CUE),
        base(matrix),
        "480p",
        2,
    )
}

/// A right-to-left document: every cue is Arabic and every run is emitted in visual order.
fn arabic_rtl(matrix: &ParityMatrix) -> DocumentCase {
    let customization = case::with_field(&base(matrix), "rtlSupport", &json!(true));
    build(
        "doc=arabic-rtl",
        block_lines(ARABIC_FIRST, 4, 8),
        customization,
        "480p",
        1,
    )
}

/// A document mixing directions, which pages by **alignment** rather than by capacity.
///
/// `textAlign: left` on a right-to-left paragraph resolves to `right`, so the Arabic cues and the
/// Latin cues resolve to different alignments and cannot share an atlas — a two-page document with
/// an alphabet of a few dozen cells, which no capacity rule would ever split.
fn mixed_directions(matrix: &ParityMatrix) -> DocumentCase {
    let mut customization = case::with_field(&base(matrix), "rtlSupport", &json!(true));
    customization = case::with_field(&customization, "textAlign", &json!("left"));
    let latin = ["one two", "three four", "five six"];
    let arabic = block_lines(ARABIC_FIRST, 3, 8);
    let mut texts = Vec::with_capacity(6);
    for (left, right) in latin.into_iter().zip(arabic) {
        texts.push(left.to_owned());
        texts.push(right);
    }
    build("doc=mixed-directions", texts, customization, "480p", 2)
}

/// A cursive script whose clusters carry more than one code point.
///
/// The stand-in does not select contextual forms — that is the browser's shaper and the browser's
/// suites own it — so what this covers is the half a page can affect: a cursive script's cell set,
/// its right-to-left visual order, and clusters of a letter plus its mark, which are the cells whose
/// identity across a repack is least obvious.
fn cursive_marks(matrix: &ParityMatrix) -> DocumentCase {
    let customization = case::with_field(&base(matrix), "rtlSupport", &json!(true));
    let letters: Vec<String> = block_lines(ARABIC_FIRST, 4, 8);
    let texts = letters
        .into_iter()
        .enumerate()
        .map(|(cue, line)| {
            let mark = char::from_u32(ARABIC_MARK_FIRST + u32::try_from(cue).unwrap_or(0))
                .expect("a character inside the Arabic mark block");
            line.chars()
                .flat_map(|character| {
                    if character == ' ' {
                        vec![character]
                    } else {
                        vec![character, mark]
                    }
                })
                .collect()
        })
        .collect();
    build("doc=cursive-marks", texts, customization, "480p", 1)
}

#[cfg(test)]
mod tests {
    use super::{CUE_STEP_US, FRAME_RATE, FRAMES_PER_CUE};

    /// The whole comparison rests on "a cue's middle frame belongs to that cue and no other", and
    /// that is only true while the cue window is a whole number of frames. A step that stopped
    /// dividing evenly would slide the compared frame off its own cue silently.
    #[test]
    fn the_cue_grid_is_whole_frames() {
        assert_eq!(
            CUE_STEP_US * u64::from(FRAME_RATE),
            FRAMES_PER_CUE * 1_000_000,
            "one cue is no longer a whole number of frames"
        );
        // A cue needs a frame of clearance on each side of the one that is compared.
        const { assert!(FRAMES_PER_CUE >= 3) }
    }
}
