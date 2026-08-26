//! Lock Rust scene math to the canonical TypeScript preview math.
//!
//! The fixture is generated from the canonical TypeScript by
//! `scripts/generate-render-parity-fixture.mjs`. The same file is asserted from the frontend suite,
//! so the two implementations are locked to each other rather than merely to their own tests.
//!
//! A failure here means preview and export would disagree. Regenerate the fixture only when the
//! behaviour change is intended and documented; never merely to make this pass.

use serde::Deserialize;

const GOLDEN: &str = include_str!("fixtures/subtitle-math-golden.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Golden {
    schema_version: u32,
    #[serde(rename = "generatedFrom")]
    _generated_from: serde_json::Value,
    #[serde(rename = "note")]
    _note: String,
    easings: Vec<String>,
    reviewed_interior_progress_samples: Vec<f64>,
    easing_samples: Vec<EasingSample>,
    scale_samples: Vec<ScaleSample>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EasingSample {
    easing: String,
    #[serde(rename = "progress")]
    _progress: f64,
    progress_bits: String,
    #[serde(rename = "eased")]
    _eased: f64,
    eased_bits: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScaleSample {
    #[serde(rename = "value")]
    _value: f64,
    value_bits: String,
    #[serde(rename = "compositionHeight")]
    _composition_height: f64,
    composition_height_bits: String,
    #[serde(rename = "scaled")]
    _scaled: f64,
    scaled_bits: String,
}

fn golden() -> Golden {
    serde_json::from_str(GOLDEN).expect("subtitle math golden fixture")
}

/// Decimal text cannot express a bit-exact expectation without inheriting a parser's rounding, so
/// the fixture carries the IEEE-754 bits and both sides compare those.
fn from_bits(hex: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(hex, 16).expect("fixture bit pattern"))
}

#[test]
fn the_easing_catalog_matches_the_canonical_catalog_exactly() {
    let golden = golden();
    assert_eq!(
        golden.schema_version, 2,
        "unexpected fixture schema version"
    );
    assert_eq!(
        golden.easings,
        osg_scene::SUBTITLE_ANIMATION_EASINGS,
        "the reviewed easing catalog drifted from the canonical one"
    );
}

#[test]
fn every_easing_sample_reproduces_the_canonical_curve_bit_for_bit() {
    let golden = golden();
    assert!(
        !golden.easing_samples.is_empty(),
        "refusing to pass against an empty fixture"
    );
    for sample in &golden.easing_samples {
        let progress = from_bits(&sample.progress_bits);
        let expected = from_bits(&sample.eased_bits);
        let actual = osg_scene::apply_subtitle_animation_easing(progress, &sample.easing);
        assert_eq!(
            actual.to_bits(),
            expected.to_bits(),
            "easing {} at progress {progress} produced {actual} but the canonical TypeScript produces {expected}",
            sample.easing,
        );
    }
}

#[test]
fn every_catalog_curve_has_a_distinct_reviewed_interior_signature() {
    let golden = golden();
    assert!(
        !golden.reviewed_interior_progress_samples.is_empty(),
        "the distinctness invariant needs reviewed interior samples"
    );
    assert!(
        golden
            .reviewed_interior_progress_samples
            .iter()
            .all(|progress| *progress > 0.0 && *progress < 1.0),
        "distinctness samples must stay inside the animation interval"
    );

    let mut signatures: Vec<(&str, Vec<u64>)> = Vec::new();
    for easing in osg_scene::SUBTITLE_ANIMATION_EASINGS {
        let signature = golden
            .reviewed_interior_progress_samples
            .iter()
            .map(|progress| osg_scene::apply_subtitle_animation_easing(*progress, easing).to_bits())
            .collect::<Vec<_>>();
        for (previous_easing, previous_signature) in &signatures {
            assert_ne!(
                &signature, previous_signature,
                "user-visible easing {easing} aliases {previous_easing} at every reviewed interior sample"
            );
        }
        signatures.push((easing, signature));
    }
}

#[test]
fn an_unknown_easing_falls_through_to_linear() {
    for progress in [-1.0, 0.0, 0.37, 1.0, 2.0] {
        assert_eq!(
            osg_scene::apply_subtitle_animation_easing(progress, "not-a-real-easing").to_bits(),
            progress.to_bits(),
        );
    }
}

#[test]
fn every_scale_sample_reproduces_the_shipped_rounding_bit_for_bit() {
    let golden = golden();
    assert!(
        !golden.scale_samples.is_empty(),
        "refusing to pass against an empty fixture"
    );
    for sample in &golden.scale_samples {
        let value = from_bits(&sample.value_bits);
        let height = from_bits(&sample.composition_height_bits);
        let expected = from_bits(&sample.scaled_bits);
        let actual = osg_scene::scale_subtitle_style_value(value, height);
        assert_eq!(
            actual.to_bits(),
            expected.to_bits(),
            "scaling {value} at height {height} produced {actual} but the shipped renderer produces {expected}",
        );
    }
}

#[test]
fn scaling_is_identity_at_the_reference_height() {
    for value in [0.0, 1.0, 28.0, 120.0] {
        assert_eq!(
            osg_scene::scale_subtitle_style_value(value, 1_080.0).to_bits(),
            value.to_bits(),
        );
    }
}
