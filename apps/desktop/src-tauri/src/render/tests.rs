//! What the export boundary promises, asserted against the boundary rather than a description of it.
//!
//! The suite is in two halves, one file each. This one needs no platform at all: it is the wire
//! payload, the refusals and the status shape, and it runs everywhere. `platform` drives a real
//! graphics adapter and real Media Foundation codecs, and is Windows-only because that is where they
//! are — it encodes a source clip, exports it through the same function the command calls, and reads
//! the result back through the platform decoder, so every stage is proven against the others rather
//! than against a file somebody generated once.
//!
//! The staged atlas is built the way `crates/osg-export/tests` builds one, through
//! `UncheckedGlyphAtlas`: the `WebView` is the only thing that can bake one for real, and a fixture
//! that skipped the descriptor's own validation would be a weaker input than the product's.

use serde_json::{Value, json};

use osg_scene::glyph::MAX_ATLAS_PAGES;

use super::fixtures;
use super::refusal;
use super::text::{EXPORT_TEXT_SCHEMA_VERSION, ExportTextRequest};

#[test]
fn the_staged_payload_becomes_one_page_and_one_run_per_cue() {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());
    let text: ExportTextRequest = serde_json::from_value(fixtures::export_text_json(atlas_id, 3))
        .expect("the payload the WebView writes must deserialize whole");

    let staged = text
        .resolve(&atlases, 3)
        .expect("three staged runs describe three cues");

    assert_eq!(staged.face().family, fixtures::FAMILY);
    assert_eq!(staged.pages().len(), 1);
    assert_eq!(
        staged.pages()[0].content_hash(),
        fixtures::ATLAS_CONTENT_HASH
    );
    assert_eq!(staged.page_of_cue(), [0, 0, 0]);
    assert_eq!(staged.runs().len(), 3);
    // Copied, not derived: the cell and the pen are the ones the baker emitted.
    let line = &staged.runs()[0].lines()[0];
    assert_eq!(line.glyphs(), [fixtures::INK_CELL]);
    assert_eq!(line.pen_x_px(), [0.0]);
}

/// A document with a large character set is baked into several pages, and each cue names the page
/// its cells were baked into. Every page is resolved and cross-checked on its own.
#[test]
fn a_document_baked_into_several_pages_resolves_every_page() {
    let mut atlases = fixtures::StubAtlases::default();
    let first = atlases.stage(fixtures::default_atlas());
    let second = atlases.stage(fixtures::default_atlas());
    let text = deserialize(&fixtures::export_text_json_pages(
        &[first, second],
        &[1, 0, 1],
    ));

    let staged = text
        .resolve(&atlases, 3)
        .expect("two pages carrying three cues between them");
    assert_eq!(staged.pages().len(), 2);
    assert_eq!(staged.page_of_cue(), [1, 0, 1]);

    // A handle nothing answers to is refused wherever in the page list it sits, not only first.
    let stale = fixtures::export_text_json_pages(&[first, osg_domain::AssetId::new()], &[0]);
    assert_eq!(
        deserialize(&stale)
            .resolve(&atlases, 1)
            .expect_err("the second page was never staged")
            .code(),
        "renderAtlasUnknown",
    );
}

/// A page list this build cannot draw from is refused before the registry is touched, and each
/// reason keeps its own code: no pages at all, more than the renderer holds, and a cue pointing at
/// a page the payload did not carry are three different things for a user to do about.
#[test]
fn a_page_list_no_cue_could_draw_from_is_refused() {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());
    let too_many: Vec<osg_domain::AssetId> = (0..=MAX_ATLAS_PAGES).map(|_| atlas_id).collect();

    let cases = [
        (
            fixtures::export_text_json_pages(&[], &[0]),
            "renderTextPagesMissing",
        ),
        (
            fixtures::export_text_json_pages(&too_many, &[0]),
            "renderTextTooManyPages",
        ),
        (
            fixtures::export_text_json_pages(&[atlas_id], &[1]),
            "renderTextPageUnknown",
        ),
    ];
    for (value, code) in cases {
        let refused = deserialize(&value)
            .resolve(&atlases, 1)
            .expect_err("a page list no cue could draw from");
        assert_eq!(refused.code(), code);
    }

    // The discriminating case: exactly as many pages as the renderer holds, with the last one
    // addressed, resolves.
    let full: Vec<osg_domain::AssetId> = (0..MAX_ATLAS_PAGES).map(|_| atlas_id).collect();
    let last = u32::try_from(MAX_ATLAS_PAGES - 1).expect("a bounded page index");
    let staged = deserialize(&fixtures::export_text_json_pages(&full, &[last]))
        .resolve(&atlases, 1)
        .expect("the largest page list this build accepts");
    assert_eq!(staged.pages().len(), MAX_ATLAS_PAGES);
    assert_eq!(staged.page_of_cue(), [last]);
}

#[test]
fn a_payload_missing_or_gaining_one_field_is_refused_whole() {
    let atlas_id = fixtures::StubAtlases::default().stage(fixtures::default_atlas());
    let complete = fixtures::export_text_json(atlas_id, 1);
    // The discriminating half: the assertions below are worth nothing unless this payload is really
    // accepted, and it is — the same payload, bent once each way.
    serde_json::from_value::<ExportTextRequest>(complete.clone()).expect("the whole payload");

    for field in ["schemaVersion", "face", "pages", "cues"] {
        let mut value = complete.clone();
        value
            .as_object_mut()
            .expect("an object")
            .remove(field)
            .expect("the field was present");
        assert!(
            serde_json::from_value::<ExportTextRequest>(value).is_err(),
            "`{field}` must be required",
        );
    }
    // The two the atlas handle moved onto, and the page a cue names: required there for the same
    // reason they were required at the top level.
    for (owner, field) in [("pages", "atlasId"), ("pages", "atlasContentHash")] {
        let mut value = complete.clone();
        value[owner][0]
            .as_object_mut()
            .expect("an object")
            .remove(field)
            .expect("the field was present");
        assert!(
            serde_json::from_value::<ExportTextRequest>(value).is_err(),
            "`{owner}[].{field}` must be required",
        );
    }
    let mut value = complete.clone();
    value["cues"][0]
        .as_object_mut()
        .expect("an object")
        .remove("page")
        .expect("the field was present");
    assert!(
        serde_json::from_value::<ExportTextRequest>(value).is_err(),
        "`cues[].page` must be required",
    );

    let mut extra = complete;
    extra
        .as_object_mut()
        .expect("an object")
        .insert("sceneRevision".to_owned(), json!("3f2a91cc-812"));
    assert!(
        serde_json::from_value::<ExportTextRequest>(extra).is_err(),
        "an unknown field must fail deserialization rather than be ignored",
    );
}

#[test]
fn a_payload_this_build_does_not_read_is_refused_before_the_registry_is_touched() {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());

    // Both directions, and the older one deliberately: version 1 carried one atlas handle at the top
    // level and no page per cue, and is refused whole rather than read as a one-page version 2.
    for version in [
        EXPORT_TEXT_SCHEMA_VERSION - 1,
        EXPORT_TEXT_SCHEMA_VERSION + 1,
    ] {
        let mut value = fixtures::export_text_json(atlas_id, 1);
        value["schemaVersion"] = json!(version);
        let refused = deserialize(&value)
            .resolve(&atlases, 1)
            .expect_err("a version");
        assert_eq!(refused.code(), "renderTextMismatched", "version {version}");
    }

    let mut value = fixtures::export_text_json(atlas_id, 1);
    value["pages"][0]["atlasContentHash"] = json!("../../etc/passwd");
    let refused = deserialize(&value)
        .resolve(&atlases, 1)
        .expect_err("an identity");
    assert_eq!(refused.code(), "renderTextMismatched");
}

#[test]
fn a_payload_that_describes_other_cues_is_refused() {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());

    for (staged, cues) in [(2_usize, 1_usize), (1, 2), (0, 1)] {
        let text = fixtures::export_text(atlas_id, staged);
        let refused = text
            .resolve(&atlases, cues)
            .expect_err("a run count that is not the cue count");
        assert_eq!(refused.code(), "renderTextMismatched", "{staged} vs {cues}");
    }
}

#[test]
fn a_run_outside_the_compositors_bounds_is_refused_before_it_is_allocated() {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());
    let line = json!({
        "glyphs": [fixtures::INK_CELL],
        "penXPx": [0.0],
        "advanceWidthPx": 10.0,
        "baselineYPx": 8.0,
    });

    // One more line than one cue may occupy.
    let mut value = fixtures::export_text_json(atlas_id, 1);
    value["cues"][0]["lines"] = json!(vec![line.clone(); osg_compositor::MAX_RUN_LINES + 1]);
    let refused = deserialize(&value)
        .resolve(&atlases, 1)
        .expect_err("too many lines");
    assert_eq!(refused.code(), "renderTextMismatched");

    // A line whose pens do not match its cells, which would be half-drawn rather than refused.
    let mut value = fixtures::export_text_json(atlas_id, 1);
    value["cues"][0]["lines"][0]["penXPx"] = json!([0.0, 10.0]);
    let refused = deserialize(&value)
        .resolve(&atlases, 1)
        .expect_err("a mismatched line");
    assert_eq!(refused.code(), "renderTextMismatched");

    // No lines at all is not an empty cue; it is a run nothing could draw.
    let mut value = fixtures::export_text_json(atlas_id, 1);
    value["cues"][0]["lines"] = json!([]);
    let refused = deserialize(&value)
        .resolve(&atlases, 1)
        .expect_err("an empty run");
    assert_eq!(refused.code(), "renderTextMismatched");
}

#[test]
fn an_atlas_that_is_not_the_one_the_caller_staged_is_refused_rather_than_drawn() {
    let mut atlases = fixtures::StubAtlases::default();
    let atlas_id = atlases.stage(fixtures::default_atlas());

    // A handle nothing answers to: an evicted atlas, or a recycled identifier.
    let evicted = fixtures::export_text(osg_domain::AssetId::new(), 1);
    assert_eq!(
        evicted
            .resolve(&atlases, 1)
            .expect_err("an unknown handle")
            .code(),
        "renderAtlasUnknown",
    );

    // The right handle, the wrong content: exactly the stale-cache case a handle alone would draw.
    let mut value = fixtures::export_text_json(atlas_id, 1);
    value["pages"][0]["atlasContentHash"] = json!("deadbeef");
    assert_eq!(
        deserialize(&value)
            .resolve(&atlases, 1)
            .expect_err("a stale identity")
            .code(),
        "renderAtlasUnknown",
    );

    // And a registry that holds nothing at all.
    assert_eq!(
        fixtures::export_text(atlas_id, 1)
            .resolve(&fixtures::EmptyAtlases, 1)
            .expect_err("an empty registry")
            .code(),
        "renderAtlasUnknown",
    );
}

#[test]
fn a_staged_payload_never_renders_its_own_contents_into_a_debug() {
    let atlas_id = fixtures::StubAtlases::default().stage(fixtures::default_atlas());
    let text = fixtures::export_text(atlas_id, 2);

    let rendered = format!("{text:?}");
    assert!(!rendered.contains(fixtures::FAMILY), "{rendered}");
    assert!(rendered.contains("cues: 2"), "{rendered}");
}

#[test]
fn every_refusal_is_typed_and_carries_no_path() {
    let refusals = [
        refusal::text_not_staged(),
        refusal::atlas_unknown(),
        refusal::text_mismatched(),
        refusal::text_pages_missing(),
        refusal::text_too_many_pages(),
        refusal::text_page_unknown(),
        refusal::cancelled(),
        refusal::timed_out(),
        refusal::staging_unavailable(),
        refusal::output_invalid(),
    ];
    for error in &refusals {
        let value = serde_json::to_value(error).expect("a refusal serializes");
        let code = value["code"].as_str().expect("a code");
        let message = value["message"].as_str().expect("a message");
        assert!(
            code.chars().all(|c| c.is_ascii_alphanumeric()),
            "a code is a fixed token: {code}",
        );
        assert!(!message.is_empty(), "{code} must say something");
        for fragment in ["\\", "/", ":\\", "C:", ".mp4", "sha256"] {
            assert!(
                !message.contains(fragment),
                "{code} leaked `{fragment}`: {message}",
            );
        }
    }
    // Every outcome a user can act on differently keeps its own code.
    let mut codes: Vec<&str> = refusals
        .iter()
        .map(crate::error::CommandError::code)
        .collect();
    codes.sort_unstable();
    codes.dedup();
    assert_eq!(codes.len(), refusals.len());
}

#[test]
fn the_status_is_the_shape_the_webview_freezes() {
    let status = super::command::render_runtime_status();
    let value = serde_json::to_value(&status).expect("the status serializes");
    let object = value.as_object().expect("an object");

    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "available",
            "maxConcurrentRenders",
            "reason",
            "remotionVersion"
        ],
    );
    assert_eq!(object["maxConcurrentRenders"], json!(1));
    assert_eq!(
        object["remotionVersion"],
        json!(osg_render::REMOTION_VERSION)
    );
    // `renderService.js` refuses a status that says both, or neither.
    let available = object["available"].as_bool().expect("a flag");
    assert_eq!(available, object["reason"].is_null());
    assert_eq!(available, cfg!(windows));
    if !available {
        assert_eq!(object["reason"], json!("runtimePayloadUnavailable"));
    }
}

fn deserialize(value: &Value) -> ExportTextRequest {
    serde_json::from_value(value.clone()).expect("the fixture payload deserializes")
}

// The half that needs the platform: a real adapter, real Media Foundation, and the same function
// the command calls. Windows-only, and in its own file for that reason.

#[cfg(windows)]
mod platform;
