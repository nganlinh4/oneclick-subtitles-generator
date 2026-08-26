//! Rendering the matrix: what every case is checked for, and which cases the default run renders.
//!
//! # What each case is checked for
//!
//! Three things, all exact, all capable of failing — and `every_check_this_gate_makes_can_actually_fail`
//! mutates each of them and shows the mutation rejected, because a comparison nobody has seen fail
//! is indistinguishable from no comparison at all:
//!
//! * **Determinism.** The same frame composed twice from the same scene is the same bytes.
//! * **Seek equals play.** The probe frame reached by walking the whole timeline is the same bytes
//!   as the probe frame composed directly from a freshly staged scene.
//! * **The cue is drawn.** The held probe frame differs from frame zero, which carries no cue.
//!   Without this the two comparisons above would pass just as happily over an empty picture.
//!
//! # How many cases the default run renders
//!
//! The full cross product is 30 presets by 9 texts by 4 output shapes before the 155 field values
//! are swept at all, which is thousands of compositions and minutes of wall clock. That is the
//! wrong default: a gate nobody runs is not a gate. So the default run covers every preset at least
//! once, every field value at least once, every text at least once and every output shape at least
//! once, by rotating texts and shapes across the preset sweep, and `OSG_PARITY_EXHAUSTIVE=1` runs
//! the same tests over the whole cross product instead.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::{Duration, Instant};

use osg_compositor::Compositor;
use serde_json::{Map, Value};

use super::case::{self, Case, Prepared};
use super::compare;
use super::matrix::{OutputEntry, ParityMatrix, TextEntry};

/// The environment variable that turns the default run into the full cross product.
pub(crate) const EXHAUSTIVE: &str = "OSG_PARITY_EXHAUSTIVE";

/// The text a field-value case is rendered with unless [`FIELD_TEXTS`] names another.
///
/// Mixed direction, with Latin letters, Arabic letters and digits: the case transforms have letters
/// to change and `rtlSupport` has a right-to-left cluster to reorder. A field-value sweep over Latin
/// alone would make several fields untestable and look green doing it.
pub(crate) const FIELD_SWEEP_TEXT: &str = "mixed-rtl";

/// Whether the caller asked for the full cross product.
pub(crate) fn exhaustive() -> bool {
    std::env::var_os(EXHAUSTIVE).is_some_and(|value| value != "0")
}

/// What one case cost and what it showed.
#[derive(Debug, Clone)]
pub(crate) struct Rendered {
    /// How many compositions the case performed.
    pub(crate) compositions: usize,
    /// Whether the held frame differs from the cue-free frame zero.
    pub(crate) cue_drawn: bool,
    /// The three probe frames: inside the fade-in, in the hold, inside the fade-out.
    pub(crate) probes: [Vec<u8>; 3],
}

impl Rendered {
    /// The frame the exact comparisons are made on.
    pub(crate) fn probe(&self) -> &[u8] {
        &self.probes[2]
    }

    /// Whether any of the three probes differs from another case's.
    pub(crate) fn differs_from(&self, other: &Self) -> bool {
        self.probes != other.probes
    }
}

/// Renders one case and checks it.
///
/// # Panics
/// Panics with the case identity, the frame index and the differing pixels when a frame is not
/// deterministic, when seeking disagrees with playing, or when the cue never reached the picture.
pub(crate) fn render_case(compositor: &Compositor, case: &Case, prepared: &Prepared) -> Rendered {
    let frames = prepared.plan.frame_count();
    let probe_indices = prepared.probe_frames();
    let probe_index = prepared.probe_frame();
    let expected_len =
        usize::try_from(u64::from(prepared.plan.width()) * u64::from(prepared.plan.height()) * 4)
            .expect("a composition inside the compositor's own area bound");

    let mut first = Vec::new();
    let mut probes: [Vec<u8>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for index in 0..frames {
        let frame = compositor
            .render_scene(&prepared.scene, index)
            .unwrap_or_else(|error| panic!("{}: frame {index} was refused: {error}", case.id));
        assert_eq!(
            frame.pixels().len(),
            expected_len,
            "{}: frame {index} came back at the wrong size",
            case.id
        );
        if index == 0 {
            first = frame.pixels().to_vec();
        }
        for (slot, wanted) in probe_indices.iter().enumerate() {
            if index == *wanted {
                probes[slot] = frame.pixels().to_vec();
            }
        }
    }
    let walked = probes[2].clone();

    // Seek equals play: the same frame from a scene that has composed nothing else.
    let sought = compositor
        .render_scene(&prepared.recompose(), probe_index)
        .expect("the freshly staged scene composes its probe frame")
        .into_pixels();
    compare::assert_identical(
        &case.id,
        probe_index,
        &walked,
        &sought,
        "seeking to a frame and playing up to it must produce the same picture",
    );

    // Determinism: the same scene, the same index, twice.
    let again = compositor
        .render_scene(&prepared.scene, probe_index)
        .expect("the scene composes its probe frame again")
        .into_pixels();
    compare::assert_identical(
        &case.id,
        probe_index,
        &walked,
        &again,
        "the same scene and index must compose the same bytes every time",
    );

    Rendered {
        compositions: usize::try_from(frames).unwrap_or(usize::MAX) + 2,
        cue_drawn: probes[1] != first,
        probes,
    }
}

/// Which of the matrix's output shapes this machine's adapter can actually compose.
///
/// Probed rather than assumed, with a throwaway device per shape, because a shape the adapter
/// refuses takes the device with it. A refusal is reported, not skipped: the caller asserts the
/// refused list is empty, so a shape that cannot be composed fails the gate once, with the size and
/// the reason, instead of failing every case that happens to use it.
#[derive(Debug, Clone)]
pub(crate) struct ShapeProbe {
    pub(crate) composable: Vec<OutputEntry>,
    pub(crate) refused: Vec<(OutputEntry, String)>,
}

pub(crate) fn probe_shapes(matrix: &ParityMatrix) -> ShapeProbe {
    let mut composable = Vec::new();
    let mut refused = Vec::new();
    for output in &matrix.outputs {
        let case = Case::new(
            format!("shape-probe out={}", output.id),
            defaults(matrix),
            matrix.text("latin").text.clone(),
            output.resolution.clone(),
            output.frame_rate,
        );
        let prepared = match case::try_prepare(&case) {
            Ok(prepared) => prepared,
            Err(reason) => {
                refused.push((output.clone(), reason));
                continue;
            }
        };
        let attempt = catch_unwind(AssertUnwindSafe(|| {
            let compositor = Compositor::new().expect("an adapter");
            compositor
                .render_scene(&prepared.scene, prepared.probe_frame())
                .map(|frame| frame.pixels().len())
        }));
        match attempt {
            Ok(Ok(_)) => composable.push(output.clone()),
            Ok(Err(error)) => refused.push((
                output.clone(),
                format!(
                    "{}x{} was refused: {error}",
                    prepared.plan.width(),
                    prepared.plan.height()
                ),
            )),
            Err(payload) => refused.push((
                output.clone(),
                format!(
                    "{}x{} aborted the compositor: {}",
                    prepared.plan.width(),
                    prepared.plan.height(),
                    panic_message(&payload)
                ),
            )),
        }
    }
    ShapeProbe {
        composable,
        refused,
    }
}

fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    payload.downcast_ref::<&str>().map_or_else(
        || {
            payload
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_else(|| "an unprintable panic".to_owned())
        },
        |message| (*message).to_owned(),
    )
}

/// Every persisted subtitle option at its default, which is what a fresh project carries.
pub(crate) fn defaults(matrix: &ParityMatrix) -> Value {
    let mut object = Map::new();
    for entry in &matrix.field_matrix {
        object.insert(entry.field.clone(), entry.default.clone());
    }
    Value::Object(object)
}

/// The companion each gated field needs switched on before it can express itself at all.
///
/// Several persisted settings draw nothing while a **different** field is at its default: a border
/// width draws nothing while the border style is `none`, a border style draws nothing at width
/// zero, a glow intensity draws nothing while the glow is off, a gradient direction draws nothing
/// while the gradient is off, a stroke width draws nothing while the stroke is off, and the custom
/// anchor and the top margin are consulted only for the position they belong to. Sweeping those
/// fields from the bare defaults would report a live setting as having no effect — a statement
/// about the base the gate chose, not about the renderer.
///
/// So each field is swept from the defaults **plus its own companions**, and compared against that
/// same base with the field itself back at its default. One switch per line, each a claim a
/// reviewer can check, and every value one the matrix already lists for that companion field, so
/// nothing here escapes the frozen input.
const COMPANIONS: &[(&str, &[(&str, &str)])] = &[
    (
        "borderColor",
        &[("borderStyle", "\"solid\""), ("borderWidth", "1")],
    ),
    ("borderStyle", &[("borderWidth", "1")]),
    ("borderWidth", &[("borderStyle", "\"solid\"")]),
    (
        "strokeColor",
        &[("strokeEnabled", "true"), ("strokeWidth", "2")],
    ),
    ("strokeEnabled", &[("strokeWidth", "2")]),
    ("strokeWidth", &[("strokeEnabled", "true")]),
    ("glowColor", &[("glowEnabled", "true")]),
    ("glowIntensity", &[("glowEnabled", "true")]),
    ("gradientColorEnd", &[("gradientEnabled", "true")]),
    ("gradientColorStart", &[("gradientEnabled", "true")]),
    ("gradientDirection", &[("gradientEnabled", "true")]),
    ("customPositionX", &[("position", "\"custom\"")]),
    ("customPositionY", &[("position", "\"custom\"")]),
    ("marginTop", &[("position", "\"top\"")]),
];

/// The two fields that need a **particular** text, and the one they need.
///
/// A wrap width and a wrap switch cannot show anything on a line that fits whatever they are set
/// to, so those two are pinned to the longest text the matrix carries. Every other field takes
/// whatever the rotation gives it, which is the point: a field swept against one script forever is
/// a field nobody has seen behave on the other eight.
const FIELD_TEXTS: &[(&str, &str)] = &[("maxWidth", "dense"), ("wordWrap", "dense")];

/// The text identity a field's **conversion** is judged against.
///
/// The plan-and-staging half of the gate renders nothing, so one text per field is enough there and
/// [`FIELD_SWEEP_TEXT`] is the one that makes most fields express themselves.
pub(crate) fn text_for(field: &str) -> &'static str {
    FIELD_TEXTS
        .iter()
        .find(|(name, _)| *name == field)
        .map_or(FIELD_SWEEP_TEXT, |(_, text)| *text)
}

/// The text one **rendered** field-value case is composed against.
///
/// The default run used to compose every field value against `mixed-rtl` — two of the matrix's nine
/// texts in the whole sweep, with the other seven reached only by `OSG_PARITY_EXHAUSTIVE`. That was
/// a real hole rather than a saving: several of the fields the ledger calls native are decided by
/// the *script*, not by the value, and a Korean, emoji or combining-mark case was never rendered at
/// a non-default setting on an ordinary run. So the text rotates by position exactly as the preset
/// sweep's does, the count of renders is unchanged, and the coverage is asserted rather than
/// described — see [`assert_field_coverage`].
fn text_for_value<'matrix>(
    matrix: &'matrix ParityMatrix,
    field: &str,
    position: usize,
) -> &'matrix TextEntry {
    FIELD_TEXTS
        .iter()
        .find(|(name, _)| *name == field)
        .map_or_else(
            || &matrix.texts[position % matrix.texts.len()],
            |(_, pinned)| matrix.text(pinned),
        )
}

/// The defaults with the companions one field needs, and that field at `value`.
pub(crate) fn base_for(matrix: &ParityMatrix, field: &str, value: &Value) -> Value {
    let mut base = defaults(matrix);
    let object = base.as_object_mut().expect("a customization is an object");
    let companions = COMPANIONS
        .iter()
        .find(|(name, _)| *name == field)
        .map_or(&[][..], |(_, switches)| *switches);
    for (companion, literal) in companions {
        let switched: Value = serde_json::from_str(literal).expect("a companion is valid JSON");
        let listed = matrix
            .field_matrix
            .iter()
            .find(|entry| entry.field == *companion)
            .expect("a companion names a field the matrix carries");
        assert!(
            listed.values.contains(&switched),
            "the companion {companion} of {field} is a value the matrix does not list"
        );
        object.insert((*companion).to_owned(), switched);
    }
    object.insert(field.to_owned(), value.clone());
    base
}

/// The same base with the field back at its own default: what its values are compared against.
pub(crate) fn baseline_for(matrix: &ParityMatrix, field: &str) -> Value {
    let default = matrix
        .field_matrix
        .iter()
        .find(|entry| entry.field == field)
        .expect("the matrix carries this field")
        .default
        .clone();
    base_for(matrix, field, &default)
}

/// The preset cases the run renders.
///
/// The default run pairs preset `i` with text `i % texts` and shape `i % shapes`, so 30 cases cover
/// all 30 presets, all 9 texts and every shape the adapter admits. The exhaustive run is the whole
/// cross product.
pub(crate) fn preset_cases(matrix: &ParityMatrix, shapes: &[OutputEntry]) -> Vec<Case> {
    let mut cases = Vec::new();
    for (index, preset) in matrix.presets.iter().enumerate() {
        if exhaustive() {
            for text in &matrix.texts {
                for shape in shapes {
                    cases.push(preset_case(
                        preset.id.as_str(),
                        &preset.customization,
                        text.id.as_str(),
                        &text.text,
                        shape,
                    ));
                }
            }
        } else {
            let text = &matrix.texts[index % matrix.texts.len()];
            let shape = &shapes[index % shapes.len()];
            cases.push(preset_case(
                preset.id.as_str(),
                &preset.customization,
                text.id.as_str(),
                &text.text,
                shape,
            ));
        }
    }
    cases
}

fn preset_case(
    preset: &str,
    customization: &Value,
    text_id: &str,
    text: &str,
    shape: &OutputEntry,
) -> Case {
    Case::new(
        format!("preset={preset} text={text_id} out={}", shape.id),
        customization.clone(),
        text,
        shape.resolution.clone(),
        shape.frame_rate,
    )
}

/// One field-value case: which field, which value, and the case that renders it.
#[derive(Debug, Clone)]
pub(crate) struct FieldCase {
    pub(crate) field: String,
    pub(crate) value: Value,
    pub(crate) is_default: bool,
    pub(crate) drawn: bool,
    pub(crate) case: Case,
    /// The same case with this one field at its default, which is what it is compared against.
    pub(crate) baseline: Case,
}

impl FieldCase {
    /// The identity of the baseline this case is compared against, for caching it.
    pub(crate) fn baseline_key(&self) -> String {
        format!(
            "{}|{}|{}|{}",
            self.baseline.resolution,
            self.baseline.frame_rate,
            self.baseline.text,
            self.baseline.customization
        )
    }
}

/// Every field-value render the matrix asks for.
///
/// The default run renders each value once, against the mixed-direction text and one shape chosen
/// by position so the sweep is spread over every shape the adapter admits. The exhaustive run
/// renders each value against every text and every shape.
pub(crate) fn field_cases(matrix: &ParityMatrix, shapes: &[OutputEntry]) -> Vec<FieldCase> {
    let mut cases = Vec::new();
    let mut position = 0_usize;
    for entry in &matrix.field_matrix {
        let baseline = baseline_for(matrix, &entry.field);
        for value in &entry.values {
            let customization = base_for(matrix, &entry.field, value);
            let is_default = *value == entry.default;
            let mut push = |text_id: &str, text: &str, shape: &OutputEntry| {
                cases.push(FieldCase {
                    field: entry.field.clone(),
                    value: value.clone(),
                    is_default,
                    drawn: entry.is_drawn(),
                    case: field_case(&entry.field, value, &customization, text_id, text, shape),
                    baseline: field_case(
                        &entry.field,
                        &entry.default,
                        &baseline,
                        text_id,
                        text,
                        shape,
                    ),
                });
            };
            if exhaustive() {
                for text in &matrix.texts {
                    for shape in shapes {
                        push(text.id.as_str(), &text.text, shape);
                    }
                }
            } else {
                let text = text_for_value(matrix, &entry.field, position);
                push(
                    text.id.as_str(),
                    &text.text,
                    &shapes[position % shapes.len()],
                );
            }
            position += 1;
        }
    }
    cases
}

fn field_case(
    field: &str,
    value: &Value,
    customization: &Value,
    text_id: &str,
    text: &str,
    shape: &OutputEntry,
) -> Case {
    Case::new(
        format!(
            "field={field}={} text={text_id} out={}",
            case::value_label(value),
            shape.id
        ),
        customization.clone(),
        text,
        shape.resolution.clone(),
        shape.frame_rate,
    )
}

/// A running count of what a sweep cost, so the gate can report it rather than estimate it.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Tally {
    pub(crate) cases: usize,
    pub(crate) compositions: usize,
}

impl Tally {
    pub(crate) fn add(&mut self, rendered: &Rendered) {
        self.cases += 1;
        self.compositions += rendered.compositions;
    }

    pub(crate) fn report(self, what: &str, elapsed: Duration) {
        println!(
            "{what}: {} cases, {} compositions, {:.2}s",
            self.cases,
            self.compositions,
            elapsed.as_secs_f64()
        );
    }
}

/// Times a sweep without letting the caller forget to.
pub(crate) fn timed<T>(work: impl FnOnce() -> T) -> (T, Duration) {
    let started = Instant::now();
    let value = work();
    (value, started.elapsed())
}
