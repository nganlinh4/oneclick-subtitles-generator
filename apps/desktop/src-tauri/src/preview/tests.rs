//! What the preview boundary has to hold, asserted so that each test can fail.
//!
//! Several of these assert a *negative* — no path in an error, no premultiplied pixel in a file, no
//! second release. A negative assertion is worthless unless the thing it forbids is reachable, so
//! each one also asserts the discriminating positive beside it: the frame really is premultiplied
//! before it is converted, the request really does carry the path-shaped string that must not come
//! back, and the lease really did release once before it was asked to release again.

use osg_compositor::AdapterSelection;
use osg_domain::{AssetId, ProjectId};
use osg_scene::glyph::{CellAdvanceVerdict, GlyphAtlasDescriptor};
use tempfile::TempDir;

use super::command::render_preview_frame;
use super::fixtures::{
    COMPOSITION_HEIGHT, COMPOSITION_WIDTH, FAMILY, SOURCE_HEIGHT, SOURCE_WIDTH, StubAtlases,
    WEIGHT, adapter, atlas, body, clip_request_json, default_atlas, default_face, face, load,
    media_server, plan, preview_request, render_request, request_json, source_clip,
    unchecked_atlas,
};
use super::host::PreviewHost;
use super::image::{decode_png, encode_png};
use super::plan::{PreviewComposition, plan_for_source};
use super::publish::PreviewBinding;
use super::refusal::PreviewRefusal;
use super::request::PreviewLayer;
use super::{
    MAX_RENDERS_IN_FLIGHT, MAX_RETAINED_BYTES, MAX_RETAINED_FRAMES, PREVIEW_MIME_TYPE,
    PREVIEW_SCHEMA_VERSION,
};

/// Leases, retention bounds and eviction order, which need no adapter and no source.
mod retention;

/// What each layer actually carries, and what the composited one does not carry yet.
mod layers;

/// A host that draws on the real adapter with the shipped bounds.
fn host() -> PreviewHost {
    PreviewHost::default()
}

/// The fixture composition: the export's conversion, applied to the fixture request.
fn composition() -> PreviewComposition {
    PreviewComposition::build(&plan(request_json()), &default_face(), default_atlas())
        .expect("the fixture request converts and composes")
}

fn binding() -> PreviewBinding {
    PreviewBinding {
        project_id: ProjectId::new(),
        source_asset_id: AssetId::new(),
        scene_revision: "revision-one".to_owned(),
        atlas_id: AssetId::new(),
    }
}

// ---- The whole command ------------------------------------------------------------------------

#[test]
fn a_valid_request_renders_and_returns_a_url_an_image_element_can_load() {
    let _adapter = adapter();
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory);
    let server = media_server();
    let host = host();
    let mut atlases = StubAtlases::default();
    let atlas_id = atlases.stage(default_atlas());

    let response = render_preview_frame(
        &host,
        &server,
        &atlases,
        &source,
        preview_request(atlas_id, 7, clip_request_json()),
    )
    .expect("the fixture request renders");

    assert_eq!(response.frame_index, 7);
    assert_eq!(response.mime_type, PREVIEW_MIME_TYPE);
    assert_eq!(response.width_px, COMPOSITION_WIDTH);
    assert_eq!(response.height_px, COMPOSITION_HEIGHT);
    assert_eq!(response.sequence_id.get_version_num(), 4);
    // A capability URL, never a path, and never the source the frame was composed over.
    assert!(response.frame_url.starts_with("http://127.0.0.1:"));
    assert!(response.frame_url.contains("&frame_token="));
    assert!(!response.frame_url.contains("preview-source"));

    let loaded = load(&response.frame_url);
    let text = String::from_utf8_lossy(&loaded);
    assert!(text.starts_with("HTTP/1.1 200"), "{}", first_line(&text));
    assert!(text.contains("Content-Type: image/png"));
    let (width, height, _) = decode_png(body(&loaded));
    assert_eq!((width, height), (COMPOSITION_WIDTH, COMPOSITION_HEIGHT));
    assert_eq!(host.frames().stats().0, 1);
}

#[test]
fn the_command_refuses_before_it_opens_anything_it_cannot_use() {
    let server = media_server();
    let host = host();
    let mut atlases = StubAtlases::default();
    let atlas_id = atlases.stage(default_atlas());
    // A path that does not exist: every refusal below must arrive without it being opened.
    let missing = std::path::Path::new("no-such-preview-source.mp4");

    let mut unknown_version = preview_request(atlas_id, 0, request_json());
    unknown_version.schema_version = PREVIEW_SCHEMA_VERSION + 1;
    let mut two_cues = preview_request(atlas_id, 0, request_json());
    let extra = two_cues.render.lyrics[0].clone();
    two_cues.render.lyrics.push(extra);
    let mut blank_revision = preview_request(atlas_id, 0, request_json());
    blank_revision.scene_revision = String::new();
    let unstaged = preview_request(AssetId::new(), 0, request_json());
    let mut wrong_hash = preview_request(atlas_id, 0, request_json());
    wrong_hash.atlas_content_hash = "ffffffff".to_owned();

    for (request, expected) in [
        (unknown_version, PreviewRefusal::UnsupportedRequest),
        (two_cues, PreviewRefusal::UnsupportedRequest),
        (blank_revision, PreviewRefusal::UnsupportedRequest),
        (unstaged, PreviewRefusal::AtlasUnknown),
        (wrong_hash, PreviewRefusal::AtlasUnknown),
    ] {
        assert_eq!(
            render_preview_frame(&host, &server, &atlases, missing, request).err(),
            Some(expected)
        );
    }
    assert_eq!(host.frames().stats(), (0, 0));
    assert_eq!(host.frames().release_count(), 0);
}

#[test]
fn an_unreadable_source_is_its_own_refusal_and_a_readable_one_is_not() {
    let directory = TempDir::new().expect("a temporary directory");
    let missing = directory.path().join("absent.mp4");
    assert_eq!(
        plan_for_source(render_request(clip_request_json()), &missing).err(),
        Some(PreviewRefusal::SourceUnreadable)
    );

    let _adapter = adapter();
    let source = source_clip(&directory);
    let planned = plan_for_source(render_request(clip_request_json()), &source)
        .expect("the synthetic clip plans");
    assert_eq!(planned.source_width, SOURCE_WIDTH);
    assert_eq!(planned.source_height, SOURCE_HEIGHT);
    assert_eq!(planned.width, COMPOSITION_WIDTH);
    assert_eq!(planned.height, COMPOSITION_HEIGHT);
}

// ---- Straight alpha ---------------------------------------------------------------------------

#[test]
fn the_published_frame_is_straight_alpha_and_the_composed_one_is_not() {
    let _adapter = adapter();
    let host = host();
    let composition = composition();
    let frame = host.compose(&composition, 0).expect("frame zero composes");

    // The discriminating half: find a partly transparent, coloured pixel. Without this the
    // assertion below could pass on a frame that had no partial coverage anywhere. That the frame
    // really is premultiplied is visible in the pixel itself — a white background at half opacity
    // reaches the readback as mid-grey, so no channel exceeds its own alpha.
    let (index, premultiplied) = frame
        .pixels()
        .chunks_exact(4)
        .enumerate()
        .find(|(_, pixel)| matches!(pixel[3], 1..=254) && pixel[0] > 0)
        .map(|(index, pixel)| (index, [pixel[0], pixel[1], pixel[2], pixel[3]]))
        .expect("the half-opacity white background leaves partly transparent coloured pixels");
    assert!(
        premultiplied[..3]
            .iter()
            .all(|channel| *channel <= premultiplied[3]),
        "a premultiplied pixel cannot carry more colour than its own alpha",
    );

    let (_, _, decoded) = decode_png(&encode_png(&frame).expect("the frame encodes"));
    let published = &decoded[index * 4..index * 4 + 4];
    assert_eq!(published[3], premultiplied[3], "alpha must never change");
    for channel in 0..3_usize {
        let alpha = u32::from(premultiplied[3]);
        let expected = ((u32::from(premultiplied[channel]) * 255 + alpha / 2) / alpha).min(255);
        assert_eq!(u32::from(published[channel]), expected);
        // The whole point: writing the premultiplied byte would have made this pixel darker.
        assert!(
            published[channel] > premultiplied[channel],
            "channel {channel} was published premultiplied, so the edge is darkened",
        );
    }
}

// ---- Generations and staleness ----------------------------------------------------------------

#[test]
fn a_frame_rendered_for_a_retired_binding_is_refused_and_released() {
    let _adapter = adapter();
    let host = host();
    let server = media_server();
    let composition = composition();
    let frame = host.compose(&composition, 0).expect("frame zero composes");

    let current = binding();
    let ticket = host
        .claim(current.clone())
        .expect("a generation is claimed");
    // The editor moves on while the GPU is busy: a different scene revision is a different binding.
    let mut edited = current;
    edited.scene_revision = "revision-two".to_owned();
    let newer = host.claim(edited).expect("the newer binding claims");
    let shown = host
        .publish(&server, &newer, &frame, 0, PreviewLayer::default())
        .expect("the frame for the newer binding publishes");
    assert_eq!(host.frames().stats().0, 1);

    assert_eq!(
        host.publish(&server, &ticket, &frame, 0, PreviewLayer::default())
            .err(),
        Some(PreviewRefusal::StaleGeneration)
    );
    // Published, then released once, and never retained — and, just as important, the frame the
    // editor *is* showing was not evicted to make room for one nobody asked for.
    assert_eq!(host.frames().release_count(), 1);
    assert_eq!(host.frames().stats().0, 1);
    assert!(String::from_utf8_lossy(&load(&shown.frame_url)).starts_with("HTTP/1.1 200"));
}

#[test]
fn the_generation_advances_only_when_the_binding_moves() {
    let host = host();
    let scene = binding();
    let ticket = host.claim(scene.clone()).expect("a generation is claimed");
    let generation = host.generation();
    assert!(host.is_current(&ticket));

    // The same binding again is the same generation: a scrub must not retire its own cache.
    let again = host.claim(scene.clone()).expect("the same binding claims");
    assert_eq!(host.generation(), generation);
    assert!(host.is_current(&again) && host.is_current(&ticket));

    // An edit moves the revision, so the frames rendered before it stop being current.
    let mut edited = scene.clone();
    edited.scene_revision = "revision-two".to_owned();
    let after_edit = host.claim(edited).expect("the edited binding claims");
    assert_eq!(host.generation(), generation + 1);
    assert!(!host.is_current(&ticket));

    // A project switch does the same, and so does a device loss.
    let mut switched = scene;
    switched.project_id = ProjectId::new();
    host.claim(switched).expect("the switched project claims");
    assert!(!host.is_current(&after_edit));
    let latest = host.claim(binding()).expect("a fresh binding claims");
    host.invalidate();
    assert!(!host.is_current(&latest));
}

// ---- Release exactly once ---------------------------------------------------------------------

#[test]
fn renders_in_flight_are_bounded_and_the_bound_is_released_again() {
    let _adapter = adapter();
    let host = PreviewHost::with_limits(
        AdapterSelection::Automatic,
        1,
        MAX_RETAINED_FRAMES,
        MAX_RETAINED_BYTES,
    );
    let composition = composition();
    assert!(host.compose(&composition, 0).is_ok());
    // The permit is given back when the render finishes, so the bound is a concurrency limit and
    // not a lifetime quota.
    assert!(host.compose(&composition, 0).is_ok());

    let none = PreviewHost::with_limits(
        AdapterSelection::Automatic,
        0,
        MAX_RETAINED_FRAMES,
        MAX_RETAINED_BYTES,
    );
    assert_eq!(
        none.compose(&composition, 0).err(),
        Some(PreviewRefusal::Busy)
    );
    const { assert!(MAX_RENDERS_IN_FLIGHT >= 1) };
}

#[test]
fn a_frame_outside_the_converted_timeline_is_refused_without_a_render() {
    let _adapter = adapter();
    let host = host();
    let composition = composition();
    let frames = composition.frame_count();
    assert_eq!(frames, 90, "three seconds at thirty frames a second");
    assert!(host.compose(&composition, frames - 1).is_ok());
    assert_eq!(
        host.compose(&composition, frames).err(),
        Some(PreviewRefusal::UnsupportedRequest)
    );
}

// ---- Device loss ------------------------------------------------------------------------------

#[test]
fn a_missing_device_is_its_own_refusal_and_retires_everything_rendered_on_it() {
    let _adapter = adapter();
    let composition = composition();
    let lost = PreviewHost::with_limits(
        AdapterSelection::None,
        MAX_RENDERS_IN_FLIGHT,
        MAX_RETAINED_FRAMES,
        MAX_RETAINED_BYTES,
    );
    let ticket = lost.claim(binding()).expect("a generation is claimed");
    assert!(lost.is_current(&ticket));
    assert_eq!(
        lost.compose(&composition, 0).err(),
        Some(PreviewRefusal::DeviceLost)
    );
    // Device loss is not "the scene was bad": it retires the generation, so a frame already on the
    // wire from the dead device is recognisably stale rather than silently kept.
    assert!(!lost.is_current(&ticket));

    // And it is distinguishable from a scene refusal on a machine whose adapter works.
    let working = host();
    assert!(working.compose(&composition, 0).is_ok());
}

// ---- The conversion's own refusals, kept distinguishable ---------------------------------------

#[test]
fn the_conversion_refusals_stay_the_ones_the_editor_has_to_explain_differently() {
    let converted = plan(request_json());

    // A face that is not the one the request's fontFamily names is a font problem, not a scene one.
    assert_eq!(
        PreviewComposition::build(
            &converted,
            &face("Georgia", WEIGHT),
            atlas("Georgia", WEIGHT)
        )
        .err(),
        Some(PreviewRefusal::FontUnavailable),
    );
    // An atlas baked from another face than the scene resolved is the same story to a user.
    assert_eq!(
        PreviewComposition::build(&converted, &default_face(), atlas("Georgia", WEIGHT)).err(),
        Some(PreviewRefusal::FontUnavailable),
    );

    // An atlas that refuses cell-advance layout carries *why*, because a shaping residual and a
    // right-to-left run are different things to tell a user.
    let mut unchecked = unchecked_atlas(FAMILY, WEIGHT);
    unchecked.layout.cell_advance_layout = CellAdvanceVerdict::Refused;
    unchecked.layout.refusal.direction_needs_bidi = true;
    let refusing = GlyphAtlasDescriptor::try_from(unchecked)
        .expect("a refusing atlas is still a well-formed one");
    assert_eq!(
        PreviewComposition::build(&converted, &default_face(), refusing).err(),
        Some(PreviewRefusal::AtlasCannotLayOut {
            shaping_crosses_clusters: false,
            direction_needs_bidi: true,
        }),
    );
}

// ---- Redaction --------------------------------------------------------------------------------

#[test]
fn no_refusal_carries_a_path_a_family_or_a_line_of_subtitle_text() {
    let _adapter = adapter();
    let directory = TempDir::new().expect("a temporary directory");
    let source = source_clip(&directory);
    let needle = source.to_string_lossy().into_owned();
    assert!(
        needle.contains(std::path::MAIN_SEPARATOR),
        "the fixture path is a real one"
    );

    let server = media_server();
    let host = host();
    let mut atlases = StubAtlases::default();
    let atlas_id = atlases.stage(default_atlas());
    let mut request = preview_request(atlas_id, 0, clip_request_json());
    request.render.lyrics[0].text = "PRIVATESUBTITLETEXT".to_owned();
    request.face.family = "PRIVATEFAMILY".to_owned();

    let refusal = render_preview_frame(&host, &server, &atlases, &source, request)
        .expect_err("a face the request does not name is refused");
    assert_eq!(refusal, PreviewRefusal::FontUnavailable);
    let rendered = format!(
        "{refusal} {refusal:?} {}",
        serde_json::to_string(&refusal).expect("a refusal serializes")
    );
    for secret in [
        needle.as_str(),
        "PRIVATESUBTITLETEXT",
        "PRIVATEFAMILY",
        "preview-source",
    ] {
        assert!(!rendered.contains(secret), "{secret} reached a refusal");
    }

    // Every refusal this boundary can produce, checked the same way.
    for candidate in [
        PreviewRefusal::UnsupportedRequest,
        PreviewRefusal::MediaUnavailable,
        PreviewRefusal::SourceUnreadable,
        PreviewRefusal::FontUnavailable,
        PreviewRefusal::AtlasUnknown,
        PreviewRefusal::AtlasCannotLayOut {
            shaping_crosses_clusters: true,
            direction_needs_bidi: false,
        },
        PreviewRefusal::SceneRejected,
        PreviewRefusal::StaleGeneration,
        PreviewRefusal::DeviceLost,
        PreviewRefusal::Busy,
        PreviewRefusal::FrameUnpublishable,
        PreviewRefusal::Unavailable,
    ] {
        let serialized = serde_json::to_string(&candidate).expect("a refusal serializes");
        let code = candidate.code();
        assert!(!serialized.contains('\\'), "{code}");
        assert!(!serialized.contains('/'), "{code}");
        assert!(
            !serialized.contains(':') || serialized.contains("\"code\":"),
            "{code}"
        );
        assert!(serialized.contains(code));
        // The code shape `nativePreviewFrames.js` will accept, or it arrives as a bare rejection.
        assert!(code.len() <= 128 && code.is_ascii());
        assert!(
            code.bytes().all(|byte| byte.is_ascii_alphanumeric()),
            "{code}"
        );
        assert!(
            code.starts_with(|first: char| first.is_ascii_alphabetic()),
            "{code}"
        );
    }
}

#[test]
fn a_published_response_carries_a_capability_and_never_a_token_the_host_kept() {
    let _adapter = adapter();
    let server = media_server();
    let host = host();
    let composition = composition();
    let frame = host.compose(&composition, 0).expect("frame zero composes");
    let ticket = host.claim(binding()).expect("a generation is claimed");
    let response = host
        .publish(&server, &ticket, &frame, 0, PreviewLayer::default())
        .expect("the frame publishes");

    let host_debug = format!("{host:?}");
    assert!(!host_debug.contains("C:\\"));
    for token in response.frame_url.split("frame_token=").skip(1) {
        assert!(!host_debug.contains(token));
    }
    assert_eq!(response.width_px, COMPOSITION_WIDTH);
    assert_eq!(response.height_px, COMPOSITION_HEIGHT);
    assert_eq!(host.frames().stats().0, 1);
}

// ---- The conversion is the export's, not a second one ------------------------------------------

#[test]
fn the_preview_composition_is_the_export_conversion_frame_for_frame() {
    let converted = plan(request_json());
    let export = osg_export::ExportPlan::convert(&converted, &default_face())
        .expect("the export conversion accepts the fixture request");
    let composition = composition();

    // Not "similar": the same numbers, from the same call. If this module ever grows a conversion
    // of its own, these stop agreeing and this test says so.
    assert_eq!(composition.width(), export.width());
    assert_eq!(composition.height(), export.height());
    assert_eq!(composition.frame_count(), export.frame_count());
    assert_eq!(
        (export.width(), export.height()),
        (COMPOSITION_WIDTH, COMPOSITION_HEIGHT)
    );
    assert_eq!(converted.source_width, SOURCE_WIDTH);
    assert_eq!(converted.source_height, SOURCE_HEIGHT);
}

/// The first line of an HTTP response, for a failure message that says what happened.
fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or_default()
}
