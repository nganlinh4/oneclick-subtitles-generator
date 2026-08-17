//! A whole document baked the way an export stages one: several cues, one descriptor per page.
//!
//! The solo bake beside this one is what a **preview** stages — one cue, one atlas, packed for that
//! cue alone. An export stages the whole cue list at once, and one atlas holds a bounded number of
//! distinct cells, so `src/platform/glyphAtlasPaging.js` splits the document into pages and records
//! which page each cue was baked into. This module reproduces that split so the gate can render the
//! export's shape rather than a single-page approximation of it.
//!
//! Two rules are reproduced, because both are load-bearing and neither is obvious:
//!
//! * **A page closes on capacity.** Cells accumulate as cues are walked in time order, and the page
//!   closes when the merged table would pass [`MAX_GLYPH_COUNT`] cells or [`MAX_TEXT_CODE_POINTS`]
//!   code points. Latin never reaches either; a Korean, CJK or emoji-heavy document reaches the
//!   first in a few dozen cues, which is why pages exist at all.
//! * **A page carries one resolved alignment.** The compositor aligns a cue by its *atlas's*
//!   alignment (`run_align` in `osg-compositor`), because CSS `start` resolves against the
//!   paragraph's own direction and only the shaper knows what that was. So one open page per
//!   resolved alignment, and a document mixing a right-to-left cue with a left-to-right one is two
//!   pages however small its alphabet.
//!
//! What a page changes about a cue is **only** its cell indices. The pen positions, the baselines,
//! the line boxes and the advances are the cue's own and are copied across untouched — the same
//! claim `glyphAtlasPage.js` makes when it remaps a run — which is what makes "the preview and the
//! export draw the same pixels" a question about packing rather than about layout.

use osg_compositor::CueRun;
use osg_export::StagedText;
use osg_render::SubtitleCustomization;
use osg_scene::glyph::{
    AtlasGlyph, AtlasLayout, GlyphAtlasDescriptor, LayoutTextAlign, MAX_GLYPH_COUNT,
    MAX_TEXT_CODE_POINTS,
};
use osg_scene::scene::ResolvedFace;

use super::text::utf16_order;
use super::{Staged, slot};

/// One document, baked twice: once per cue on its own, and once as the pages an export stages.
#[derive(Debug, Clone)]
pub(crate) struct Document {
    face: ResolvedFace,
    /// Each cue's own bake, which is exactly what the preview surface stages for that cue.
    solo: Vec<Staged>,
    pages: Vec<GlyphAtlasDescriptor>,
    page_of_cue: Vec<u32>,
    runs: Vec<CueRun>,
}

impl Document {
    /// Bakes every cue alone, then partitions the cues into the pages an export would stage.
    pub(crate) fn bake(texts: &[String], customization: &SubtitleCustomization) -> Self {
        let solo: Vec<Staged> = texts
            .iter()
            .map(|text| super::bake(text, customization))
            .collect();
        assert!(!solo.is_empty(), "a document has at least one cue");

        let mut pages = Vec::new();
        let mut page_of_cue = vec![0_u32; solo.len()];
        let mut runs: Vec<Option<CueRun>> = vec![None; solo.len()];
        for (index, page) in partition(&solo).into_iter().enumerate() {
            let number = u32::try_from(index).expect("a bounded page count");
            let cells = pack(page.cells);
            let layouts: Vec<AtlasLayout> = page
                .cues
                .iter()
                .map(|cue| {
                    remap(
                        solo[*cue].atlas().layout(),
                        solo[*cue].atlas().glyphs(),
                        &cells,
                    )
                })
                .collect();
            for (cue, layout) in page.cues.iter().zip(&layouts) {
                page_of_cue[*cue] = number;
                runs[*cue] = Some(CueRun::from_layout(layout));
            }
            // The first cue this page serves owns the descriptor's layout and its run-scoped
            // metrics, which is the choice `glyphAtlasPage.js` makes: a descriptor carries exactly
            // one layout, and every other cue on the page carries its own run separately.
            let first = solo[page.cues[0]].atlas();
            pages.push(super::descriptor(
                &first.face().requested_family,
                first.face().weight,
                *first.metrics(),
                layouts[0].clone(),
                cells,
                page_hash(number, &page.cues),
            ));
        }

        Self {
            face: solo[0].face().clone(),
            solo,
            pages,
            page_of_cue,
            runs: runs
                .into_iter()
                .map(|run| run.expect("every cue was assigned to exactly one page"))
                .collect(),
        }
    }

    /// The staged text an export carries: every page, the page each cue was baked into, every run.
    pub(crate) fn staged_text(&self) -> StagedText {
        StagedText::new(
            self.face.clone(),
            self.pages.clone(),
            self.page_of_cue.clone(),
            self.runs.clone(),
        )
    }

    /// The staged text the **preview** carries for one cue: that cue's bake, alone, on one page.
    ///
    /// The same call `apps/desktop/src-tauri/src/preview/plan.rs` makes — `StagedText::single` with
    /// one run copied from the atlas's own layout — so the two sides of the comparison are the two
    /// sides the product has, not two arrangements of the same data.
    pub(crate) fn preview_text(&self, cue: usize) -> StagedText {
        let staged = &self.solo[cue];
        StagedText::single(
            staged.face().clone(),
            staged.atlas().clone(),
            vec![staged.run().clone()],
        )
    }

    /// The face every page and every solo bake was made from, which the conversion is checked
    /// against.
    pub(crate) const fn face(&self) -> &ResolvedFace {
        &self.face
    }

    /// How many cues this document carries.
    pub(crate) fn cues(&self) -> usize {
        self.solo.len()
    }

    /// How many pages the partition produced.
    pub(crate) fn page_count(&self) -> usize {
        self.pages.len()
    }

    /// Which page a cue was baked into.
    pub(crate) fn page_of(&self, cue: usize) -> usize {
        usize::try_from(self.page_of_cue[cue]).expect("a bounded page index")
    }

    /// How many distinct cells each page carries, for the report a multi-page case prints.
    pub(crate) fn cells_per_page(&self) -> Vec<usize> {
        self.pages.iter().map(|page| page.glyphs().len()).collect()
    }

    /// How the cue's cells are indexed on its own bake against how they are indexed on its page.
    ///
    /// The whole difference a page makes, and the thing the identity comparison is really about: if
    /// this comes back equal for every cue then the multi-page shape is not being exercised at all.
    pub(crate) fn indices_differ(&self, cue: usize) -> bool {
        let solo = self.solo[cue].run();
        let paged = &self.runs[cue];
        solo.lines()
            .iter()
            .zip(paged.lines())
            .any(|(mine, theirs)| mine.glyphs() != theirs.glyphs())
    }

    /// Whether the cue's page is packed to different atlas dimensions from its own bake.
    pub(crate) fn geometry_differs(&self, cue: usize) -> bool {
        let solo = self.solo[cue].atlas().atlas();
        let paged = self.pages[self.page_of(cue)].atlas();
        solo.height_px != paged.height_px || solo.glyph_count != paged.glyph_count
    }

    /// Checks that a page changed a cue's **addresses** and nothing else.
    ///
    /// The exact half of the preview-against-export comparison, and the one with no tolerance in it
    /// at all. Rendering can only tell you that two pictures agree; this says *why* they have to:
    /// every number the compositor places a glyph from is bit-identical between the cue's own bake
    /// and its page, every cell a run index resolves to is the same cluster with the same ink box,
    /// and the coverage bytes under that box are the same bytes at a different address.
    ///
    /// A remap that pointed a cue at the wrong cluster, a pack that changed a cell's size, or a
    /// merge that dropped a cell are each caught here as a named difference rather than as a
    /// handful of pixels somebody has to interpret.
    pub(crate) fn repack_is_address_only(&self, cue: usize) -> Result<(), String> {
        let solo = self.solo[cue].atlas();
        let page = &self.pages[self.page_of(cue)];
        let (mine, theirs) = (self.solo[cue].run(), &self.runs[cue]);
        if mine.lines().len() != theirs.lines().len() {
            return Err(format!(
                "cue {cue} was laid out on a different number of lines"
            ));
        }
        for (number, (line, remapped)) in mine.lines().iter().zip(theirs.lines()).enumerate() {
            if line.advance_width_px().to_bits() != remapped.advance_width_px().to_bits()
                || line.baseline_y_px().to_bits() != remapped.baseline_y_px().to_bits()
                || line.pen_x_px().len() != remapped.pen_x_px().len()
                || line
                    .pen_x_px()
                    .iter()
                    .zip(remapped.pen_x_px())
                    .any(|(pen, moved)| pen.to_bits() != moved.to_bits())
            {
                return Err(format!("cue {cue} line {number} was moved by the repack"));
            }
            for (position, (own, paged)) in line
                .glyphs()
                .iter()
                .zip(remapped.glyphs())
                .enumerate()
                .map(|(position, (own, paged))| (position, (*own, *paged)))
            {
                let from = &solo.glyphs()[usize::try_from(own).unwrap_or(0)];
                let to = &page.glyphs()[usize::try_from(paged).unwrap_or(0)];
                if from.cluster != to.cluster
                    || from.width_px != to.width_px
                    || from.height_px != to.height_px
                    || from.origin_x_px != to.origin_x_px
                    || from.origin_y_px != to.origin_y_px
                    || from.advance_width_px.to_bits() != to.advance_width_px.to_bits()
                    || from.direction != to.direction
                {
                    return Err(format!(
                        "cue {cue} line {number} cell {position} resolves to a different cell on \
                         its page than on its own bake"
                    ));
                }
                if ink(solo, from) != ink(page, to) {
                    return Err(format!(
                        "cue {cue} line {number} cell {position} carries different coverage on its \
                         page than on its own bake"
                    ));
                }
            }
        }
        Ok(())
    }
}

/// The coverage bytes under one cell's box, read out of its own atlas.
fn ink(atlas: &GlyphAtlasDescriptor, cell: &AtlasGlyph) -> Vec<u8> {
    let stride = atlas.atlas().bytes_per_row;
    let mut bytes = Vec::with_capacity((cell.width_px * cell.height_px * 4) as usize);
    for row in 0..cell.height_px {
        let start = ((cell.y_px + row) * stride + cell.x_px * 4) as usize;
        let end = start + (cell.width_px * 4) as usize;
        bytes.extend_from_slice(&atlas.pixels()[start..end]);
    }
    bytes
}

/// One page under construction: its alignment, its merged cell table and the cues it serves.
#[derive(Debug)]
struct Page {
    align: LayoutTextAlign,
    /// Sorted by UTF-16 code unit and distinct, which is the order a descriptor is validated in.
    /// Positions are assigned by [`pack`] when the page closes.
    cells: Vec<AtlasGlyph>,
    code_points: usize,
    cues: Vec<usize>,
}

impl Page {
    fn open(staged: &Staged, cue: usize) -> Self {
        let cells = staged.atlas().glyphs().to_vec();
        Self {
            align: staged.atlas().layout().text_align,
            code_points: code_points(&cells),
            cells,
            cues: vec![cue],
        }
    }
}

/// Splits the cues into pages, greedily, in cue order, one open page per resolved alignment.
fn partition(solo: &[Staged]) -> Vec<Page> {
    let mut open: Vec<Page> = Vec::new();
    let mut closed: Vec<Page> = Vec::new();
    for (cue, staged) in solo.iter().enumerate() {
        let align = staged.atlas().layout().text_align;
        let Some(position) = open.iter().position(|page| page.align == align) else {
            open.push(Page::open(staged, cue));
            continue;
        };
        let merged = merge(&open[position].cells, staged.atlas().glyphs());
        let merged_code_points = code_points(&merged);
        if merged.len() > MAX_GLYPH_COUNT || merged_code_points > MAX_TEXT_CODE_POINTS {
            // The page is full. It closes as it stands and this cue opens the next one, which is
            // what keeps the split a pure function of the cue order rather than of a repack.
            closed.push(std::mem::replace(
                &mut open[position],
                Page::open(staged, cue),
            ));
            continue;
        }
        open[position].cells = merged;
        open[position].code_points = merged_code_points;
        open[position].cues.push(cue);
    }
    // Closed pages first, in the order they filled up, then the pages still open in the order their
    // alignments first appeared. Deterministic, and the same list for the same cue list every time.
    closed.extend(open);
    closed
}

/// Merges a cue's sorted cell table into a page's, keeping it sorted and distinct.
fn merge(page: &[AtlasGlyph], run: &[AtlasGlyph]) -> Vec<AtlasGlyph> {
    let mut merged = Vec::with_capacity(page.len() + run.len());
    let (mut left, mut right) = (0_usize, 0_usize);
    while left < page.len() && right < run.len() {
        match utf16_order(&page[left].cluster, &run[right].cluster) {
            std::cmp::Ordering::Equal => {
                merged.push(page[left].clone());
                left += 1;
                right += 1;
            }
            std::cmp::Ordering::Less => {
                merged.push(page[left].clone());
                left += 1;
            }
            std::cmp::Ordering::Greater => {
                merged.push(run[right].clone());
                right += 1;
            }
        }
    }
    merged.extend_from_slice(&page[left..]);
    merged.extend_from_slice(&run[right..]);
    merged
}

fn code_points(cells: &[AtlasGlyph]) -> usize {
    cells.iter().map(|cell| cell.code_points.len()).sum()
}

/// Assigns every cell of a closed page its position in the page's own grid.
fn pack(mut cells: Vec<AtlasGlyph>) -> Vec<AtlasGlyph> {
    for (index, cell) in cells.iter_mut().enumerate() {
        let (x_px, y_px) = slot(u32::try_from(index).expect("a bounded cell count"));
        cell.x_px = x_px;
        cell.y_px = y_px;
    }
    cells
}

/// One cue's layout with its cell indices moved from its own table onto the page's.
///
/// Indices are the only thing that changes. Every pen, baseline, advance, justification and line box
/// is the cue's own and is carried across untouched, so a page cannot move a glyph — it can only
/// change which cell the glyph is drawn from, and that cell is the same cluster either way.
fn remap(layout: &AtlasLayout, local: &[AtlasGlyph], page: &[AtlasGlyph]) -> AtlasLayout {
    let index_of = |cell: u32| -> u32 {
        let cluster = &local[usize::try_from(cell).expect("a bounded cell index")].cluster;
        let found = page
            .binary_search_by(|candidate| utf16_order(&candidate.cluster, cluster))
            .expect("every cell of a cue is on the page that cue was assigned to");
        u32::try_from(found).expect("a bounded cell index")
    };
    let mut remapped = layout.clone();
    for line in &mut remapped.lines {
        line.glyphs = line.glyphs.iter().map(|cell| index_of(*cell)).collect();
    }
    remapped
}

/// A page's cache key: eight lower-case hexadecimal digits, distinct per page of a document.
fn page_hash(number: u32, cues: &[usize]) -> String {
    let mut hash = 0x811c_9dc5_u32 ^ number;
    for cue in cues {
        for byte in u64::try_from(*cue).unwrap_or(u64::MAX).to_le_bytes() {
            hash ^= u32::from(byte);
            hash = hash.wrapping_mul(0x0100_0193);
        }
    }
    format!("{hash:08x}")
}
