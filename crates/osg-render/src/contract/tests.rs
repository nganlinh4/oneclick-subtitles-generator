//! Render contract tests: wire shape, bounds, presets, and fail-closed validation.

use serde_json::json;

use super::*;

fn request_json() -> serde_json::Value {
    json!({
        "sourceAssetId": AssetId::new(),
        "projectId": ProjectId::new(),
        "sceneRevision": 0,
        "selectedSubtitles": "original",
        "selectedNarration": "none",
        "narrationArtifactId": null,
        "lyrics": [{"id":"cue-1","startUs":0,"endUs":2_000_000,"text":"Hello"}],
        "settings": {
            "resolution":"720p","frameRate":30,"originalAudioVolume":100,
            "narrationVolume":80,"trimStartUs":0,"trimEndUs":2_000_000
        },
        "customization": {
            "fontSize":28,"fontFamily":"'Inter', sans-serif","fontWeight":600,
            "textColor":"#ffffff","textAlign":"center","lineHeight":1.2,
            "letterSpacing":0,"textTransform":"none","backgroundColor":"#000000",
            "backgroundOpacity":50,"backgroundPaddingX":16,"backgroundPaddingY":8,
            "borderRadius":4,"borderWidth":0,
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

#[test]
fn request_is_exact_path_free_and_dimension_math_is_stable() {
    let request: RenderRequest = serde_json::from_value(request_json()).expect("request");
    let plan = request.validate(1_920, 1_080, 5_000_000).expect("plan");
    assert_eq!(
        (plan.width, plan.height, plan.duration_frames),
        (1_280, 720, 60)
    );

    let mut unknown = request_json();
    unknown["sourcePath"] = json!("C:\\private\\clip.mp4");
    assert!(serde_json::from_value::<RenderRequest>(unknown).is_err());
}

#[test]
fn crop_changes_output_aspect_without_pre_cropping_visuals() {
    let mut value = request_json();
    value["crop"]["width"] = json!(50);
    let request: RenderRequest = serde_json::from_value(value).expect("request");
    let plan = request.validate(1_920, 1_080, 5_000_000).expect("plan");
    assert_eq!((plan.width, plan.height), (640, 720));
    assert!((plan.crop.width - 50.0).abs() < f64::EPSILON);
}

#[test]
fn editor_catalog_variants_round_trip() {
    let mut value = request_json();
    value["customization"]["textAlign"] = json!("justify");
    value["customization"]["borderStyle"] = json!("double");
    let request: RenderRequest = serde_json::from_value(value).expect("request");
    assert_eq!(request.customization.text_align, TextAlign::Justify);
    assert_eq!(request.customization.border_style, BorderStyle::Double);
    request
        .validate(1_920, 1_080, 5_000_000)
        .expect("valid render plan");
}

#[test]
fn padding_is_bounded_and_old_persisted_customizations_get_the_reviewed_defaults() {
    let mut legacy = request_json();
    legacy["customization"]
        .as_object_mut()
        .expect("customization object")
        .remove("backgroundPaddingX");
    legacy["customization"]
        .as_object_mut()
        .expect("customization object")
        .remove("backgroundPaddingY");
    let legacy: RenderRequest = serde_json::from_value(legacy).expect("legacy request");
    assert_eq!(
        legacy.customization.background_padding_x.to_bits(),
        16.0_f64.to_bits()
    );
    assert_eq!(
        legacy.customization.background_padding_y.to_bits(),
        8.0_f64.to_bits()
    );

    for (field, value) in [
        ("backgroundPaddingX", -0.01),
        ("backgroundPaddingY", 1_000.01),
    ] {
        let mut invalid = request_json();
        invalid["customization"][field] = json!(value);
        let request: RenderRequest = serde_json::from_value(invalid).expect("typed request");
        assert!(matches!(
            request.validate(1_920, 1_080, 5_000_000),
            Err(RenderError::InvalidRequest)
        ));
    }
}

#[test]
fn every_shipped_and_user_preset_identity_crosses_the_native_contract() {
    const PRESETS: [&str; 30] = [
        "default",
        "modern",
        "classic",
        "neon",
        "minimal",
        "gaming",
        "cinematic",
        "gradient",
        "retro",
        "elegant",
        "cyberpunk",
        "vintage",
        "comic",
        "horror",
        "luxury",
        "kawaii",
        "grunge",
        "corporate",
        "anime",
        "vaporwave",
        "steampunk",
        "noir",
        "pastel",
        "bold",
        "sketch",
        "glitch",
        "royal",
        "sunset",
        "ocean",
        "forest",
    ];
    for preset in PRESETS.into_iter().chain(["custom_1750000000000"]) {
        let mut value = request_json();
        value["customization"]["preset"] = json!(preset);
        let request: RenderRequest = serde_json::from_value(value).expect("preset request");
        assert_eq!(request.customization.preset, preset);
        request
            .validate(1_920, 1_080, 5_000_000)
            .expect("valid preset render plan");
    }
}

#[test]
fn preset_identity_uses_the_exact_utf8_boundary() {
    for preset in ["x".repeat(128), format!("{}ab", "한".repeat(42))] {
        let mut value = request_json();
        value["customization"]["preset"] = json!(preset);
        let request: RenderRequest = serde_json::from_value(value).expect("preset request");
        request
            .validate(1_920, 1_080, 5_000_000)
            .expect("bounded preset");
    }
    for preset in [
        String::new(),
        "x".repeat(129),
        "한".repeat(43),
        "bad\0preset".to_owned(),
    ] {
        let mut value = request_json();
        value["customization"]["preset"] = json!(preset);
        let request: RenderRequest = serde_json::from_value(value).expect("preset request");
        assert!(matches!(
            request.validate(1_920, 1_080, 5_000_000),
            Err(RenderError::InvalidRequest)
        ));
    }
}

#[test]
fn invalid_timing_fonts_colors_and_non_finite_values_fail_closed() {
    let mut duplicate = request_json();
    duplicate["lyrics"] = json!([
        {"id":"same","startUs":0,"endUs":1,"text":"A"},
        {"id":"same","startUs":1,"endUs":2,"text":"B"}
    ]);
    let request: RenderRequest = serde_json::from_value(duplicate).expect("shape");
    assert!(request.validate(100, 100, 10).is_err());

    let mut bad_color = request_json();
    bad_color["customization"]["textColor"] = json!("url(secret)");
    let request: RenderRequest = serde_json::from_value(bad_color).expect("shape");
    assert!(request.validate(100, 100, 5_000_000).is_err());

    let mut bad_fps = request_json();
    bad_fps["settings"]["frameRate"] = json!(29);
    assert!(serde_json::from_value::<RenderRequest>(bad_fps).is_err());
}
