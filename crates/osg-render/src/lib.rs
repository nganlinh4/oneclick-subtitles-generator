//! Native Remotion rendering without a WebView-facing HTTP control plane.
//!
//! The crate owns a deliberately small boundary: a validated, path-free render
//! contract enters from the application; trusted native paths enter separately;
//! one supervised worker produces a staged MP4. Nothing in this crate is a
//! general process runner or accepts executable arguments from the `WebView`.

#![recursion_limit = "256"]

mod contract;
mod engine;
mod error;
mod protocol;
mod runtime;

pub use contract::{
    AnimationEasing, AnimationType, BorderStyle, CanvasBackgroundMode, CropSettings, FrameRate,
    GradientType, LineBreakBehavior, RenderLyric, RenderPlan, RenderRequest, RenderResolution,
    RenderSettings, SubtitleCustomization, SubtitlePosition, TextAlign, TextTransform,
    ValidatedLyric,
};
pub use engine::{
    NativeRenderInputs, PreparedRender, RenderCancellationToken, RenderEngine, RenderPhase,
    RenderProgress, RenderProgressSink, RenderRunControl,
};
pub use error::{RenderError, Result};
pub use protocol::{
    MAX_PROTOCOL_FRAME_BYTES, PROTOCOL_VERSION, WorkerMessage, WorkerRenderRequest,
};
pub use runtime::{
    REMOTION_VERSION, RenderRuntime, RenderRuntimeManifest, RuntimeFile, RuntimeStatus,
};
