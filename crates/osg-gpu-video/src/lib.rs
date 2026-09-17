//! One audited boundary for the native zero-copy export path.
//!
//! Media Foundation decodes into NV12 D3D11 surfaces. A D3D11 video processor applies the exact
//! visible aperture, colour description and correcting rotation into shared BGRA VRAM. The wgpu
//! compositor reads that surface and writes another shared BGRA surface; Media Foundation encodes
//! it through `MFCreateDXGISurfaceBuffer`. No frame-sized host allocation exists in this crate.

#[cfg(windows)]
mod d3d;
mod error;
#[cfg(windows)]
mod pipeline;
#[cfg(windows)]
mod processor;
#[cfg(windows)]
mod shared;

pub use error::{GpuVideoError, InteropStage, WorkerStage};
#[cfg(windows)]
pub use pipeline::GpuVideoPipeline;
