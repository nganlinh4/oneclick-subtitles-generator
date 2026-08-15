//! Deterministic channel up- and down-mixing.
//!
//! The policy is deliberately simple and stated rather than inferred:
//!
//! - **Equal counts** pass through untouched.
//! - **Anything to mono** is the arithmetic mean of the source channels, summed in ascending
//!   channel order so the rounding is the same on every run.
//! - **Mono to anything** duplicates the one channel into every output channel.
//! - **Wider to narrower (both above mono)** keeps the leading channels and drops the rest.
//! - **Narrower to wider (both above mono)** copies the source channels and leaves the remaining
//!   output channels silent.
//!
//! No ITU-R downmix matrix is applied. OSG's shipped export mixes at stereo and its sources are
//! effectively always mono or stereo, and inventing surround coefficients here would be a
//! behavioural decision with no parity fixture behind it. The consequence is honest and bounded: a
//! 5.1 source downmixed to stereo keeps front left and front right and drops centre, LFE and the
//! rears rather than folding them in at some unreviewed gain.

/// Remap one packet of interleaved frames into `target_channels`, appending to `out`.
///
/// `out` is cleared first. A partial trailing frame in `source` is ignored rather than padded.
pub(crate) fn remap(
    source: &[f32],
    source_channels: usize,
    target_channels: usize,
    out: &mut [f32],
) {
    debug_assert!(source_channels > 0 && target_channels > 0);
    let frames = source.len() / source_channels;
    debug_assert!(out.len() >= frames * target_channels);
    for frame in 0..frames {
        let input = &source[frame * source_channels..(frame + 1) * source_channels];
        let output = &mut out[frame * target_channels..(frame + 1) * target_channels];
        remap_frame(input, output);
    }
}

/// How many samples [`remap`] writes for a packet of `samples` interleaved source samples.
pub(crate) fn remapped_len(
    samples: usize,
    source_channels: usize,
    target_channels: usize,
) -> usize {
    (samples / source_channels) * target_channels
}

fn remap_frame(input: &[f32], output: &mut [f32]) {
    if input.len() == output.len() {
        output.copy_from_slice(input);
        return;
    }
    if output.len() == 1 {
        let mut sum = 0.0_f32;
        for sample in input {
            sum += *sample;
        }
        #[expect(
            clippy::cast_precision_loss,
            reason = "the channel count is at most 16, exactly representable in f32"
        )]
        let count = input.len() as f32;
        output[0] = sum / count;
        return;
    }
    if input.len() == 1 {
        output.fill(input[0]);
        return;
    }
    let shared = input.len().min(output.len());
    output[..shared].copy_from_slice(&input[..shared]);
    if output.len() > shared {
        output[shared..].fill(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::{remap, remapped_len};

    fn remapped(source: &[f32], source_channels: usize, target_channels: usize) -> Vec<f32> {
        let mut out = vec![0.0; remapped_len(source.len(), source_channels, target_channels)];
        remap(source, source_channels, target_channels, &mut out);
        out
    }

    #[test]
    fn equal_counts_pass_through() {
        let source = [0.25, -0.5, 0.75, -1.0];
        assert_eq!(remapped(&source, 2, 2), source.to_vec());
    }

    #[test]
    fn downmix_to_mono_is_the_mean() {
        assert_eq!(remapped(&[1.0, 0.0, -1.0, 0.5], 2, 1), vec![0.5, -0.25]);
        let thirds = remapped(&[0.3, 0.6, 0.9], 3, 1);
        assert_eq!(thirds.len(), 1);
        assert!((thirds[0] - 0.6).abs() < 1e-6);
    }

    #[test]
    fn mono_upmix_duplicates() {
        assert_eq!(remapped(&[0.5, -0.5], 1, 2), vec![0.5, 0.5, -0.5, -0.5]);
        assert_eq!(remapped(&[0.25], 1, 4), vec![0.25; 4]);
    }

    #[test]
    fn wider_sources_keep_the_leading_channels() {
        // 5.1 order is FL, FR, FC, LFE, RL, RR: stereo keeps FL and FR.
        let frame = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        assert_eq!(remapped(&frame, 6, 2), vec![1.0, 2.0]);
    }

    #[test]
    fn narrower_sources_leave_the_extra_channels_silent() {
        assert_eq!(remapped(&[1.0, 2.0], 2, 4), vec![1.0, 2.0, 0.0, 0.0]);
    }

    #[test]
    fn a_partial_trailing_frame_is_ignored() {
        assert_eq!(remapped(&[1.0, 2.0, 3.0], 2, 2), vec![1.0, 2.0]);
        assert_eq!(remapped_len(3, 2, 2), 2);
    }
}
