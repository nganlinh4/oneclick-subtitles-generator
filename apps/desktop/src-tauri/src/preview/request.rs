//! What crosses the command boundary, in both directions.
//!
//! The request is the same [`RenderRequest`] an export is built from, plus the four things a single
//! frame needs that a whole export does not: which frame, which staged atlas, which face the
//! `WebView` resolved, and the revision the caller believes it is looking at.
//!
//! Carrying the export's own request rather than a preview-shaped scene is the whole point. The
//! style, the crop, the trim, the resolution and the frame rate are then read by the conversion in
//! `crates/osg-export/src/convert/`, which is the single place those decisions are made. A preview
//! DTO that carried only cues and a face could not render what the user configured, and one that
//! carried a *second* description of the style would be the divergence this boundary exists to
//! close.

use osg_domain::AssetId;
use osg_render::RenderRequest;
use osg_scene::scene::ResolvedFace;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::refusal::PreviewRefusal;
use super::{MAX_IDENTITY_BYTES, PREVIEW_SCHEMA_VERSION};

/// Which layer of the composition a caller is asking for.
///
/// The two are not two renderers — the same compositor draws both, from the same converted plan —
/// but the *last* blend differs, and that is what the editor is choosing between:
///
/// - [`Self::Composited`] is the whole frame as the export writes it, one image, blended on the GPU.
///   Every surface where a user decides whether the output looks right asks for this one.
/// - [`Self::Subtitles`] is the subtitle pass alone on a transparent ground, for the `WebView` to lay
///   over its own `<video>`. Cheap enough for continuous playback, and **approximate**: the browser
///   performs the final blend, over a frame its own decoder colour-managed, so chroma subsampling,
///   the browser's colour management and its straight-alpha compositing all land in the gap. It is
///   never what a user judges, and it must never be the last thing on screen.
///
/// Absent from a request, the layer is [`Self::Composited`]: the guaranteed one is the default, and
/// asking for the approximation has to be deliberate.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PreviewLayer {
    /// The fully composited frame: what the export writes, delivered as one image.
    #[default]
    Composited,
    /// The subtitle pass alone, on a transparent ground, for the `WebView` to blend.
    Subtitles,
}

/// One preview frame request, exactly as it arrives.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreviewFrameRequest {
    /// The request shape version, refused before any other field is read.
    pub(crate) schema_version: u32,
    /// The caller's identity for the scene it believes it is looking at.
    ///
    /// Opaque here: it is compared, never parsed. It exists so a frame that finishes after an edit
    /// can be recognised as belonging to the text that was on screen before it.
    pub(crate) scene_revision: String,
    /// The handle [`crate::glyph_atlas::command::glyph_atlas_stage`] minted for the baked atlas.
    pub(crate) atlas_id: AssetId,
    /// The baker's identity for that atlas, cross-checked against the staged one.
    pub(crate) atlas_content_hash: String,
    /// Which frame of the converted timeline to draw.
    pub(crate) frame_index: u32,
    /// The face the `WebView` resolved and baked from.
    pub(crate) face: ResolvedFace,
    /// The validated render request the export path is built from.
    pub(crate) render: RenderRequest,
    /// Which layer to draw. Defaulted rather than required, so every existing caller keeps asking
    /// for the composited frame without saying so.
    #[serde(default)]
    pub(crate) layer: PreviewLayer,
}

impl PreviewFrameRequest {
    /// Checks everything decidable without opening the source or touching the GPU.
    ///
    /// Deliberately shallow: [`RenderRequest::validate`] owns the render contract's own bounds and
    /// runs against the real source, and re-stating any of them here would create a second
    /// vocabulary to keep in step. What is checked is only what belongs to *this* boundary.
    pub(crate) fn check(&self) -> Result<(), PreviewRefusal> {
        if self.schema_version != PREVIEW_SCHEMA_VERSION
            || !is_opaque_identity(&self.scene_revision)
            || !is_opaque_identity(&self.atlas_content_hash)
        {
            return Err(PreviewRefusal::UnsupportedRequest);
        }
        // One staged atlas carries one `AtlasLayout`, and the compositor needs one staged run per
        // cue, so a request may name at most as many cues as the atlas can lay out. Refused here,
        // before a source is opened, rather than surfacing later as a run-count rejection whose
        // cause is not obvious.
        //
        // NONE is not a refusal. An instant between cues is an ordinary frame: the video underlay,
        // the crop and the canvas backfill are all still composed, and the editor documents
        // `cue: null` as a legitimate request rather than an error. A cue-less request converts to a
        // cue-less scene, which is staged with no runs at all.
        if self.render.lyrics.len() > MAX_REQUEST_LYRICS {
            return Err(PreviewRefusal::UnsupportedRequest);
        }
        Ok(())
    }
}

/// Cues one request may name, mirroring `NATIVE_PREVIEW_LIMITS.maxLyricsPerRequest`.
const MAX_REQUEST_LYRICS: usize = 1;

/// A bounded, control-free opaque token: a revision or a content hash this side only compares.
fn is_opaque_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTITY_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
}

/// What the `WebView` gets back: an element-loadable URL and the frame's own measurements.
///
/// Exactly the fields `NATIVE_PREVIEW_RESPONSE_FIELDS` in `nativePreviewFrames.js` accepts, in the
/// shape it accepts them. Nothing else may be added without changing that module too, because it
/// matches the response key set exactly and refuses a response carrying anything more — which
/// [`tests::the_response_is_exactly_the_field_set_the_webview_accepts`] reads out of that file
/// rather than restating here.
///
/// The layer is echoed for the same reason the frame index and the dimensions are: a subtitle layer
/// shown where a composited frame was asked for is a *wrong picture* rather than a failure, and the
/// only way the caller can refuse one is to be told which layer it actually got.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewFrameResponse {
    /// The opaque capability the frame is published under.
    pub(crate) sequence_id: Uuid,
    /// The loopback URL an `<img>` may load. Never a filesystem path.
    pub(crate) frame_url: String,
    /// The frame of the converted timeline this image shows.
    pub(crate) frame_index: u32,
    /// The composition width the conversion derived.
    pub(crate) width_px: u32,
    /// The composition height the conversion derived.
    pub(crate) height_px: u32,
    /// The image type, always [`super::PREVIEW_MIME_TYPE`].
    pub(crate) mime_type: String,
    /// Which layer this image carries, echoed from the request.
    pub(crate) layer: PreviewLayer,
}

/// The boundary, asserted against the other side of it rather than against a description of it.
///
/// Every gate was green while the `WebView` sent a payload this struct could not deserialize at all,
/// because both sides were checked only against themselves: the frontend test froze the JS key set
/// and the command-contract check compares command *names*. So these tests read the transport's own
/// source, build a request out of the field set it actually writes, and put it through serde. A
/// field added, removed or renamed on either side fails here instead of failing every preview frame
/// at runtime.
#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};
    use uuid::Uuid;

    use super::super::fixtures::{clip_request_json, default_face, request_json};
    use super::*;

    /// The module that builds the request, so its field set is read from its own source.
    const TRANSPORT_REQUEST: &str =
        include_str!("../../../../../src/platform/nativePreviewRequest.js");
    /// The module that reads the response, which is the other half of the same boundary.
    const TRANSPORT_FRAMES: &str =
        include_str!("../../../../../src/platform/nativePreviewFrames.js");

    /// The entries of a frozen array of string literals in the transport's source.
    fn webview_list(source: &str, name: &str) -> Vec<String> {
        let needle = format!("export const {name} = Object.freeze([");
        let start = source
            .find(&needle)
            .unwrap_or_else(|| panic!("the transport must still declare {name}"))
            + needle.len();
        let end = start
            + source[start..]
                .find(']')
                .expect("the declaration must be closed");
        source[start..end]
            .split(',')
            .map(|entry| entry.trim().trim_matches('\'').to_owned())
            .filter(|entry| !entry.is_empty())
            .collect()
    }

    /// A whole number the transport declares under `name`, as a constant or as a bound.
    fn webview_number(source: &str, name: &str) -> u32 {
        let declared = source
            .find(name)
            .unwrap_or_else(|| panic!("the transport must still declare {name}"))
            + name.len();
        let rest = &source[declared..];
        let assigned = rest
            .find(['=', ':'])
            .expect("a declaration must assign a value")
            + 1;
        let value = &rest[assigned..];
        value[..value
            .find([';', ','])
            .expect("the value must be terminated")]
            .trim()
            .replace('_', "")
            .parse()
            .expect("a whole number")
    }

    /// The value the `WebView` puts in each field, so a field it invents fails loudly here.
    fn wire_value(field: &str, atlas_id: AssetId, render: &Value) -> Value {
        match field {
            "schemaVersion" => json!(PREVIEW_SCHEMA_VERSION),
            "sceneRevision" => json!("3f2a91cc-812"),
            "atlasId" => json!(atlas_id),
            "atlasContentHash" => json!("0000abcd"),
            "frameIndex" => json!(0),
            "face" => json!(default_face()),
            "render" => render.clone(),
            "layer" => json!("composited"),
            other => panic!("the WebView sends `{other}`, which this build does not read"),
        }
    }

    /// The request the `WebView` actually writes, assembled from its own field list.
    fn webview_request(render: &Value) -> Value {
        let atlas_id = AssetId::new();
        let mut object = Map::new();
        for field in webview_list(TRANSPORT_REQUEST, "NATIVE_PREVIEW_REQUEST_FIELDS") {
            let value = wire_value(&field, atlas_id, render);
            object.insert(field, value);
        }
        Value::Object(object)
    }

    #[test]
    fn the_payload_the_webview_writes_is_exactly_the_request_this_build_reads() {
        let request: PreviewFrameRequest = serde_json::from_value(webview_request(&request_json()))
            .expect("the payload the WebView writes must deserialize whole");
        request
            .check()
            .expect("the payload the WebView writes must pass this boundary's own checks");
        assert_eq!(request.layer, PreviewLayer::Composited);
        // The two mirrored constants, read from the transport rather than restated here.
        assert_eq!(
            webview_number(TRANSPORT_REQUEST, "NATIVE_PREVIEW_SCHEMA_VERSION"),
            PREVIEW_SCHEMA_VERSION
        );
        assert_eq!(
            webview_number(TRANSPORT_REQUEST, "maxLyricsPerRequest") as usize,
            MAX_REQUEST_LYRICS
        );
        assert_eq!(
            webview_number(TRANSPORT_REQUEST, "maxIdentityBytes") as usize,
            MAX_IDENTITY_BYTES
        );
    }

    #[test]
    fn a_payload_missing_or_gaining_one_field_is_refused_whole() {
        // The discriminating half: the assertions below are worth nothing unless the accepted
        // payload above really is accepted, and it is — this is the same payload, bent once each way.
        for field in webview_list(TRANSPORT_REQUEST, "NATIVE_PREVIEW_REQUEST_FIELDS") {
            let mut value = webview_request(&request_json());
            value
                .as_object_mut()
                .expect("an object")
                .remove(&field)
                .expect("the field was present");
            let accepted = serde_json::from_value::<PreviewFrameRequest>(value).is_ok();
            // `layer` is the one field that may be absent, and its default is the composited frame.
            assert_eq!(accepted, field == "layer", "{field}");
        }

        let mut extra = webview_request(&request_json());
        extra.as_object_mut().expect("an object").insert(
            "scene".to_owned(),
            json!({"widthPx": 1_920, "heightPx": 1_080}),
        );
        assert!(
            serde_json::from_value::<PreviewFrameRequest>(extra).is_err(),
            "an unknown field must fail deserialization rather than be ignored",
        );
    }

    #[test]
    fn the_response_is_exactly_the_field_set_the_webview_accepts() {
        let response = PreviewFrameResponse {
            sequence_id: Uuid::new_v4(),
            frame_url: "http://127.0.0.1:1/frame".to_owned(),
            frame_index: 0,
            width_px: 480,
            height_px: 360,
            mime_type: super::super::PREVIEW_MIME_TYPE.to_owned(),
            layer: PreviewLayer::Subtitles,
        };
        let serialized = serde_json::to_value(&response).expect("a response serializes");
        let mut written: Vec<String> = serialized
            .as_object()
            .expect("an object")
            .keys()
            .cloned()
            .collect();
        written.sort();
        let mut accepted = webview_list(TRANSPORT_FRAMES, "NATIVE_PREVIEW_RESPONSE_FIELDS");
        accepted.sort();
        assert_eq!(written, accepted);
        // The layer is echoed as the same spelling the `WebView` compares against.
        assert_eq!(serialized["layer"], json!("subtitles"));
    }

    #[test]
    fn an_instant_with_no_cue_is_a_request_and_two_cues_are_not() {
        let mut cue_less = clip_request_json();
        cue_less["lyrics"] = json!([]);
        let request: PreviewFrameRequest =
            serde_json::from_value(webview_request(&cue_less)).expect("a cue-less payload");
        assert!(request.render.lyrics.is_empty());
        assert_eq!(request.check(), Ok(()));

        let mut two = clip_request_json();
        two["lyrics"] = json!([
            {"id":"cue-1","startUs":0,"endUs":500_000,"text":"A"},
            {"id":"cue-2","startUs":500_000,"endUs":1_000_000,"text":"B"},
        ]);
        let refused: PreviewFrameRequest =
            serde_json::from_value(webview_request(&two)).expect("a two-cue payload");
        assert_eq!(
            refused.check(),
            Err(PreviewRefusal::UnsupportedRequest),
            "one staged atlas holds one run, so two cues cannot both be drawn",
        );
    }
}
