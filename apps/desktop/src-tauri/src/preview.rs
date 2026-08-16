//! The native side of the preview-frame boundary: one composited frame, delivered as an image.
//!
//! `src/platform/nativePreviewFrames.js` asks for one frame of a scene and expects back a URL its
//! `<img>` can load. This module is the receiving end.
//!
//! ## The rule this module exists to obey
//!
//! **Preview and export go through the same conversion.** `crates/osg-export/src/convert/` is the
//! single place every decision in `src/platform/renderParityLedger.js` is applied — the `trimStart`
//! rebase, the duration source, the output dimensions, the canvas ground, the whole style mapping.
//! Nothing here re-derives any of it. A preview frame is produced by:
//!
//! 1. probing the same source the export would open ([`osg_export::probe_source`]),
//! 2. validating the same [`osg_render::RenderRequest`] against it,
//! 3. converting it with [`osg_export::ExportPlan::convert`],
//! 4. composing the staged text with [`osg_export::ExportPlan::compose`], and
//! 5. drawing frame `index` of the resulting scene with `osg-compositor`.
//!
//! Steps 3 to 5 are exactly what an export runs per frame. If this module ever grows a scene
//! builder or a style mapper of its own, the divergence the migration exists to remove has been
//! rebuilt, so [`plan`] deliberately contains no arithmetic beyond the unit conversions
//! [`osg_export`] does not expose.
//!
//! ## Direction, and why a URL rather than bytes
//!
//! The content security policy is `connect-src 'self' ipc: http://ipc.localhost` with no
//! `wasm-unsafe-eval` and no `blob:`, so the `WebView` cannot fetch or stream a native frame. It
//! *can* load `http://127.0.0.1:*` as an image. A frame therefore reaches the editor as an ordinary
//! element load from the loopback capability in `crates/osg-media-server`, addressed by an opaque
//! identifier and two credentials. No frame bytes cross the command boundary and no filesystem path
//! is constructed, stored or returned.
//!
//! ## Premultiplied in, straight out
//!
//! [`osg_compositor::Frame`] is premultiplied, because that is what compositing needs. `PNG` alpha
//! is straight by specification. Writing the premultiplied bytes into the file unchanged darkens
//! exactly the antialiased glyph edges and the fading cues — the preview would show crunchy,
//! dark-fringed text where the export shows none. [`image`] converts once, through
//! [`osg_compositor::Frame::to_straight_alpha`], and a test asserts an antialiased edge survives it.
//!
//! ## What is bounded, and what is released
//!
//! Renders in flight, frames retained, bytes retained and the size of any one frame are all
//! bounded; the retained frames evict least-recently-used. Every published frame holds a
//! [`publish::FrameLease`] over its capability entry, and the lease releases **exactly once** —
//! whether it is superseded, evicted, invalidated by a stale generation or dropped on teardown.
//! Releasing zero times leaves the registry to evict blindly; releasing twice would revoke a
//! capability another render had since been granted.
//!
//! ## Staleness
//!
//! Every frame is bound to the project, the media, the scene revision and the renderer generation
//! it was rendered for ([`publish::PreviewBinding`]). A render that finishes after an edit, a
//! project switch or a device loss finds the binding it was issued under is no longer current, and
//! its frame is released rather than shown.

use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) mod command;
pub(crate) mod host;
mod image;
mod plan;
mod publish;
mod refusal;
mod request;

/// The only preview request shape this build reads, mirroring `NATIVE_PREVIEW_SCENE_VERSION`.
///
/// An unknown version is refused whole rather than migrated: a field's meaning is defined by its
/// version, so reading one out of an unknown request is guessing.
const PREVIEW_SCHEMA_VERSION: u32 = 1;

/// Renders allowed to run at once.
///
/// The compositor is serialised behind one device, so this bounds how many callers may be waiting
/// on it before the next one is refused rather than queued. It mirrors
/// `NATIVE_PREVIEW_LIMITS.maxInFlight`, which is what the `WebView` will actually dispatch.
const MAX_RENDERS_IN_FLIGHT: usize = 2;

/// Published frames retained at once.
///
/// Below the frame server's own `MAX_FRAME_SEQUENCES`, so this bound is what evicts rather than the
/// transport's, and a URL the `WebView` still holds is released by an owner that knows it did.
const MAX_RETAINED_FRAMES: usize = 6;

/// Encoded bytes retained across every published preview frame.
const MAX_RETAINED_BYTES: usize = 24 * 1024 * 1024;

/// The largest encoded frame this boundary publishes.
///
/// At or below the frame server's own per-frame bound, so a frame that passes here is one the
/// transport will accept rather than one that fails after a render has already been spent.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// The image type preview frames are published as.
///
/// `PNG` because it is lossless and carries straight alpha; a preview that had been through a lossy
/// encoder could not be compared with an export frame at all.
const PREVIEW_MIME_TYPE: &str = "image/png";

/// The longest opaque revision or content-hash string a request may carry.
const MAX_IDENTITY_BYTES: usize = 128;

/// One frame always fits the retained-byte budget, so eviction never has to refuse a rendered frame.
const _: () = assert!(MAX_FRAME_BYTES <= MAX_RETAINED_BYTES);

/// A monotonic renderer generation.
///
/// A counter rather than a clock, so the ordering is total, reproducible and free of any dependence
/// on wall time — the determinism rule applies here as much as it does to the pixels.
#[derive(Debug, Default)]
pub(crate) struct GenerationCounter(AtomicU64);

impl GenerationCounter {
    /// The generation in force now.
    pub(crate) fn current(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }

    /// Retires every outstanding generation and returns the new one.
    pub(crate) fn advance(&self) -> u64 {
        self.0.fetch_add(1, Ordering::AcqRel) + 1
    }
}

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;
