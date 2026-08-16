//! What a persisted option changes before a single pixel is drawn.
//!
//! Rendering is the expensive half of the gate and the ambiguous half: a setting can be carried
//! perfectly and still leave a particular frame unchanged, because the frame it would have changed
//! is one where the effect is not visible — a border style with no border width, an easing at a
//! moment where the curve has the same value either way. Asserting "every field changes the
//! picture" would therefore be false, and a gate that asserts something false gets weakened until
//! it passes.
//!
//! So the unconditional assertion lives here instead, where it is exactly true:
//!
//! * A field the ledger calls `native` or `fixed`, given a value other than its default, must
//!   change **the conversion or the staged text**. Those are the only two things a persisted
//!   subtitle option can reach: `ExportPlan` is what the compositor and the encoder are configured
//!   from, and the staged atlas is what the `WebView` bakes. A value that changes neither is a
//!   setting that has been dropped on the floor, whatever a frame happens to look like.
//! * A field the ledger calls `inert` must change **neither**, for any value the contract accepts.
//!   That is what `inert` means, and it is the assertion that keeps an inert field from quietly
//!   growing an effect.

use serde_json::{Value, json};

use super::case::{Case, Prepared};
use super::matrix::ParityMatrix;

/// What one changed field diverged in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Divergence {
    /// The conversion — the scene, the style, the crop, the audio plan or the encoder config.
    pub(crate) plan: bool,
    /// The staged text — the face, the atlas or the laid-out run.
    pub(crate) staged: bool,
}

impl Divergence {
    /// Whether the field reached anything at all.
    pub(crate) const fn reaches_the_pipeline(self) -> bool {
        self.plan || self.staged
    }

    /// How a report names it.
    pub(crate) const fn label(self) -> &'static str {
        match (self.plan, self.staged) {
            (true, true) => "plan+staged",
            (true, false) => "plan",
            (false, true) => "staged",
            (false, false) => "nothing",
        }
    }
}

/// Measures one case against the case it was derived from.
pub(crate) fn divergence(base: &Prepared, other: &Prepared) -> Divergence {
    Divergence {
        plan: base.plan != other.plan,
        staged: base.staged != other.staged,
    }
}

/// A value an inert field is set to, to prove it stays inert.
///
/// The matrix cannot supply these: the generator lists a value per field only where the value is
/// interesting to *render*, and an inert field has nothing to render, so it carries its default
/// alone. Every value here is one the render contract validates, so the only thing being tested is
/// whether the pipeline reacts to it — and it must not.
pub(crate) fn inert_probes() -> Vec<(&'static str, Value)> {
    vec![
        ("gradientColorMid", json!("#ff0000")),
        ("gradientType", json!("radial")),
        ("lineBreakBehavior", json!("manual")),
        ("maxLines", json!(1)),
        ("multiShadowEnabled", json!(true)),
        ("pulseEnabled", json!(true)),
        ("pulseSpeed", json!(4.0)),
        ("shadowLayers", json!(8)),
        ("shakeEnabled", json!(true)),
        ("shakeIntensity", json!(25.0)),
    ]
}

/// Asserts the probe list names exactly the fields the ledger calls inert.
///
/// # Panics
/// Panics when an inert field has no probe or a probe names a field that is not inert. Either way
/// the gate would be claiming a coverage it does not have.
pub(crate) fn check_inert_probes(matrix: &ParityMatrix) {
    let mut inert: Vec<&str> = matrix
        .field_matrix
        .iter()
        .filter(|entry| entry.is_inert())
        .map(|entry| entry.field.as_str())
        .collect();
    inert.sort_unstable();
    let mut probed: Vec<&str> = inert_probes().into_iter().map(|(field, _)| field).collect();
    probed.sort_unstable();
    assert_eq!(
        inert, probed,
        "the inert probes and the ledger's inert fields have come apart"
    );
    assert!(
        matrix
            .field_matrix
            .iter()
            .filter(|entry| entry.is_inert())
            .all(|entry| entry.values.len() == 1),
        "an inert field grew a second value in the matrix, which the gate does not know how to read"
    );
}

/// The case a field sweep varies, and the case one alternative value produces.
pub(crate) fn variant(base: &Case, field: &str, value: &Value, label: &str) -> Case {
    Case::new(
        format!("{label} {field}={}", super::case::value_label(value)),
        super::case::with_field(&base.customization, field, value),
        base.text.clone(),
        base.resolution.clone(),
        base.frame_rate,
    )
}
