//! The validated, path-free render contract.
//!
//! The crate owns a deliberately small boundary: a request the `WebView` sends is validated here
//! against the source it names and becomes a [`RenderPlan`], which is the only shape the export
//! pipeline in `osg-export` accepts. Nothing in this crate opens a file, spawns a process or
//! touches a native path, so a contract refusal can never carry one.
//!
//! The raised recursion limit is for the contract's own test fixtures, which build one deeply
//! nested `serde_json::json!` request literal.

#![recursion_limit = "256"]

mod contract;
mod error;

pub use contract::{
    AnimationEasing, AnimationType, BorderStyle, CanvasBackgroundMode, CropSettings, FrameRate,
    GradientType, LineBreakBehavior, RenderLyric, RenderNarrationSource, RenderPlan, RenderRequest,
    RenderResolution, RenderSettings, RenderSubtitleSource, SubtitleCustomization,
    SubtitlePosition, TextAlign, TextTransform, ValidatedLyric,
};
pub use error::{RenderError, Result};
