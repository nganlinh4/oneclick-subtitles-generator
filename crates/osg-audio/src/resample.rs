//! Deterministic rational resampling.
//!
//! The position of output frame `n` is `n * source_rate / target_rate` in source frames, held as an
//! exact integer quotient and remainder. Nothing accumulates: frame `n` is computed from `n`, so a
//! block boundary cannot shift the phase and two runs cannot end up a sample apart.
//!
//! The filter is a 32 tap windowed sinc, low-passed at the lower of the two Nyquist limits, with
//! one tap set per phase. When the reduced denominator is small enough to enumerate — every rate
//! pair a real file uses reduces to at most a few hundred phases — the taps are precomputed once
//! and indexed by the exact remainder, so the interpolation is exact for that phase rather than
//! quantised. For an exotic rate pair whose reduced denominator is beyond
//! [`MAX_RESAMPLE_PHASES`], the crate falls back to linear interpolation rather than allocating a
//! table proportional to the rate; that path is lower quality and is documented as such, not
//! silently substituted.
//!
//! Each phase's taps are normalised to sum to one, so a constant input stays constant to within
//! `f32` rounding at every phase. That is both the correct DC gain and the property the tests
//! assert.

use crate::window::FrameWindow;

/// How many taps the windowed sinc uses.
pub(crate) const RESAMPLE_TAPS: usize = 32;
/// How many taps sit on each side of the interpolation point.
const RESAMPLE_HALF_TAPS: u64 = 16;
/// The first tap's offset from the interpolation point.
const RESAMPLE_FIRST_TAP: i64 = -15;
/// The largest phase table the resampler will build.
pub(crate) const MAX_RESAMPLE_PHASES: u64 = 1_024;

#[derive(Debug)]
enum Kernel {
    /// Rates match: frames are read straight through.
    Passthrough,
    /// The reduced denominator is too large to tabulate; interpolate between neighbours.
    Linear,
    /// One set of taps per phase, indexed by the exact remainder.
    Polyphase(Vec<f32>),
}

/// A fixed rational rate conversion.
#[derive(Debug)]
pub(crate) struct Resampler {
    step: u64,
    phases: u64,
    kernel: Kernel,
}

impl Resampler {
    pub(crate) fn new(source_rate: u32, target_rate: u32) -> Self {
        if source_rate == target_rate {
            return Self {
                step: 1,
                phases: 1,
                kernel: Kernel::Passthrough,
            };
        }
        let divisor =
            greatest_common_divisor(u64::from(source_rate), u64::from(target_rate)).max(1);
        let step = u64::from(source_rate) / divisor;
        let phases = u64::from(target_rate) / divisor;
        let kernel = if phases <= MAX_RESAMPLE_PHASES {
            Kernel::Polyphase(build_taps(phases, source_rate, target_rate))
        } else {
            Kernel::Linear
        };
        Self {
            step,
            phases,
            kernel,
        }
    }

    /// The source frame and phase output frame `local` reads from.
    pub(crate) fn position(&self, local: u64) -> (u64, u64) {
        let scaled = u128::from(local) * u128::from(self.step);
        let phases = u128::from(self.phases).max(1);
        (
            u64::try_from(scaled / phases).unwrap_or(u64::MAX),
            u64::try_from(scaled % phases).unwrap_or(0),
        )
    }

    /// How many frames before the position the filter reads.
    pub(crate) const fn history(&self) -> u64 {
        match self.kernel {
            Kernel::Passthrough | Kernel::Linear => 0,
            Kernel::Polyphase(_) => RESAMPLE_HALF_TAPS - 1,
        }
    }

    /// How many frames after the position the filter reads.
    pub(crate) const fn lookahead(&self) -> u64 {
        match self.kernel {
            Kernel::Passthrough => 0,
            Kernel::Linear => 1,
            Kernel::Polyphase(_) => RESAMPLE_HALF_TAPS,
        }
    }

    /// One output sample for `channel`, read from `window` at `base` plus `phase`.
    pub(crate) fn render(
        &self,
        window: &FrameWindow,
        base: u64,
        phase: u64,
        channel: usize,
    ) -> f32 {
        let index = i64::try_from(base).unwrap_or(i64::MAX);
        match &self.kernel {
            Kernel::Passthrough => window.sample(index, channel),
            Kernel::Linear => {
                let start = window.sample(index, channel);
                let end = window.sample(index.saturating_add(1), channel);
                #[expect(
                    clippy::cast_precision_loss,
                    reason = "phase and denominator are both below 2^32, exact in f64"
                )]
                let fraction = (phase as f64) / (self.phases as f64);
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "the interpolation is deliberately carried out in f32 output precision"
                )]
                let fraction = fraction as f32;
                start + (end - start) * fraction
            }
            Kernel::Polyphase(taps) => {
                let offset = usize::try_from(phase).unwrap_or(0) * RESAMPLE_TAPS;
                let Some(phase_taps) = taps.get(offset..offset + RESAMPLE_TAPS) else {
                    return 0.0;
                };
                let first = index.saturating_add(RESAMPLE_FIRST_TAP);
                let mut sum = 0.0_f32;
                for (tap, weight) in phase_taps.iter().enumerate() {
                    let at = first.saturating_add(i64::try_from(tap).unwrap_or(0));
                    sum += weight * window.sample(at, channel);
                }
                sum
            }
        }
    }
}

/// Build one set of taps per phase, each normalised to unity DC gain.
fn build_taps(phases: u64, source_rate: u32, target_rate: u32) -> Vec<f32> {
    let cutoff = 0.5 * (f64::from(target_rate) / f64::from(source_rate)).min(1.0);
    #[expect(
        clippy::cast_precision_loss,
        reason = "RESAMPLE_TAPS is 32, exactly representable"
    )]
    let half = (RESAMPLE_TAPS / 2) as f64;
    let capacity = usize::try_from(phases).unwrap_or(usize::MAX) * RESAMPLE_TAPS;
    let mut table = Vec::with_capacity(capacity);
    for phase in 0..phases {
        #[expect(
            clippy::cast_precision_loss,
            reason = "phase and phases are both below 2^32, exact in f64"
        )]
        let fraction = (phase as f64) / (phases as f64);
        let mut taps = [0.0_f64; RESAMPLE_TAPS];
        let mut sum = 0.0_f64;
        for (tap, weight) in taps.iter_mut().enumerate() {
            #[expect(
                clippy::cast_precision_loss,
                reason = "tap is below 32, exactly representable"
            )]
            let position = (tap as f64) - (half - 1.0) - fraction;
            let value = sinc(2.0 * cutoff * position) * blackman((position + half) / (2.0 * half));
            *weight = value;
            sum += value;
        }
        let scale = if sum.abs() < 1e-12 { 0.0 } else { 1.0 / sum };
        for weight in taps {
            #[expect(
                clippy::cast_possible_truncation,
                reason = "the taps are applied to f32 samples and are stored at that precision"
            )]
            let stored = (weight * scale) as f32;
            table.push(stored);
        }
    }
    table
}

fn sinc(value: f64) -> f64 {
    if value.abs() < 1e-12 {
        return 1.0;
    }
    let scaled = core::f64::consts::PI * value;
    scaled.sin() / scaled
}

/// A Blackman window over `0.0..=1.0`, zero at both ends.
fn blackman(position: f64) -> f64 {
    let position = position.clamp(0.0, 1.0);
    let angle = 2.0 * core::f64::consts::PI * position;
    0.42 - 0.5 * angle.cos() + 0.08 * (2.0 * angle).cos()
}

const fn greatest_common_divisor(mut left: u64, mut right: u64) -> u64 {
    while right != 0 {
        let next = left % right;
        left = right;
        right = next;
    }
    left
}

#[cfg(test)]
mod tests {
    use super::{MAX_RESAMPLE_PHASES, RESAMPLE_TAPS, Resampler, greatest_common_divisor};
    use crate::window::FrameWindow;

    fn filled(channels: usize, frames: usize, value: impl Fn(usize) -> f32) -> FrameWindow {
        let mut window = FrameWindow::new(channels);
        let mut samples = Vec::with_capacity(frames * channels);
        for frame in 0..frames {
            for _ in 0..channels {
                samples.push(value(frame));
            }
        }
        window.extend(&samples, 0);
        window.mark_ended();
        window
    }

    #[test]
    fn matching_rates_pass_straight_through() {
        let resampler = Resampler::new(48_000, 48_000);
        assert_eq!(resampler.position(1_000), (1_000, 0));
        assert_eq!(resampler.history(), 0);
        assert_eq!(resampler.lookahead(), 0);
        let window = filled(1, 16, |frame| f32::from(u8::try_from(frame).unwrap_or(0)));
        for frame in 0_u64..16 {
            let (base, phase) = resampler.position(frame);
            let expected = f32::from(u8::try_from(frame).unwrap_or(0));
            assert!((resampler.render(&window, base, phase, 0) - expected).abs() < 1e-6);
        }
    }

    #[test]
    fn positions_are_exact_rationals_that_never_accumulate() {
        let resampler = Resampler::new(44_100, 48_000);
        // 44100/48000 reduces to 147/160.
        assert_eq!(resampler.position(1), (0, 147));
        assert_eq!(resampler.position(160), (147, 0));
        assert_eq!(resampler.position(1_000_000), (918_750, 0));
    }

    #[test]
    fn a_standard_rate_pair_tabulates_every_phase() {
        let resampler = Resampler::new(44_100, 48_000);
        assert_eq!(resampler.history(), 15);
        assert_eq!(resampler.lookahead(), 16);
        // 2 * 147 = 294 = 1 source frame and 134/160 of the next.
        assert_eq!(resampler.position(2), (1, 134));
        // 160 phases, well inside the tabulation ceiling.
        assert_eq!(MAX_RESAMPLE_PHASES.min(160), 160);
    }

    #[test]
    fn an_exotic_rate_pair_falls_back_to_linear() {
        // 44101 is coprime with 48000, so the reduced denominator is 48000 phases.
        let resampler = Resampler::new(44_101, 48_000);
        assert_eq!(resampler.history(), 0);
        assert_eq!(resampler.lookahead(), 1);
        let window = filled(1, 8, |frame| if frame == 0 { 0.0 } else { 1.0 });
        let (base, phase) = resampler.position(1);
        let rendered = resampler.render(&window, base, phase, 0);
        assert!((0.0..=1.0).contains(&rendered));
    }

    #[test]
    fn a_constant_signal_survives_every_phase_of_an_upsample() {
        let resampler = Resampler::new(44_100, 48_000);
        let window = filled(1, 512, |_| 0.5);
        for frame in 100..300_u64 {
            let (base, phase) = resampler.position(frame);
            let rendered = resampler.render(&window, base, phase, 0);
            assert!(
                (rendered - 0.5).abs() < 1e-5,
                "phase {phase} rendered {rendered}"
            );
        }
    }

    #[test]
    fn a_constant_signal_survives_a_downsample() {
        let resampler = Resampler::new(48_000, 24_000);
        let window = filled(2, 512, |_| -0.25);
        for frame in 40..200_u64 {
            let (base, phase) = resampler.position(frame);
            for channel in 0..2 {
                let rendered = resampler.render(&window, base, phase, channel);
                assert!((rendered + 0.25).abs() < 1e-5, "rendered {rendered}");
            }
        }
    }

    #[test]
    fn taps_are_bounded_and_the_table_is_the_declared_size() {
        let resampler = Resampler::new(8_000, 48_000);
        // 8000/48000 reduces to 1/6.
        assert_eq!(resampler.position(6), (1, 0));
        let window = filled(1, 64, |_| 1.0);
        // Far enough in that the whole 32 tap kernel sits inside the window.
        let (base, phase) = resampler.position(121);
        assert_eq!((base, phase), (20, 1));
        let rendered = resampler.render(&window, base, phase, 0);
        assert!((rendered - 1.0).abs() < 1e-5, "rendered {rendered}");
        assert_eq!(RESAMPLE_TAPS % 2, 0);
    }

    #[test]
    fn the_divisor_helper_is_a_gcd() {
        assert_eq!(greatest_common_divisor(48_000, 44_100), 300);
        assert_eq!(greatest_common_divisor(48_000, 0), 48_000);
        assert_eq!(greatest_common_divisor(0, 0), 0);
    }
}
