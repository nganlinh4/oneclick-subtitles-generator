//! The colour conversion, against values derived from the standard rather than from itself.
//!
//! The failure this guards against is not a crash. It is an export that is washed out, or one whose
//! blacks are crushed, in a way nobody notices until it is compared side by side with the preview it
//! was supposed to match. So the tests below do three separate things: they check the anchors that
//! must be exact, they check the whole space against an independent floating-point implementation of
//! the same standard, and they check that studio and full range actually *disagree* — because a
//! conversion that quietly ignored the range would pass the first two.

use osg_decode::{NominalRange, SourceColorimetry, YuvMatrix, YuvToRgb};

/// An independent reference conversion, written from the Rec.601/709 definitions in floating point.
///
/// Deliberately not the crate's arithmetic: comparing an implementation to itself proves nothing.
/// This is the textbook formula, and the crate's fixed-point version has to land within one level of
/// it everywhere.
fn reference(colorimetry: SourceColorimetry, luma: u8, blue: u8, red: u8) -> [f64; 3] {
    let red_luma = colorimetry.matrix.red_luma();
    let blue_luma = colorimetry.matrix.blue_luma();
    let green_luma = 1.0 - red_luma - blue_luma;

    let (luma, blue, red) = match colorimetry.range {
        NominalRange::Full => (
            f64::from(luma),
            f64::from(blue) - 128.0,
            f64::from(red) - 128.0,
        ),
        NominalRange::Studio => (
            (f64::from(luma) - 16.0) * 255.0 / 219.0,
            (f64::from(blue) - 128.0) * 255.0 / 224.0,
            (f64::from(red) - 128.0) * 255.0 / 224.0,
        ),
    };

    let to_red = 2.0 * (1.0 - red_luma);
    let to_blue = 2.0 * (1.0 - blue_luma);
    [
        luma + to_red * red,
        luma - to_blue * blue_luma / green_luma * blue - to_red * red_luma / green_luma * red,
        luma + to_blue * blue,
    ]
}

fn every_colorimetry() -> [SourceColorimetry; 4] {
    [
        SourceColorimetry::STUDIO_BT709,
        SourceColorimetry::FULL_BT709,
        SourceColorimetry::STUDIO_BT601,
        SourceColorimetry {
            range: NominalRange::Full,
            matrix: YuvMatrix::Bt601,
        },
    ]
}

#[test]
fn studio_range_black_and_white_land_exactly_on_the_ends() {
    let convert = YuvToRgb::new(SourceColorimetry::STUDIO_BT709);
    // 16 is studio black and 235 is studio white. Anything else here is the washed-out bug.
    assert_eq!(convert.pixel(16, 128, 128), [0, 0, 0]);
    assert_eq!(convert.pixel(235, 128, 128), [255, 255, 255]);
}

#[test]
fn full_range_black_and_white_land_exactly_on_the_ends() {
    let convert = YuvToRgb::new(SourceColorimetry::FULL_BT709);
    assert_eq!(convert.pixel(0, 128, 128), [0, 0, 0]);
    assert_eq!(convert.pixel(255, 128, 128), [255, 255, 255]);
    // Full range has no footroom and no headroom, so nothing is left over to clip.
    assert_eq!(convert.pixel(128, 128, 128), [128, 128, 128]);
}

#[test]
fn studio_range_footroom_and_headroom_clip_instead_of_wrapping() {
    let convert = YuvToRgb::new(SourceColorimetry::STUDIO_BT709);
    // A legal studio source may carry samples below 16 and above 235. They are blacker than black
    // and whiter than white; the honest answer is black and white, not a wrapped byte.
    assert_eq!(convert.pixel(0, 128, 128), [0, 0, 0]);
    assert_eq!(convert.pixel(255, 128, 128), [255, 255, 255]);
}

#[test]
fn the_two_ranges_disagree_by_enough_to_see() {
    // This is the whole point. A conversion that ignored the nominal range would pass every anchor
    // above and still be wrong on every real frame, so the disagreement is asserted directly.
    let studio = YuvToRgb::new(SourceColorimetry::STUDIO_BT709);
    let full = YuvToRgb::new(SourceColorimetry::FULL_BT709);

    // A dark grey. Read as studio when it is really full range, it comes back far darker.
    assert_eq!(full.pixel(32, 128, 128), [32, 32, 32]);
    assert_eq!(studio.pixel(32, 128, 128), [19, 19, 19]);

    // A bright grey. The same mistake pushes it up towards clipping.
    assert_eq!(full.pixel(200, 128, 128), [200, 200, 200]);
    assert_eq!(studio.pixel(200, 128, 128), [214, 214, 214]);
}

#[test]
fn a_neutral_sample_stays_neutral_in_every_description() {
    // No chroma excursion means no colour, whatever the matrix is. A green cast here would mean the
    // luma coefficients had been transposed.
    for colorimetry in every_colorimetry() {
        let convert = YuvToRgb::new(colorimetry);
        for luma in [16_u8, 64, 128, 200, 235] {
            let [red, green, blue] = convert.pixel(luma, 128, 128);
            assert_eq!(red, green, "{colorimetry:?} at luma {luma} is not neutral");
            assert_eq!(green, blue, "{colorimetry:?} at luma {luma} is not neutral");
        }
    }
}

#[test]
fn the_matrices_disagree_on_a_saturated_colour() {
    // Rec.601 and Rec.709 share their neutrals and differ on everything else. If they agreed here,
    // the matrix attribute would not be being read.
    let bt709 = YuvToRgb::new(SourceColorimetry::STUDIO_BT709);
    let bt601 = YuvToRgb::new(SourceColorimetry::STUDIO_BT601);
    let sample = (63_u8, 102_u8, 240_u8);

    let from_709 = bt709.pixel(sample.0, sample.1, sample.2);
    let from_601 = bt601.pixel(sample.0, sample.1, sample.2);
    assert_ne!(from_709, from_601);
}

#[test]
fn the_fixed_point_conversion_tracks_the_standard_everywhere() {
    // The sweep that actually proves the coefficients. Every combination below is compared against
    // the independent floating-point reference; one level is the whole tolerance, which is the
    // rounding of the final byte and nothing else.
    let samples = [0_u8, 1, 16, 17, 63, 100, 128, 129, 200, 235, 240, 254, 255];
    for colorimetry in every_colorimetry() {
        let convert = YuvToRgb::new(colorimetry);
        for luma in samples {
            for blue in samples {
                for red in samples {
                    let produced = convert.pixel(luma, blue, red);
                    let expected = reference(colorimetry, luma, blue, red);
                    for channel in 0..3 {
                        let want = expected[channel].round().clamp(0.0, 255.0);
                        let difference = f64::from(produced[channel]) - want;
                        assert!(
                            difference.abs() <= 1.0,
                            "{colorimetry:?} at ({luma}, {blue}, {red}) channel {channel}: \
                             produced {}, standard says {want}",
                            produced[channel]
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn an_undeclared_source_is_assumed_by_height_and_says_so() {
    // The convention every decoder shares: standard definition is Rec.601, high definition is
    // Rec.709, and neither is full range unless it says so.
    assert_eq!(
        SourceColorimetry::assumed_for(480),
        SourceColorimetry::STUDIO_BT601
    );
    assert_eq!(
        SourceColorimetry::assumed_for(720),
        SourceColorimetry::STUDIO_BT709
    );
    assert_eq!(
        SourceColorimetry::assumed_for(1080),
        SourceColorimetry::STUDIO_BT709
    );
}

#[test]
fn a_declared_description_beats_the_assumption() {
    use osg_decode::colorimetry::{
        MF_NOMINAL_RANGE_0_255, MF_NOMINAL_RANGE_16_235, MF_YUV_MATRIX_BT601, MF_YUV_MATRIX_BT709,
    };

    // A 1080p source that declares full range is believed, which is exactly what a re-imported OSG
    // export needs: `osg-encode` writes full range on purpose.
    assert_eq!(
        SourceColorimetry::from_attributes(Some(MF_NOMINAL_RANGE_0_255), None, 1080),
        Ok(SourceColorimetry::FULL_BT709)
    );
    // A standard-definition source that declares Rec.709 is believed too, against the convention.
    assert_eq!(
        SourceColorimetry::from_attributes(
            Some(MF_NOMINAL_RANGE_16_235),
            Some(MF_YUV_MATRIX_BT709),
            480
        ),
        Ok(SourceColorimetry::STUDIO_BT709)
    );
    assert_eq!(
        SourceColorimetry::from_attributes(None, Some(MF_YUV_MATRIX_BT601), 1080),
        Ok(SourceColorimetry::STUDIO_BT601)
    );
    // Zero is the platform's own "unknown" and must fall back rather than be read as an enumerant.
    assert_eq!(
        SourceColorimetry::from_attributes(Some(0), Some(0), 1080),
        Ok(SourceColorimetry::STUDIO_BT709)
    );
}

#[test]
fn a_description_that_cannot_be_reproduced_is_refused_rather_than_approximated() {
    use osg_decode::DecodeError;

    // MFNominalRange_48_208 and MFNominalRange_64_127 are narrower broadcast ranges, and 4 and 5 on
    // the matrix are Rec.2020, which would need tone mapping this crate does not do. Silently
    // treating any of them as the nearest supported description is a whole-image error.
    for range in [3_u32, 4] {
        assert_eq!(
            SourceColorimetry::from_attributes(Some(range), None, 1080),
            Err(DecodeError::UnsupportedColorimetry)
        );
    }
    for matrix in [3_u32, 4, 5] {
        assert_eq!(
            SourceColorimetry::from_attributes(None, Some(matrix), 1080),
            Err(DecodeError::UnsupportedColorimetry)
        );
    }
}
