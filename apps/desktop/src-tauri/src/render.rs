//! The native video export: a `WebView` request in, a durable, playable `MP4` out.
//!
//! # What changed, and what deliberately did not
//!
//! The engine under `render_start` is now [`osg_export`], the crate that decodes the source through
//! the operating system's own codecs, composites each frame with `osg-compositor` — the same
//! compositor the preview draws with, from the same staged glyph atlas — and encodes and muxes
//! through Media Foundation. Nothing this command does at run time reaches the managed Remotion
//! worker, its runtime manifest, its staging or its readiness checks. That code is still in the
//! tree, still driven by the settings surface in `crate::render_packages`, and deleting it is a
//! separate step that is much smaller now that nothing depends on it running.
//!
//! The command contract did not change. `render_start` takes the same `RenderRequest` and emits the
//! same `RenderEvent` shapes, because `src/platform/renderService.js` validates every one of them
//! field by field and treats anything else as a protocol error. The one addition is an **optional**
//! `text` argument carrying the staged glyphs, which an absent field deserializes to `None`, so the
//! payload the current frontend sends still arrives intact and is refused in typed terms rather than
//! failing to deserialize.
//!
//! # Why an export cannot draw without that argument
//!
//! Text is shaped and rasterized once, by the `WebView`, into an atlas that is staged to Rust; there
//! is no Rust text stack and there will not be one, because a second shaping engine is exactly the
//! divergence between preview and export the migration exists to remove. An export therefore needs
//! the atlas the editor baked and one laid-out run per cue. It never picks an atlas by scanning the
//! registry for something plausible: an export that drew with a different atlas than the preview
//! showed would be the failure this pipeline was built to make impossible, so a request that does
//! not name one is refused. See [`text`] for the shape and the reasoning.
//!
//! # Layout
//!
//! * [`command`] — the four `WebView` entry points and the order their failures happen in.
//! * [`prepare`] — everything decidable before a job exists.
//! * [`text`] — where an export's glyphs come from.
//! * [`export`] — the engine: request and staged text to a finished file.
//! * [`progress`] — the bounded, monotonic report stream.
//! * [`publish`] — finished file to durable artifact, running job to terminal job.
//! * [`manifest`] — the durable record, re-checked against the artifact store on every read.
//! * [`events`] — the shapes the `WebView` has frozen.
//! * [`refusal`] — why an export refused, in a vocabulary that carries nothing private.
//! * [`host`] — the concurrency bound, the staging root, the playback registry, and the managed
//!   payload machinery that is no longer on this path.

mod command;
mod events;
mod export;
mod host;
mod manifest;
mod prepare;
mod progress;
mod publish;
mod refusal;
mod text;

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;

pub(crate) use command::{
    render_playback_release, render_result, render_runtime_status, render_start,
};
pub(crate) use host::RenderRuntimeHost;
