//! The platform-independent decoder contract.
//!
//! One trait, one factory, one honest failure. A platform without an audited backend returns
//! [`DecodeError::UnsupportedPlatform`] from [`open_decoder`]; it never quietly decodes with
//! something else, and it never returns a frame it did not read out of the file it was given.

use std::path::Path;

use osg_scene::{ExactTime, FrameTimeline};

use crate::cancel::CancelToken;
use crate::colorimetry::SourceColorimetry;
use crate::error::DecodeError;
use crate::frame::DecodedFrame;
use crate::limits::DecodeLimits;
use crate::sampling::OutputSampler;
use crate::source::SourceInfo;

/// How one source is to be decoded.
///
/// Carries the **output** timeline, not the source's: an export samples the source at the instants
/// its own timeline names, and that timeline already carries the trim offset and the output frame
/// rate. Handing it to the decoder is what makes [`VideoDecoder::frame_for_output`] answerable at
/// all, and it is why the decoder and the compositor cannot disagree about which source frame an
/// output frame shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecoderConfig {
    timeline: FrameTimeline,
    limits: DecodeLimits,
    colorimetry: Option<SourceColorimetry>,
}

impl DecoderConfig {
    /// A configuration with the shipped bounds and the source's own declared colour description.
    #[must_use]
    pub fn new(timeline: FrameTimeline) -> Self {
        Self {
            timeline,
            limits: DecodeLimits::new(),
            colorimetry: None,
        }
    }

    /// Replaces the bounds the source is held to.
    #[must_use]
    pub const fn with_limits(mut self, limits: DecodeLimits) -> Self {
        self.limits = limits;
        self
    }

    /// Overrides the colour description instead of reading it off the source.
    ///
    /// For a file whose declaration is absent or wrong. It is an override, not a default: a source
    /// that declares its range is believed unless a caller says otherwise here, because guessing is
    /// the failure this crate is careful about.
    #[must_use]
    pub const fn with_colorimetry(mut self, colorimetry: SourceColorimetry) -> Self {
        self.colorimetry = Some(colorimetry);
        self
    }

    /// The output timeline the source is sampled against.
    #[must_use]
    pub const fn timeline(self) -> FrameTimeline {
        self.timeline
    }

    /// The sampler over the output timeline.
    #[must_use]
    pub const fn sampler(self) -> OutputSampler {
        OutputSampler::new(self.timeline)
    }

    /// The bounds the source is held to.
    #[must_use]
    pub const fn limits(self) -> DecodeLimits {
        self.limits
    }

    /// The colour description override, when one was set.
    #[must_use]
    pub const fn colorimetry(self) -> Option<SourceColorimetry> {
        self.colorimetry
    }
}

/// What a decoder has had to do to answer the requests made of it.
///
/// Not diagnostics for their own sake. A test that asserts "seeking to frame N produces the same
/// frame as walking to N" is only meaningful if the two really took different routes, and these
/// counters are how that is proven rather than assumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DecodeStats {
    seeks: u64,
    samples_decoded: u64,
}

impl DecodeStats {
    /// How many times the reader has been repositioned.
    #[must_use]
    pub const fn seeks(self) -> u64 {
        self.seeks
    }

    /// How many samples have been pulled out of the source.
    #[must_use]
    pub const fn samples_decoded(self) -> u64 {
        self.samples_decoded
    }

    #[cfg(windows)]
    pub(crate) const fn record_seek(&mut self) {
        self.seeks = self.seeks.saturating_add(1);
    }

    #[cfg(windows)]
    pub(crate) const fn record_sample(&mut self) {
        self.samples_decoded = self.samples_decoded.saturating_add(1);
    }
}

/// A platform decoder that yields source frames as CPU RGBA8.
///
/// Implementations are used from the thread that created them: the backends this trait exists for
/// are COM APIs, whose objects belong to the apartment they were created in.
///
/// The frame-selection methods are all the same operation seen from different angles — every one of
/// them resolves to an instant and then to the sample that covers it — so they cannot disagree with
/// each other, and none of them can return the frame the seek happened to land on.
pub trait VideoDecoder: core::fmt::Debug {
    /// What the file says about itself: real dimensions, real frame rate, real duration.
    fn source(&self) -> SourceInfo;

    /// The configuration this decoder was opened with.
    fn config(&self) -> DecoderConfig;

    /// A handle that can stop this decode from another thread.
    fn cancel_token(&self) -> CancelToken;

    /// What the decoder has had to do so far.
    fn stats(&self) -> DecodeStats;

    /// The source frame output frame `index` shows.
    ///
    /// The instant comes from the output timeline in [`DecoderConfig`], so trim and frame-rate
    /// conversion are already in it.
    ///
    /// # Errors
    /// Returns [`DecodeError::FrameOutOfRange`] past the end of the timeline,
    /// [`DecodeError::TruncatedStream`] when the source ends first, [`DecodeError::Cancelled`] when
    /// the token has been signalled, and otherwise the first platform failure.
    fn frame_for_output(&mut self, index: u32) -> Result<DecodedFrame, DecodeError>;

    /// The source frame covering `time`.
    ///
    /// For a preview scrub, which asks for an instant rather than an output frame index.
    ///
    /// # Errors
    /// The same failures as [`Self::frame_for_output`].
    fn frame_at_time(&mut self, time: ExactTime) -> Result<DecodedFrame, DecodeError>;

    /// Source frame `index`, on the source's own frame grid.
    ///
    /// # Errors
    /// The same failures as [`Self::frame_for_output`].
    fn source_frame(&mut self, index: u64) -> Result<DecodedFrame, DecodeError>;

    /// The next frame in decode order, or `None` at the end of the stream.
    ///
    /// The sequential walk. Cheaper than asking for frames by index and the natural way to read a
    /// source from start to finish; it is also how a test proves that a sought frame is the frame
    /// walking would have reached.
    ///
    /// # Errors
    /// [`DecodeError::Cancelled`] when the token has been signalled, and otherwise the first
    /// platform failure.
    fn next_frame(&mut self) -> Result<Option<DecodedFrame>, DecodeError>;

    /// Releases the source.
    ///
    /// Idempotent. Every later request fails with [`DecodeError::Closed`] rather than reopening
    /// the file behind the caller's back.
    fn close(&mut self);
}

/// Opens the audited decoder backend for the running platform.
///
/// `source` must be an absolute path to a readable file. It is consumed here and never appears in
/// an error.
///
/// # Errors
/// Returns [`DecodeError::UnsupportedPlatform`] when this build has no audited backend for the
/// running platform, and otherwise the first path, bound or platform failure.
#[cfg(windows)]
pub fn open_decoder(
    source: &Path,
    config: DecoderConfig,
) -> Result<Box<dyn VideoDecoder>, DecodeError> {
    let decoder = crate::mf::MediaFoundationDecoder::open(source, config)?;
    Ok(Box::new(decoder))
}

/// Opens the audited decoder backend for the running platform.
///
/// # Errors
/// Always [`DecodeError::UnsupportedPlatform`] on this target: the shipped release target is
/// Windows, and another platform gets its own audited backend behind this trait rather than a
/// silent fallback to whatever decoder happens to be installed.
#[cfg(not(windows))]
pub fn open_decoder(
    source: &Path,
    config: DecoderConfig,
) -> Result<Box<dyn VideoDecoder>, DecodeError> {
    let _ = (source, config);
    Err(DecodeError::UnsupportedPlatform)
}
