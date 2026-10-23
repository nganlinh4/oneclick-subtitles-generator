//! Bounds-checked parsing of the few binary formats OSG inspects itself: WAV headers and image
//! signatures. Every function is total over arbitrary input; malformed bytes yield an error or
//! `false`, never a panic.

pub mod image;
pub mod wav;

/// Whether `bytes` is a RIFF container of the given four-byte form type.
fn is_riff_form(bytes: &[u8], form: [u8; 4]) -> bool {
    bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(form.as_slice())
}
