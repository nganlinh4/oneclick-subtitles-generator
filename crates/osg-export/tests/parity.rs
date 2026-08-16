#![recursion_limit = "256"]

//! The exhaustive parity gate: the suite that authorises deleting the shipped renderer.
//!
//! The migration is only finished when every persisted option a saved project can carry has been
//! rendered through the native pipeline and judged. `src/platform/renderParityLedger.js` records
//! what each option is *supposed* to do; this suite is what checks that it does it. The input is
//! frozen in `tests/fixtures/parity-matrix.json`, generated from the real JavaScript modules by
//! `scripts/generate-parity-matrix.mjs` and guarded by `npm run test:parity-matrix`, so the gate
//! cannot quietly cover fewer presets or fewer fields than exist.
//!
//! # What is asserted, and what is only measured
//!
//! * Every shipped preset and every field value is **rendered**, and each render is checked for
//!   determinism, for seek-equals-play and for actually drawing its cue. Those are exact.
//! * Every field value other than a default must **reach the conversion or the staged text**. That
//!   is the assertion that a persisted setting has not been dropped, and it is exact.
//! * Every inert field must reach **neither**, and must leave the frame byte-identical.
//! * Native frames against decoded exported frames cannot be exact — `H.264` is lossy — so
//!   `roundtrip` measures the difference, states the tolerance it admits, and proves the tolerance
//!   is tight enough by showing that a one-pixel shift of the subtitle layer sits far outside it.
//!
//! # Cost
//!
//! The default run covers every preset, every field value, every text and every output shape at
//! least once. `OSG_PARITY_EXHAUSTIVE=1` runs the same tests over the whole cross product. Both
//! print their case count, composition count and wall clock, so the numbers in any report are
//! measured rather than estimated.

#[path = "parity/mod.rs"]
mod gate;
mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::panic::AssertUnwindSafe;

use gate::case::{self, Case};
use gate::compare;
use gate::effects;
use gate::matrix::{self, ParityMatrix};
use gate::plans::{self, Divergence};
use gate::sweep::{self, FieldCase};
use osg_compositor::Compositor;

/// The matrix, plus the output shapes this machine's adapter can actually compose.
struct Bench {
    matrix: ParityMatrix,
    shapes: Vec<matrix::OutputEntry>,
    compositor: Compositor,
}

fn bench() -> Bench {
    let matrix = matrix::load();
    let probe = sweep::probe_shapes(&matrix);
    for (output, reason) in &probe.refused {
        println!("output shape {} is not composable: {reason}", output.id);
    }
    let compositor = Compositor::new().expect("a graphics adapter");
    println!(
        "adapter: {} ({}, {:?}); composable shapes: {}",
        compositor.adapter().name(),
        compositor.adapter().backend(),
        compositor.adapter().kind(),
        probe
            .composable
            .iter()
            .map(|output| output.id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    assert!(
        !probe.composable.is_empty(),
        "no output shape in the matrix can be composed at all"
    );
    Bench {
        matrix,
        shapes: probe.composable,
        compositor,
    }
}

#[test]
fn the_frozen_matrix_covers_every_preset_and_every_persisted_option() {
    let matrix = matrix::load();
    plans::check_inert_probes(&matrix);
    let coverage = matrix.coverage;
    println!(
        "matrix: {} presets, {} persisted options ({} subtitle + {} output), \
         {} field-value renders, {} texts, {} output shapes",
        coverage.presets,
        coverage.total_persisted_options,
        coverage.subtitle_fields,
        coverage.output_fields,
        coverage.field_value_renders,
        coverage.texts,
        coverage.outputs,
    );
    assert_eq!(coverage.presets, 30, "the shipped preset count changed");
    assert_eq!(
        coverage.total_persisted_options, 70,
        "the persisted option count changed"
    );
    assert!(
        matrix
            .field_matrix
            .iter()
            .all(|entry| entry.disposition != "pending"),
        "a persisted option is still pending, so the renderer cannot be deleted"
    );
}

#[test]
fn every_output_shape_the_matrix_names_can_be_composed() {
    let _lock = gate::exclusive();
    let matrix = matrix::load();
    let probe = sweep::probe_shapes(&matrix);
    let refused: Vec<String> = probe
        .refused
        .iter()
        .map(|(output, reason)| {
            format!(
                "{} ({} @{}fps): {reason}",
                output.id, output.resolution, output.frame_rate
            )
        })
        .collect();
    assert!(
        refused.is_empty(),
        "the matrix names output shapes this pipeline cannot compose:\n  {}",
        refused.join("\n  ")
    );
}

#[test]
fn every_persisted_option_reaches_the_conversion_or_the_staging() {
    // No adapter and no codec: this is the exact half of the gate, and it is the one that proves a
    // setting has not been dropped on the floor between the request and the pipeline.
    let matrix = matrix::load();
    let mut reached: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    let mut dropped: Vec<String> = Vec::new();
    let mut refused: Vec<String> = Vec::new();
    let mut values = 0_usize;
    for entry in &matrix.field_matrix {
        // Each field is judged against the defaults plus its own companions, with the field itself
        // back at its default, so the comparison is about the field and not about the switch.
        let base_case = Case::new(
            format!("base {}", entry.field),
            sweep::baseline_for(&matrix, &entry.field),
            matrix.text(sweep::text_for(&entry.field)).text.clone(),
            "480p",
            30,
        );
        let base = case::prepare(&base_case);
        for value in entry.alternatives() {
            values += 1;
            let variant = plans::variant(&base_case, &entry.field, value, "base");
            let prepared = match case::try_prepare(&variant) {
                Ok(prepared) => prepared,
                Err(reason) => {
                    refused.push(format!("{}: {reason}", variant.id));
                    continue;
                }
            };
            let divergence = plans::divergence(&base, &prepared);
            if entry.is_drawn() && !divergence.reaches_the_pipeline() {
                dropped.push(variant.id.clone());
            }
            reached
                .entry(divergence.label())
                .or_default()
                .push(variant.id);
        }
    }
    for (label, cases) in &reached {
        println!("{} values reach {label}", cases.len());
    }
    println!("{values} non-default field values were converted and staged");
    assert!(
        dropped.is_empty(),
        "these persisted settings changed neither the conversion nor the staged text:\n  {}",
        dropped.join("\n  ")
    );
    assert!(
        refused.is_empty(),
        "these persisted settings validate but the pipeline will not convert them:\n  {}",
        refused.join("\n  ")
    );
}

#[test]
fn every_inert_option_stays_inert() {
    let _lock = gate::exclusive();
    let bench = bench();
    let shape = bench.shapes[0].clone();
    let base_case = Case::new(
        "inert-base",
        sweep::defaults(&bench.matrix),
        bench.matrix.text(sweep::FIELD_SWEEP_TEXT).text.clone(),
        shape.resolution.clone(),
        shape.frame_rate,
    );
    let base = case::prepare(&base_case);
    let base_frame = sweep::render_case(&bench.compositor, &base_case, &base);
    assert!(
        base_frame.cue_drawn,
        "the inert probe's own baseline never drew a cue, so it could not detect one appearing"
    );

    for (field, value) in plans::inert_probes() {
        let variant = plans::variant(&base_case, field, &value, "inert");
        let prepared = case::prepare(&variant);
        let divergence = plans::divergence(&base, &prepared);
        assert_eq!(
            divergence,
            Divergence {
                plan: false,
                staged: false
            },
            "{}: an inert option reached {}",
            variant.id,
            divergence.label()
        );
        let rendered = sweep::render_case(&bench.compositor, &variant, &prepared);
        for (slot, index) in prepared.probe_frames().into_iter().enumerate() {
            compare::assert_identical(
                &variant.id,
                index,
                &base_frame.probes[slot],
                &rendered.probes[slot],
                "an inert option must not change a single byte of the picture",
            );
        }
    }
    println!("{} inert options stayed inert", plans::inert_probes().len());
}

#[test]
fn every_check_this_gate_makes_can_actually_fail() {
    // A sweep where nothing is really compared passes on every case and proves nothing, and that
    // failure mode is invisible from the outside: a green run looks the same either way. So each of
    // the three checks the sweep makes is mutated here and shown to reject the mutation.
    let _lock = gate::exclusive();
    let bench = bench();
    let shape = bench.shapes[0].clone();
    let subject = Case::new(
        "mutation",
        sweep::defaults(&bench.matrix),
        bench.matrix.text("latin").text.clone(),
        shape.resolution.clone(),
        shape.frame_rate,
    );
    let prepared = case::prepare(&subject);
    let rendered = sweep::render_case(&bench.compositor, &subject, &prepared);
    let probe = prepared.probe_frame();

    // 1. The exact comparison. One channel of one pixel, changed by one level, must be caught, and
    //    the diagnosis must name the case, the frame and the pixel without naming a file.
    let mut mutated = rendered.probe().to_vec();
    mutated[4] = mutated[4].wrapping_add(1);
    let caught = std::panic::catch_unwind(AssertUnwindSafe(|| {
        compare::assert_identical(&subject.id, probe, rendered.probe(), &mutated, "mutation");
    }))
    .expect_err("a one-level mutation of one pixel must fail the exact comparison");
    let message = caught
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_else(|| "an unprintable panic".to_owned());
    assert!(message.contains(&subject.id), "{message}");
    assert!(message.contains(&format!("frame {probe}")), "{message}");
    assert!(message.contains("pixel 1:"), "{message}");
    assert!(!message.contains(std::path::MAIN_SEPARATOR), "{message}");

    // 2. The cue-is-drawn check. A cue moved outside the window draws nothing, so the check that
    //    every case really put a subtitle on the screen has to report it.
    let mut empty = subject.clone();
    empty.lyrics = Some(serde_json::json!([{
        "id": "cue-1",
        "startUs": 9_000_000_u64,
        "endUs": 9_500_000_u64,
        "text": subject.text,
    }]));
    let staged = case::prepare(&empty);
    let blank = sweep::render_case(&bench.compositor, &empty, &staged);
    assert!(
        !blank.cue_drawn,
        "a case whose cue never enters the window reported a drawn cue, so the check is vacuous"
    );

    // 3. The setting-changes-the-picture check. A field the ledger calls native, given a value the
    //    matrix lists, must move the picture — measured here rather than assumed, so the sweep's
    //    partition is known to be built on a comparison that can come out either way.
    let bigger = plans::variant(&subject, "fontSize", &serde_json::json!(200), "mutation");
    let grown = case::prepare(&bigger);
    let grown_frame = sweep::render_case(&bench.compositor, &bigger, &grown);
    assert!(
        grown_frame.differs_from(&rendered),
        "a font size of 200 composed the same picture as 28, so the sweep's comparison is inert"
    );
    println!("all three of the gate's checks reject a deliberate mutation");
}

#[test]
fn every_shipped_preset_renders() {
    let _lock = gate::exclusive();
    let bench = bench();
    let cases = sweep::preset_cases(&bench.matrix, &bench.shapes);
    // The coverage claim, asserted rather than commented: whatever the selection rule is, this run
    // has to have rendered every preset, every text and every shape the adapter admits.
    assert_coverage(&bench, &cases);
    let mut refused: Vec<String> = Vec::new();
    let (tally, elapsed) = sweep::timed(|| {
        let mut tally = sweep::Tally::default();
        for case in &cases {
            let prepared = match case::try_prepare(case) {
                Ok(prepared) => prepared,
                Err(reason) => {
                    refused.push(format!("{}: {reason}", case.id));
                    continue;
                }
            };
            let rendered = sweep::render_case(&bench.compositor, case, &prepared);
            assert!(
                rendered.cue_drawn,
                "{}: the cue never reached the picture, so nothing this case checked means anything \
                 ({} cells on {} lines)",
                case.id,
                prepared.staged.placed_cells(),
                prepared.staged.line_count(),
            );
            tally.add(&rendered);
        }
        tally
    });
    tally.report("presets", elapsed);
    assert!(
        refused.is_empty(),
        "these shipped presets cannot be converted at all:\n  {}",
        refused.join("\n  ")
    );
    assert_eq!(tally.cases, cases.len());
}

#[test]
fn every_field_value_renders_and_changes_the_picture_where_it_can() {
    let _lock = gate::exclusive();
    let bench = bench();
    let cases: Vec<FieldCase> = sweep::field_cases(&bench.matrix, &bench.shapes);
    if sweep::exhaustive() {
        assert_eq!(
            cases.len(),
            bench.matrix.coverage.field_value_renders
                * bench.matrix.coverage.texts
                * bench.shapes.len(),
            "the exhaustive sweep is not the cross product it claims to be"
        );
    } else {
        assert_eq!(
            cases.len(),
            bench.matrix.coverage.field_value_renders,
            "the default sweep does not render every field value exactly once"
        );
    }
    // Grouped by the comparison each case makes, and one baseline held at a time. Caching every
    // baseline would be simpler and would not survive the exhaustive run: three probe frames of a
    // 1080p composition are 25 MB, and the cross product needs 1_458 baselines, which is 19 GB of
    // pictures nobody is looking at any more.
    let mut groups: BTreeMap<String, Vec<&FieldCase>> = BTreeMap::new();
    for field_case in &cases {
        groups
            .entry(field_case.baseline_key())
            .or_default()
            .push(field_case);
    }

    let mut outcome = FieldOutcome::default();
    let ((), elapsed) = sweep::timed(|| {
        for group in groups.values() {
            outcome.run_group(&bench, group);
        }
    });
    outcome.finish(elapsed);
}

/// What the field sweep learned, accumulated across every group it renders.
#[derive(Debug, Default)]
struct FieldOutcome {
    tally: sweep::Tally,
    visible: usize,
    /// How many of the invisible ones are invisible by proof rather than by review.
    proved: usize,
    invisible: Vec<String>,
    unexpected: Vec<String>,
    stale: Vec<String>,
    refused: Vec<String>,
}

impl FieldOutcome {
    /// Renders one group's baseline, then every case that is compared against it.
    fn run_group(&mut self, bench: &Bench, group: &[&FieldCase]) {
        let first = group.first().expect("a group has at least one case");
        let staged = case::prepare(&first.baseline);
        let baseline = sweep::render_case(&bench.compositor, &first.baseline, &staged);
        assert!(
            baseline.cue_drawn,
            "{}: the baseline never drew a cue, so no field could be seen to change it",
            first.baseline.id
        );
        self.tally.add(&baseline);

        for field_case in group {
            let prepared = match case::try_prepare(&field_case.case) {
                Ok(prepared) => prepared,
                Err(reason) => {
                    self.refused
                        .push(format!("{}: {reason}", field_case.case.id));
                    continue;
                }
            };
            let rendered = sweep::render_case(&bench.compositor, &field_case.case, &prepared);
            assert!(
                rendered.cue_drawn,
                "{}: the cue never reached the picture",
                field_case.case.id
            );
            self.tally.add(&rendered);

            if field_case.is_default {
                compare::assert_identical(
                    &field_case.case.id,
                    prepared.probe_frame(),
                    baseline.probe(),
                    rendered.probe(),
                    "a field left at its default must compose the baseline picture",
                );
            } else if field_case.drawn {
                let drawable_same = prepared.plan == staged.plan
                    && prepared.staged.draws_the_same_as(&staged.staged);
                self.judge(field_case, &rendered, &baseline, drawable_same);
            }
        }
    }

    /// Partitions one value into "changes the picture" and "provably cannot".
    ///
    /// `drawable_same` is the mechanical half: when a value leaves the conversion and everything
    /// the compositor draws from byte-identical, the frame *must* be identical, and that is checked
    /// rather than excused. `maxWidth` on a line that already fits, `wordWrap` on a text that has
    /// one line either way and `rtlSupport` on a text with no right-to-left cluster all land here,
    /// on every text, without anybody maintaining a list of which text they land on.
    ///
    /// What is left over is the reviewed list in `effects.rs`: a value that really does reach the
    /// drawing and still cannot move a pixel.
    fn judge(
        &mut self,
        field_case: &FieldCase,
        rendered: &sweep::Rendered,
        baseline: &sweep::Rendered,
        drawable_same: bool,
    ) {
        let label = case::value_label(&field_case.value);
        let expected = effects::expected_invisible(&field_case.field, &label);
        if rendered.differs_from(baseline) {
            assert!(
                !drawable_same,
                "{}: the conversion and everything drawn from it are byte-identical to the \
                 baseline's, yet the picture changed — the comparison that decides this partition \
                 is looking at less than the compositor is",
                field_case.case.id
            );
            self.visible += 1;
            if let Some(reason) = expected {
                self.stale.push(format!(
                    "{}: listed as unable to change the picture ({reason}) but changed it",
                    field_case.case.id
                ));
            }
        } else {
            self.invisible.push(format!("{}={label}", field_case.field));
            if drawable_same {
                self.proved += 1;
            } else if expected.is_none() {
                self.unexpected.push(format!(
                    "{}: reaches the drawing and left the picture byte-identical",
                    field_case.case.id
                ));
            }
        }
    }

    /// Reports what was measured, then fails on anything that has to be looked at.
    fn finish(self, elapsed: std::time::Duration) {
        self.tally.report("field values", elapsed);
        println!(
            "field values that change the picture: {}; that cannot: {} \
             ({} proved identical in everything the compositor draws, {} reviewed)",
            self.visible,
            self.invisible.len(),
            self.proved,
            self.invisible.len() - self.proved,
        );
        assert!(
            self.unexpected.is_empty(),
            "these settings reach the pipeline and no longer change the picture:\n  {}",
            self.unexpected.join("\n  ")
        );
        assert!(
            self.stale.is_empty(),
            "these settings are listed as unable to change the picture and now do:\n  {}",
            self.stale.join("\n  ")
        );
        assert!(
            self.refused.is_empty(),
            "these persisted field values validate but the pipeline will not render them:\n  {}",
            self.refused.join("\n  ")
        );
    }
}

/// Asserts a preset selection really covers every preset, every text and every shape.
///
/// The selection rule rotates texts and shapes across presets so the default run stays affordable,
/// and a rotation is exactly the kind of arithmetic that silently stops covering something when the
/// counts change. This turns the coverage claim into an assertion.
fn assert_coverage(bench: &Bench, cases: &[Case]) {
    let mut texts: BTreeSet<&str> = BTreeSet::new();
    let mut shapes: BTreeSet<(&str, u16)> = BTreeSet::new();
    let mut presets: BTreeSet<&str> = BTreeSet::new();
    for case in cases {
        texts.insert(case.text.as_str());
        shapes.insert((case.resolution.as_str(), case.frame_rate));
        presets.insert(
            case.id
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .trim_start_matches("preset="),
        );
    }
    let expected_texts: BTreeSet<&str> = bench
        .matrix
        .texts
        .iter()
        .map(|entry| entry.text.as_str())
        .collect();
    let expected_shapes: BTreeSet<(&str, u16)> = bench
        .shapes
        .iter()
        .map(|shape| (shape.resolution.as_str(), shape.frame_rate))
        .collect();
    let expected_presets: BTreeSet<&str> = bench
        .matrix
        .presets
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    assert_eq!(
        presets, expected_presets,
        "a shipped preset was not rendered"
    );
    assert_eq!(texts, expected_texts, "a matrix text was not rendered");
    assert_eq!(
        shapes, expected_shapes,
        "a composable output shape was not rendered"
    );
    println!(
        "preset coverage: {} presets, {} texts, {} shapes over {} cases",
        presets.len(),
        texts.len(),
        shapes.len(),
        cases.len()
    );
}
