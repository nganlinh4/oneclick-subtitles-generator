//! Staged inputs for the export tests.
//!
//! Everything here is valid by construction, so a test that wants an invalid input says exactly
//! which field it broke. The request is built by deserializing the same shape the `WebView` sends,
//! rather than by constructing the contract types directly, so the tests exercise the boundary the
//! product actually crosses.

// Not every test target uses every builder, and one that did would be a coincidence.
#![allow(dead_code)]

/// The real-media fixtures, for the suites that drive Media Foundation and a GPU adapter.
#[cfg(windows)]
pub(crate) mod media;

use osg_compositor::{CueLine, CueRun};
use osg_domain::{AssetId, ProjectId};
use osg_export::StagedText;
use osg_render::{RenderPlan, RenderRequest};
use osg_scene::glyph::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasLayout, AtlasLine, AtlasMetrics, CellAdvanceVerdict,
    Direction, FaceProbe, FaceStyle, GLYPH_ATLAS_VERSION, GlyphAtlasDescriptor, LayoutRefusal,
    LayoutTextAlign, PixelFormat, ProbeFamily, TextTransform, UncheckedGlyphAtlas,
};
use osg_scene::scene::ResolvedFace;
use serde_json::{Value, json};

/// The family the fixture request names and the fixture face resolves.
pub(crate) const FAMILY: &str = "Inter";
/// The weight the fixture resolves.
pub(crate) const WEIGHT: u16 = 600;

/// The fixture source's real dimensions and duration, as a decoder would report them.
pub(crate) const SOURCE_WIDTH: u32 = 1_920;
pub(crate) const SOURCE_HEIGHT: u32 = 1_080;
pub(crate) const SOURCE_DURATION_US: u64 = 10_000_000;

const ATLAS_WIDTH: u32 = 16;
const ATLAS_HEIGHT: u32 = 8;
const BYTES_PER_ROW: u32 = ATLAS_WIDTH * 4;
const INK_LEFT: u32 = 8;

/// The blank cell, which inks nothing.
pub(crate) const SPACE_CELL: u32 = 0;
/// The inked cell, an 8x8 opaque block.
pub(crate) const INK_CELL: u32 = 1;

/// The request exactly as the `WebView` sends it, with one two-second cue.
#[must_use]
pub(crate) fn request_json() -> Value {
    json!({
        "sourceAssetId": AssetId::new(),
        "projectId": ProjectId::new(),
        "narrationArtifactId": null,
        "lyrics": [{"id":"cue-1","startUs":1_000_000,"endUs":2_000_000,"text":"A"}],
        "settings": {
            "resolution":"720p","frameRate":30,"originalAudioVolume":100,
            "narrationVolume":80,"trimStartUs":0,"trimEndUs":2_000_000
        },
        "customization": {
            "fontSize":28,"fontFamily":"'Inter', sans-serif","fontWeight":600,
            "textColor":"#ffffff","textAlign":"center","lineHeight":1.2,
            "letterSpacing":0,"textTransform":"none","backgroundColor":"#000000",
            "backgroundOpacity":50,"borderRadius":4,"borderWidth":0,
            "borderColor":"#ffffff","borderStyle":"none","textShadowEnabled":true,
            "textShadowColor":"#000000","textShadowBlur":4,"textShadowOffsetX":0,
            "textShadowOffsetY":2,"glowEnabled":false,"glowColor":"#ffffff",
            "glowIntensity":10,"gradientEnabled":false,"gradientType":"linear",
            "gradientDirection":"45deg","gradientColorStart":"#ffffff",
            "gradientColorEnd":"#cccccc","gradientColorMid":"#eeeeee",
            "strokeEnabled":false,"strokeWidth":0,"strokeColor":"#000000",
            "multiShadowEnabled":false,"shadowLayers":1,"pulseEnabled":false,
            "pulseSpeed":1,"shakeEnabled":false,"shakeIntensity":2,"position":"bottom",
            "customPositionX":50,"customPositionY":80,"marginBottom":80,"marginTop":80,
            "marginLeft":0,"marginRight":0,"maxWidth":80,"fadeInDuration":0.3,
            "fadeOutDuration":0.3,"animationType":"fade","animationEasing":"ease",
            "wordWrap":true,"maxLines":3,"lineBreakBehavior":"auto",
            "rtlSupport":false,"preset":"default"
        },
        "crop": {"x":0,"y":0,"width":100,"height":100,"aspectRatio":null}
    })
}

/// The fixture request, deserialized.
#[must_use]
pub(crate) fn request(value: Value) -> RenderRequest {
    serde_json::from_value(value).expect("the fixture request deserializes")
}

/// The fixture request, validated against the fixture source.
#[must_use]
pub(crate) fn plan(value: Value) -> RenderPlan {
    request(value)
        .validate(SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_DURATION_US)
        .expect("the fixture request validates against the fixture source")
}

/// The default fixture plan.
#[must_use]
pub(crate) fn default_plan() -> RenderPlan {
    plan(request_json())
}

/// The face the `WebView` resolved for the fixture request.
#[must_use]
pub(crate) fn face(family: &str, weight: u16) -> ResolvedFace {
    ResolvedFace {
        family: family.to_owned(),
        source: "sha256:0101010101010101010101010101010101010101010101010101010101010101"
            .to_owned(),
        weight,
    }
}

/// The fixture face.
#[must_use]
pub(crate) fn default_face() -> ResolvedFace {
    face(FAMILY, WEIGHT)
}

/// The atlas descriptor as it arrives from the baker, so a test can break one field.
#[must_use]
pub(crate) fn unchecked_atlas(family: &str, weight: u16) -> UncheckedGlyphAtlas {
    UncheckedGlyphAtlas {
        version: GLYPH_ATLAS_VERSION,
        face: AtlasFace {
            requested_family: family.to_owned(),
            weight,
            style: FaceStyle::Normal,
            font_size_px: 24.0,
            css_font: format!("normal {weight} 24px \"{family}\""),
            substituted: false,
            probes: vec![
                probe(ProbeFamily::Monospace, 100.0, 120.0),
                probe(ProbeFamily::Serif, 90.0, 90.0),
                probe(ProbeFamily::SansSerif, 95.0, 110.0),
            ],
        },
        metrics: AtlasMetrics {
            ascent_px: 8.0,
            descent_px: 2.0,
            line_height_px: 12.0,
            baseline_px: 8.0,
            run_advance_width_px: 10.0,
            shaping_residual_px: 0.0,
            letter_spacing_px: 0.0,
            base_direction: Direction::Ltr,
        },
        layout: AtlasLayout {
            text_transform: TextTransform::None,
            letter_spacing_px: 0.0,
            max_width_px: None,
            word_wrap: true,
            text_align: LayoutTextAlign::Center,
            line_count: 1,
            width_px: 10.0,
            height_px: 12.0,
            cell_advance_layout: CellAdvanceVerdict::Reproduces,
            refusal: LayoutRefusal {
                shaping_crosses_clusters: false,
                direction_needs_bidi: false,
            },
            lines: vec![AtlasLine {
                glyphs: vec![INK_CELL],
                pen_x_px: vec![0.0],
                advance_width_px: 10.0,
                measured_width_px: 10.0,
                shaping_residual_px: 0.0,
                baseline_y_px: 8.0,
                justification_px: 0.0,
                ends_paragraph: true,
            }],
        },
        atlas: AtlasGeometry {
            width_px: ATLAS_WIDTH,
            height_px: ATLAS_HEIGHT,
            padding_px: 0,
            glyph_count: 2,
            pixel_format: PixelFormat::Rgba8,
            bytes_per_row: BYTES_PER_ROW,
        },
        glyphs: vec![
            AtlasGlyph {
                cluster: " ".to_owned(),
                code_points: vec![0x20],
                direction: Direction::Neutral,
                advance_width_px: 4.0,
                x_px: 0,
                y_px: 0,
                width_px: 0,
                height_px: 0,
                origin_x_px: 0,
                origin_y_px: 0,
                substituted: false,
            },
            AtlasGlyph {
                cluster: "A".to_owned(),
                code_points: vec![0x41],
                direction: Direction::Ltr,
                advance_width_px: 10.0,
                x_px: INK_LEFT,
                y_px: 0,
                width_px: 8,
                height_px: 8,
                origin_x_px: 0,
                origin_y_px: 8,
                substituted: false,
            },
        ],
        content_hash: "0000abcd".to_owned(),
        pixels: ink_pixels(),
    }
}

fn probe(family: ProbeFamily, alone: f64, chained: f64) -> FaceProbe {
    FaceProbe {
        probe_family: family,
        alone_width_px: alone,
        chained_width_px: chained,
        participated: alone.to_bits() != chained.to_bits(),
    }
}

/// Opaque white coverage in the right half only, so a wrong `UV` samples nothing.
fn ink_pixels() -> Vec<u8> {
    let mut pixels = vec![0_u8; (ATLAS_HEIGHT * BYTES_PER_ROW) as usize];
    for y in 0..ATLAS_HEIGHT {
        for x in INK_LEFT..ATLAS_WIDTH {
            let start = (y * BYTES_PER_ROW + x * 4) as usize;
            pixels[start..start + 4].copy_from_slice(&[255, 255, 255, 255]);
        }
    }
    pixels
}

/// The checked atlas.
#[must_use]
pub(crate) fn atlas(family: &str, weight: u16) -> GlyphAtlasDescriptor {
    GlyphAtlasDescriptor::try_from(unchecked_atlas(family, weight))
        .expect("the fixture atlas is one the baker could have produced")
}

/// The fixture run: the atlas's own layout, copied rather than re-derived.
#[must_use]
pub(crate) fn ink_run() -> CueRun {
    CueRun::from_layout(atlas(FAMILY, WEIGHT).layout())
}

/// A single-line run over `glyphs`, with a pen per cell, for the tests that break one on purpose.
#[must_use]
pub(crate) fn run_of(glyphs: Vec<u32>) -> CueRun {
    let pens = (0..glyphs.len())
        .map(|index| f64::from(u32::try_from(index).unwrap_or(u32::MAX)) * 10.0)
        .collect();
    CueRun::single_line(CueLine::new(glyphs, pens, 10.0, 8.0))
}

/// The staged text for `cues` cues, all drawing the inked cell.
#[must_use]
pub(crate) fn staged_text(cues: usize) -> StagedText {
    StagedText::single(
        default_face(),
        atlas(FAMILY, WEIGHT),
        (0..cues).map(|_| ink_run()).collect(),
    )
}
