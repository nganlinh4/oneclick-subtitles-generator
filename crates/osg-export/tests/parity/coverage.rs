//! Whether a sweep really covered what it says it covered.
//!
//! Both sweeps in this gate keep the default run affordable by **rotating**: preset `i` takes text
//! `i % texts` and shape `i % shapes`, and each field value takes the next text and the next shape.
//! A rotation is exactly the kind of arithmetic that silently stops covering something when a count
//! changes — nine texts against thirty presets covers all nine, and against twenty-seven presets it
//! would still look fine and cover all nine, and against twelve it would cover four and say nothing.
//!
//! So the coverage claim is an assertion rather than a comment in both places, and it names what was
//! missed rather than only that something was.

use std::collections::BTreeSet;

use super::case::Case;
use super::matrix::{OutputEntry, ParityMatrix};
use super::sweep::FieldCase;

/// Asserts a preset selection really covers every preset, every text and every shape.
///
/// The selection rule rotates texts and shapes across presets so the default run stays affordable,
/// and a rotation is exactly the kind of arithmetic that silently stops covering something when the
/// counts change. This turns the coverage claim into an assertion.
pub(crate) fn assert_preset_coverage(
    matrix: &ParityMatrix,
    shapes: &[OutputEntry],
    cases: &[Case],
) {
    let presets: BTreeSet<&str> = cases
        .iter()
        .map(|case| {
            case.id
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .trim_start_matches("preset=")
        })
        .collect();
    let expected: BTreeSet<&str> = matrix
        .presets
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();
    assert_eq!(presets, expected, "a shipped preset was not rendered");
    let (texts, shape_count) = assert_texts_and_shapes(matrix, shapes, cases, "preset");
    println!(
        "preset coverage: {} presets, {texts} texts, {shape_count} shapes over {} cases",
        presets.len(),
        cases.len()
    );
}

/// The same for the field sweep, which rotates the texts across values rather than across presets.
///
/// Asserted for the same reason and against the same rotation hazard, and it is the assertion that
/// stops the sweep sliding back to composing every value against one script.
pub(crate) fn assert_field_coverage(
    matrix: &ParityMatrix,
    shapes: &[OutputEntry],
    cases: &[FieldCase],
) {
    let rendered: Vec<Case> = cases.iter().map(|entry| entry.case.clone()).collect();
    let fields: BTreeSet<&str> = cases.iter().map(|entry| entry.field.as_str()).collect();
    let expected: BTreeSet<&str> = matrix
        .field_matrix
        .iter()
        .map(|entry| entry.field.as_str())
        .collect();
    assert_eq!(fields, expected, "a persisted option was not rendered");
    let (texts, shape_count) = assert_texts_and_shapes(matrix, shapes, &rendered, "field-value");
    println!(
        "field-value coverage: {} fields, {texts} texts, {shape_count} shapes over {} cases",
        fields.len(),
        cases.len()
    );
}

/// Asserts a selection covered every matrix text and every composable shape.
fn assert_texts_and_shapes(
    matrix: &ParityMatrix,
    shapes: &[OutputEntry],
    cases: &[Case],
    what: &str,
) -> (usize, usize) {
    let texts: BTreeSet<&str> = cases.iter().map(|case| case.text.as_str()).collect();
    let seen: BTreeSet<(&str, u16)> = cases
        .iter()
        .map(|case| (case.resolution.as_str(), case.frame_rate))
        .collect();
    let expected_texts: BTreeSet<&str> = matrix
        .texts
        .iter()
        .map(|entry| entry.text.as_str())
        .collect();
    let expected_shapes: BTreeSet<(&str, u16)> = shapes
        .iter()
        .map(|shape| (shape.resolution.as_str(), shape.frame_rate))
        .collect();
    assert_eq!(
        texts, expected_texts,
        "the {what} sweep did not render every matrix text"
    );
    assert_eq!(
        seen, expected_shapes,
        "the {what} sweep did not render every composable output shape"
    );
    (texts.len(), seen.len())
}
