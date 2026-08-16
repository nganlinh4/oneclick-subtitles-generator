//! The glyph atlas descriptor arrives from the `WebView`, so it is treated as input, not as data the
//! baker vouches for.
//!
//! Every limit the baker exports is asserted against the baker's own source here, so the mirror
//! cannot drift silently, and every bound and agreement is asserted from the refusal side: a
//! descriptor that exists must be one the compositor can address without checking anything again.
//!
//! Split by what is being judged rather than by size: `support` builds a descriptor the baker could
//! really have emitted, `bounds` covers the limits and the wire shape, `agreement` covers the
//! fields only this side can re-derive, and `layout` covers the authoritative layout the compositor
//! draws from.

// `tests/glyph.rs` is this target's crate root, so a bare `mod` would look for a sibling in
// `tests/` — where `layout.rs` is already a different test target. The paths are explicit so the
// four files live together in `tests/glyph/` and collide with nothing.
#[path = "glyph/agreement.rs"]
mod agreement;
#[path = "glyph/bounds.rs"]
mod bounds;
#[path = "glyph/layout.rs"]
mod layout;
#[path = "glyph/support.rs"]
mod support;
