//! Valid-by-construction inputs for the export tests, so a test that wants an invalid one says
//! which field it broke.
//!
//! Nothing here is checked in as bytes. The source clip is encoded by `osg-encode` through the same
//! platform codecs the export writes with, and the atlas is built through `UncheckedGlyphAtlas`,
//! which is the only way a descriptor can exist — so a fixture cannot be more permissive than the
//! baker the product actually uses.
//!
//! The composition these fixtures produce is **1280x720**, and both edges are deliberately multiples
//! of sixteen: `osg-decode` refuses a file whose coded size the platform decoder pads, so a test
//! that wants to read its own export back has to compose at a size the encoder does not pad.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use osg_domain::{AssetId, ProjectId};
use osg_scene::glyph::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasLayout, AtlasLine, AtlasMetrics, CellAdvanceVerdict,
    Direction, FaceProbe, FaceStyle, GLYPH_ATLAS_VERSION, GlyphAtlasDescriptor, LayoutRefusal,
    LayoutTextAlign, PixelFormat, ProbeFamily, TextTransform, UncheckedGlyphAtlas,
};
use osg_scene::scene::ResolvedFace;
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::error::CommandResult;

use super::refusal;
use super::text::{EXPORT_TEXT_SCHEMA_VERSION, ExportTextRequest, StagedAtlases};

/// Serialises the tests that acquire a graphics adapter while Media Foundation is open.
///
/// `osg-export`'s own end-to-end suite records that several threads each acquiring a `wgpu` device
/// while Media Foundation is open elsewhere faulted inside the platform layers, with no `unsafe` of
/// our own anywhere in the stack. The note is repeated here because these tests share a binary with
/// hundreds that never touch a GPU.
///
/// It used to say the product never has that concurrency. It does — see the correction in
/// `crates/osg-export/tests/support/media.rs`.
static PLATFORM: Mutex<()> = Mutex::new(());

pub(super) fn platform() -> MutexGuard<'static, ()> {
    PLATFORM.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The family the fixture request names and the fixture face resolves.
pub(super) const FAMILY: &str = "Inter";
/// The weight the fixture resolves.
pub(super) const WEIGHT: u16 = 600;
/// The synthetic clip: 16:9, two seconds at thirty frames a second.
///
/// Both edges are multiples of sixteen for the same reason the composition's are: `osg-decode`
/// refuses a file whose coded size the platform decoder pads, and the export reads this clip.
pub(super) const SOURCE_WIDTH: u32 = 256;
pub(super) const SOURCE_HEIGHT: u32 = 144;
pub(super) const SOURCE_FPS: u32 = 30;
pub(super) const SOURCE_FRAMES: u32 = 60;
/// The composition the fixture request converts to: 720p at the source's 16:9 aspect.
pub(super) const COMPOSITION_WIDTH: u32 = 1_280;
pub(super) const COMPOSITION_HEIGHT: u32 = 720;
/// How many output frames the fixture request exports: one second of the clip.
pub(super) const EXPORT_FRAMES: u32 = 30;

const ATLAS_WIDTH: u32 = 16;
const ATLAS_HEIGHT: u32 = 8;
const BYTES_PER_ROW: u32 = ATLAS_WIDTH * 4;
const INK_LEFT: u32 = 8;
/// The inked cell: an 8x8 opaque block, so a wrong `UV` samples nothing at all.
pub(super) const INK_CELL: u32 = 1;
/// The baker's identity for the fixture atlas.
pub(super) const ATLAS_CONTENT_HASH: &str = "0000abcd";

/// The render request exactly as the `WebView` sends it, over one second of the synthetic clip.
pub(super) fn request_json() -> Value {
    let mut value: Value = serde_json::from_str(REQUEST_TEXT).expect("the fixture request is JSON");
    value["sourceAssetId"] = json!(AssetId::new());
    value["projectId"] = json!(ProjectId::new());
    value
}

const REQUEST_TEXT: &str = r##"{
  "sourceAssetId": null,
  "projectId": null,
  "sceneRevision": 0,
  "selectedSubtitles": "original",
  "selectedNarration": "none",
  "narrationArtifactId": null,
  "lyrics": [{"id":"cue-1","startUs":0,"endUs":1000000,"text":"A"}],
  "settings": {
    "resolution":"720p","frameRate":30,"originalAudioVolume":100,
    "narrationVolume":80,"trimStartUs":0,"trimEndUs":1000000
  },
  "customization": {
    "fontSize":96,"fontFamily":"'Inter', sans-serif","fontWeight":600,
    "textColor":"#ffffff","textAlign":"center","lineHeight":1.2,
    "letterSpacing":0,"textTransform":"none","backgroundColor":"#000000",
    "backgroundOpacity":50,"backgroundPaddingX":16,"backgroundPaddingY":8,
    "borderRadius":4,"borderWidth":0,
    "borderColor":"#ffffff","borderStyle":"none","textShadowEnabled":false,
    "textShadowColor":"#000000","textShadowBlur":4,"textShadowOffsetX":0,
    "textShadowOffsetY":2,"glowEnabled":false,"glowColor":"#ffffff",
    "glowIntensity":10,"gradientEnabled":false,"gradientType":"linear",
    "gradientDirection":"45deg","gradientColorStart":"#ffffff",
    "gradientColorEnd":"#cccccc","gradientColorMid":"#eeeeee",
    "strokeEnabled":false,"strokeWidth":0,"strokeColor":"#000000",
    "multiShadowEnabled":false,"shadowLayers":1,"pulseEnabled":false,
    "pulseSpeed":1,"shakeEnabled":false,"shakeIntensity":2,"position":"bottom",
    "customPositionX":50,"customPositionY":80,"marginBottom":80,"marginTop":80,
    "marginLeft":0,"marginRight":0,"maxWidth":80,"fadeInDuration":0,
    "fadeOutDuration":0,"animationType":"fade","animationEasing":"linear",
    "wordWrap":true,"maxLines":3,"lineBreakBehavior":"auto",
    "rtlSupport":false,"preset":"default"
  },
  "crop": {"x":0,"y":0,"width":100,"height":100,"aspectRatio":null}
}"##;

/// The face the `WebView` resolved for the fixture request.
pub(super) fn face(family: &str, weight: u16) -> ResolvedFace {
    ResolvedFace {
        family: family.to_owned(),
        source: "sha256:0303030303030303030303030303030303030303030303030303030303030303"
            .to_owned(),
        weight,
    }
}

pub(super) fn default_face() -> ResolvedFace {
    face(FAMILY, WEIGHT)
}

/// The atlas as it arrives from the baker, so a test can break exactly one field.
fn unchecked_atlas(family: &str, weight: u16) -> UncheckedGlyphAtlas {
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
        content_hash: ATLAS_CONTENT_HASH.to_owned(),
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
pub(super) fn atlas(family: &str, weight: u16) -> GlyphAtlasDescriptor {
    GlyphAtlasDescriptor::try_from(unchecked_atlas(family, weight))
        .expect("the fixture atlas is one the baker could have produced")
}

pub(super) fn default_atlas() -> GlyphAtlasDescriptor {
    atlas(FAMILY, WEIGHT)
}

/// A staging registry stand-in that answers for exactly the atlases it was given.
///
/// The real [`crate::glyph_atlas::registry::GlyphAtlasStore`] only admits an atlas through its own
/// decoding boundary, which is private to that module, so this is how the export boundary is tested
/// without reaching into it.
#[derive(Debug, Default)]
pub(super) struct StubAtlases {
    staged: HashMap<AssetId, GlyphAtlasDescriptor>,
}

impl StubAtlases {
    pub(super) fn stage(&mut self, descriptor: GlyphAtlasDescriptor) -> AssetId {
        let atlas_id = AssetId::new();
        self.staged.insert(atlas_id, descriptor);
        atlas_id
    }
}

impl StagedAtlases for StubAtlases {
    fn descriptor(
        &self,
        atlas_id: AssetId,
        content_hash: &str,
    ) -> CommandResult<GlyphAtlasDescriptor> {
        self.staged
            .get(&atlas_id)
            .filter(|descriptor| descriptor.content_hash() == content_hash)
            .cloned()
            .ok_or_else(refusal::atlas_unknown)
    }
}

/// A registry that is present but holds nothing, for the refusal that says so.
#[derive(Debug, Default)]
pub(super) struct EmptyAtlases;

impl StagedAtlases for EmptyAtlases {
    fn descriptor(&self, _: AssetId, _: &str) -> CommandResult<GlyphAtlasDescriptor> {
        Err(refusal::atlas_unknown())
    }
}

/// The staged-text payload exactly as the `WebView` would write it: one page, one run per cue.
pub(super) fn export_text_json(atlas_id: AssetId, cues: usize) -> Value {
    export_text_json_pages(&[atlas_id], &vec![0; cues])
}

/// The same payload for a document baked into several pages, with the page each cue names.
///
/// The two are one function because the single-page shape is the multi-page shape with one entry:
/// a fixture that built them separately could drift, and then the common case would be tested
/// against a payload the baker never writes.
pub(super) fn export_text_json_pages(atlas_ids: &[AssetId], page_of_cue: &[u32]) -> Value {
    json!({
        "schemaVersion": EXPORT_TEXT_SCHEMA_VERSION,
        "face": default_face(),
        "pages": atlas_ids.iter().map(|atlas_id| json!({
            "atlasId": atlas_id,
            "atlasContentHash": ATLAS_CONTENT_HASH,
        })).collect::<Vec<_>>(),
        "cues": page_of_cue.iter().map(|page| json!({
            "page": page,
            "lines": [{
                "glyphs": [INK_CELL],
                "penXPx": [0.0],
                "advanceWidthPx": 10.0,
                "baselineYPx": 8.0,
            }],
        })).collect::<Vec<_>>(),
    })
}

/// That payload, deserialized the way the command boundary deserializes it.
pub(super) fn export_text(atlas_id: AssetId, cues: usize) -> ExportTextRequest {
    serde_json::from_value(export_text_json(atlas_id, cues))
        .expect("the fixture staged text deserializes")
}

/// Encodes the synthetic source clip and returns where it landed.
///
/// Four flat quadrants: they survive compression well enough to be read back as a number, and being
/// far apart in luma makes a missing or wrongly framed underlay unmistakable rather than a judgement
/// call.
pub(super) fn source_clip(directory: &TempDir, name: &str) -> PathBuf {
    use osg_encode::{EncoderConfig, FrameBuffer, PixelLayout, VideoConfig, open_encoder};

    let output = directory.path().join(name);
    let video = VideoConfig::new(SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_FPS, 1, SOURCE_FRAMES)
        .expect("a supported source configuration")
        .with_bitrate_kbps(8_000)
        .expect("8 Mbit/s is in range")
        .with_keyframe_interval(10)
        .expect("10 frames is in range");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video))
        .expect("Media Foundation must provide an H.264 encoder for these tests to mean anything");
    for index in 0..SOURCE_FRAMES {
        let pixels = frame_pixels(index);
        let frame = FrameBuffer::new(&pixels, SOURCE_WIDTH, SOURCE_HEIGHT, PixelLayout::Rgba8)
            .expect("a synthetic frame is the configured size");
        encoder
            .write_frame(index, &frame)
            .expect("the platform accepts a well-formed frame");
    }
    encoder.finalize().expect("the source container is closed");
    output
}

/// One `RGBA8` frame: three fixed quadrants, and one that ramps with the frame index.
///
/// The ramp is what makes "the export shows the frame the timeline names" an assertion rather than
/// a hope: every source frame is a different picture, so composing two different output instants
/// cannot accidentally produce the same image.
fn frame_pixels(index: u32) -> Vec<u8> {
    let ramp = u8::try_from(16 + index * 2).expect("sixty steps of two stay inside a byte");
    let levels = [ramp, 96_u8, 160, 224];
    let mut pixels = vec![255_u8; (SOURCE_WIDTH * SOURCE_HEIGHT * 4) as usize];
    for y in 0..SOURCE_HEIGHT {
        for x in 0..SOURCE_WIDTH {
            let quadrant =
                usize::from(y >= SOURCE_HEIGHT / 2) * 2 + usize::from(x >= SOURCE_WIDTH / 2);
            let start = ((y * SOURCE_WIDTH + x) * 4) as usize;
            pixels[start..start + 3].copy_from_slice(&[levels[quadrant]; 3]);
        }
    }
    pixels
}
