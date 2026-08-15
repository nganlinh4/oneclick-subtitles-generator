//! Decode one source frame, composite the subtitles over it, hand back the pixels.
//!
//! This is the seam the determinism contract binds. Encoded bytes are not reproducible — hardware
//! encoders differ between vendors and driver versions — so what has to be provably deterministic
//! is what reaches the encoder, and that is exactly what this type produces. Composing frame `n`
//! directly and composing it after `0..n` give the same bytes, because the decoder resolves every
//! request through the exact rational timeline rather than trusting a seek, and the compositor's
//! plan is a pure function of the scene and the frame index.
//!
//! Nothing here re-derives anything. The decoder owns frame-exact sampling, the compositor owns
//! crop, flip, backfill and blending, and this type owns only the loop that joins them.

use std::path::Path;

use osg_compositor::{Compositor, Crop, Frame, SourceFrame, SubtitleScene, VideoUnderlay};
use osg_decode::{DecoderConfig, VideoDecoder, open_decoder};

use crate::convert::ExportPlan;
use crate::error::ExportError;

/// A source, a compositor and a staged scene, ready to produce any frame of an export.
#[derive(Debug)]
pub struct FrameRenderer {
    compositor: Compositor,
    decoder: Box<dyn VideoDecoder>,
    scene: SubtitleScene,
    crop: Crop,
    frame_count: u32,
}

impl FrameRenderer {
    /// Acquires a GPU adapter and opens the source against the plan's trimmed timeline.
    ///
    /// `source` must be an absolute path to a readable video file. It is consumed here and never
    /// appears in an error or in a `Debug` rendering.
    ///
    /// # Errors
    /// Returns [`ExportError::CompositionRejected`] when no adapter can be acquired, and
    /// [`ExportError::SourceUnreadable`] when the source cannot be opened or is outside the
    /// decoder's bounds.
    pub fn open(
        plan: &ExportPlan,
        scene: SubtitleScene,
        source: &Path,
    ) -> Result<Self, ExportError> {
        let compositor = Compositor::new()?;
        let decoder = open_decoder(source, DecoderConfig::new(plan.source_timeline()))?;
        Ok(Self {
            compositor,
            decoder,
            scene,
            crop: plan.crop(),
            frame_count: plan.frame_count(),
        })
    }

    /// How many frames this export produces.
    #[must_use]
    pub const fn frame_count(&self) -> u32 {
        self.frame_count
    }

    /// Composes output frame `index`: the source frame it shows, cropped and flipped, with the
    /// subtitle layer blended over it in the same pass.
    ///
    /// Pixels come back tightly packed, premultiplied `RGBA8`, top row first.
    ///
    /// # Errors
    /// Returns [`ExportError::SourceUnreadable`] when the source cannot produce the frame the
    /// timeline names — including when the stream ends first, which is a truncation rather than a
    /// quietly shorter export — and [`ExportError::CompositionRejected`] when the composition
    /// itself is refused.
    pub fn frame(&mut self, index: u32) -> Result<Frame, ExportError> {
        let decoded = self.decoder.frame_for_output(index)?;
        let width = u32::try_from(decoded.width()).unwrap_or(u32::MAX);
        let height = u32::try_from(decoded.height()).unwrap_or(u32::MAX);
        let source = SourceFrame::new(width, height, decoded.into_pixels())?;
        let underlay = VideoUnderlay::new(source, self.crop);
        Ok(self
            .compositor
            .render_scene_over(&self.scene, &underlay, index)?)
    }

    /// Releases the source.
    ///
    /// Idempotent. Every later request fails rather than reopening the file behind the caller's
    /// back, which is what makes a cancelled export stop reading.
    pub fn close(&mut self) {
        self.decoder.close();
    }
}
