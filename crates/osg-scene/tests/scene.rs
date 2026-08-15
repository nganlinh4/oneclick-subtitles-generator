//! A scene that exists must be renderable, so construction is tested for total validation rather
//! than for the happy path.

use osg_scene::scene::{
    MAX_CUE_TEXT_BYTES, MAX_DIMENSION, MIN_DIMENSION, ResolvedFace, SCENE_SCHEMA_VERSION, Scene,
    SceneCue, SceneError,
};
use osg_scene::timeline::{ExactTime, FrameTimeline};

fn timeline() -> FrameTimeline {
    FrameTimeline::new(30, 1, 300, ExactTime::ZERO).expect("timeline")
}

fn face() -> ResolvedFace {
    ResolvedFace {
        family: "Inter".to_owned(),
        source: "blake3:0123456789abcdef".to_owned(),
        weight: 400,
    }
}

fn cue(start: i64, end: i64) -> SceneCue {
    SceneCue {
        text: "hello".to_owned(),
        start: ExactTime::new(start, 1).expect("start"),
        end: ExactTime::new(end, 1).expect("end"),
    }
}

fn build(cues: Vec<SceneCue>) -> Result<Scene, SceneError> {
    Scene::new(SCENE_SCHEMA_VERSION, 1_920, 1_080, timeline(), face(), cues)
}

#[test]
fn a_valid_scene_keeps_everything_it_was_given() {
    let scene = build(vec![cue(0, 1), cue(2, 3)]).expect("scene");
    assert_eq!(scene.width(), 1_920);
    assert_eq!(scene.height(), 1_080);
    assert_eq!(scene.cues().len(), 2);
    assert_eq!(scene.face().family, "Inter");
    assert_eq!(scene.timeline().frame_count(), 300);
}

#[test]
fn an_unknown_schema_version_is_refused_rather_than_guessed_at() {
    // The contract this replaces had no version at all, so a field could change meaning silently.
    assert_eq!(
        Scene::new(
            SCENE_SCHEMA_VERSION + 1,
            1_920,
            1_080,
            timeline(),
            face(),
            vec![]
        ),
        Err(SceneError::UnsupportedSchemaVersion)
    );
    assert_eq!(
        Scene::new(0, 1_920, 1_080, timeline(), face(), vec![]),
        Err(SceneError::UnsupportedSchemaVersion)
    );
}

#[test]
fn odd_dimensions_are_refused_before_a_whole_render_is_wasted() {
    // The encoders downstream require even dimensions; failing here costs nothing, failing at the
    // encode stage costs the entire render.
    for (width, height) in [(1_921, 1_080), (1_920, 1_081), (1_921, 1_081)] {
        assert_eq!(
            Scene::new(
                SCENE_SCHEMA_VERSION,
                width,
                height,
                timeline(),
                face(),
                vec![]
            ),
            Err(SceneError::UnsupportedDimensions),
            "{width}x{height}"
        );
    }
}

#[test]
fn dimensions_outside_the_supported_range_are_refused() {
    for (width, height) in [
        (MIN_DIMENSION - 2, 1_080),
        (1_920, MIN_DIMENSION - 2),
        (MAX_DIMENSION + 2, 1_080),
        (1_920, MAX_DIMENSION + 2),
        (0, 0),
    ] {
        assert_eq!(
            Scene::new(
                SCENE_SCHEMA_VERSION,
                width,
                height,
                timeline(),
                face(),
                vec![]
            ),
            Err(SceneError::UnsupportedDimensions),
            "{width}x{height}"
        );
    }
    assert!(
        Scene::new(
            SCENE_SCHEMA_VERSION,
            MIN_DIMENSION,
            MIN_DIMENSION,
            timeline(),
            face(),
            vec![]
        )
        .is_ok()
    );
    assert!(
        Scene::new(
            SCENE_SCHEMA_VERSION,
            MAX_DIMENSION,
            MAX_DIMENSION,
            timeline(),
            face(),
            vec![]
        )
        .is_ok()
    );
}

#[test]
fn a_cue_must_end_after_it_starts() {
    assert_eq!(build(vec![cue(2, 2)]), Err(SceneError::UnorderedCues));
    assert_eq!(build(vec![cue(3, 2)]), Err(SceneError::UnorderedCues));
}

#[test]
fn cues_must_arrive_in_start_order() {
    // Selection takes the first match, so an unordered list would silently hide cues. Refusing
    // turns a picture that quietly loses subtitles into an error the caller can see.
    assert_eq!(
        build(vec![cue(4, 5), cue(0, 1)]),
        Err(SceneError::UnorderedCues)
    );
    assert!(
        build(vec![cue(0, 1), cue(0, 2)]).is_ok(),
        "equal starts are allowed"
    );
}

#[test]
fn overlapping_cues_are_allowed_because_the_renderer_already_tolerates_them() {
    // Overlap is not an error today — the first cue simply wins — so refusing it here would break
    // existing projects rather than protect them.
    assert!(build(vec![cue(0, 10), cue(2, 4)]).is_ok());
}

#[test]
fn empty_and_oversize_cue_text_is_refused() {
    let mut empty = cue(0, 1);
    empty.text = String::new();
    assert_eq!(build(vec![empty]), Err(SceneError::UnsupportedCues));

    let mut oversize = cue(0, 1);
    oversize.text = "a".repeat(MAX_CUE_TEXT_BYTES + 1);
    assert_eq!(build(vec![oversize]), Err(SceneError::UnsupportedCues));

    let mut largest = cue(0, 1);
    largest.text = "a".repeat(MAX_CUE_TEXT_BYTES);
    assert!(build(vec![largest]).is_ok());
}

#[test]
fn cue_text_is_measured_in_bytes_so_multibyte_text_cannot_smuggle_past_the_bound() {
    let mut cue = cue(0, 1);
    // Four bytes each, so a quarter of the bound in characters is the whole bound in bytes.
    cue.text = "\u{1F600}".repeat(MAX_CUE_TEXT_BYTES / 4);
    assert!(build(vec![cue.clone()]).is_ok());
    cue.text.push('\u{1F600}');
    assert_eq!(build(vec![cue]), Err(SceneError::UnsupportedCues));
}

#[test]
fn a_scene_carries_the_exact_face_rather_than_a_family_name_to_hope_for() {
    let scene = build(vec![]).expect("scene");
    assert_eq!(scene.face().source, "blake3:0123456789abcdef");
    assert_eq!(scene.face().weight, 400);
}

#[test]
fn an_unresolvable_face_is_refused() {
    let cases = [
        ResolvedFace {
            family: String::new(),
            source: "blake3:a".to_owned(),
            weight: 400,
        },
        ResolvedFace {
            family: "Inter".to_owned(),
            source: String::new(),
            weight: 400,
        },
        ResolvedFace {
            family: "Inter\u{0}".to_owned(),
            source: "blake3:a".to_owned(),
            weight: 400,
        },
        ResolvedFace {
            family: "Inter".to_owned(),
            source: "blake3:a".to_owned(),
            weight: 450,
        },
        ResolvedFace {
            family: "Inter".to_owned(),
            source: "blake3:a".to_owned(),
            weight: 0,
        },
        ResolvedFace {
            family: "Inter".to_owned(),
            source: "blake3:a".to_owned(),
            weight: 1_000,
        },
        ResolvedFace {
            family: "a".repeat(257),
            source: "blake3:a".to_owned(),
            weight: 400,
        },
    ];
    for face in cases {
        assert_eq!(
            Scene::new(
                SCENE_SCHEMA_VERSION,
                1_920,
                1_080,
                timeline(),
                face.clone(),
                vec![]
            ),
            Err(SceneError::UnsupportedFace),
            "{face:?}"
        );
    }
}

#[test]
fn an_empty_cue_list_is_a_valid_scene() {
    // A render with no subtitles is a legitimate request, not an error.
    assert!(build(vec![]).is_ok());
}

#[test]
fn errors_name_the_field_and_never_the_value() {
    // A scene error may be logged; a user's subtitle text may not.
    for error in [
        SceneError::UnsupportedSchemaVersion,
        SceneError::UnsupportedDimensions,
        SceneError::UnsupportedCues,
        SceneError::UnorderedCues,
        SceneError::UnsupportedFace,
    ] {
        let text = error.to_string();
        assert!(!text.contains("hello"), "{text}");
        assert!(!text.contains('/') && !text.contains('\\'), "{text}");
    }
}
