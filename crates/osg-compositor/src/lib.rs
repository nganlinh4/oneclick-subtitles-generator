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

mod compositor;
mod device;
mod error;
mod frame;
mod geometry;
mod quad_pipeline;
mod readback;
mod scene;
mod size;
mod style;
mod subtitle;

pub use compositor::Compositor;
pub use device::{AdapterProfile, AdapterSelection, DeviceKind};
pub use error::{Axis, CompositorError, Rejection};
pub use frame::Frame;
pub use scene::TestScene;
pub use size::{FrameSize, MAX_FRAME_DIMENSION, MAX_FRAME_PIXELS, MIN_FRAME_DIMENSION};
pub use style::{SubtitleStyle, SubtitleStyleSpec};
pub use subtitle::{CueRun, MAX_RUN_GLYPHS, MAX_RUN_LINES, SubtitleScene};
