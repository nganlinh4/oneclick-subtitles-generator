//! The typed refusals an export produces, and what this suite honestly cannot drive.
//!
//! # What a lost device has to produce
//!
//! `apps/desktop/src-tauri/src/render/refusal.rs` keys `renderDeviceLost` off exactly three
//! compositor refusals — [`CompositorError::NoAdapter`], [`CompositorError::DeviceUnavailable`] and
//! [`CompositorError::ReadbackFailed`] — reached through
//! [`ExportError::CompositionRejected`]. Everything else the compositor refuses becomes
//! `renderSceneRejected`, which tells the user something different: retrying will not help. So the
//! property that matters on this side of the boundary is that those three arrive at the mapping
//! **as** `CompositionRejected` carrying their own variant, rather than being flattened into a
//! generic composition failure the way `AtlasFaceMismatch` deliberately is.
//!
//! # What cannot be tested here, stated rather than faked
//!
//! **An export cannot be made to lose its device.** `osg_export::run_export` builds its own
//! compositor inside `FrameRenderer::open`, which calls `Compositor::new()`; there is no
//! adapter-selection seam on [`ExportJob`], so nothing a test can pass in will make that acquisition
//! fail on a machine whose GPU works. The fault-injection path that exists —
//! [`AdapterSelection::None`] — reaches the compositor and stops there.
//!
//! Writing an "export fails with `renderDeviceLost`" test anyway would mean asserting on a mapping
//! this suite never actually drove, which is the shape of coverage that is not coverage. So this
//! module asserts the two halves that *are* real — the refusal the no-device path produces, and that
//! an export refused before the encoder opens leaves nothing behind — and prints what is left
//! uncovered, so it is a known gap rather than a silent one.
//!
//! The gap is narrow. `run_export` acquires the device at `FrameRenderer::open`, which is **before**
//! `open_encoder` is ever called, so a device that cannot be acquired refuses on the same path this
//! module does drive: the one where no output file has been created yet. What is untested is the
//! frontend mapping of that refusal, and it is untested here because it lives in another crate.

use osg_compositor::{AdapterSelection, Compositor, CompositorError};
use osg_export::{ExportError, StagedText};

/// The three compositor refusals the frontend shows as a lost graphics device.
fn device_refusals() -> Vec<CompositorError> {
    vec![
        CompositorError::NoAdapter {
            reason: "no adapter".to_owned(),
        },
        CompositorError::DeviceUnavailable {
            reason: "device request failed".to_owned(),
        },
        CompositorError::ReadbackFailed {
            reason: "map failed".to_owned(),
        },
    ]
}

#[test]
fn a_compositor_with_no_backends_refuses_with_the_variant_the_frontend_calls_a_lost_device() {
    let _lock = super::exclusive();
    // The fault-injection path, driven for real rather than constructed: this is the code a machine
    // with no usable GPU takes, and it has to end in `NoAdapter` rather than in a panic or a
    // software fallback nobody asked for.
    let refused = Compositor::with_adapters(AdapterSelection::None)
        .expect_err("a compositor with no backends must not acquire a device");
    assert!(
        matches!(refused, CompositorError::NoAdapter { .. }),
        "the no-device path produced {refused} rather than a missing adapter"
    );
    println!("no-backend acquisition refused with: {refused}");

    // And the lift into the export's own vocabulary keeps the variant, because that variant is what
    // `render/refusal.rs` matches on. A refusal flattened here would reach the user as
    // "this render is not one the native compositor can draw" — advice to change the render, for a
    // failure changing the render cannot fix.
    for error in device_refusals() {
        let lifted = ExportError::from(error);
        let ExportError::CompositionRejected { reason } = &lifted else {
            panic!("a device refusal was lifted to {lifted} rather than a composition refusal");
        };
        assert!(
            matches!(
                reason,
                CompositorError::NoAdapter { .. }
                    | CompositorError::DeviceUnavailable { .. }
                    | CompositorError::ReadbackFailed { .. }
            ),
            "a device refusal reached the mapping as {reason}"
        );
    }
    println!(
        "{} device refusals reach the frontend mapping as composition refusals carrying their own \
         variant",
        device_refusals().len()
    );
    println!(
        "not covered here: an export that loses its device mid-run. `run_export` builds its own \
         compositor inside `FrameRenderer::open` and `ExportJob` carries no adapter selection, so \
         the acquisition cannot be made to fail from a test on a machine whose GPU works"
    );
}

/// An export refused where a lost device would refuse it — before the encoder is opened.
///
/// The staging is refused by the composition itself, which produces the same
/// [`ExportError::CompositionRejected`] a lost adapter produces and refuses it at the same point in
/// `run_export`: after the plan, before `open_encoder`. What is asserted is that no output file is
/// left at the location, and the assertion is not vacuous — the same location is then exported to
/// successfully, so a run that *did* leave a file behind would be seen.
#[cfg(windows)]
#[test]
fn an_export_refused_before_the_encoder_opens_leaves_no_file_at_the_output() {
    use tempfile::TempDir;

    use super::roundtrip;
    use super::{case::Case, matrix, sweep};

    let _lock = super::exclusive();
    let directory = TempDir::new().expect("a temporary directory");
    let source = roundtrip::clip(&directory, "refusal-source.mp4");
    let loaded = matrix::load();
    let case = Case::new(
        "refusal=no-pages",
        sweep::defaults(&loaded),
        loaded.text("latin").text.clone(),
        "480p",
        30,
    );
    let prepared = roundtrip::prepare_against(&source, &case);
    let output = directory.path().join("refused.mp4");

    // A staging with no atlas page at all: the runs are the ones the case really baked, so nothing
    // but the page list is wrong, and the composition is what refuses it.
    let pageless = StagedText::new(
        prepared.staged.face().clone(),
        Vec::new(),
        Vec::new(),
        vec![prepared.staged.run().clone()],
    );
    let error = roundtrip::export_text(&source, &output, None, &case, pageless)
        .expect_err("an export with no atlas page must not report success");
    assert!(
        matches!(error, ExportError::CompositionRejected { .. }),
        "the refusal was {error} rather than a composition refusal"
    );
    assert!(
        !output.exists(),
        "an export refused before the encoder opened left a container behind"
    );

    // The other half, which is what stops the assertion above from passing for a location nothing
    // could ever be written to.
    let summary = roundtrip::export(&source, &output, None, &case, &prepared)
        .expect("the same request with a real staging exports to the same location");
    assert!(output.is_file(), "the successful export produced no file");
    println!(
        "refused before the encoder: no file; the same location then took a {} byte export",
        summary.file_bytes()
    );
}
