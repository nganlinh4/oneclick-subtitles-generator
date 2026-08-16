//! The managed preview host: one device, one generation, one bounded set of live frames.
//!
//! Everything that must be shared between preview requests lives here, and everything it holds is
//! bounded. The compositor is created once and reused, because acquiring a device per frame would
//! make scrubbing unusable; it is thrown away and re-acquired only when the device is lost, which
//! is also the moment every frame rendered on it stops being trustworthy.

use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

use osg_compositor::{AdapterSelection, Compositor, Frame};

use super::plan::PreviewComposition;
use super::publish::{FrameLease, PreviewBinding, PublishedFrames};
use super::refusal::PreviewRefusal;
use super::request::{PreviewFrameResponse, PreviewLayer};
use super::{
    GenerationCounter, MAX_FRAME_BYTES, MAX_RENDERS_IN_FLIGHT, MAX_RETAINED_BYTES,
    MAX_RETAINED_FRAMES, PREVIEW_MIME_TYPE, image,
};

/// The generation a render was issued under, and what it was issued for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreviewTicket {
    binding: PreviewBinding,
    generation: u64,
}

/// The shared state behind `preview_frame_render`.
pub(crate) struct PreviewHost {
    /// Held across a render, so the device serialises rather than being asked for two frames at
    /// once. `None` means no device has been acquired yet, or the last one was lost.
    compositor: Mutex<Option<Compositor>>,
    /// Which adapters may be acquired. Restricted only by tests, which need the no-device path.
    adapters: AdapterSelection,
    in_flight: AtomicUsize,
    max_in_flight: usize,
    generation: GenerationCounter,
    /// What the current generation is for. `None` before the first render.
    binding: Mutex<Option<PreviewBinding>>,
    frames: PublishedFrames,
}

impl fmt::Debug for PreviewHost {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreviewHost")
            .field("generation", &self.generation.current())
            .field("in_flight", &self.in_flight.load(Ordering::Acquire))
            .field("frames", &self.frames)
            .finish_non_exhaustive()
    }
}

impl Default for PreviewHost {
    fn default() -> Self {
        Self::with_limits(
            AdapterSelection::Automatic,
            MAX_RENDERS_IN_FLIGHT,
            MAX_RETAINED_FRAMES,
            MAX_RETAINED_BYTES,
        )
    }
}

impl PreviewHost {
    /// Creates the host with explicit bounds and adapter selection.
    pub(crate) fn with_limits(
        adapters: AdapterSelection,
        max_in_flight: usize,
        max_frames: usize,
        max_bytes: usize,
    ) -> Self {
        Self {
            compositor: Mutex::new(None),
            adapters,
            in_flight: AtomicUsize::new(0),
            max_in_flight,
            generation: GenerationCounter::default(),
            binding: Mutex::new(None),
            frames: PublishedFrames::with_limits(max_frames, max_bytes),
        }
    }

    /// The published-frame registry, for the bounds and release assertions.
    #[cfg(test)]
    pub(crate) const fn frames(&self) -> &PublishedFrames {
        &self.frames
    }

    /// The generation in force now.
    #[cfg(test)]
    pub(crate) fn generation(&self) -> u64 {
        self.generation.current()
    }

    /// Claims the generation this render belongs to, advancing it when the binding has moved.
    ///
    /// This is the one place a project switch, a media change or an edit is noticed. Advancing
    /// retires every frame rendered under the previous binding, so a URL the editor is still
    /// holding stops resolving as soon as the thing it described stopped being current — rather
    /// than at some later eviction the editor cannot correlate with anything.
    pub(crate) fn claim(&self, binding: PreviewBinding) -> Result<PreviewTicket, PreviewRefusal> {
        let mut current = self
            .binding
            .lock()
            .map_err(|_| PreviewRefusal::Unavailable)?;
        let generation = if current.as_ref() == Some(&binding) {
            self.generation.current()
        } else {
            let advanced = self.generation.advance();
            *current = Some(binding.clone());
            advanced
        };
        drop(current);
        self.frames.retire_others(&binding, generation);
        Ok(PreviewTicket {
            binding,
            generation,
        })
    }

    /// Whether a ticket still describes what the editor is asking for.
    pub(crate) fn is_current(&self, ticket: &PreviewTicket) -> bool {
        if self.generation.current() != ticket.generation {
            return false;
        }
        self.binding
            .lock()
            .is_ok_and(|binding| binding.as_ref() == Some(&ticket.binding))
    }

    /// Retires everything: the device's frames stop being current and the capabilities are given up.
    ///
    /// Used on a lost device and on teardown. Idempotent, and every lease it drops is released
    /// exactly once by [`FrameLease`]'s own rule.
    pub(crate) fn invalidate(&self) {
        self.generation.advance();
        if let Ok(mut binding) = self.binding.lock() {
            *binding = None;
        }
        self.frames.retire_all();
    }

    /// Composes one frame of a composition, bounded by how many renders may already be running.
    ///
    /// A lost device is not retried here: the compositor is dropped so the next request acquires a
    /// fresh one, every frame rendered on the dead device is retired, and the caller is told the
    /// device was lost rather than being handed a frame from a device that is not the one the rest
    /// of the session used.
    ///
    /// # What this draws, and what it does not
    ///
    /// [`Compositor::render_scene`] is the subtitle pass on a fully transparent ground: an area no
    /// cue covers comes back `0,0,0,0`. That is exactly [`PreviewLayer::Subtitles`].
    ///
    /// [`PreviewLayer::Composited`] is *defined* as the whole frame — the decoded source, cropped,
    /// flipped and backfilled, with the pass blended over it by
    /// [`Compositor::render_scene_over`] — but this host has no decoded source frame to hand it, so
    /// today both layers are this one call and come back byte-identical. That gap is asserted, with
    /// measured pixels, by `the_composited_layer_has_no_video_ground_yet`, so it cannot be mistaken
    /// for the guarantee `docs/rewrite/NATIVE_RENDERER.md` describes. Closing it means giving this
    /// host a decoder, not changing what [`PreviewLayer::Subtitles`] means.
    pub(crate) fn compose(
        &self,
        composition: &PreviewComposition,
        frame_index: u32,
    ) -> Result<Frame, PreviewRefusal> {
        if frame_index >= composition.frame_count() {
            return Err(PreviewRefusal::UnsupportedRequest);
        }
        let _permit = RenderPermit::claim(&self.in_flight, self.max_in_flight)?;
        let mut held = match self.acquire() {
            Ok(held) => held,
            Err(refusal) => return Err(self.after(refusal)),
        };
        let compositor = held.as_ref().ok_or(PreviewRefusal::DeviceLost)?;
        match compositor.render_scene(composition.scene(), frame_index) {
            Ok(frame) => Ok(frame),
            Err(error) => {
                let refusal = PreviewRefusal::from(error);
                if refusal == PreviewRefusal::DeviceLost {
                    // Thrown away rather than reused: the next request acquires a fresh device, and
                    // the guard is released before the generation is retired so the two locks are
                    // never held at once.
                    *held = None;
                }
                drop(held);
                Err(self.after(refusal))
            }
        }
    }

    /// Retires everything when the refusal means the device is gone, and returns it either way.
    fn after(&self, refusal: PreviewRefusal) -> PreviewRefusal {
        if refusal == PreviewRefusal::DeviceLost {
            self.invalidate();
        }
        refusal
    }

    /// Encodes, publishes and retains one composed frame, or releases it as stale.
    ///
    /// The staleness check happens *after* the frame exists and before its URL is handed back,
    /// because that is the window that actually exists: the edit or the project switch lands while
    /// the GPU is busy. It is asked exactly once, inside the retention lock, so there is no second
    /// window between deciding and retaining — and a frame that lost its race is released by the
    /// lease it is still holding rather than retained for a binding nobody is asking about.
    pub(crate) fn publish(
        &self,
        server: &osg_media_server::MediaServer,
        ticket: &PreviewTicket,
        frame: &Frame,
        frame_index: u32,
        layer: PreviewLayer,
    ) -> Result<PreviewFrameResponse, PreviewRefusal> {
        let encoded = image::encode_png(frame)?;
        let bytes = encoded.len();
        debug_assert!(bytes <= MAX_FRAME_BYTES, "encode_png enforces the bound");
        let lease =
            FrameLease::publish(server, PREVIEW_MIME_TYPE, encoded, self.frames.releases())?;
        let sequence_id = lease.sequence_id();
        let frame_url = lease
            .frame_url()
            .ok_or(PreviewRefusal::FrameUnpublishable)?;

        // The URL above never leaves this function unless the frame is admitted, so nothing can
        // load an image that was already stale when it was made.
        self.frames.retain(
            ticket.binding.clone(),
            ticket.generation,
            bytes,
            lease,
            &|| self.is_current(ticket),
        )?;
        Ok(PreviewFrameResponse {
            sequence_id,
            frame_url,
            frame_index,
            width_px: frame.width(),
            height_px: frame.height(),
            mime_type: PREVIEW_MIME_TYPE.to_owned(),
            layer,
        })
    }

    /// Returns the held device, acquiring one if there is none.
    fn acquire(&self) -> Result<MutexGuard<'_, Option<Compositor>>, PreviewRefusal> {
        let mut held = self
            .compositor
            .lock()
            .map_err(|_| PreviewRefusal::Unavailable)?;
        if held.is_none() {
            *held = Some(Compositor::with_adapters(self.adapters)?);
        }
        Ok(held)
    }
}

/// One in-flight render, counted for as long as it is running.
struct RenderPermit<'host> {
    in_flight: &'host AtomicUsize,
}

impl fmt::Debug for RenderPermit<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RenderPermit")
            .field("in_flight", &self.in_flight.load(Ordering::Acquire))
            .finish()
    }
}

impl<'host> RenderPermit<'host> {
    /// Takes a slot, or refuses when the bound is already reached.
    ///
    /// A compare-and-exchange loop rather than a fetch-add-then-check, so the count can never
    /// momentarily exceed the bound and a refusal never has to undo an increment.
    fn claim(in_flight: &'host AtomicUsize, max: usize) -> Result<Self, PreviewRefusal> {
        let mut running = in_flight.load(Ordering::Acquire);
        loop {
            if running >= max {
                return Err(PreviewRefusal::Busy);
            }
            match in_flight.compare_exchange_weak(
                running,
                running + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(Self { in_flight }),
                Err(observed) => running = observed,
            }
        }
    }
}

impl Drop for RenderPermit<'_> {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(1, Ordering::AcqRel);
    }
}
