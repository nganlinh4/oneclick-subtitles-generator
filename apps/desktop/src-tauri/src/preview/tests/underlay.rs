//! The decoded video ground under the composited layer.
//!
//! `docs/rewrite/NATIVE_RENDERER.md` says the paused, scrubbing and style-adjusting editor must show
//! the fully composited native frame, because that is where a user decides whether the output looks
//! right. That claim is only worth anything if the video is really there, is really the frame the
//! export would use, and really carries the crop and the flips. Each of those is measured here.
//!
//! Every pixel assertion runs over [`quadrant_clip`], whose four quadrants are four far-apart
//! colours. A frame that lost its underlay, ignored the crop or ignored a flip therefore reports a
//! **different quadrant colour** at a sampled point rather than a small difference someone has to
//! judge — and the same points on the subtitle layer are fully transparent, which is the
//! discriminating opposite each of these needs.

use std::fs;
use std::path::PathBuf;

use osg_decode::{DecoderConfig, open_decoder};
use osg_domain::AssetId;
use osg_media_server::MediaServer;
use serde_json::{Value, json};
use tempfile::TempDir;

use super::super::command::render_preview_frame;
use super::super::fixtures::{
    BOTTOM_LEFT, QUADRANTS, StubAtlases, TOP_LEFT, TOP_RIGHT, adapter, body, clip_request_json,
    default_atlas, default_face, load, media_server, plan, preview_request, quadrant_clip,
    render_request, request_json,
};
use super::super::host::{PreviewGround, PreviewHost};
use super::super::image::decode_png;
use super::super::plan::{PreviewComposition, plan_for_source};
use super::super::refusal::PreviewRefusal;
use super::super::request::PreviewLayer;
use super::super::source::SourceDecoders;

/// How far a decoded pixel may sit from the quadrant colour it was encoded as.
///
/// Generous on purpose. The number that decides every assertion below is *which* quadrant colour is
/// nearest — they are two hundred levels apart per channel, so nothing a lossy H.264 round trip
/// through 4:2:0 chroma does can move one onto another. This bound only catches a pixel that is not
/// really the source's at all.
const MAX_QUADRANT_DISTANCE: u32 = 30_000;

/// Frames scrubbed through in one pass, well past the source's ten-frame keyframe interval.
const SCRUB_FRAMES: u32 = 12;

/// The output frame whose source frame the export's own decoder is asked for independently.
const SAMPLED_OUTPUT_FRAME: u32 = 7;

/// Which source frame that output frame shows: 0.5s of trim plus 7/24s, on a 30fps source.
const SAMPLED_SOURCE_FRAME: u64 = 23;

/// One preview session over the quadrant clip: a server, a host, a staged atlas and a source.
struct Session {
    /// Held for its `Drop`: the encoded clips live in it.
    _directory: TempDir,
    source: PathBuf,
    server: MediaServer,
    host: PreviewHost,
    atlases: StubAtlases,
    atlas_id: AssetId,
}

impl Session {
    fn new() -> Self {
        let directory = TempDir::new().expect("a temporary directory");
        let source = quadrant_clip(&directory);
        let mut atlases = StubAtlases::default();
        let atlas_id = atlases.stage(default_atlas());
        Self {
            _directory: directory,
            source,
            server: media_server(),
            host: PreviewHost::default(),
            atlases,
            atlas_id,
        }
    }

    /// Renders one frame of `render` and returns the image an `<img>` would actually load.
    ///
    /// End to end through the command, because the ground is chosen from the request's layer and
    /// asking the host directly would assert what the compositor does rather than what the boundary
    /// does with what it was asked.
    fn image(&self, render: &Value, frame_index: u32, layer: PreviewLayer) -> Image {
        let mut request = preview_request(self.atlas_id, frame_index, render.clone());
        request.layer = layer;
        let response = render_preview_frame(
            &self.host,
            &self.server,
            &self.atlases,
            &self.source,
            request,
        )
        .expect("the quadrant request renders");
        assert_eq!(
            response.layer, layer,
            "the response names the layer it drew"
        );
        let (width, height, pixels) = decode_png(body(&load(&response.frame_url)));
        assert_eq!((width, height), (response.width_px, response.height_px));
        Image {
            width,
            height,
            pixels,
        }
    }
}

/// A decoded preview image, addressed by pixel.
struct Image {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

impl Image {
    /// The RGBA sample at `(x, y)`.
    fn sample(&self, x: u32, y: u32) -> [u8; 4] {
        let start = usize::try_from((y * self.width + x) * 4).expect("a small frame offset");
        self.pixels[start..start + 4]
            .try_into()
            .expect("four channels per pixel")
    }

    /// Asserts the sample at `(x, y)` is the source's `quadrant`, opaque and close to its colour.
    fn assert_quadrant(&self, x: u32, y: u32, quadrant: usize, what: &str) {
        let pixel = self.sample(x, y);
        let (nearest, distance) = nearest_quadrant(pixel);
        assert_eq!(nearest, quadrant, "{what}: {pixel:?} is not that quadrant");
        assert!(
            distance <= MAX_QUADRANT_DISTANCE,
            "{what}: {pixel:?} is {distance} from {:?}, so it is not the source's pixel",
            QUADRANTS[quadrant],
        );
        assert_eq!(pixel[3], 255, "{what}: the video ground must be opaque");
    }

    /// How many pixels are recognisably one quadrant's colour.
    fn count_near(&self, quadrant: usize) -> usize {
        self.pixels
            .chunks_exact(4)
            .filter(|pixel| {
                let sample = [pixel[0], pixel[1], pixel[2], pixel[3]];
                let (nearest, distance) = nearest_quadrant(sample);
                nearest == quadrant && distance <= MAX_QUADRANT_DISTANCE
            })
            .count()
    }
}

/// The quadrant colour a pixel is nearest, and the squared distance to it.
fn nearest_quadrant(pixel: [u8; 4]) -> (usize, u32) {
    QUADRANTS
        .iter()
        .enumerate()
        .map(|(index, colour)| {
            let distance = (0..3)
                .map(|channel| {
                    let difference = i32::from(pixel[channel]) - i32::from(colour[channel]);
                    difference.unsigned_abs().pow(2)
                })
                .sum();
            (index, distance)
        })
        .min_by_key(|(_, distance)| *distance)
        .expect("four quadrant colours")
}

/// The clip request with 24fps output and half a second of trim, over a 30fps source.
///
/// Both on purpose: an output frame index is then *not* a source frame index, which is the only
/// shape in which "the decoder samples the right frame" can fail visibly. Frame
/// [`SAMPLED_OUTPUT_FRAME`] of this timeline is source frame [`SAMPLED_SOURCE_FRAME`].
fn rebased_request() -> Value {
    let mut value = request_json();
    value["settings"]["frameRate"] = json!(24);
    value["settings"]["trimStartUs"] = json!(500_000);
    value["settings"]["trimEndUs"] = json!(2_500_000);
    value["lyrics"] = json!([{"id":"cue-1","startUs":500_000,"endUs":2_500_000,"text":"A"}]);
    value
}

#[test]
fn the_composited_layer_carries_the_decoded_source_where_no_cue_covers() {
    let _adapter = adapter();
    let session = Session::new();
    let render = clip_request_json();

    let composited = session.image(&render, 0, PreviewLayer::Composited);
    let (quarter_x, quarter_y) = (composited.width / 4, composited.height / 4);
    let (three_quarter_x, three_quarter_y) = (quarter_x * 3, quarter_y * 3);

    // Each quadrant of the source, in its own place, at full opacity. A composited frame that had
    // been drawn on a transparent ground reports `[0, 0, 0, 0]` at every one of them.
    composited.assert_quadrant(quarter_x, quarter_y, TOP_LEFT, "the top left");
    composited.assert_quadrant(three_quarter_x, quarter_y, TOP_RIGHT, "the top right");
    composited.assert_quadrant(quarter_x, three_quarter_y, BOTTOM_LEFT, "the bottom left");

    // The discriminating opposite: the same instant, the same cue, on the layer that is *defined*
    // as having no video under it.
    let subtitles = session.image(&render, 0, PreviewLayer::Subtitles);
    for (x, y) in [
        (quarter_x, quarter_y),
        (three_quarter_x, quarter_y),
        (quarter_x, three_quarter_y),
    ] {
        assert_eq!(
            subtitles.sample(x, y),
            [0, 0, 0, 0],
            "the subtitle layer gained a video underlay at ({x}, {y})",
        );
    }
    // And the cue really is on both, so "where no cue covers" is a real qualification rather than a
    // description of the whole frame.
    assert!(
        subtitles
            .pixels
            .chunks_exact(4)
            .any(|pixel| pixel[3] == 255),
        "no cue was drawn at all, so the sampled points prove nothing",
    );
}

#[test]
fn crop_and_flip_reach_the_composited_layer_and_not_the_subtitle_one() {
    let _adapter = adapter();
    let session = Session::new();
    let plain = clip_request_json();
    let mut flipped = plain.clone();
    flipped["crop"]["flipX"] = json!(true);
    let mut cropped = plain.clone();
    cropped["crop"]["width"] = json!(50.0);

    // The flip, seen as the top two quadrants changing places.
    let unflipped_image = session.image(&plain, 0, PreviewLayer::Composited);
    let (quarter_x, quarter_y) = (unflipped_image.width / 4, unflipped_image.height / 4);
    let three_quarter_x = quarter_x * 3;
    unflipped_image.assert_quadrant(quarter_x, quarter_y, TOP_LEFT, "unflipped, left");
    unflipped_image.assert_quadrant(three_quarter_x, quarter_y, TOP_RIGHT, "unflipped, right");

    let flipped_image = session.image(&flipped, 0, PreviewLayer::Composited);
    flipped_image.assert_quadrant(quarter_x, quarter_y, TOP_RIGHT, "flipped, left");
    flipped_image.assert_quadrant(three_quarter_x, quarter_y, TOP_LEFT, "flipped, right");

    // The crop, seen as a narrower frame that no longer contains the source's right half at all.
    let cropped_image = session.image(&cropped, 0, PreviewLayer::Composited);
    assert_eq!(
        (cropped_image.width, cropped_image.height),
        (unflipped_image.width / 2, unflipped_image.height),
        "the crop region did not drive the composition size",
    );
    assert!(
        unflipped_image.count_near(TOP_RIGHT) > 0,
        "the uncropped frame has no right-hand quadrant, so the crop assertion proves nothing",
    );
    assert_eq!(
        cropped_image.count_near(TOP_RIGHT),
        0,
        "the cropped frame still contains the half the crop excluded",
    );

    // Neither reaches the subtitle layer: it is the same pass on the same transparent ground, and a
    // flip applied to it would be applied a second time by the `WebView`'s own `<video>`.
    let plain_pass = session.image(&plain, 0, PreviewLayer::Subtitles);
    let flipped_pass = session.image(&flipped, 0, PreviewLayer::Subtitles);
    assert_eq!(
        plain_pass.pixels, flipped_pass.pixels,
        "the flip reached the subtitle layer",
    );
    assert_eq!(plain_pass.sample(quarter_x, quarter_y), [0, 0, 0, 0]);
}

#[test]
fn the_frame_decoded_for_an_output_frame_is_the_one_the_export_would_decode() {
    let _adapter = adapter();
    let directory = TempDir::new().expect("a temporary directory");
    let source = quadrant_clip(&directory);
    let render = rebased_request();
    let converted =
        plan_for_source(render_request(render), &source).expect("the rebased request plans");
    let composition = PreviewComposition::build(&converted, &default_face(), default_atlas())
        .expect("the rebased request converts and composes");

    // The grid the decoder is opened with is the export's own, not one this module derived.
    let export = osg_export::ExportPlan::convert(&converted, &default_face())
        .expect("the export conversion accepts the request");
    assert_eq!(composition.source_timeline(), export.source_timeline());

    let decoders = SourceDecoders::default();
    let decoded = decoders
        .frame(
            AssetId::new(),
            &source,
            DecoderConfig::new(composition.source_timeline()),
            SAMPLED_OUTPUT_FRAME,
        )
        .expect("the preview decodes the frame the timeline names");

    // What `osg_export::FrameRenderer::open` does, verbatim: the same source, the same timeline.
    let mut reference = open_decoder(&source, DecoderConfig::new(export.source_timeline()))
        .expect("the export's own decoder opens the same source");
    let expected = reference
        .frame_for_output(SAMPLED_OUTPUT_FRAME)
        .expect("the export decodes the frame the timeline names");
    reference.close();

    assert_eq!(decoded.source_index(), expected.source_index());
    assert_eq!(decoded.pixels(), expected.pixels());
    // The discriminating half. A decoder handed the output index instead of the output *instant*
    // would answer frame 7 here, and every assertion above would still pass.
    assert_eq!(decoded.source_index(), SAMPLED_SOURCE_FRAME);
    assert_ne!(
        decoded.source_index(),
        u64::from(SAMPLED_OUTPUT_FRAME),
        "the trim and the frame-rate change did not move the sampled source frame",
    );
}

#[test]
fn a_source_that_cannot_be_decoded_refuses_by_type_rather_than_dropping_the_video() {
    let _adapter = adapter();
    let directory = TempDir::new().expect("a temporary directory");
    let broken = directory.path().join("not-a-container.mp4");
    fs::write(&broken, b"this file is not a video container").expect("write the broken source");
    let absent = directory.path().join("never-created.mp4");

    let host = PreviewHost::default();
    let composition =
        PreviewComposition::build(&plan(request_json()), &default_face(), default_atlas())
            .expect("the fixture request converts and composes");

    for path in [broken.as_path(), absent.as_path()] {
        let ground = PreviewGround::DecodedSource {
            asset_id: AssetId::new(),
            path,
        };
        let refusal = host
            .compose(&composition, 0, ground)
            .expect_err("a source that cannot be decoded is refused");
        // Not a panic, and — the failure that would actually mislead — not a frame. A composited
        // layer that quietly fell back to the subtitle pass looks exactly like a broken video.
        assert_eq!(refusal, PreviewRefusal::SourceUnreadable);
        let rendered = format!(
            "{refusal} {refusal:?} {}",
            serde_json::to_string(&refusal).expect("a refusal serializes")
        );
        assert!(!rendered.contains("not-a-container"));
        assert!(!rendered.contains("never-created"));
    }

    // The discriminating half: the same host and the same scene still compose on a ground that
    // needs no decoder, so what was refused was the video and not the composition.
    assert!(
        host.compose(&composition, 0, PreviewGround::Transparent)
            .is_ok(),
        "the refusal was about the scene rather than the source",
    );
    assert_eq!(
        host.decoders().opens(),
        0,
        "a decoder that never opened must not be counted as one that did",
    );
}

#[test]
fn one_decoder_serves_a_whole_scrub_and_is_reopened_only_when_the_media_moves() {
    let _adapter = adapter();
    let session = Session::new();
    let render = clip_request_json();

    for index in 0..SCRUB_FRAMES {
        session.image(&render, index, PreviewLayer::Composited);
    }
    assert_eq!(
        session.host.decoders().opens(),
        1,
        "the scrub reopened the source instead of keeping it",
    );

    // Kept *and* walked. A decoder that re-seeks per frame decodes from the previous keyframe every
    // time, which at a ten-frame interval is several times this many samples.
    let stats = session
        .host
        .decoders()
        .stats()
        .expect("a decoder is still held");
    assert!(
        stats.seeks() <= 1,
        "a forward scrub repositioned the reader {} times",
        stats.seeks(),
    );
    assert!(
        stats.samples_decoded() <= u64::from(SCRUB_FRAMES) + 2,
        "a forward scrub decoded {} samples for {SCRUB_FRAMES} frames",
        stats.samples_decoded(),
    );

    // A different media is a different decoder: `clip_request_json` mints a fresh asset identifier.
    session.image(&clip_request_json(), 0, PreviewLayer::Composited);
    assert_eq!(session.host.decoders().opens(), 2);

    // So is the same media on a different output timeline, because the decoder samples against it.
    let mut retimed = render.clone();
    retimed["settings"]["frameRate"] = json!(24);
    session.image(&retimed, 0, PreviewLayer::Composited);
    assert_eq!(session.host.decoders().opens(), 3);

    // And the subtitle layer needs none of it: it is the pass on a transparent ground.
    session.image(&retimed, 1, PreviewLayer::Subtitles);
    assert_eq!(
        session.host.decoders().opens(),
        3,
        "the subtitle layer opened a decoder it has no use for",
    );
}
