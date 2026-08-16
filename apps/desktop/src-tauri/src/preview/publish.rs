//! Publishing a frame, binding it to what it was rendered for, and releasing it exactly once.
//!
//! A published frame owns a capability in `crates/osg-media-server`. That capability has to be
//! given up when the frame is superseded, evicted, invalidated or dropped — and given up *once*.
//! Zero releases leave the transport to evict blindly, so a URL the editor still holds stops
//! resolving for a reason no owner knows about. Two releases revoke by identifier, and identifiers
//! are reused by nothing here but could be, so the second release is a capability another render
//! was granted. [`FrameLease`] makes both impossible: the release is a single atomic swap, and
//! `Drop` performs whichever release the caller did not.

use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use osg_domain::{AssetId, ProjectId};
use osg_media_server::{MediaServer, RegisteredFrameSequence};

use super::refusal::PreviewRefusal;

/// What a frame was rendered for.
///
/// Any change to any part of it retires every frame rendered under the previous one: a project
/// switch, a different media asset, an edit that moves the scene revision, or a different staged
/// atlas all mean the pixels on screen no longer describe what the editor is showing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreviewBinding {
    /// The project the frame belongs to.
    pub(crate) project_id: ProjectId,
    /// The media the frame was composed over.
    pub(crate) source_asset_id: AssetId,
    /// The caller's identity for the scene, compared and never parsed.
    pub(crate) scene_revision: String,
    /// The staged atlas the glyphs came from.
    pub(crate) atlas_id: AssetId,
}

/// A published frame's capability, released exactly once.
pub(crate) struct FrameLease {
    server: MediaServer,
    sequence: RegisteredFrameSequence,
    released: AtomicBool,
    /// How many releases actually reached the transport. A test asserts this is one, never two and
    /// never zero, which is the whole property this type exists to hold.
    releases: Arc<AtomicUsize>,
}

impl fmt::Debug for FrameLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The registration token authorises revocation, so it is never rendered anywhere.
        formatter
            .debug_struct("FrameLease")
            .field("sequence_id", &self.sequence.id)
            .field("released", &self.released.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl FrameLease {
    /// Publishes one encoded frame and takes the capability it was published under.
    pub(crate) fn publish(
        server: &MediaServer,
        mime_type: &str,
        bytes: Vec<u8>,
        releases: &Arc<AtomicUsize>,
    ) -> Result<Self, PreviewRefusal> {
        let sequence = server
            .register_frame_sequence(mime_type, vec![bytes])
            .map_err(|_| PreviewRefusal::FrameUnpublishable)?;
        Ok(Self {
            server: server.clone(),
            sequence,
            released: AtomicBool::new(false),
            releases: Arc::clone(releases),
        })
    }

    /// The opaque capability identifier.
    pub(crate) const fn sequence_id(&self) -> uuid::Uuid {
        self.sequence.id
    }

    /// The element-loadable URL for the single frame this lease published.
    ///
    /// A preview publishes one image per capability, so the transport index is always zero; the
    /// scene's own frame index travels in the response beside it rather than in the path.
    pub(crate) fn frame_url(&self) -> Option<String> {
        self.sequence.frame_url(0)
    }

    /// Gives the capability up. Returns whether *this* call was the one that did it.
    pub(crate) fn release(&self) -> bool {
        if self.released.swap(true, Ordering::AcqRel) {
            return false;
        }
        // The transport reports an already-absent sequence as `Ok(false)`; either way the
        // capability is gone and this owner has spent its one release.
        let _ = self
            .server
            .unregister_frame_sequence(self.sequence.id, self.sequence.registration_token());
        self.releases.fetch_add(1, Ordering::AcqRel);
        true
    }
}

impl Drop for FrameLease {
    fn drop(&mut self) {
        self.release();
    }
}

/// One retained preview frame.
#[derive(Debug)]
struct RetainedFrame {
    binding: PreviewBinding,
    generation: u64,
    bytes: usize,
    /// Held, never read: the lease's `Drop` is what releases the capability, so storing it here is
    /// how a retained frame stays alive and how eviction frees it exactly once.
    #[allow(
        dead_code,
        reason = "the field's Drop is its purpose; reading it would be the mistake"
    )]
    lease: FrameLease,
}

/// The bounded, least-recently-published store of live preview capabilities.
///
/// Bounded twice, by count and by retained bytes, because either alone leaves the other unbounded.
/// The front of `frames` is always the next eviction, and evicting drops the lease, which releases
/// it — so the bound and the release rule are the same mechanism rather than two that must agree.
#[derive(Debug, Default)]
struct Retention {
    frames: Vec<RetainedFrame>,
    total_bytes: usize,
}

/// The published-frame registry.
pub(crate) struct PublishedFrames {
    retention: Mutex<Retention>,
    max_frames: usize,
    max_bytes: usize,
    releases: Arc<AtomicUsize>,
}

impl fmt::Debug for PublishedFrames {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PublishedFrames")
            .field("max_frames", &self.max_frames)
            .field("max_bytes", &self.max_bytes)
            .finish_non_exhaustive()
    }
}

impl PublishedFrames {
    /// Creates the registry with explicit bounds.
    pub(crate) fn with_limits(max_frames: usize, max_bytes: usize) -> Self {
        Self {
            retention: Mutex::new(Retention::default()),
            max_frames,
            max_bytes,
            releases: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// The counter every lease this registry mints reports its one release to.
    pub(crate) fn releases(&self) -> &Arc<AtomicUsize> {
        &self.releases
    }

    /// How many releases have actually reached the transport.
    #[cfg(test)]
    pub(crate) fn release_count(&self) -> usize {
        self.releases.load(Ordering::Acquire)
    }

    /// Retains a lease against the binding and generation it was rendered for.
    ///
    /// `admit` is asked **while the store is locked**, which is what makes staleness a single
    /// decision rather than two racing ones: a frame that lost its race is refused before anything
    /// is evicted for it, so a stale result can never displace a frame the editor is still showing.
    /// Its lease is dropped on that path, which releases it exactly once.
    ///
    /// Otherwise evicts least-recently-published frames until both bounds hold. A frame larger than
    /// the whole byte budget is refused rather than admitted by emptying the store.
    pub(crate) fn retain(
        &self,
        binding: PreviewBinding,
        generation: u64,
        bytes: usize,
        lease: FrameLease,
        admit: &dyn Fn() -> bool,
    ) -> Result<(), PreviewRefusal> {
        if bytes > self.max_bytes || self.max_frames == 0 {
            return Err(PreviewRefusal::FrameUnpublishable);
        }
        let mut retention = self
            .retention
            .lock()
            .map_err(|_| PreviewRefusal::Unavailable)?;
        if !admit() {
            return Err(PreviewRefusal::StaleGeneration);
        }
        while !retention.frames.is_empty()
            && (retention.frames.len() >= self.max_frames
                || retention.total_bytes.saturating_add(bytes) > self.max_bytes)
        {
            // Removing drops the lease, which releases it. The order is oldest first, so a scrub
            // gives up the frame the editor is least likely to still be showing.
            retention.frames.remove(0);
            retention.total_bytes = total_bytes(&retention.frames);
        }
        retention.frames.push(RetainedFrame {
            binding,
            generation,
            bytes,
            lease,
        });
        retention.total_bytes = total_bytes(&retention.frames);
        Ok(())
    }

    /// Releases every frame that is not bound to `binding` at `generation`.
    ///
    /// This is what an edit, a project switch or a device loss does to frames already on the wire.
    pub(crate) fn retire_others(&self, binding: &PreviewBinding, generation: u64) {
        let Ok(mut retention) = self.retention.lock() else {
            return;
        };
        retention
            .frames
            .retain(|frame| frame.generation == generation && &frame.binding == binding);
        retention.total_bytes = total_bytes(&retention.frames);
    }

    /// Releases everything. Used on teardown.
    pub(crate) fn retire_all(&self) {
        let Ok(mut retention) = self.retention.lock() else {
            return;
        };
        retention.frames.clear();
        retention.total_bytes = 0;
    }

    /// How many frames and bytes are retained now.
    #[cfg(test)]
    pub(crate) fn stats(&self) -> (usize, usize) {
        self.retention.lock().map_or((0, 0), |retention| {
            (retention.frames.len(), retention.total_bytes)
        })
    }

    /// The capability identifiers retained now, oldest first.
    #[cfg(test)]
    pub(crate) fn retained_ids(&self) -> Vec<uuid::Uuid> {
        self.retention.lock().map_or_else(
            |_| Vec::new(),
            |retention| {
                retention
                    .frames
                    .iter()
                    .map(|frame| frame.lease.sequence_id())
                    .collect()
            },
        )
    }
}

/// Recomputed after every change rather than adjusted, so the bound cannot drift from what is held.
fn total_bytes(frames: &[RetainedFrame]) -> usize {
    frames.iter().map(|frame| frame.bytes).sum()
}
