//! The full-range Rec.709 declaration survives the encode/decode round trip.

use osg_decode::{DecoderConfig, open_decoder};
use tempfile::TempDir;

use super::{GREY_TOLERANCE, decoder_for, encoded_clip, measured_levels, output_timeline};

#[test]
fn the_full_range_the_encoder_declared_survives_the_round_trip() {
    // `osg-encode` writes `MFNominalRange_0_255` on purpose, and this is the assertion that the
    // decoder reads it back rather than assuming the studio range that compressed video usually
    // carries. If this ever regresses, every re-imported export comes back with crushed blacks.
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "range.mp4");
    let decoder = decoder_for(&clip);
    assert_eq!(
        decoder.source().colorimetry().range,
        osg_decode::NominalRange::Full,
        "the decoder did not read back the range the encoder declared"
    );
}

#[test]
fn decoding_the_same_clip_at_the_wrong_range_is_visibly_different() {
    // The proof that the range is applied and not decorative. The same bytes, decoded once as the
    // file declares itself and once as studio range, must disagree by far more than compression
    // noise — that disagreement is exactly the washed-out export the migration is guarding against.
    let directory = TempDir::new().expect("a temporary directory");
    let clip = encoded_clip(&directory, "wrong-range.mp4");

    let mut honest = decoder_for(&clip);
    let honest_levels = measured_levels(&honest.frame_for_output(0).expect("a frame"));

    let mistaken_config = DecoderConfig::new(output_timeline())
        .with_colorimetry(osg_decode::SourceColorimetry::STUDIO_BT709);
    let mut mistaken = open_decoder(&clip, mistaken_config)
        .expect("the clip opens with an overridden description");
    let mistaken_levels = measured_levels(&mistaken.frame_for_output(0).expect("a frame"));

    // The dark quadrant was encoded at 32. Read as studio range it lands near 19.
    assert!(
        (honest_levels[1] - 32).abs() <= GREY_TOLERANCE,
        "the honest decode put the dark quadrant at {}",
        honest_levels[1]
    );
    assert!(
        honest_levels[1] - mistaken_levels[1] >= 8,
        "reading the dark quadrant as studio range changed it from {} to {}, which is not enough \
         to say the range is being applied at all",
        honest_levels[1],
        mistaken_levels[1]
    );
    // The bright quadrant was encoded at 224 and moves the other way.
    assert!(
        mistaken_levels[3] - honest_levels[3] >= 8,
        "the bright quadrant moved from {} to {}",
        honest_levels[3],
        mistaken_levels[3]
    );
}
