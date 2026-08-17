//! A stand-in for the `WebView` baker, so the matrix can be rendered without a browser.
//!
//! # What this is, and what it is not
//!
//! The architecture forbids a Rust text stack: `src/platform/glyphAtlas*.js` shapes, rasterizes,
//! wraps and reorders, and Rust draws what it staged. A gate that has to render 30 presets against
//! 9 scripts therefore needs staged text for each of them, and there is no browser in `cargo test`.
//!
//! So this module produces a descriptor the baker *could* have produced: it obeys every bound and
//! every derived-field agreement `osg_scene::glyph` enforces, and it consumes the same
//! customization fields the real baker consumes — the transform, the spacing, the line box, the
//! wrap width, the alignment and the direction — so a field the staging boundary owns changes the
//! staged text here exactly as it would change it there.
//!
//! It is **not** a shaper. Advances come from a fixed function of the cluster rather than from a
//! font, cluster boundaries are a bounded approximation of UAX #29 covering the fixture's nine
//! texts, and right-to-left order is a reversal rather than UAX #9. Those are the browser's job and
//! the browser's suites test them. What this module makes testable is everything downstream: that
//! the conversion, the scene, the compositor and the encoder carry what was staged, for every
//! preset, every field value and every script in the matrix.

use osg_compositor::CueRun;
use osg_export::{StagedText, primary_font_family};
use osg_render::SubtitleCustomization;
use osg_scene::glyph::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasLayout, AtlasMetrics, Direction, FaceProbe,
    FaceStyle, GLYPH_ATLAS_VERSION, GlyphAtlasDescriptor, PixelFormat, ProbeFamily,
    UncheckedGlyphAtlas,
};
use osg_scene::scene::ResolvedFace;

mod layout;
pub(crate) mod paged;
mod text;

use layout::{layout, metrics, wrap};
use text::{advance_of, clusters, direction_of, ink_width, transform, utf16_order};

/// The size the stand-in bakes at. One size for every case, because the compositor scales the atlas
/// by `fontSize / atlasFontSize`, so a second bake size would only move the same ratio around.
const ATLAS_FONT_SIZE_PX: f64 = 24.0;
/// Face ascent at that size.
const ASCENT_PX: f64 = 19.0;
/// Face descent at that size.
const DESCENT_PX: f64 = 5.0;
/// The square each cell occupies in the atlas, in pixels.
const CELL_PX: u32 = 16;
/// How many cells one atlas row carries.
const CELL_COLUMNS: u32 = 8;
/// The transparent ring the baker leaves around every cell's ink, inside the cell's own box.
///
/// The real baker's default (`paddingPx: 1` in `src/platform/glyphAtlasRequest.js`), and
/// `measureCell` puts it *inside* `widthPx`/`heightPx` with the origin moved to match, so a cell's
/// declared box is ink plus ring rather than ink alone. Reproducing that is not cosmetic: the
/// compositor samples the atlas with a **linear** filter, so a fragment on a cell's own edge blends
/// the texel just outside it. With a ring, that texel is transparent whatever else the atlas holds,
/// which is what makes the same cue draw the same pixels from a page it shares with other cues as
/// from a bake of its own. With no ring it would blend whichever cell happened to be packed next to
/// it, and the picture would depend on the packing.
const CELL_PADDING_PX: u32 = 1;
/// The widest ink one cell can carry, which is its box less the ring on both sides.
const MAX_INK_PX: u32 = CELL_PX - 2 * CELL_PADDING_PX;
/// The wrap width `maxWidth: 100` means, in atlas pixels.
///
/// The real wrap width is a percentage of the composition, resolved in
/// `src/components/previews/native/nativePreviewGeometry.js` and baked into the atlas. The stand-in
/// resolves the same percentage against a fixed reference instead, which keeps `maxWidth`
/// observable — a narrower value wraps into more lines — without inventing a second geometry model.
const WRAP_REFERENCE_PX: f64 = 400.0;
/// The narrowest cluster advance, before letter spacing.
const MIN_ADVANCE_PX: f64 = 6.0;
/// How much the cluster's first code point may widen it.
const ADVANCE_SPREAD: u32 = 9;

/// The face, atlas and runs one case stages, plus the resolved face the conversion checks against.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Staged {
    face: ResolvedFace,
    atlas: GlyphAtlasDescriptor,
    run: CueRun,
}

impl Staged {
    /// The face the conversion is given, which is the one the atlas was baked from.
    pub(crate) const fn face(&self) -> &ResolvedFace {
        &self.face
    }

    /// The one atlas this bake produced, which is the whole of what a preview stages.
    pub(crate) const fn atlas(&self) -> &GlyphAtlasDescriptor {
        &self.atlas
    }

    /// The run this bake laid out.
    pub(crate) const fn run(&self) -> &CueRun {
        &self.run
    }

    /// The staged text for a scene carrying `cues` cues, all drawing this run.
    pub(crate) fn text(&self, cues: usize) -> StagedText {
        StagedText::single(
            self.face.clone(),
            self.atlas.clone(),
            (0..cues).map(|_| self.run.clone()).collect(),
        )
    }

    /// How many cells the run places, for the diagnostics a failing case prints.
    pub(crate) fn placed_cells(&self) -> usize {
        self.run.placed_cells()
    }

    /// How many lines the run occupies.
    pub(crate) fn line_count(&self) -> usize {
        self.run.lines().len()
    }

    /// Whether two stagings give the compositor the same thing to draw.
    ///
    /// Not the same as `self == other`. A descriptor carries provenance the compositor never reads
    /// — the wrap width the baker measured against, the alignment it justified for, the content
    /// hash — and a setting that changes only those has changed the staged text without changing a
    /// pixel. `maxWidth` on a line that already fits, `wordWrap` on a text with one line and
    /// `rtlSupport` on a text with no right-to-left cluster are all exactly that.
    ///
    /// This compares what is actually drawn: the face size the cells are scaled by, the metrics the
    /// lines are stacked with, the atlas geometry and its pixels, the cells, and the run's own
    /// positions. The sweep uses it to turn "this value did not change the picture" from an
    /// exception somebody has to maintain into a claim it can check — and, because the claim is
    /// then asserted, a comparison that is too narrow fails loudly rather than passing quietly.
    pub(crate) fn draws_the_same_as(&self, other: &Self) -> bool {
        let (mine, theirs) = (&self.atlas, &other.atlas);
        mine.face().font_size_px.to_bits() == theirs.face().font_size_px.to_bits()
            && mine.face().requested_family == theirs.face().requested_family
            && mine.face().weight == theirs.face().weight
            && mine.metrics() == theirs.metrics()
            && mine.atlas() == theirs.atlas()
            && mine.glyphs() == theirs.glyphs()
            && mine.pixels() == theirs.pixels()
            && self.run == other.run
    }
}

/// Bakes `text` the way `customization` asks for it.
///
/// # Panics
/// Panics when the customization names no usable family, or when the descriptor it produces is one
/// the baker could not have produced. Both are bugs in this module rather than findings about the
/// pipeline, so they fail loudly here instead of being reported as a parity failure.
pub(crate) fn bake(text: &str, customization: &SubtitleCustomization) -> Staged {
    let family = primary_font_family(&customization.font_family)
        .expect("every preset names a real family")
        .to_owned();
    let weight = customization.font_weight;

    let transformed = transform(text, customization.text_transform);
    let clusters = clusters(&transformed);
    let cells = distinct_cells(&clusters, customization.letter_spacing, weight);
    let lines = wrap(&clusters, &cells, customization);
    let layout = layout(&lines, &cells, customization);
    let metrics = metrics(&cells, &clusters, customization);

    let atlas = descriptor(
        &family,
        weight,
        metrics,
        layout,
        cells.iter().map(Cell::to_glyph).collect(),
        content_hash(&transformed, customization),
    );
    let run = CueRun::from_layout(atlas.layout());
    Staged {
        face: resolved_face(family, weight),
        atlas,
        run,
    }
}

/// The face a stand-in bake resolves, which is the one the conversion is checked against.
fn resolved_face(family: String, weight: u16) -> ResolvedFace {
    ResolvedFace {
        family,
        source: "sha256:0101010101010101010101010101010101010101010101010101010101010101"
            .to_owned(),
        weight,
    }
}

/// Assembles one descriptor from a cell table, the layout it describes and that run's metrics.
///
/// Shared with [`paged`], which hands it a **page's** merged cell table and the remapped layout of
/// the first cue that page serves — which is exactly the descriptor `src/platform/glyphAtlasPage.js`
/// emits for a page, down to the choice of whose layout and whose run-scoped metrics it carries.
///
/// # Panics
/// Panics when the descriptor is one the baker could not have produced, which is a bug in this
/// module rather than a finding about the pipeline.
fn descriptor(
    family: &str,
    weight: u16,
    metrics: AtlasMetrics,
    layout: AtlasLayout,
    glyphs: Vec<AtlasGlyph>,
    content_hash: String,
) -> GlyphAtlasDescriptor {
    let unchecked = UncheckedGlyphAtlas {
        version: GLYPH_ATLAS_VERSION,
        face: AtlasFace {
            requested_family: family.to_owned(),
            weight,
            style: FaceStyle::Normal,
            font_size_px: ATLAS_FONT_SIZE_PX,
            css_font: format!("normal {weight} {ATLAS_FONT_SIZE_PX}px \"{family}\""),
            substituted: false,
            probes: probes(),
        },
        metrics,
        atlas: geometry(glyphs.len()),
        layout,
        pixels: pixels(&glyphs, weight),
        glyphs,
        content_hash,
    };
    GlyphAtlasDescriptor::try_from(unchecked)
        .expect("the stand-in bakes a descriptor the baker could have produced")
}

/// One distinct cluster and the cell baked for it.
#[derive(Debug, Clone, PartialEq)]
struct Cell {
    cluster: String,
    advance_px: f64,
    direction: Direction,
    x_px: u32,
    y_px: u32,
    ink_px: u32,
}

impl Cell {
    fn to_glyph(&self) -> AtlasGlyph {
        let inked = self.ink_px > 0;
        let padding = i32::try_from(CELL_PADDING_PX).unwrap_or(0);
        AtlasGlyph {
            cluster: self.cluster.clone(),
            code_points: self.cluster.chars().map(u32::from).collect(),
            direction: self.direction,
            advance_width_px: self.advance_px,
            x_px: self.x_px,
            y_px: self.y_px,
            // The box carries the transparent ring as well as the ink, which is what
            // `measureCell` emits, and the origin is measured from the box's own corner.
            width_px: if inked {
                self.ink_px + 2 * CELL_PADDING_PX
            } else {
                0
            },
            height_px: if inked { CELL_PX } else { 0 },
            origin_x_px: if inked { padding } else { 0 },
            // The ink sits entirely above the baseline, so the baseline is one ring above the
            // box's bottom edge.
            origin_y_px: if inked {
                i32::try_from(CELL_PX - CELL_PADDING_PX).unwrap_or(0)
            } else {
                0
            },
            substituted: false,
        }
    }
}

/// The distinct cells the run needs, in the baker's packing order.
fn distinct_cells(clusters: &[String], letter_spacing: f64, weight: u16) -> Vec<Cell> {
    let mut distinct: Vec<&str> = Vec::new();
    for cluster in clusters {
        if !distinct.contains(&cluster.as_str()) {
            distinct.push(cluster);
        }
    }
    distinct.sort_unstable_by(|left, right| utf16_order(left, right));
    distinct
        .into_iter()
        .enumerate()
        .map(|(index, cluster)| {
            let (x_px, y_px) = slot(u32::try_from(index).expect("a bounded cell count"));
            let blank = cluster.chars().all(char::is_whitespace);
            Cell {
                cluster: cluster.to_owned(),
                advance_px: advance_of(cluster, letter_spacing),
                direction: direction_of(cluster),
                x_px,
                y_px,
                ink_px: if blank { 0 } else { ink_width(cluster, weight) },
            }
        })
        .collect()
}

fn probes() -> Vec<FaceProbe> {
    [
        (ProbeFamily::Monospace, 100.0, 120.0),
        (ProbeFamily::Serif, 90.0, 90.0),
        (ProbeFamily::SansSerif, 95.0, 110.0),
    ]
    .into_iter()
    .map(
        |(probe_family, alone_width_px, chained_width_px)| FaceProbe {
            probe_family,
            alone_width_px,
            chained_width_px,
            participated: alone_width_px.to_bits() != chained_width_px.to_bits(),
        },
    )
    .collect()
}

fn rows(cell_count: usize) -> u32 {
    let cells = u32::try_from(cell_count).expect("a bounded cell count");
    cells.div_ceil(CELL_COLUMNS).max(1)
}

fn geometry(cell_count: usize) -> AtlasGeometry {
    AtlasGeometry {
        width_px: CELL_COLUMNS * CELL_PX,
        height_px: rows(cell_count) * CELL_PX,
        padding_px: CELL_PADDING_PX,
        glyph_count: u32::try_from(cell_count).expect("a bounded cell count"),
        pixel_format: PixelFormat::Rgba8,
        bytes_per_row: CELL_COLUMNS * CELL_PX * 4,
    }
}

/// Coverage for every cell: a per-cluster pattern, so two clusters never rasterize alike.
///
/// Rasterized from the emitted cells rather than from the `Cell` list, so a page's merged table
/// rasterizes through exactly this function too. The ink is inset by [`CELL_PADDING_PX`] on every
/// side of the cell's box, leaving the ring transparent for the reason that constant records.
fn pixels(glyphs: &[AtlasGlyph], weight: u16) -> Vec<u8> {
    let width = CELL_COLUMNS * CELL_PX;
    let height = rows(glyphs.len()) * CELL_PX;
    let stride = width * 4;
    let mut buffer = vec![0_u8; (height * stride) as usize];
    for glyph in glyphs {
        let (Some(ink_width), Some(ink_height)) = (
            glyph.width_px.checked_sub(2 * CELL_PADDING_PX),
            glyph.height_px.checked_sub(2 * CELL_PADDING_PX),
        ) else {
            continue;
        };
        let seed = glyph.cluster.chars().next().map_or(0, u32::from) + u32::from(weight);
        for row in 0..ink_height {
            for column in 0..ink_width {
                // Deterministic, cluster-dependent and never fully transparent, so a cell that is
                // drawn always reaches the frame.
                let coverage =
                    u8::try_from(128 + ((seed + row * 7 + column * 13) % 128)).unwrap_or(u8::MAX);
                let x = glyph.x_px + CELL_PADDING_PX + column;
                let y = glyph.y_px + CELL_PADDING_PX + row;
                let start = (y * stride + x * 4) as usize;
                buffer[start..start + 4].copy_from_slice(&[coverage; 4]);
            }
        }
    }
    buffer
}

/// Where the cell in slot `index` is packed: the same eight-column grid for a run and for a page.
const fn slot(index: u32) -> (u32, u32) {
    (
        (index % CELL_COLUMNS) * CELL_PX,
        (index / CELL_COLUMNS) * CELL_PX,
    )
}

/// The baker's cache key: eight lower-case hexadecimal digits over everything that was baked.
fn content_hash(text: &str, customization: &SubtitleCustomization) -> String {
    let mut hash = 0x811c_9dc5_u32;
    let mut absorb = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u32::from(*byte);
            hash = hash.wrapping_mul(0x0100_0193);
        }
    };
    absorb(text.as_bytes());
    absorb(customization.font_family.as_bytes());
    absorb(&customization.font_weight.to_le_bytes());
    absorb(&customization.letter_spacing.to_le_bytes());
    absorb(&customization.line_height.to_le_bytes());
    absorb(&customization.max_width.to_le_bytes());
    format!("{hash:08x}")
}
