//! Getting the reader to the sample that covers an instant: clamp, seek at or before it (backing
//! off when the platform snaps late), then walk forward.

use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::core::GUID;

use super::MediaFoundationDecoder;
use crate::error::{DecodeError, MfStage};
use crate::limits::HUNDRED_NANOS_PER_SECOND;
use crate::mf::platform::platform_error;
use crate::mf::sample::SourceSample;

/// How far before a target the decoder will re-seek when the first attempt lands past it.
///
/// A seek is supposed to go to the keyframe at or before the requested instant. Some sources snap
/// the other way, and a decoder that accepts that silently returns a later frame than it was asked
/// for. Backing off in widening steps finds a keyframe that really is earlier; reaching zero means
/// the source's first frame is the honest answer and there is nowhere earlier to look.
const SEEK_BACKOFFS_100NS: [i64; 4] = [
    0,
    HUNDRED_NANOS_PER_SECOND,
    5 * HUNDRED_NANOS_PER_SECOND,
    30 * HUNDRED_NANOS_PER_SECOND,
];

impl MediaFoundationDecoder {
    /// Repositions the reader. The decoded state is discarded, because none of it is valid any
    /// more and keeping a stale frame is how a decoder returns the wrong one.
    ///
    /// The position is clamped inside the source. Media Foundation refuses a seek past the end with
    /// a platform error, and reporting that as a platform failure would hide the thing the caller
    /// actually needs to know, which is that the file is shorter than the timeline.
    fn seek_to(&mut self, position_100ns: i64) -> Result<(), DecodeError> {
        let reader = self.reader()?.clone();
        let time_format = GUID::zeroed();
        let position = PROPVARIANT::from(self.clamp_into_source(position_100ns));

        // SAFETY: both arguments are live locals for the duration of the call. The zero GUID is the
        // platform's "100-nanosecond units" time format, and the reader copies the position rather
        // than retaining the pointer.
        unsafe { reader.SetCurrentPosition(&raw const time_format, &raw const position) }
            .map_err(|error| platform_error(MfStage::Seek, &error))?;

        self.current = None;
        self.pending = None;
        self.at_end = false;
        self.stats.record_seek();
        Ok(())
    }

    /// Brings a seek position inside the source's declared span.
    ///
    /// A declared duration of zero means the container did not say, in which case there is nothing
    /// to clamp against and the position is passed through.
    fn clamp_into_source(&self, position_100ns: i64) -> i64 {
        let duration = self.info.duration_100ns();
        if duration <= 0 {
            return position_100ns.max(0);
        }
        position_100ns.clamp(0, duration - 1)
    }

    /// How far forward walking is preferred over seeking, in 100ns units.
    fn walk_budget_100ns(&self) -> i64 {
        let frames = i64::from(self.config.limits().forward_scan_frames());
        frames.saturating_mul(self.info.grid().frame_duration_100ns())
    }

    fn should_seek(&self, target_100ns: i64) -> bool {
        match &self.current {
            // Nothing decoded yet: the start of the file is already where a target of zero wants to
            // be, so only a real offset is worth a seek.
            None => target_100ns > 0,
            Some(current) => {
                let position = current.presentation_100ns();
                target_100ns < position
                    || target_100ns.saturating_sub(position) > self.walk_budget_100ns()
            }
        }
    }

    /// Gets the reader to a decode position at or before `target_100ns`.
    fn seek_before(&mut self, target_100ns: i64) -> Result<(), DecodeError> {
        for backoff in SEEK_BACKOFFS_100NS {
            self.check_cancelled()?;
            let position = target_100ns.saturating_sub(backoff);
            self.seek_to(position)?;
            self.ensure_current()?;
            match &self.current {
                // Nothing after this position at all; the walk will report the truncation.
                None => return Ok(()),
                Some(current) if current.presentation_100ns() <= target_100ns => return Ok(()),
                Some(_) => {}
            }
            if position <= 0 {
                // Already at the start of the source. Its first frame is the honest answer for an
                // instant that precedes it.
                return Ok(());
            }
        }
        Ok(())
    }

    /// Walks forward until `current` is the sample covering `target_100ns`.
    fn walk_to(&mut self, target_100ns: i64) -> Result<(), DecodeError> {
        let budget = self.config.limits().max_decode_walk();
        let mut walked = 0_u32;

        self.ensure_current()?;
        if self.current.is_none() {
            return Err(DecodeError::TruncatedStream {
                decoded: self.stats.samples_decoded(),
            });
        }
        loop {
            self.check_cancelled()?;
            self.fill_pending()?;
            let advance = self
                .pending
                .as_ref()
                .is_some_and(|next| next.presentation_100ns() <= target_100ns);
            if !advance {
                return Ok(());
            }
            self.current = self.pending.take();
            walked += 1;
            if walked > budget {
                return Err(DecodeError::FrameNotFound { target_100ns });
            }
        }
    }

    /// Resolves one instant into the source frame that covers it.
    pub(crate) fn selected_sample_at_100ns(
        &mut self,
        target_100ns: i64,
    ) -> Result<SourceSample, DecodeError> {
        self.check_usable()?;
        // An instant past the source's declared span is answered without touching the platform. The
        // caller's timeline is longer than the file, which is a fact about the file and not a
        // platform failure, and reporting it as one would send someone looking at Media Foundation.
        let duration = self.info.duration_100ns();
        if duration > 0 && target_100ns >= duration {
            return Err(DecodeError::TruncatedStream {
                decoded: self.stats.samples_decoded(),
            });
        }
        if self.should_seek(target_100ns) {
            self.seek_before(target_100ns)?;
        }
        self.walk_to(target_100ns)?;

        let decoded = self.stats.samples_decoded();

        let current = self
            .current
            .as_ref()
            .ok_or(DecodeError::TruncatedStream { decoded })?;
        // A container presentation may legitimately outlive its selected video stream because an
        // audio track has a small encoder-delay tail. Browsers keep the last picture visible for
        // that tail, and the shared presentation duration above says the source is still live, so
        // do the same. A source with no declared duration gets no such authority: once its final
        // sample interval ends, holding it would turn an unknown/truncated stream into a complete
        // one. Targets at or beyond a positive declared duration were already refused above.
        if self.at_end
            && duration <= 0
            && target_100ns
                >= current
                    .presentation_100ns()
                    .saturating_add(current.duration_100ns())
        {
            return Err(DecodeError::TruncatedStream { decoded });
        }
        Ok(SourceSample::new(
            current.interface().clone(),
            current.presentation_100ns(),
            current.duration_100ns(),
        ))
    }
}
