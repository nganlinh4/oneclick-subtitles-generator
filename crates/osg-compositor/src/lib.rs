//! Headless GPU composition foundation for the OSG native renderer.
//!
//! This crate is the pixel half of the accepted native-renderer architecture: one Rust/GPU
//! compositor serving both the editor preview and the export, so there is never a second
//! implementation of the same maths. It owns device acquisition, offscreen composition and
//! readback. It is the foundation only — the scene DTO, the glyph atlas and the frame transport
//! land on top of it.
//!
//! Three properties are structural rather than aspirational:
//!
//! - **Headless.** No window, no surface, no swapchain. Frames are composed into an offscreen
//!   texture and copied back to host memory.
//! - **Deterministic.** No RNG and no clock. Every pixel is a function of the frame size and the
//!   caller-supplied phase, so seeking is exact and repeatable.
//! - **Fail-closed.** A missing adapter, an absurd size or a failed readback is a typed
//!   [`CompositorError`], never a panic and never a silently degraded frame.
//!
//! The crate contains no `unsafe` code, in line with the workspace's `unsafe_code = "forbid"`.
//!
//! ```no_run
//! use osg_compositor::{Compositor, FrameSize, TestScene};
//!
//! # fn main() -> Result<(), osg_compositor::CompositorError> {
//! let compositor = Compositor::new()?;
//! let frame = compositor.render(TestScene::origin(), FrameSize::new(1920, 1080)?)?;
//! assert_eq!(frame.pixels().len(), 1920 * 1080 * 4);
//! # Ok(())
//! # }
//! ```

mod compositor;
mod device;
mod error;
mod frame;
mod readback;
mod scene;
mod size;

pub use compositor::Compositor;
pub use device::{AdapterProfile, AdapterSelection, DeviceKind};
pub use error::{Axis, CompositorError};
pub use frame::Frame;
pub use scene::TestScene;
pub use size::{FrameSize, MAX_FRAME_DIMENSION, MAX_FRAME_PIXELS, MIN_FRAME_DIMENSION};
