//! The reviewed list of settings that reach the drawing and still cannot change the picture.
//!
//! Every field value the matrix carries is asserted to reach the conversion or the staged text
//! (`plans.rs`), then rendered and compared against the same case with the field back at its
//! default. Most of them change the picture. The ones that do not are sorted into two piles, and
//! the size of the second pile is the point:
//!
//! * **Proved.** The value left the conversion and everything the compositor draws from
//!   byte-identical, so the frame *must* be identical — `Staged::draws_the_same_as` says so and the
//!   sweep checks it. A wrap width a line never reaches, a wrap switch on a text with one line, a
//!   right-to-left switch on a text with no right-to-left cluster and a case transform on a script
//!   with no case all land here, on every text, with nobody maintaining a list of which.
//! * **Reviewed.** What is left: a value that really does reach the drawing and still cannot move a
//!   pixel. Those are listed below, one line each, with the reason.
//!
//! The list is an assertion in both directions: an entry that starts changing the picture fails the
//! gate as loudly as a value that stops changing it, because either one means somebody should look.
//! It is deliberately a table in source rather than a generated file. It is empty now that the
//! redundant `ease`/`ease-in-out` alias was corrected; a future exception must justify itself here.

/// One value that reaches the pipeline and leaves the probe frame alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Invisible {
    /// The persisted field.
    pub(crate) field: &'static str,
    /// The value, as `case::value_label` writes it.
    pub(crate) value: &'static str,
    /// Why this value cannot change the picture of the swept case.
    pub(crate) reason: &'static str,
}

/// The reviewed list.
pub(crate) const INVISIBLE: &[Invisible] = &[];

/// The reason this value is expected to leave the picture alone, when it is expected to.
pub(crate) fn expected_invisible(field: &str, value: &str) -> Option<&'static str> {
    INVISIBLE
        .iter()
        .find(|entry| entry.field == field && entry.value == value)
        .map(|entry| entry.reason)
}
