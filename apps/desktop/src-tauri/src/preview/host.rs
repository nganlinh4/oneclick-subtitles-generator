//! The managed preview host: one device, one generation, one bounded set of live frames.
//!
//! Everything that must be shared between preview requests lives here, and everything it holds is
//! bounded. The compositor is created once and reused, because acquiring a device per frame would
//! make scrubbing unusable; it is thrown away and re-acquired only when the device is lost, which
//! is also the moment every frame rendered on it stops being trustworthy.

use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

use osg_compositor::{AdapterSelection, Compositor, Frame, VideoUnderlay};
use osg_decode::DecoderConfig;
use osg_domain::AssetId;

use super::plan::PreviewComposition;
use super::publish::{FrameLease, PreviewBinding, PublishedFrames};
use super::refusal::PreviewRefusal;
use super::request::{PreviewFrameResponse, PreviewLayer};
use super::source::SourceDecoders;
use super::{
    GenerationCounter, MAX_FRAME_BYTES, MAX_RENDERS_IN_FLIGHT, MAX_RETAINED_BYTES,
    MAX_RETAINED_FRAMES, PREVIEW_MIME_TYPE, image,
};

/// What a frame is composed on.
///
/// The two layers a request may ask for are exactly these two grounds, and
/// [`Self::for_layer`] is the only place that mapping is made — exhaustively, so a third layer is a
/// compile error here rather than a picture nobody chose.
#[derive(Clone, Copy)]
pub(crate) enum PreviewGround<'source> {
    /// A fully transparent ground: the subtitle pass alone, for the `WebView` to blend over its own
    /// `<video>` during continuous playback.
    Transparent,
    /// The decoded source frame, cropped, flipped and backfilled — the frame the export writes.
    DecodedSource {
        /// The media the frame is decoded from, which is also what the held decoder answers for.
        asset_id: AssetId,
        /// Where that media is. Used to open the source and never retained, stored or returned.
        path: &'source Path,
    },
}

impl fmt::Debug for PreviewGround<'_> {
    /// Redacted: the path is the user's filesystem and this boundary never renders one.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transparent => formatter.write_str("Transparent"),
            Self::DecodedSource { asset_id, .. } => formatter
                .debug_struct("DecodedSource")
                .field("asset_id", asset_id)
                .finish_non_exhaustive(),
        }
    }
}

impl<'source> PreviewGround<'source> {
    /// The ground a layer is defined as.
    pub(crate) const fn for_layer(
        layer: PreviewLayer,
        asset_id: AssetId,
        path: &'source Path,
    ) -> Self {
        match layer {
            PreviewLayer::Composited => Self::DecodedSource { asset_id, path },
            // The playback overlay, and it must stay one: giving it a video underlay would make the
            // `WebView` blend the source frame over its own `<video>` a second time.
            PreviewLayer::Subtitles => Self::Transparent,
        }
    }
}

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
    /// The one open source decoder, reused across a scrub and reopened only when the media or the
    /// output timeline changes.
    decoders: SourceDecoders,
}

impl fmt::Debug for PreviewHost {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreviewHost")
            .field("generation", &self.generation.current())
            .field("in_flight", &self.in_flight.load(Ordering::Acquire))
            .field("frames", &self.frames)
            .field("decoders", &self.decoders)
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
            decoders: SourceDecoders::default(),
        }
    }

    /// The published-frame registry, for the bounds and release assertions.
    #[cfg(test)]
    pub(crate) const fn frames(&self) -> &PublishedFrames {
        &self.frames
    }

    /// The held decoder, for the assertions about reuse and about what it had to do.
    #[cfg(test)]
    pub(crate) const fn decoders(&self) -> &SourceDecoders {
        &self.decoders
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
        self.claim_interrupted(binding, &|| ())
    }

    /// [`Self::claim`], with the window between the compare-and-advance and the retire opened.
    ///
    /// The compare-and-advance is atomic under the binding lock, but the retire that follows it
    /// cannot be: [`PublishedFrames::retain`] takes the retention lock and asks its admission
    /// question under it, and that question takes the binding lock, so a claim holding the binding
    /// lock across the retire would invert the two orders into a deadlock. The retire is therefore
    /// ordered against the claim by *generation* instead of by exclusion — see
    /// [`PublishedFrames::retire_superseded`] — which is order-independent and needs no second lock.
    ///
    /// `interrupted` is the preemption point that makes the interleaving reachable on purpose: with
    /// `MAX_RENDERS_IN_FLIGHT` above one, a second claim can land here in full, and a test drives it
    /// through this hook rather than racing two threads and hoping to hit the window.
    pub(crate) fn claim_interrupted(
        &self,
        binding: PreviewBinding,
        interrupted: &dyn Fn(),
    ) -> Result<PreviewTicket, PreviewRefusal> {
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
        interrupted();
        self.frames.retire_superseded(&binding, generation);
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
        // The decoder is given up too, so teardown really does release the source file rather than
        // holding it open for a session that has ended.
        self.decoders.close();
    }

    /// Composes one frame of a composition, bounded by how many renders may already be running.
    ///
    /// A lost device is not retried here: the compositor is dropped so the next request acquires a
    /// fresh one, every frame rendered on the dead device is retired, and the caller is told the
    /// device was lost rather than being handed a frame from a device that is not the one the rest
    /// of the session used.
    ///
    /// # What each ground draws
    ///
    /// [`PreviewGround::Transparent`] is [`Compositor::render_scene`]: the subtitle pass on a fully
    /// transparent ground, so an area no cue covers comes back `0,0,0,0`. That is exactly
    /// [`PreviewLayer::Subtitles`], and it must stay that way — it is the layer the `WebView` lays
    /// over its own `<video>`.
    ///
    /// [`PreviewGround::DecodedSource`] is [`Compositor::render_scene_over`]: the source frame the
    /// converted timeline names for this output frame, with the conversion's crop, flips and canvas
    /// backfill, and the same pass blended over it in the same GPU pass. That is the frame the
    /// export writes, which is the whole point of [`PreviewLayer::Composited`] — a user deciding
    /// whether the output looks right is looking at the output.
    ///
    /// The source is decoded **before** the device is taken and the decoder's lock is released
    /// before the compositor's is acquired, so the two are never held at once and a slow decode does
    /// not hold the GPU.
    pub(crate) fn compose(
        &self,
        composition: &PreviewComposition,
        frame_index: u32,
        ground: PreviewGround<'_>,
    ) -> Result<Frame, PreviewRefusal> {
        if frame_index >= composition.frame_count() {
            return Err(PreviewRefusal::UnsupportedRequest);
        }
        let _permit = RenderPermit::claim(&self.in_flight, self.max_in_flight)?;
        let underlay = self.decode(composition, frame_index, ground)?;
        let mut held = match self.acquire() {
            Ok(held) => held,
            Err(refusal) => return Err(self.after(refusal)),
        };
        let compositor = held.as_ref().ok_or(PreviewRefusal::DeviceLost)?;
        let composed = match underlay.as_ref() {
            Some(underlay) => {
                compositor.render_scene_over(composition.scene(), underlay, frame_index)
            }
            None => compositor.render_scene(composition.scene(), frame_index),
        };
        match composed {
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

    /// Decodes the source frame this output frame shows, or nothing for a transparent ground.
    ///
    /// The decoder is asked for the **output** frame index, not for a time or a source frame: the
    /// configuration carries the conversion's own source timeline, so the trim offset and the
    /// output frame rate are already in the question and `osg-decode` resolves it to an exact
    /// instant and walks to the sample covering it. A seek is a starting point there, never an
    /// answer.
    fn decode(
        &self,
        composition: &PreviewComposition,
        frame_index: u32,
        ground: PreviewGround<'_>,
    ) -> Result<Option<VideoUnderlay>, PreviewRefusal> {
        let PreviewGround::DecodedSource { asset_id, path } = ground else {
            return Ok(None);
        };
        let config = DecoderConfig::new(composition.source_timeline());
        let decoded = self.decoders.frame(asset_id, path, config, frame_index)?;
        Ok(Some(decoded.underlay(composition.crop())?))
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
