//! Real H.264 files decode at the size they actually are.
//!
//! WHAT THIS EXISTS FOR. Media Foundation reports the unpadded size when a source is opened and the
//! decoder's real output type once decoding begins: 640x360 arrives in a 640x368 surface, 1920x1080
//! in 1920x1088, because H.264 codes in sixteen-pixel macroblocks. The reader used to treat that as
//! a source changing size mid-stream and refused it, so NO frame could be decoded for either size —
//! which is most real video.
//!
//! Accepting the padded surface alone would have been worse than refusing: the chroma plane begins
//! after the FULL surface, so converting at the picture height shifts colour, and the padding rows
//! hold whatever the encoder left there. So the fix carries the surface and the picture rectangle
//! separately, and these tests check the picture — its size, and that the padding never reaches it.

use std::path::{Path, PathBuf};

use osg_decode::{DecoderConfig, VideoDecoder};

/// The geometry fixtures, owned by the crate whose decoder they exercise.
///
/// They used to live under `e2e/fixtures/media`, where they were ALSO being handed to the
/// application as a stand-in for a downloaded video — which is what made a colour-bars clip look
/// like proof that the product could play what a customer plays. That use is gone: the journeys
/// download a real video now.
///
/// These files stay, because they are not stand-ins for anything. Each one is a real encode that
/// carries a geometry a decoder gets wrong in a specific way: a 1080p frame whose surface is
/// macroblock-padded to 1088 rows, a rotation only the container declares, a non-square pixel
/// aspect, an already-aligned frame that must not be "corrected", and a padded frame whose bottom
/// rows must be the picture rather than the encoder's leftovers. None of them can be obtained on
/// demand from a video-sharing site, and every one of them was a real defect before it was a test.
fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn open(path: &Path) -> Box<dyn VideoDecoder> {
    let timeline =
        osg_scene::FrameTimeline::new(30, 1, 1, osg_scene::ExactTime::ZERO).expect("timeline");
    osg_decode::open_decoder(path, DecoderConfig::new(timeline))
        .unwrap_or_else(|error| panic!("{} must open: {error:?}", path.display()))
}

/// Every pixel of a decoded frame, as `(r, g, b, a)` at `(x, y)`.
fn pixel(frame: &osg_decode::DecodedFrame, x: usize, y: usize) -> [u8; 4] {
    frame.pixel(x, y).expect("pixel inside the frame")
}

#[test]
fn a_source_whose_height_is_not_a_multiple_of_sixteen_decodes_its_first_frame() {
    let path = fixture("bars-6s-640x360.mp4");
    let mut decoder = open(&path);

    let opened = decoder.source();
    assert_eq!(opened.display_width(), 640);
    assert_eq!(opened.display_height(), 360);

    let frame = decoder
        .frame_for_output(0)
        .expect("the first frame of an ordinary 360p video must decode");
    assert_eq!(frame.width(), 640);
    assert_eq!(frame.height(), 360);

    // The surface really is padded once the decoder settles on its output type, which is the
    // condition this test exists for. Asserted AFTER decoding, because before the first sample the
    // reader only knows what the file advertised. If a platform ever stops padding, this says so
    // rather than passing quietly with the crop untested.
    let settled = decoder.source();
    assert_eq!(
        settled.coded_geometry().height(),
        368,
        "expected the decoder to pad 360 rows into a 368-row surface",
    );
    assert_eq!(
        settled.display_height(),
        360,
        "the picture must stay 360 rows"
    );
}

#[test]
fn a_1080p_source_decodes_at_1080_rows() {
    // 1080 is not a multiple of sixteen either, so this is the same defect at the size most video is.
    let mut decoder = open(&fixture("bars-1s-1920x1080.mp4"));
    let opened = decoder.source();
    assert_eq!(
        (opened.display_width(), opened.display_height()),
        (1920, 1080)
    );

    let frame = decoder.frame_for_output(0).expect("1080p must decode");
    assert_eq!((frame.width(), frame.height()), (1920, 1080));

    let settled = decoder.source();
    assert_eq!(settled.coded_geometry().height(), 1088);
    assert_eq!(settled.display_height(), 1080);
}

#[test]
fn an_aligned_source_is_unaffected() {
    // The control: 480 IS a multiple of sixteen, so there is no padding and nothing to crop. If this
    // ever diverges from the padded cases, the crop is being applied where it should not be.
    let mut decoder = open(&fixture("bars-1s-640x480-aligned.mp4"));
    let info = decoder.source();
    assert_eq!((info.display_width(), info.display_height()), (640, 480));
    assert_eq!(info.coded_geometry().height(), 480);

    let frame = decoder
        .frame_for_output(0)
        .expect("an aligned source must decode");
    assert_eq!((frame.width(), frame.height()), (640, 480));
}

#[test]
fn the_bottom_rows_of_a_padded_frame_are_the_picture_that_belongs_there() {
    // The assertion a size check cannot make. This fixture is blue for its first 352 rows and red
    // for its last eight, encoded losslessly, so the eight rows that sit exactly where the
    // macroblock padding would be have a colour of their own. A crop that took the wrong rows, or
    // let the padding through, shows up here as the wrong colour rather than as the right size.
    let mut decoder = open(&fixture("bands-1s-640x360-redfoot.mp4"));
    let frame = decoder.frame_for_output(0).expect("decode");
    assert_eq!((frame.width(), frame.height()), (640, 360));

    let red_enough = |[r, g, b, a]: [u8; 4]| a == u8::MAX && r > 150 && g < 90 && b < 90;
    let blue_enough = |[r, g, b, a]: [u8; 4]| a == u8::MAX && b > 150 && r < 90 && g < 90;

    for x in [0, 320, 639] {
        assert!(
            blue_enough(pixel(&frame, x, 0)),
            "top row is not the blue band at x={x}"
        );
        assert!(
            blue_enough(pixel(&frame, x, 351)),
            "row 351 is not the blue band at x={x}"
        );
        // The rows that occupy the padding's position must be the picture's own last rows.
        assert!(
            red_enough(pixel(&frame, x, 352)),
            "row 352 is not the red foot at x={x}"
        );
        assert!(
            red_enough(pixel(&frame, x, 359)),
            "the final row is not the red foot at x={x}"
        );
    }

    // Chroma boundary: the red foot begins on an even row, so its first chroma row must be red
    // through. A crop with an odd origin would sample the blue band's chroma here.
    for y in [352, 353, 358, 359] {
        assert!(
            red_enough(pixel(&frame, 1, y)),
            "chroma edge wrong at row {y}"
        );
    }
}

#[test]
fn a_rotated_source_reports_its_upright_size() {
    let path = fixture("bars-1s-640x360-rotated.mp4");
    let mut decoder = open(&path);
    let info = decoder.source();

    // Whether the container's rotation survives remuxing is the platform's business; what must hold
    // is that the frame handed out matches what the source reports, padding excluded either way.
    let frame = decoder
        .frame_for_output(0)
        .expect("a rotated source must decode");
    assert_eq!(
        (frame.width(), frame.height()),
        (
            info.display_width() as usize,
            info.display_height() as usize
        ),
        "the decoded frame must match the size the source reports",
    );
}

#[test]
fn an_anamorphic_source_displays_wider_than_it_decodes() {
    // Non-square pixels: the decoded frame stays on its own grid and the DISPLAY size is stretched.
    // The crop must not disturb that relationship.
    let mut decoder = open(&fixture("bars-1s-720x480-anamorphic.mp4"));
    let info = decoder.source();
    let frame = decoder
        .frame_for_output(0)
        .expect("an anamorphic source must decode");

    assert_eq!((frame.width(), frame.height()), (720, 480));
    assert!(
        info.display_width() > 720,
        "a 16:9 720x480 source must display wider than it decodes, got {}",
        info.display_width(),
    );
    assert_eq!(info.display_height(), 480);
}
