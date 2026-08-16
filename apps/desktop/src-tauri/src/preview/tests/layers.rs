//! What each layer carries, and what the composited one does not carry yet.
//!
//! Two of these assert a property of the *subtitle* layer — transparent where nothing is drawn,
//! straight alpha where something is — and both are worthless without their discriminating
//! opposite, so each also asserts that the frame really does contain the case it forbids: real ink
//! at full opacity, and a partly transparent pixel that was premultiplied before it was published.
//!
//! The third asserts a gap rather than a guarantee. `docs/rewrite/NATIVE_RENDERER.md` defines the
//! composited layer as the decoded source, cropped and backfilled, with the subtitle pass blended
//! over it; this host has no decoder, so it draws both layers with
//! `osg_compositor::Compositor::render_scene` and the two come back identical. That is measured here
//! rather than described, because a boundary that *named* two layers while returning one picture
//! would read, from the outside, exactly like one that returned two.

use osg_domain::AssetId;
use serde_json::json;
use tempfile::TempDir;

use super::super::command::render_preview_frame;
use super::super::fixtures::{
    COMPOSITION_HEIGHT, COMPOSITION_WIDTH, StubAtlases, adapter, body, clip_request_json,
    default_atlas, load, media_server, preview_request, preview_request_json, source_clip,
};
use super::super::host::PreviewHost;
use super::super::image::decode_png;
use super::super::refusal::PreviewRefusal;
use super::super::request::{PreviewFrameRequest, PreviewLayer};

/// The frame the `<img>` would actually load, for one layer, through the whole command.
///
/// End to end on purpose: the layer is a property of the request, so asking the compositor directly
/// would assert what `render_scene` does rather than what the boundary does with what it was asked.
fn published_pixels(layer: PreviewLayer) -> Vec<u8> {
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory);
    let server = media_server();
    let host = PreviewHost::default();
    let mut atlases = StubAtlases::default();
    let atlas_id = atlases.stage(default_atlas());

    let mut request = preview_request(atlas_id, 0, clip_request_json());
    request.layer = layer;
    let response = render_preview_frame(&host, &server, &atlases, &source, request)
        .expect("the fixture request renders");
    assert_eq!(
        response.layer, layer,
        "the response names the layer it drew"
    );

    let (width, height, pixels) = decode_png(body(&load(&response.frame_url)));
    assert_eq!((width, height), (COMPOSITION_WIDTH, COMPOSITION_HEIGHT));
    pixels
}

/// Every pixel's alpha, which is the only channel these tests reason about directly.
fn alphas(pixels: &[u8]) -> Vec<u8> {
    pixels.chunks_exact(4).map(|pixel| pixel[3]).collect()
}

#[test]
fn the_subtitle_layer_is_transparent_where_no_cue_covers_and_opaque_where_ink_is() {
    let _adapter = adapter();
    let pixels = published_pixels(PreviewLayer::Subtitles);
    let alpha = alphas(&pixels);

    // The cue sits at the bottom with an 80px margin, so the top-left corner is ground and nothing
    // else. A layer meant to be laid over a `<video>` that arrived with an opaque corner would hide
    // the video everywhere the subtitle is not.
    assert_eq!(
        &pixels[..4],
        &[0, 0, 0, 0],
        "the ground of a subtitle layer is fully transparent, not a colour to key out",
    );
    // The discriminating half: without real ink somewhere, the assertion above passes on an empty
    // image, which is the one failure that would look exactly like success.
    assert!(
        alpha.contains(&255),
        "the cue's glyph ink reaches full opacity",
    );
    assert!(
        alpha.iter().any(|value| matches!(*value, 1..=254)),
        "the half-opacity background box leaves partly covered pixels",
    );
}

#[test]
fn the_subtitle_layer_is_published_straight_alpha_rather_than_premultiplied() {
    let _adapter = adapter();
    let pixels = published_pixels(PreviewLayer::Subtitles);

    // A partly transparent, coloured pixel is the only place the two conventions differ at all.
    // `osg_compositor::Frame` is premultiplied, so no channel may exceed its own alpha; `PNG` is
    // straight, so this pixel's colour must be *brighter* than the alpha it carries. Publishing the
    // premultiplied bytes unchanged would dark-fringe every antialiased glyph edge and nothing else.
    let (index, published) = pixels
        .chunks_exact(4)
        .enumerate()
        .find(|(_, pixel)| matches!(pixel[3], 1..=254) && pixel[0] > 0)
        .map(|(index, pixel)| (index, [pixel[0], pixel[1], pixel[2], pixel[3]]))
        .expect("the half-opacity white box leaves partly transparent coloured pixels");
    assert!(
        published[..3].iter().any(|channel| *channel > published[3]),
        "pixel {index} carries no more colour than its own alpha, so it was published premultiplied",
    );
}

#[test]
fn the_composited_layer_has_no_video_ground_yet() {
    let _adapter = adapter();
    // DELETE THIS TEST when the host learns to decode a source frame. It asserts the documented
    // gap in `super::super`: the composited layer is *defined* as the subtitle pass over the
    // decoded, cropped, backfilled source, and this host draws it with `render_scene`, so it comes
    // back on a transparent ground and byte-identical to the subtitle layer. Asserting the gap is
    // what stops "composited" from being read as a guarantee it does not currently earn.
    let composited = published_pixels(PreviewLayer::Composited);
    let subtitles = published_pixels(PreviewLayer::Subtitles);

    assert_eq!(
        &composited[..4],
        &[0, 0, 0, 0],
        "a composited frame over a decoded source would have an opaque corner",
    );
    assert_eq!(
        composited, subtitles,
        "the two layers are one picture until this host has a video ground to lay the pass over",
    );
}

#[test]
fn an_omitted_layer_is_the_composited_one_and_an_unknown_layer_is_refused() {
    let atlas_id = AssetId::new();
    let omitted: PreviewFrameRequest = serde_json::from_value(preview_request_json(
        atlas_id,
        0,
        &clip_request_json(),
        None,
    ))
    .expect("a request without a layer is still a request");
    // The guaranteed layer is what a caller that says nothing gets. The approximation has to be
    // asked for by name.
    assert_eq!(omitted.layer, PreviewLayer::Composited);

    for (named, expected) in [
        ("composited", PreviewLayer::Composited),
        ("subtitles", PreviewLayer::Subtitles),
    ] {
        let request: PreviewFrameRequest = serde_json::from_value(preview_request_json(
            atlas_id,
            0,
            &clip_request_json(),
            Some(named),
        ))
        .expect("a named layer deserializes");
        assert_eq!(request.layer, expected);
    }

    // A typo must not quietly become the default: a caller asking for a layer this build does not
    // have is asking for a picture it would not recognise.
    assert!(
        serde_json::from_value::<PreviewFrameRequest>(preview_request_json(
            atlas_id,
            0,
            &clip_request_json(),
            Some("overlay"),
        ))
        .is_err(),
        "an unknown layer is refused rather than defaulted",
    );
    // And the field is still closed: nothing outside the request's own vocabulary is read.
    let mut extra = preview_request_json(atlas_id, 0, &clip_request_json(), Some("subtitles"));
    extra["ground"] = json!("video");
    assert!(serde_json::from_value::<PreviewFrameRequest>(extra).is_err());
}

#[test]
fn the_device_lost_code_is_the_one_the_webview_switches_on() {
    // `NATIVE_PREVIEW_DEVICE_LOST_CODES` in `src/components/previews/native/useNativePreviewFrame.js`
    // is this exact string, and `useNativePreviewFrame.test.js` reads this file to prove it. A lost
    // device reported under a code the editor does not recognise is handled as an ordinary refusal,
    // which never releases the surface — so the two ends have to be pinned from both sides.
    assert_eq!(PreviewRefusal::DeviceLost.code(), "previewDeviceLost");
}

#[test]
fn a_refusal_on_the_subtitle_path_carries_no_path_either() {
    let server = media_server();
    let host = PreviewHost::default();
    let mut atlases = StubAtlases::default();
    let atlas_id = atlases.stage(default_atlas());
    let missing = std::path::Path::new("no-such-preview-source-for-a-layer.mp4");

    let mut request = preview_request(atlas_id, 0, clip_request_json());
    request.layer = PreviewLayer::Subtitles;
    let refusal = render_preview_frame(&host, &server, &atlases, missing, request)
        .expect_err("an unreadable source is refused whichever layer was asked for");

    assert_eq!(refusal, PreviewRefusal::SourceUnreadable);
    let rendered = format!(
        "{refusal} {refusal:?} {}",
        serde_json::to_string(&refusal).expect("a refusal serializes")
    );
    assert!(!rendered.contains("no-such-preview-source-for-a-layer"));
    assert!(!rendered.contains(".mp4"));
}
