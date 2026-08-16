//! The frozen input: every shipped preset, every persisted option, every text, every output shape.
//!
//! `scripts/generate-parity-matrix.mjs` writes `tests/fixtures/parity-matrix.json` from the real
//! JavaScript modules — the preset definitions, the customization defaults and the parity ledger —
//! and `npm run test:parity-matrix` guards it. This module reads it and nothing else: the gate
//! never invents a preset, a field or a value of its own, so a preset added or a field renamed
//! reaches the gate through the generator instead of falling silently outside it.
//!
//! The file is embedded rather than read from disk, so nothing here can leak a filesystem path into
//! a failure and a missing fixture is a compile error rather than a skipped run. It is read through
//! `serde_json::Value` rather than derived types because the crate's test dependencies carry
//! `serde_json` and not `serde`, and a gate is not a reason to widen a dependency set.

use serde_json::Value;

/// The shape version this gate understands. A generator that changes the fixture's shape must bump
/// it, so a stale fixture fails loudly instead of quietly under-covering.
pub(crate) const SUPPORTED_VERSION: u64 = 1;

/// The arithmetic the generator computed, asserted here so nothing was skipped between the two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Coverage {
    pub(crate) presets: usize,
    pub(crate) subtitle_fields: usize,
    pub(crate) output_fields: usize,
    pub(crate) total_persisted_options: usize,
    pub(crate) texts: usize,
    pub(crate) outputs: usize,
    pub(crate) field_value_renders: usize,
}

/// One shipped preset, already merged against the defaults.
#[derive(Debug, Clone)]
pub(crate) struct PresetEntry {
    pub(crate) id: String,
    pub(crate) customization: Value,
}

/// One persisted subtitle field, its disposition and the values worth rendering.
#[derive(Debug, Clone)]
pub(crate) struct FieldEntry {
    pub(crate) field: String,
    pub(crate) disposition: String,
    pub(crate) default: Value,
    pub(crate) values: Vec<Value>,
}

impl FieldEntry {
    /// Whether the ledger says the native renderer draws this field.
    ///
    /// `fixed` counts: a deliberately corrected field is still one the renderer consumes, and the
    /// correction is recorded in the ledger rather than in the field's effect on the plan.
    pub(crate) fn is_drawn(&self) -> bool {
        self.disposition == "native" || self.disposition == "fixed"
    }

    /// Whether the ledger says this field is validated, persisted and deliberately without effect.
    pub(crate) fn is_inert(&self) -> bool {
        self.disposition == "inert"
    }

    /// The values that are not the default, which are the ones a sweep learns anything from.
    pub(crate) fn alternatives(&self) -> impl Iterator<Item = &Value> {
        self.values
            .iter()
            .filter(move |value| **value != self.default)
    }
}

/// One text worth rendering.
#[derive(Debug, Clone)]
pub(crate) struct TextEntry {
    pub(crate) id: String,
    pub(crate) text: String,
}

/// One output shape worth rendering.
#[derive(Debug, Clone)]
pub(crate) struct OutputEntry {
    pub(crate) id: String,
    pub(crate) resolution: String,
    pub(crate) frame_rate: u16,
}

/// The whole frozen matrix.
#[derive(Debug, Clone)]
pub(crate) struct ParityMatrix {
    pub(crate) coverage: Coverage,
    pub(crate) presets: Vec<PresetEntry>,
    pub(crate) field_matrix: Vec<FieldEntry>,
    pub(crate) output_fields: Vec<String>,
    pub(crate) texts: Vec<TextEntry>,
    pub(crate) outputs: Vec<OutputEntry>,
}

/// The fixture, embedded at compile time.
const FIXTURE: &str = include_str!("../fixtures/parity-matrix.json");

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value
        .get(key)
        .unwrap_or_else(|| panic!("the parity matrix carries no `{key}`"))
}

fn text_of(value: &Value, key: &str) -> String {
    field(value, key)
        .as_str()
        .unwrap_or_else(|| panic!("`{key}` is not a string"))
        .to_owned()
}

fn count_of(value: &Value, key: &str) -> usize {
    usize::try_from(
        field(value, key)
            .as_u64()
            .unwrap_or_else(|| panic!("`{key}` is not a count")),
    )
    .expect("a bounded count")
}

fn list_of<'a>(value: &'a Value, key: &str) -> &'a Vec<Value> {
    field(value, key)
        .as_array()
        .unwrap_or_else(|| panic!("`{key}` is not a list"))
}

/// Loads the frozen matrix and checks it against its own declared arithmetic.
///
/// # Panics
/// Panics when the fixture does not parse, carries a shape this gate does not understand, or does
/// not add up. Any of those means the gate would be covering less than it claims, which is the one
/// failure a coverage gate must never absorb.
pub(crate) fn load() -> ParityMatrix {
    let root: Value = serde_json::from_str(FIXTURE).expect("the generated parity matrix parses");
    assert_eq!(
        field(&root, "version").as_u64(),
        Some(SUPPORTED_VERSION),
        "the parity matrix was regenerated in a shape this gate does not understand"
    );
    let declared = field(&root, "coverage");
    let coverage = Coverage {
        presets: count_of(declared, "presets"),
        subtitle_fields: count_of(declared, "subtitleFields"),
        output_fields: count_of(declared, "outputFields"),
        total_persisted_options: count_of(declared, "totalPersistedOptions"),
        texts: count_of(declared, "texts"),
        outputs: count_of(declared, "outputs"),
        field_value_renders: count_of(declared, "fieldValueRenders"),
    };

    let presets: Vec<PresetEntry> = list_of(&root, "presets")
        .iter()
        .map(|entry| PresetEntry {
            id: text_of(entry, "id"),
            customization: field(entry, "customization").clone(),
        })
        .collect();
    let field_matrix: Vec<FieldEntry> = list_of(&root, "fieldMatrix")
        .iter()
        .map(|entry| FieldEntry {
            field: text_of(entry, "field"),
            disposition: text_of(entry, "disposition"),
            default: field(entry, "default").clone(),
            values: list_of(entry, "values").clone(),
        })
        .collect();
    let output_fields: Vec<String> = list_of(&root, "outputFields")
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .expect("an output field is a name")
                .to_owned()
        })
        .collect();
    let texts: Vec<TextEntry> = list_of(&root, "texts")
        .iter()
        .map(|entry| TextEntry {
            id: text_of(entry, "id"),
            text: text_of(entry, "text"),
        })
        .collect();
    let outputs: Vec<OutputEntry> = list_of(&root, "outputs")
        .iter()
        .map(|entry| OutputEntry {
            id: text_of(entry, "id"),
            resolution: text_of(entry, "resolution"),
            frame_rate: u16::try_from(count_of(entry, "frameRate")).expect("a supported rate"),
        })
        .collect();

    let matrix = ParityMatrix {
        coverage,
        presets,
        field_matrix,
        output_fields,
        texts,
        outputs,
    };
    check(&matrix);
    matrix
}

fn check(matrix: &ParityMatrix) {
    let coverage = matrix.coverage;
    assert_eq!(matrix.presets.len(), coverage.presets);
    assert_eq!(matrix.field_matrix.len(), coverage.subtitle_fields);
    assert_eq!(matrix.output_fields.len(), coverage.output_fields);
    assert_eq!(matrix.texts.len(), coverage.texts);
    assert_eq!(matrix.outputs.len(), coverage.outputs);
    assert_eq!(
        coverage.subtitle_fields + coverage.output_fields,
        coverage.total_persisted_options,
        "the persisted-option total is not the sum of its halves"
    );
    let renders: usize = matrix
        .field_matrix
        .iter()
        .map(|entry| entry.values.len())
        .sum();
    assert_eq!(
        renders, coverage.field_value_renders,
        "the field sweep does not cost what the fixture says it costs"
    );
    assert!(
        matrix
            .field_matrix
            .iter()
            .all(|entry| entry.values.first() == Some(&entry.default)),
        "every field must render its default first, or the value every project carries is untested"
    );
    assert!(
        matrix
            .field_matrix
            .iter()
            .all(|entry| entry.is_drawn() || entry.is_inert()),
        "a field reached the gate with no decided disposition"
    );
}

impl ParityMatrix {
    /// The text with this identity.
    pub(crate) fn text(&self, id: &str) -> &TextEntry {
        self.texts
            .iter()
            .find(|entry| entry.id == id)
            .expect("the matrix carries this text")
    }
}
