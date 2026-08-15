//! A bounded sliding view of one source's frames.
//!
//! The mixer walks output frames in order, so each source is read in order too. The window keeps
//! only the frames the resampler's filter still needs — a few tens of frames on either side of the
//! current position — and forgets everything behind it. That is what keeps a six-hour source inside
//! a few kilobytes instead of gigabytes.
//!
//! Outside the frames the source actually produced, the window reads as silence. That makes the
//! start of a stream, the end of a stream and a trimmed-away region the same case, so no branch in
//! the resampler has to special-case an edge.

use std::collections::VecDeque;

/// Frames of one source, already remapped to the output channel count, at the source's own rate.
#[derive(Debug)]
pub(crate) struct FrameWindow {
    channels: usize,
    samples: VecDeque<f32>,
    first: u64,
    next: u64,
    ended: bool,
}

impl FrameWindow {
    pub(crate) fn new(channels: usize) -> Self {
        debug_assert!(channels > 0);
        Self {
            channels,
            samples: VecDeque::new(),
            first: 0,
            next: 0,
            ended: false,
        }
    }

    /// The index just past the last frame the source has produced so far.
    pub(crate) const fn next_index(&self) -> u64 {
        self.next
    }

    /// Whether the source has run out of frames.
    pub(crate) const fn ended(&self) -> bool {
        self.ended
    }

    /// Record that the source produced its last frame.
    pub(crate) const fn mark_ended(&mut self) {
        self.ended = true;
    }

    /// Append a packet of interleaved frames, keeping only those at or after `keep_from`.
    ///
    /// Frames before `keep_from` are counted but not stored, which is how a trim start is skipped
    /// without ever buffering the part of the source that was trimmed away.
    pub(crate) fn extend(&mut self, frames: &[f32], keep_from: u64) {
        let count = u64::try_from(frames.len() / self.channels).unwrap_or(u64::MAX);
        for index in 0..count {
            let absolute = self.next + index;
            if absolute < keep_from {
                continue;
            }
            if self.samples.is_empty() {
                self.first = absolute;
            }
            let offset = usize::try_from(index).unwrap_or(usize::MAX) * self.channels;
            self.samples
                .extend(frames[offset..offset + self.channels].iter().copied());
        }
        self.next += count;
    }

    /// Forget every frame before `index`.
    pub(crate) fn drop_before(&mut self, index: u64) {
        if index <= self.first || self.samples.is_empty() {
            return;
        }
        let buffered = u64::try_from(self.samples.len() / self.channels).unwrap_or(u64::MAX);
        let dropped = (index - self.first).min(buffered);
        let sample_count = usize::try_from(dropped).unwrap_or(usize::MAX) * self.channels;
        self.samples.drain(..sample_count);
        self.first += dropped;
    }

    /// One sample, or silence when the index is outside what the source produced or still holds.
    pub(crate) fn sample(&self, frame: i64, channel: usize) -> f32 {
        let Ok(frame) = u64::try_from(frame) else {
            return 0.0;
        };
        if frame < self.first || frame >= self.next {
            return 0.0;
        }
        let offset = usize::try_from(frame - self.first).unwrap_or(usize::MAX) * self.channels;
        self.samples.get(offset + channel).copied().unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::FrameWindow;

    #[test]
    #[expect(
        clippy::float_cmp,
        reason = "the assertion is exact by design: samples must be bit-identical"
    )]
    fn frames_read_back_by_absolute_index() {
        let mut window = FrameWindow::new(2);
        window.extend(&[1.0, 2.0, 3.0, 4.0], 0);
        assert_eq!(window.next_index(), 2);
        assert_eq!(window.sample(0, 0), 1.0);
        assert_eq!(window.sample(0, 1), 2.0);
        assert_eq!(window.sample(1, 0), 3.0);
        assert_eq!(window.sample(1, 1), 4.0);
    }

    #[test]
    #[expect(
        clippy::float_cmp,
        reason = "the assertion is exact by design: samples must be bit-identical"
    )]
    fn outside_the_produced_range_reads_as_silence() {
        let mut window = FrameWindow::new(1);
        window.extend(&[1.0, 2.0], 0);
        assert_eq!(window.sample(-1, 0), 0.0);
        assert_eq!(window.sample(2, 0), 0.0);
        assert_eq!(window.sample(i64::MAX, 0), 0.0);
    }

    #[test]
    #[expect(
        clippy::float_cmp,
        reason = "the assertion is exact by design: samples must be bit-identical"
    )]
    fn frames_before_the_keep_point_are_counted_but_not_stored() {
        let mut window = FrameWindow::new(1);
        window.extend(&[1.0, 2.0, 3.0, 4.0], 2);
        assert_eq!(window.next_index(), 4);
        assert_eq!(window.sample(0, 0), 0.0);
        assert_eq!(window.sample(1, 0), 0.0);
        assert_eq!(window.sample(2, 0), 3.0);
        assert_eq!(window.sample(3, 0), 4.0);
    }

    #[test]
    #[expect(
        clippy::float_cmp,
        reason = "the assertion is exact by design: samples must be bit-identical"
    )]
    fn dropping_bounds_the_buffer_without_shifting_indices() {
        let mut window = FrameWindow::new(2);
        for value in 0..8_u8 {
            let sample = f32::from(value);
            window.extend(&[sample, sample], 0);
        }
        window.drop_before(6);
        assert_eq!(window.sample(5, 0), 0.0);
        assert_eq!(window.sample(6, 0), 6.0);
        assert_eq!(window.sample(7, 1), 7.0);
        window.drop_before(100);
        assert_eq!(window.sample(7, 0), 0.0);
    }

    #[test]
    fn ending_is_sticky() {
        let mut window = FrameWindow::new(1);
        assert!(!window.ended());
        window.mark_ended();
        assert!(window.ended());
    }
}
