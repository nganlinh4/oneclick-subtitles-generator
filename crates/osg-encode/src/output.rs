//! Where the encoder is allowed to write, checked before any platform call.
//!
//! The design note is explicit that the path never crosses the IPC boundary: it is derived inside
//! Rust from an opaque export identifier and consumed here. This module is the last gate before it
//! reaches `MFCreateSinkWriterFromURL`, and it is deliberately pure so the rules are testable
//! without a filesystem or a platform.

use std::path::Path;

use crate::error::{EncodeError, OutputRejection};

/// The longest path the encoder will hand to the platform, in UTF-16 code units.
///
/// The Win32 wide-character APIs cap at `32_767` including the terminator; the margin below leaves
/// room for the terminator and keeps the check comfortably inside the limit.
pub const MAX_OUTPUT_PATH_UNITS: usize = 32_000;

/// Checks that `path` names a file this encoder may create.
///
/// Purely structural: it never touches the filesystem, so it can run in a unit test on any
/// platform. The parent-directory check that does need the filesystem is left to the backend, which
/// reports [`OutputRejection::ParentMissing`].
///
/// # Errors
/// Returns [`EncodeError::OutputUnusable`] naming the structural rule that was broken.
pub fn check_output_path(path: &Path) -> Result<(), EncodeError> {
    let refuse = |reason| Err(EncodeError::OutputUnusable { reason });

    if !path.is_absolute() {
        return refuse(OutputRejection::NotAbsolute);
    }
    let Some(file_name) = path.file_name() else {
        return refuse(OutputRejection::NoFileName);
    };
    if file_name.is_empty() {
        return refuse(OutputRejection::NoFileName);
    }
    let is_mp4 = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"));
    if !is_mp4 {
        return refuse(OutputRejection::NotMp4);
    }
    // A NUL cannot survive the wide-string boundary: everything past it would be silently dropped
    // and the encoder would write to a different file than the caller named.
    if path.as_os_str().as_encoded_bytes().contains(&0) {
        return refuse(OutputRejection::InteriorNul);
    }
    if path.as_os_str().len() > MAX_OUTPUT_PATH_UNITS {
        return refuse(OutputRejection::TooLong);
    }
    Ok(())
}
