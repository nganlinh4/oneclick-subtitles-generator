//! Comparing two frames, and saying enough about a difference to diagnose it.
//!
//! Two kinds of comparison happen in this gate and they are deliberately not the same:
//!
//! * **Exact.** A composed frame against a composed frame — the same case rendered twice, or
//!   reached by walking rather than by seeking. Those must be byte-identical, because the
//!   compositor's output is a pure function of the scene and the frame index. Nothing is tolerated
//!   here at all.
//! * **Tolerant.** A composed frame against the same frame decoded back out of a finished `MP4`.
//!   Those cannot be byte-identical: `H.264` is lossy, the chroma is subsampled, and hardware
//!   encoders differ between vendors and driver versions. [`Tolerance`] is what that comparison is
//!   allowed to absorb, and `roundtrip.rs` measures the number it is set to rather than choosing a
//!   round one.
//!
//! A failing comparison has to leave enough behind to diagnose without leaking anything: the case
//! identity, the frame index and the differing pixels, and never a filesystem path or a line of
//! somebody's subtitles.

use std::fmt::Write as _;

/// How many differing pixels a failure lists before it stops.
const LISTED_PIXELS: usize = 8;

/// The distribution of per-channel differences between two frames of the same size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct FrameDiff {
    /// How many pixels differ in any colour channel.
    pub(crate) differing_pixels: u64,
    /// How many pixels were compared.
    pub(crate) total_pixels: u64,
    /// The largest per-channel absolute difference anywhere in the frame.
    pub(crate) max_channel: u32,
    /// The mean per-channel absolute difference over every channel of every pixel.
    pub(crate) mean_channel: f64,
    /// The smallest difference at or above which one channel in a thousand sits.
    pub(crate) p999_channel: u32,
    /// The largest absolute difference in the alpha channel.
    pub(crate) max_alpha: u32,
}

impl FrameDiff {
    /// Whether the two frames were identical byte for byte.
    pub(crate) const fn is_identical(&self) -> bool {
        self.differing_pixels == 0 && self.max_alpha == 0
    }
}

/// Measures one frame against another. Both must be tightly packed `RGBA8` of the same size.
///
/// # Panics
/// Panics when the two frames are not the same length, which is a harness error rather than a
/// parity finding.
pub(crate) fn diff(left: &[u8], right: &[u8]) -> FrameDiff {
    assert_eq!(
        left.len(),
        right.len(),
        "frames of different sizes cannot be compared"
    );
    let mut histogram = [0_u64; 256];
    let mut differing_pixels = 0_u64;
    let mut max_channel = 0_u32;
    let mut max_alpha = 0_u32;
    let mut total = 0_u64;
    for (a, b) in left.chunks_exact(4).zip(right.chunks_exact(4)) {
        let mut differs = false;
        for channel in 0..3 {
            let delta = u32::from(a[channel].abs_diff(b[channel]));
            histogram[delta as usize] += 1;
            total += 1;
            max_channel = max_channel.max(delta);
            differs |= delta != 0;
        }
        max_alpha = max_alpha.max(u32::from(a[3].abs_diff(b[3])));
        if differs {
            differing_pixels += 1;
        }
    }
    let sum: u64 = histogram
        .iter()
        .enumerate()
        .map(|(delta, count)| u64::try_from(delta).unwrap_or(0).saturating_mul(*count))
        .sum();
    #[expect(
        clippy::cast_precision_loss,
        reason = "a channel count and its sum are far inside the exactly representable range"
    )]
    let mean_channel = if total == 0 {
        0.0
    } else {
        sum as f64 / total as f64
    };
    FrameDiff {
        differing_pixels,
        total_pixels: u64::try_from(left.len()).unwrap_or(0) / 4,
        max_channel,
        mean_channel,
        p999_channel: percentile(&histogram, total, 999),
        max_alpha,
    }
}

/// The smallest difference at or above which `1000 - permille` channels in a thousand sit.
fn percentile(histogram: &[u64; 256], total: u64, permille: u64) -> u32 {
    if total == 0 {
        return 0;
    }
    let target = total.saturating_mul(permille) / 1_000;
    let mut seen = 0_u64;
    for (delta, count) in histogram.iter().enumerate() {
        seen += count;
        if seen > target {
            return u32::try_from(delta).unwrap_or(u32::MAX);
        }
    }
    255
}

/// What a lossy round trip is allowed to absorb.
///
/// Every number is measured rather than chosen: `roundtrip.rs` prints the distribution it observes
/// and asserts that a one-pixel shift of the subtitle layer sits far outside it.
#[derive(Debug, Clone, Copy, PartialEq)]
#[expect(
    clippy::struct_field_names,
    reason = "every bound is a per-channel quantity, and dropping the unit would leave three               numbers whose meaning has to be looked up"
)]
pub(crate) struct Tolerance {
    pub(crate) mean_channel: f64,
    pub(crate) p999_channel: u32,
    pub(crate) max_channel: u32,
}

impl Tolerance {
    /// Whether a measured difference is inside this tolerance.
    pub(crate) fn admits(&self, diff: &FrameDiff) -> bool {
        diff.mean_channel <= self.mean_channel
            && diff.p999_channel <= self.p999_channel
            && diff.max_channel <= self.max_channel
            && diff.max_alpha == 0
    }
}

/// A failure report: the case, the frame, the distribution and the first differing pixels.
///
/// Carries no path, no filename and no subtitle text — the case identity names a preset, a field, a
/// matrix text identity and an output shape, all of which are fixture identifiers.
pub(crate) fn report(
    case: &str,
    frame: u32,
    diff: &FrameDiff,
    left: &[u8],
    right: &[u8],
) -> String {
    let mut message = format!(
        "{case}: frame {frame} differs — {} of {} pixels, mean {:.4}, p999 {}, max {}, alpha {}",
        diff.differing_pixels,
        diff.total_pixels,
        diff.mean_channel,
        diff.p999_channel,
        diff.max_channel,
        diff.max_alpha,
    );
    let mut listed = 0_usize;
    for (index, (a, b)) in left.chunks_exact(4).zip(right.chunks_exact(4)).enumerate() {
        if a == b {
            continue;
        }
        let _ = write!(message, "\n  pixel {index}: {a:?} against {b:?}");
        listed += 1;
        if listed == LISTED_PIXELS {
            let _ = write!(message, "\n  ...");
            break;
        }
    }
    message
}

/// Asserts two composed frames are the same bytes, with a diagnosable message when they are not.
pub(crate) fn assert_identical(case: &str, frame: u32, left: &[u8], right: &[u8], why: &str) {
    if left == right {
        return;
    }
    let measured = diff(left, right);
    panic!("{why}\n{}", report(case, frame, &measured, left, right));
}

#[cfg(test)]
mod tests {
    use super::{Tolerance, diff};

    /// Two frames that differ by one level in one channel of one pixel.
    fn mutated(pixels: &[u8], index: usize, delta: u8) -> Vec<u8> {
        let mut copy = pixels.to_vec();
        copy[index] = copy[index].wrapping_add(delta);
        copy
    }

    #[test]
    fn an_identical_pair_measures_zero_and_a_one_level_mutation_does_not() {
        let frame = vec![64_u8; 64 * 4];
        let measured = diff(&frame, &frame);
        assert!(measured.is_identical());
        assert_eq!(measured.max_channel, 0);
        assert!(measured.mean_channel.abs() < f64::EPSILON);

        let mutated = mutated(&frame, 6, 1);
        let measured = diff(&frame, &mutated);
        assert!(!measured.is_identical(), "a one-level mutation went unseen");
        assert_eq!(measured.differing_pixels, 1);
        assert_eq!(measured.max_channel, 1);
    }

    #[test]
    fn an_alpha_only_mutation_is_never_absorbed_by_a_colour_tolerance() {
        // The export is opaque by construction, so a difference in alpha is a structural failure
        // rather than a lossy one, and no colour tolerance may admit it.
        let frame = vec![200_u8; 16 * 4];
        let mut mutated = frame.clone();
        mutated[3] = 128;
        let measured = diff(&frame, &mutated);
        assert_eq!(measured.max_alpha, 72);
        let generous = Tolerance {
            mean_channel: 255.0,
            p999_channel: 255,
            max_channel: 255,
        };
        assert!(!generous.admits(&measured));
    }

    #[test]
    fn the_percentile_reports_the_tail_rather_than_the_bulk() {
        // Nine hundred and ninety-nine channels at zero and one at fifty: the mean is small and the
        // tail is not, which is exactly the shape a localised regression makes.
        let mut left = vec![0_u8; 1_000 * 4];
        let mut right = left.clone();
        for pixel in 0..1_000 {
            left[pixel * 4 + 3] = 255;
            right[pixel * 4 + 3] = 255;
        }
        right[0] = 50;
        let measured = diff(&left, &right);
        assert!(measured.mean_channel < 0.02, "{measured:?}");
        assert_eq!(measured.max_channel, 50);
        let tolerance = Tolerance {
            mean_channel: 0.5,
            p999_channel: 2,
            max_channel: 8,
        };
        assert!(
            !tolerance.admits(&measured),
            "a fifty-level outlier must not hide behind a small mean"
        );
    }

    #[test]
    fn a_failure_report_carries_the_case_the_frame_and_the_pixels_and_no_path() {
        let left = vec![0_u8; 8 * 4];
        let mut right = left.clone();
        right[4] = 9;
        let measured = diff(&left, &right);
        let message = super::report(
            "preset=neon text=korean out=sd-30",
            11,
            &measured,
            &left,
            &right,
        );
        assert!(message.contains("preset=neon"), "{message}");
        assert!(message.contains("frame 11"), "{message}");
        assert!(message.contains("pixel 1:"), "{message}");
        assert!(!message.contains(std::path::MAIN_SEPARATOR), "{message}");
        assert!(
            !message.contains(":\\") && !message.contains(":/"),
            "{message}"
        );
    }
}
