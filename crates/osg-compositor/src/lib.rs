//! The GPU half of the OSG native renderer: one compositor, fed by one glyph source.
//!
//! The accepted architecture (`docs/rewrite/NATIVE_RENDERER.md`) is a single Rust/GPU pixel pipeline
//! serving both the editor preview and the export, so there is never a second implementation of the
//! same maths. This crate is that pipeline. It takes a validated [`osg_scene::scene::Scene`], the
//! [`osg_scene::glyph::GlyphAtlasDescriptor`] the `WebView` baked, a resolved style and the staged
//! glyph runs, and composes any frame of that scene into tightly packed RGBA8 bytes.
//!
//! Four properties are structural rather than aspirational:
//!
//! - **Headless.** No window, no surface, no swapchain. Frames are composed into an offscreen
//!   texture and copied back to host memory.
//! - **Deterministic.** No RNG and no clock. Frame times come from the scene's exact rational
//!   timeline, the plan is a pure function of the scene and the frame index, and every GPU resource
//!   a frame touches is created and dropped inside that frame. Rendering frame `n` directly and
//!   rendering it after frames `0..n` produce the same bytes.
//! - **No text stack.** Shaping happens once, in the `WebView`. This crate places already-rasterized
//!   cells; it never measures, shapes or segments text, so preview and export cannot diverge on the
//!   one axis the migration exists to guarantee.
//! - **Fail-closed.** A missing adapter, an absurd size, an atlas baked from another face or a run
//!   that points outside the atlas is a typed [`CompositorError`], never a panic and never a
//!   silently degraded frame.
//!
//! All layout, animation, easing, cue-selection, scaling and colour maths lives in `osg-scene` and
//! is called from here, never re-derived.
//!
//! Everything a subtitle can be decorated with — the glow, the background box, its border, the drop
//! shadow, the glyph stroke and the gradient fill — is drawn here too, in the order `crate::plan`
//! fixes and documents. Two of those are blurs, and both go through one bounded separable Gaussian:
//! there is no second kernel and no `O(radius^2)` path anywhere in the crate.
//!
//! A frame may be composed on a transparent ground ([`Compositor::render_scene`]) or over a decoded
//! video frame ([`Compositor::render_scene_over`]). The underlay carries the crop, the flips and the
//! canvas backfill, because those are operations on the source frame and doing them in the same pass
//! as the subtitle layer is what keeps one pixel pipeline rather than two. The seam with the decoder
//! is a plain byte buffer — [`SourceFrame`] — so this crate depends on no decoder.
//!
//! The crate contains no `unsafe` code, in line with the workspace's `unsafe_code = "forbid"`.
//!
//! ```no_run
//! use osg_compositor::{Compositor, SubtitleScene};
//!
//! # fn main() -> Result<(), osg_compositor::CompositorError> {
//! # fn staged() -> SubtitleScene { unimplemented!() }
//! let compositor = Compositor::new()?;
//! let scene: SubtitleScene = staged();
//! let frame = compositor.render_scene(&scene, 0)?;
//! assert_eq!(frame.pixels().len() as u64, scene.size().rgba8_len());
//! # Ok(())
//! # }
//! ```

mod blur;
mod compositor;
mod crop;
mod decoration;
mod device;
mod error;
mod frame;
mod geometry;
mod glyphs;
mod masks;
mod pass;
mod plan;
mod quad_pipeline;
mod readback;
mod scene;
mod size;
mod style;
mod subtitle;
mod underlay;
mod underlay_pipeline;
mod underlay_resources;

pub use compositor::Compositor;
pub use crop::{
    CANVAS_BACKFILL_BRIGHTNESS, CANVAS_BACKFILL_ZOOM, CanvasBackground, Crop, CropSpec,
    DEFAULT_CANVAS_BLUR, MAX_CANVAS_BLUR_RADIUS, MAX_CANVAS_BLUR_SIGMA,
};
pub use decoration::{
    Border, BorderStyle, FillPaint, Glow, Gradient, MAX_DECORATION_BLUR_RADIUS,
    MAX_DECORATION_BLUR_SIGMA, Stroke, SubtitleDecoration, SubtitleDecorationSpec, TextShadow,
    decoration_blur_radius_px, decoration_blur_sigma_px,
};
pub use device::{AdapterProfile, AdapterSelection, DeviceKind};
pub use error::{Axis, CompositorError, Rejection};
pub use frame::Frame;
pub use scene::TestScene;
pub use size::{FrameSize, MAX_FRAME_DIMENSION, MAX_FRAME_PIXELS, MIN_FRAME_DIMENSION};
pub use style::{SubtitleStyle, SubtitleStyleSpec};
pub use subtitle::{CueRun, MAX_RUN_GLYPHS, MAX_RUN_LINES, SubtitleScene};
pub use underlay::{SourceFrame, VideoUnderlay};
