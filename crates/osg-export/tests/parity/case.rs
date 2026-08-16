//! One case: a customization, a text, an output shape, and the conversion they produce.
//!
//! A case is the unit the gate renders, reports and — when it fails — identifies. Building the
//! request as the JSON the `WebView` really sends and validating it through `RenderRequest` keeps
//! the gate on the boundary the product crosses rather than on the contract types behind it.

use osg_compositor::SubtitleScene;
use osg_export::ExportPlan;
use osg_render::{RenderRequest, SubtitleCustomization};
use serde_json::{Value, json};

use super::bake::{self, Staged};

/// The source every swept case is validated against: a 16:9 clip long enough to trim inside.
pub(crate) const SOURCE_WIDTH: u32 = 1_920;
pub(crate) const SOURCE_HEIGHT: u32 = 1_080;
pub(crate) const SOURCE_DURATION_US: u64 = 10_000_000;

/// The trim window one swept case covers: one second, which is 25, 30 or 60 frames.
pub(crate) const WINDOW_US: u64 = 1_000_000;
/// When the case's single cue starts.
///
/// `osg_scene::cues` puts the fade-in window **before** the cue — `start - fadeIn ..= start` — and
/// the fade-out window **after** it, which is what the shipped renderer does. So a cue placed at
/// the beginning of the window is already holding at every frame, and every probe would land in the
/// hold: `animationType`, `animationEasing`, `fadeInDuration` and `fadeOutDuration` would all report
/// as having no effect, and the report would be wrong. The cue is therefore placed in the middle,
/// with the default 0.3 s fade windows falling inside the timeline on both sides.
pub(crate) const CUE_START_US: u64 = 400_000;
/// When it ends, so the fade-out window is inside the timeline too.
pub(crate) const CUE_END_US: u64 = 700_000;

/// Deterministic identifiers, so two runs of the same case build byte-identical requests.
const ASSET_ID: &str = "01890000-0000-7000-8000-000000000001";
const PROJECT_ID: &str = "01890000-0000-7000-8000-000000000002";

/// What varies between cases, and how a failing one names itself.
#[derive(Debug, Clone)]
pub(crate) struct Case {
    /// The case identity, e.g. `preset=neon text=korean out=uhd-60`. Carries no path and no
    /// subtitle text — the text is named by its matrix identity, never quoted.
    pub(crate) id: String,
    pub(crate) customization: Value,
    pub(crate) text: String,
    pub(crate) resolution: String,
    pub(crate) frame_rate: u16,
    /// A cue list of the case's own, for the dense case. One cue when absent.
    pub(crate) lyrics: Option<Value>,
    /// A trim window of the case's own, for the long case. [`WINDOW_US`] when absent.
    pub(crate) window_us: Option<u64>,
}

impl Case {
    /// A case over one cue and the standard window.
    pub(crate) fn new(
        id: impl Into<String>,
        customization: Value,
        text: impl Into<String>,
        resolution: impl Into<String>,
        frame_rate: u16,
    ) -> Self {
        Self {
            id: id.into(),
            customization,
            text: text.into(),
            resolution: resolution.into(),
            frame_rate,
            lyrics: None,
            window_us: None,
        }
    }

    /// How long this case's timeline is.
    pub(crate) fn window_us(&self) -> u64 {
        self.window_us.unwrap_or(WINDOW_US)
    }

    /// How many cues the case carries, which is how many runs it has to stage.
    pub(crate) fn cue_count(&self) -> usize {
        self.lyrics
            .as_ref()
            .and_then(|lyrics| lyrics.as_array())
            .map_or(1, Vec::len)
    }

    /// The request exactly as the `WebView` sends it.
    pub(crate) fn request(&self) -> Value {
        let window = self.window_us();
        let lyrics = self.lyrics.clone().unwrap_or_else(|| {
            json!([{
                "id": "cue-1",
                "startUs": CUE_START_US.min(window / 2),
                "endUs": CUE_END_US.min(window),
                "text": self.text,
            }])
        });
        json!({
            "sourceAssetId": ASSET_ID,
            "projectId": PROJECT_ID,
            "narrationArtifactId": null,
            "lyrics": lyrics,
            "settings": {
                "resolution": self.resolution,
                "frameRate": self.frame_rate,
                "originalAudioVolume": 100,
                "narrationVolume": 80,
                "trimStartUs": 0,
                "trimEndUs": window,
            },
            "customization": self.customization,
            "crop": {"x": 0, "y": 0, "width": 100, "height": 100, "aspectRatio": null},
        })
    }

    /// The typed customization, for the stand-in baker.
    pub(crate) fn typed_customization(&self) -> SubtitleCustomization {
        serde_json::from_value(self.customization.clone())
            .expect("the matrix carries complete customizations")
    }
}

/// Everything one case needs to render: the conversion, the staged text and the composed scene.
#[derive(Debug)]
pub(crate) struct Prepared {
    pub(crate) plan: ExportPlan,
    pub(crate) staged: Staged,
    pub(crate) scene: SubtitleScene,
    /// How many cues the case staged, so a re-stage produces the same runs.
    pub(crate) cues: usize,
}

impl Prepared {
    /// The three frames a case is judged on, plus frame zero, which carries no cue.
    ///
    /// One frame is not enough. The cue fades in, holds, then fades out, and a setting that only
    /// moves one of those three phases is invisible at a probe inside either of the others. So the
    /// sweep looks at a frame inside the fade-in (a quarter in), one in the hold, and one inside
    /// the fade-out — all three already composed by the walk, so they cost nothing beyond it.
    pub(crate) fn probe_frames(&self) -> [u32; 3] {
        let frames = u64::from(self.plan.frame_count());
        let last = self.plan.frame_count().saturating_sub(1);
        [5_u64, 11, 17].map(|twentieths| {
            u32::try_from((frames * twentieths) / 20)
                .unwrap_or(0)
                .min(last)
        })
    }

    /// The frame the exact comparisons are made on: the last probe, furthest from the start.
    pub(crate) fn probe_frame(&self) -> u32 {
        self.probe_frames()[2]
    }

    /// A second scene from the same inputs, for the seek-against-play comparison.
    pub(crate) fn recompose(&self) -> SubtitleScene {
        self.plan
            .compose(self.staged.text(self.cues))
            .expect("the staged text composes")
    }
}

/// Converts a case, or says which stage refused it and why.
///
/// A refusal is a finding rather than a harness error: every value in the matrix is one a saved
/// project can carry, so a persisted setting the pipeline will not convert is exactly what this
/// gate exists to surface. It is returned rather than panicked so one refusal does not hide the
/// rest of the sweep; the callers collect them and fail once, with the whole list.
pub(crate) fn try_prepare(case: &Case) -> Result<Prepared, String> {
    try_prepare_against(case, SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_DURATION_US)
}

/// The same conversion against a real source's own dimensions and duration.
pub(crate) fn try_prepare_against(
    case: &Case,
    width: u32,
    height: u32,
    duration_us: u64,
) -> Result<Prepared, String> {
    let request: RenderRequest = serde_json::from_value(case.request())
        .map_err(|error| format!("the request does not deserialize: {error}"))?;
    let plan = request
        .validate(width, height, duration_us)
        .map_err(|error| format!("the request does not validate: {error}"))?;
    let staged = bake::bake(&case.text, &case.typed_customization());
    let converted = ExportPlan::convert(&plan, staged.face())
        .map_err(|error| format!("the request does not convert: {error}"))?;
    let cues = case.cue_count();
    let scene = converted
        .compose(staged.text(cues))
        .map_err(|error| format!("the staged text does not compose: {error}"))?;
    Ok(Prepared {
        plan: converted,
        staged,
        scene,
        cues,
    })
}

/// The same conversion, for a caller whose case cannot legitimately be refused.
///
/// # Panics
/// Panics with the case identity and the refusal.
pub(crate) fn prepare(case: &Case) -> Prepared {
    try_prepare(case).unwrap_or_else(|reason| panic!("{}: {reason}", case.id))
}

/// The customization a preset carries, with one field replaced.
pub(crate) fn with_field(customization: &Value, field: &str, value: &Value) -> Value {
    let mut next = customization.clone();
    next.as_object_mut()
        .expect("a customization is an object")
        .insert(field.to_owned(), value.clone());
    next
}

/// How a value names itself inside a case identity: compact, and never a subtitle's own text.
pub(crate) fn value_label(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Whether the case's own settings explain a cue that drew nothing.
///
/// A cue positioned off the frame draws nothing, and that is correct: the shipped renderer emits
/// `left: -100%` for a `customPositionX` of -100 and puts the box off-screen too. The gate must not
/// call that a pipeline failure.
///
/// It must not accept absence in general either, or it would pass for a renderer that dropped every
/// cue. So this is asked only when a cue did NOT draw, and it answers from the same resolver the
/// compositor uses: the absence is explained exactly when the box's own anchor lies outside the
/// frame. A cue that vanishes while its anchor is inside the frame is still a failure, which is the
/// case that matters.
///
/// Deliberately not a visibility prediction. Predicting visibility needs the run's drawn width in
/// composition space, which means re-deriving the compositor's glyph scaling here — a second
/// implementation of the thing under test, and the one mistake this whole migration exists to avoid.
pub(crate) fn absence_is_explained(case: &Case, composition: (u32, u32)) -> bool {
    use osg_scene::layout::{Margins, SubtitlePosition, TextAlign, resolve_subtitle_box};

    let number = |key: &str| -> f64 {
        case.customization
            .get(key)
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    };
    let text = |key: &str| -> &str {
        case.customization
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
    };

    let Some(position) = SubtitlePosition::from_wire(text("position")) else {
        return false;
    };
    let align = TextAlign::from_wire(text("textAlign")).unwrap_or(TextAlign::Center);
    let (width, height) = (f64::from(composition.0), f64::from(composition.1));
    let subtitle_box = resolve_subtitle_box(
        position,
        Margins {
            bottom: number("marginBottom"),
            top: number("marginTop"),
            left: number("marginLeft"),
            right: number("marginRight"),
        },
        number("customPositionX"),
        number("customPositionY"),
        align,
        width,
        height,
    );

    subtitle_box.right < 0.0
        || subtitle_box.left > width
        || subtitle_box.anchor_y < 0.0
        || subtitle_box.anchor_y > height
}
