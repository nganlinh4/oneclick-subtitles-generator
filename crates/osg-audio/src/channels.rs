//! Deterministic channel up- and down-mixing.
//!
//! The policy is deliberately simple and stated rather than inferred:
//!
//! - **Equal counts** pass through untouched.
//! - **Anything to mono** is the arithmetic mean of the source channels, summed in ascending
//!   channel order so the rounding is the same on every run.
//! - **Mono to anything** duplicates the one channel into every output channel.
//! - **Surround to stereo** folds down with the standard ITU-R BS.775 coefficients.
//! - **Any other wider to narrower** keeps the leading channels and drops the rest.
//! - **Narrower to wider (both above mono)** copies the source channels and leaves the remaining
//!   output channels silent.
//!
//! The surround case is called out because getting it wrong is not a subtle quality difference. In
//! the standard channel order the third channel is centre, and centre is where dialogue lives, so
//! simply keeping the two leading channels would export a 5.1 film clip with the speech missing —
//! silently, and in a tool whose entire purpose is subtitling speech. The shipped export ran its
//! audio through `FFmpeg`, which folds surround down by this same standard rather than truncating, so
//! the fold-down is also the closer match to what users already got.
//!
//! LFE is dropped rather than folded in, matching the usual default: it carries no dialogue and
//! summing it into full-range channels muddies the result. The coefficients are normalised so a
//! fold-down cannot introduce clipping that the source did not have.

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
    if output.len() == 2
        && let Some(folded) = fold_surround_to_stereo(input)
    {
        output.copy_from_slice(&folded);
        return;
    }
    let shared = input.len().min(output.len());
    output[..shared].copy_from_slice(&input[..shared]);
    if output.len() > shared {
        output[shared..].fill(0.0);
    }
}

/// The ITU-R BS.775 gain for a channel folded into an adjacent one, -3 dB.
const FOLD_GAIN: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// Fold a standard surround layout down to stereo, or `None` if the layout is not one we recognise.
///
/// Channel order is the WAVE/SMPTE one every container in use here declares: front left, front
/// right, front centre, LFE, then the surrounds. Only layouts whose third channel really is centre
/// are folded; anything else falls through to the truncating path rather than guessing which
/// channel holds the dialogue.
///
/// The result is divided by the total gain applied to either side, so a fold-down is quieter but
/// never louder than its source and cannot clip on its own account.
fn fold_surround_to_stereo(input: &[f32]) -> Option<[f32; 2]> {
    let (centre, left_surrounds, right_surrounds) = match input.len() {
        // FL FR FC, and FL FR FC LFE: no surrounds to fold in either case.
        3 | 4 => (input[2], [None, None], [None, None]),
        // FL FR FC LFE BL BR
        6 => (input[2], [Some(input[4]), None], [Some(input[5]), None]),
        // FL FR FC LFE BL BR SL SR
        8 => (
            input[2],
            [Some(input[4]), Some(input[6])],
            [Some(input[5]), Some(input[7])],
        ),
        _ => return None,
    };

    let mut left = input[0] + FOLD_GAIN * centre;
    let mut right = input[1] + FOLD_GAIN * centre;
    let mut gain = 1.0 + FOLD_GAIN;
    for (left_channel, right_channel) in left_surrounds.iter().zip(right_surrounds.iter()) {
        let (Some(left_sample), Some(right_sample)) = (left_channel, right_channel) else {
            continue;
        };
        left += FOLD_GAIN * left_sample;
        right += FOLD_GAIN * right_sample;
        gain += FOLD_GAIN;
    }
    Some([left / gain, right / gain])
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
    fn surround_folds_down_instead_of_dropping_the_dialogue() {
        // 5.1 order is FL, FR, FC, LFE, BL, BR. Truncating to the first two would export a film
        // clip with the speech missing, because centre is where dialogue lives.
        let gain = 1.0 + 2.0 * super::FOLD_GAIN;
        let folded = remapped(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], 6, 2);
        assert_eq!(folded.len(), 2);
        assert!((folded[0] - (1.0 + super::FOLD_GAIN * (3.0 + 5.0)) / gain).abs() < 1e-6);
        assert!((folded[1] - (2.0 + super::FOLD_GAIN * (3.0 + 6.0)) / gain).abs() < 1e-6);
    }

    #[test]
    fn a_centre_only_signal_survives_the_fold_rather_than_vanishing() {
        // The failure this guards against, stated directly: dialogue panned to centre with silent
        // fronts must still be audible in the stereo result, and in both channels equally.
        let folded = remapped(&[0.0, 0.0, 0.8, 0.0, 0.0, 0.0], 6, 2);
        assert!(folded[0] > 0.1, "centre vanished from the left channel");
        assert!(
            (folded[0] - folded[1]).abs() < 1e-6,
            "centre must stay centred"
        );
    }

    #[test]
    fn folding_down_cannot_make_a_frame_louder_than_its_source() {
        // Normalised gain, so a fold-down never introduces clipping the source did not have.
        for frame in [
            [1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
            [-1.0, -1.0, -1.0, -1.0, -1.0, -1.0],
            [1.0, -1.0, 1.0, 0.0, -1.0, 1.0],
        ] {
            for sample in remapped(&frame, 6, 2) {
                assert!(sample.abs() <= 1.0, "{frame:?} folded to {sample}");
            }
        }
    }

    #[test]
    fn every_standard_surround_layout_folds_and_others_truncate() {
        // 3.0, 4.0 (3.1), 5.1 and 7.1 have centre third and fold; an unrecognised width falls back
        // to truncation rather than guessing which channel carries the dialogue.
        for channels in [3, 4, 6, 8] {
            let frame: Vec<f32> = (0..channels).map(|_| 0.0).collect();
            let mut centred = frame.clone();
            centred[2] = 1.0;
            let folded = remapped(&centred, channels, 2);
            assert!(folded[0] > 0.1, "{channels} channels dropped centre");
        }

        let five = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert_eq!(
            remapped(&five, 5, 2),
            vec![1.0, 2.0],
            "unknown width truncates"
        );
    }

    #[test]
    fn narrowing_that_is_not_a_surround_fold_keeps_the_leading_channels() {
        assert_eq!(remapped(&[1.0, 2.0, 3.0, 4.0], 4, 3), vec![1.0, 2.0, 3.0]);
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
