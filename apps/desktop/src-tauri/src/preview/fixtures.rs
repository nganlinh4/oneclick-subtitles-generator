//! Valid-by-construction inputs, so a test that wants an invalid one says which field it broke.
//!
//! The render request is built by deserializing the shape the `WebView` actually sends rather than
//! by constructing the contract types, so the tests cross the boundary the product crosses. The
//! atlas is built the same way: through `UncheckedGlyphAtlas`, which is the only way a descriptor
//! can exist, so a fixture cannot be more permissive than the baker.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use osg_domain::{AssetId, ProjectId};
use osg_encode::{EncoderConfig, FrameBuffer, PixelLayout, VideoConfig, open_encoder};
use osg_media_server::MediaServer;
use osg_render::{RenderPlan, RenderRequest};
use osg_scene::glyph::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasLayout, AtlasLine, AtlasMetrics, CellAdvanceVerdict,
    Direction, FaceProbe, FaceStyle, GLYPH_ATLAS_VERSION, GlyphAtlasDescriptor, LayoutRefusal,
    LayoutTextAlign, PixelFormat, ProbeFamily, TextTransform, UncheckedGlyphAtlas,
};
use osg_scene::scene::ResolvedFace;
use serde_json::{Value, json};
use tempfile::TempDir;

use super::command::StagedAtlases;
use super::refusal::PreviewRefusal;
use super::request::{PreviewFrameRequest, PreviewLayer};

/// Serialises the tests that acquire a graphics adapter.
///
/// `osg-export`'s end-to-end suite records that several threads each acquiring their own `wgpu`
/// device while Media Foundation is open elsewhere faulted inside the platform layers, with no
/// `unsafe` of our own anywhere in the stack. The product composes one preview frame at a time, so
/// that concurrency is not a shape it ever has. The note is repeated here rather than assumed
/// known, because these tests share a binary with two hundred that do not touch a GPU at all.
static ADAPTER: Mutex<()> = Mutex::new(());

/// Takes the adapter lock, ignoring poisoning so one failing test does not fail the rest.
pub(super) fn adapter() -> MutexGuard<'static, ()> {
    ADAPTER.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The family the fixture request names and the fixture face resolves.
pub(super) const FAMILY: &str = "Inter";
/// The weight the fixture resolves.
pub(super) const WEIGHT: u16 = 600;
/// The fixture source's dimensions and duration, as a decoder would report them.
pub(super) const SOURCE_WIDTH: u32 = 320;
pub(super) const SOURCE_HEIGHT: u32 = 240;
pub(super) const SOURCE_DURATION_US: u64 = 3_000_000;
/// The composition the fixture request converts to: 360p at the source's 4:3 aspect.
pub(super) const COMPOSITION_WIDTH: u32 = 480;
pub(super) const COMPOSITION_HEIGHT: u32 = 360;

const ATLAS_WIDTH: u32 = 16;
const ATLAS_HEIGHT: u32 = 8;
const BYTES_PER_ROW: u32 = ATLAS_WIDTH * 4;
const INK_LEFT: u32 = 8;
/// The inked cell: an 8x8 opaque block, so a wrong `UV` samples nothing at all.
const INK_CELL: u32 = 1;

/// The render request exactly as the `WebView` sends it, with one cue over the whole clip.
///
/// The background is **white at half opacity** on purpose. That puts a large field of partly
/// transparent, brightly coloured pixels in every frame, which is what makes the straight-alpha
/// assertion able to fail: premultiplied, those pixels are mid-grey; straight, they are white.
///
/// Parsed from the literal wire text rather than built with `json!`, so the fixture is the JSON the
/// boundary receives rather than a Rust expression that resembles it.
#[must_use]
pub(super) fn request_json() -> Value {
    let mut value: Value = serde_json::from_str(REQUEST_TEXT).expect("the fixture request is JSON");
    // Fresh identifiers per call, so two fixtures are never accidentally the same project.
    value["sourceAssetId"] = json!(AssetId::new());
    value["projectId"] = json!(ProjectId::new());
    value
}

/// The request body, exactly as `renderService` serialises it.
const REQUEST_TEXT: &str = r##"{
  "sourceAssetId": null,
  "projectId": null,
  "narrationArtifactId": null,
  "lyrics": [{"id":"cue-1","startUs":0,"endUs":3000000,"text":"A"}],
  "settings": {
    "resolution":"360p","frameRate":30,"originalAudioVolume":100,
    "narrationVolume":80,"trimStartUs":0,"trimEndUs":3000000
  },
  "customization": {
    "fontSize":28,"fontFamily":"'Inter', sans-serif","fontWeight":600,
    "textColor":"#ffffff","textAlign":"center","lineHeight":1.2,
    "letterSpacing":0,"textTransform":"none","backgroundColor":"#ffffff",
    "backgroundOpacity":50,"borderRadius":4,"borderWidth":0,
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

/// The fixture request, deserialized.
#[must_use]
pub(super) fn render_request(value: Value) -> RenderRequest {
    serde_json::from_value(value).expect("the fixture request deserializes")
}

/// The fixture request, validated against the fixture source's numbers.
#[must_use]
pub(super) fn plan(value: Value) -> RenderPlan {
    render_request(value)
        .validate(SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_DURATION_US)
        .expect("the fixture request validates against the fixture source")
}

/// The face the `WebView` resolved for the fixture request.
#[must_use]
pub(super) fn face(family: &str, weight: u16) -> ResolvedFace {
    ResolvedFace {
        family: family.to_owned(),
        source: "sha256:0202020202020202020202020202020202020202020202020202020202020202"
            .to_owned(),
        weight,
    }
}

/// The fixture face.
#[must_use]
pub(super) fn default_face() -> ResolvedFace {
    face(FAMILY, WEIGHT)
}

/// The atlas as it arrives from the baker, so a test can break exactly one field.
#[must_use]
pub(super) fn unchecked_atlas(family: &str, weight: u16) -> UncheckedGlyphAtlas {
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
pub(super) fn atlas(family: &str, weight: u16) -> GlyphAtlasDescriptor {
    GlyphAtlasDescriptor::try_from(unchecked_atlas(family, weight))
        .expect("the fixture atlas is one the baker could have produced")
}

/// The fixture atlas.
#[must_use]
pub(super) fn default_atlas() -> GlyphAtlasDescriptor {
    atlas(FAMILY, WEIGHT)
}

/// A staging registry stand-in that answers for exactly the atlases it was given.
#[derive(Debug, Default)]
pub(super) struct StubAtlases {
    staged: HashMap<AssetId, GlyphAtlasDescriptor>,
}

impl StubAtlases {
    /// Stages one atlas under a fresh handle and returns it.
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
    ) -> Result<GlyphAtlasDescriptor, PreviewRefusal> {
        self.staged
            .get(&atlas_id)
            .filter(|descriptor| descriptor.content_hash() == content_hash)
            .cloned()
            .ok_or(PreviewRefusal::AtlasUnknown)
    }
}

/// A preview request for `frame_index`, naming `atlas_id` and carrying `render`.
///
/// The layer is left at its default, which is the composited one, so a test that does not mention
/// layers is asking for exactly what every caller asked for before layers existed.
#[must_use]
pub(super) fn preview_request(
    atlas_id: AssetId,
    frame_index: u32,
    render: Value,
) -> PreviewFrameRequest {
    PreviewFrameRequest {
        schema_version: super::PREVIEW_SCHEMA_VERSION,
        scene_revision: "3f2a91cc-812".to_owned(),
        atlas_id,
        atlas_content_hash: "0000abcd".to_owned(),
        frame_index,
        face: default_face(),
        render: render_request(render),
        layer: PreviewLayer::default(),
    }
}

/// The same request as the wire text a `WebView` would send, so serde's own defaulting is exercised.
///
/// `layer` is included only when `layer` is `Some`, which is how a test can assert that an omitted
/// field means the composited frame rather than that some other code path supplied it.
#[must_use]
pub(super) fn preview_request_json(
    atlas_id: AssetId,
    frame_index: u32,
    render: &Value,
    layer: Option<&str>,
) -> Value {
    let mut value = json!({
        "schemaVersion": super::PREVIEW_SCHEMA_VERSION,
        "sceneRevision": "3f2a91cc-812",
        "atlasId": atlas_id,
        "atlasContentHash": "0000abcd",
        "frameIndex": frame_index,
        "face": default_face(),
        "render": render,
    });
    if let Some(layer) = layer {
        value["layer"] = json!(layer);
    }
    value
}

/// A tiny valid `PNG`, for the lease and bounds tests that care about capabilities, not pixels.
///
/// Encoded rather than checked in as bytes, because the transport signature-checks what it is given
/// and a hand-written header would be testing the fixture rather than the boundary. It deliberately
/// does not go through the compositor: acquiring a device to prove an eviction order would make the
/// bounds tests depend on the GPU for no reason.
#[must_use]
pub(super) fn published_bytes() -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().expect("a 2x2 png header");
    writer
        .write_image_data(&[255_u8; 16])
        .expect("a 2x2 opaque white image");
    writer.finish().expect("the png is closed");
    bytes
}

/// A media server with the shipped release origins.
#[must_use]
pub(super) fn media_server() -> MediaServer {
    MediaServer::start(["https://tauri.localhost".to_owned()]).expect("start the media server")
}

/// The synthetic source clip the end-to-end test probes and plans against.
///
/// Encoded here rather than checked in, so what the preview plans against is a real container that
/// Media Foundation produced and can read back, not bytes somebody generated once.
#[must_use]
pub(super) fn source_clip(directory: &TempDir) -> PathBuf {
    let output = directory.path().join("preview-source.mp4");
    let video = VideoConfig::new(SOURCE_WIDTH, SOURCE_HEIGHT, 30, 1, 90)
        .expect("a supported source configuration")
        .with_bitrate_kbps(8_000)
        .expect("8 Mbit/s is in range")
        .with_keyframe_interval(10)
        .expect("10 frames is in range");
    let mut encoder = open_encoder(&output, EncoderConfig::video_only(video))
        .expect("Media Foundation must provide an H.264 encoder");
    let pixels = vec![64_u8; (SOURCE_WIDTH * SOURCE_HEIGHT * 4) as usize];
    for index in 0..90 {
        let frame = FrameBuffer::new(&pixels, SOURCE_WIDTH, SOURCE_HEIGHT, PixelLayout::Rgba8)
            .expect("a synthetic frame is the configured size");
        encoder
            .write_frame(index, &frame)
            .expect("the platform accepts a well-formed frame");
    }
    encoder.finalize().expect("the source container is closed");
    output
}

/// The fixture request retargeted at the synthetic clip, which is three seconds long.
#[must_use]
pub(super) fn clip_request_json() -> Value {
    let mut value = request_json();
    value["settings"]["trimEndUs"] = json!(1_000_000);
    value["lyrics"] = json!([{"id":"cue-1","startUs":0,"endUs":1_000_000,"text":"A"}]);
    value
}

/// Loads a published frame URL the way an `<img>` would, returning the raw HTTP response.
///
/// A real socket rather than a call into the registry: the property under test is that the URL the
/// command handed back resolves over the transport the `WebView` is allowed to use.
#[must_use]
pub(super) fn load(url: &str) -> Vec<u8> {
    let authority = url
        .strip_prefix("http://")
        .and_then(|rest| rest.split_once('/'))
        .expect("a loopback frame url");
    let target = &url[url.find("/frame/").expect("a frame path")..];
    let mut stream = TcpStream::connect(authority.0).expect("connect to the media server");
    stream
        .write_all(
            format!(
                "GET {target} HTTP/1.1\r\nHost: {}\r\nOrigin: https://tauri.localhost\r\n\
                 Connection: close\r\n\r\n",
                authority.0
            )
            .as_bytes(),
        )
        .expect("write the frame request");
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .expect("read the frame response");
    response
}

/// The body of an HTTP response.
#[must_use]
pub(super) fn body(response: &[u8]) -> &[u8] {
    response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map_or(&[][..], |index| &response[index + 4..])
}
