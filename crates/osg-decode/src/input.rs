//! Where the decoder is allowed to read from, checked before any platform call.
//!
//! Same rule as the encoder's output gate, for the same reason: the path is derived inside Rust
//! from an opaque media identifier and never crosses the IPC boundary. This module is the last gate
//! before it reaches `MFCreateSourceReaderFromURL`, and it is deliberately pure so the rules are
//! testable without a filesystem or a platform.
//!
//! Nothing here inspects the file's contents. A source is untrusted regardless of where it lives,
//! and everything that decides whether its *bytes* are acceptable is in [`crate::limits`].

use std::path::Path;

use crate::error::{DecodeError, SourceRejection};

/// The longest path the decoder will hand to the platform, in UTF-16 code units.
///
/// The Win32 wide-character APIs cap at `32_767` including the terminator; the margin below leaves
/// room for the terminator and keeps the check comfortably inside the limit.
pub const MAX_SOURCE_PATH_UNITS: usize = 32_000;

/// Checks that `path` names a file this decoder may open.
///
/// Purely structural: it never touches the filesystem, so it can run in a unit test on any
/// platform. The existence check that does need the filesystem is left to the backend, which
/// reports [`SourceRejection::NotAFile`].
///
/// # Errors
/// Returns [`DecodeError::SourceUnusable`] naming the structural rule that was broken.
pub fn check_source_path(path: &Path) -> Result<(), DecodeError> {
    let refuse = |reason| Err(DecodeError::SourceUnusable { reason });

    if !path.is_absolute() {
        return refuse(SourceRejection::NotAbsolute);
    }
    let Some(file_name) = path.file_name() else {
        return refuse(SourceRejection::NoFileName);
    };
    if file_name.is_empty() {
        return refuse(SourceRejection::NoFileName);
    }
    // A NUL cannot survive the wide-string boundary: everything past it would be silently dropped
    // and the decoder would read a different file than the caller named.
    if path.as_os_str().as_encoded_bytes().contains(&0) {
        return refuse(SourceRejection::InteriorNul);
    }
    if path.as_os_str().len() > MAX_SOURCE_PATH_UNITS {
        return refuse(SourceRejection::TooLong);
    }
    Ok(())
}
