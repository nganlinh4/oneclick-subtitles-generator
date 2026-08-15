//! Deterministic subtitle scene math for the OSG native renderer.
//!
//! This crate is the single source of the layout and animation maths that both the editor preview
//! and the export share. It is pure and free of I/O, RNG and clocks: every value is a function of
//! its inputs, so seeking is exact and a frame rendered at a timestamp is identical in both
//! surfaces and across runs.
//!
//! Behaviour is locked to the implementation being replaced by a generated golden fixture
//! (`tests/fixtures/subtitle-math-golden.json`), asserted from Rust here and from JavaScript in the
//! frontend suite. The fixture is generated from the shipped source, never hand-edited.

pub mod easing;
pub mod scale;
pub mod timeline;

pub use easing::{SUBTITLE_ANIMATION_EASINGS, apply_subtitle_animation_easing};
pub use scale::scale_subtitle_style_value;
pub use timeline::{ExactTime, FrameTimeline, TimelineError};
