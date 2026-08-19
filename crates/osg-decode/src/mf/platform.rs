//! Bringing up COM and the Media Foundation platform, and translating their failures.
//!
//! Each `unsafe` block below is a single foreign call whose only precondition is the one the safety
//! comment states.
//!
//! `MFShutdown` is never called. The reference implementation makes its shutdown a deliberate
//! no-op because tearing down the shared media platform breaks every later use of it in the same
//! process — and in this process the encoder is one of those later uses. The OS reclaims everything
//! at exit.

use std::borrow::Cow;
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::Media::MediaFoundation::{MF_VERSION, MFSTARTUP_FULL, MFStartup};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

use crate::error::{DecodeError, MfStage, SourceRejection};

/// Translates a platform error into a typed, path-free failure.
///
/// The `HRESULT` is a fixed system status code, not caller data, so it is safe to keep; the
/// platform's human-readable message is dropped because it is locale-dependent and can quote
/// resource names.
pub(crate) fn platform_error(stage: MfStage, error: &windows::core::Error) -> DecodeError {
    DecodeError::MediaFoundation {
        stage,
        code: error.code().0.cast_unsigned(),
    }
}

thread_local! {
    /// Whether this thread has already joined the multithreaded apartment.
    static COM_APARTMENT: Cell<bool> = const { Cell::new(false) };
}

/// The result of the one-time platform startup, so a failure is reported identically every time.
static MEDIA_PLATFORM: OnceLock<Result<(), DecodeError>> = OnceLock::new();

/// Joins the multithreaded COM apartment for the calling thread, once.
///
/// A thread that is already in the multithreaded apartment succeeds; one that is in a
/// single-threaded apartment is left alone, because Media Foundation's free-threaded objects work
/// from either and forcing a change would break whatever put the thread there.
///
/// The matching `CoUninitialize` is deliberately never called, for the reason recorded on this
/// module.
fn ensure_com_apartment() -> Result<(), DecodeError> {
    COM_APARTMENT.with(|joined| {
        if joined.get() {
            return Ok(());
        }
        // SAFETY: `CoInitializeEx` is callable from any thread at any time. `None` is the documented
        // value for the reserved parameter, and the returned `HRESULT` is inspected rather than
        // assumed. No pointer is retained and nothing outlives the call.
        let status = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if status.is_ok() || status == RPC_E_CHANGED_MODE {
            joined.set(true);
            Ok(())
        } else {
            Err(DecodeError::MediaFoundation {
                stage: MfStage::ComApartment,
                code: status.0.cast_unsigned(),
            })
        }
    })
}

/// Starts the Media Foundation platform once per process.
pub(crate) fn ensure_media_foundation() -> Result<(), DecodeError> {
    ensure_com_apartment()?;
    *MEDIA_PLATFORM.get_or_init(|| {
        // SAFETY: `MFStartup` takes a version constant and a flag, both supplied by the platform
        // bindings, and borrows nothing. It is idempotent per process and this `OnceLock` calls it
        // at most once regardless.
        let started = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) };
        started.map_err(|error| platform_error(MfStage::PlatformStartup, &error))
    })
}

/// Encodes `path` as a NUL-terminated wide string for the platform.
///
/// [`crate::input::check_source_path`] has already rejected interior NULs, so the terminator pushed
/// here is the only one in the buffer and the platform cannot see a truncated path.
///
/// # Errors
/// Returns [`DecodeError::SourceUnusable`] when the encoded path is longer than the platform
/// accepts.
pub(crate) fn wide_path(path: &Path) -> Result<Vec<u16>, DecodeError> {
    use std::os::windows::ffi::OsStrExt as _;

    let usable = without_verbatim_prefix(path);
    let mut units: Vec<u16> = usable.as_os_str().encode_wide().collect();
    if units.len() >= crate::input::MAX_SOURCE_PATH_UNITS {
        return Err(DecodeError::SourceUnusable {
            reason: SourceRejection::TooLong,
        });
    }
    units.push(0);
    Ok(units)
}

/// The same file, spelled the way Media Foundation's source resolver accepts.
///
/// `std::fs::canonicalize` returns a VERBATIM path on Windows -- `\\\\?\\C:\\...` -- and the application
/// canonicalizes every media location when it records it, which is the right thing for identity and
/// for refusing traversal. Media Foundation then refuses that spelling: `MFCreateSourceReaderFromURL`
/// reads the leading `\\\\` as a network share and fails with `ERROR_BAD_NETPATH` (0x80070035).
/// Measured, not assumed -- probing the identical bytes through the plain spelling succeeds and
/// through the verbatim spelling returns exactly that code.
///
/// So every locally imported file produced a preview that refused as unreadable, and an export that
/// would have failed the same way, because of how its path was written down.
///
/// The prefix is removed ONLY for an ordinary drive path that still fits what the platform accepts
/// without it. A verbatim UNC (`\\\\?\\UNC\\server\\share`) and anything longer than `MAX_PATH` keep the
/// prefix: for those it is load-bearing, and quietly rewriting them would trade one broken case for
/// another.
fn without_verbatim_prefix(path: &Path) -> Cow<'_, Path> {
    use std::path::{Component, Prefix};

    /// What `MFCreateSourceReaderFromURL` can open without the verbatim escape.
    const MAX_PATH: usize = 260;

    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return Cow::Borrowed(path);
    };
    // `VerbatimDisk` is the canonicalize output for a normal drive. `Verbatim` and `VerbatimUNC`
    // are deliberately not touched.
    let Prefix::VerbatimDisk(drive) = prefix.kind() else {
        return Cow::Borrowed(path);
    };

    let remainder = path.as_os_str().to_string_lossy();
    let Some(stripped) = remainder.get(4..) else {
        return Cow::Borrowed(path);
    };
    if stripped.len() >= MAX_PATH {
        return Cow::Borrowed(path);
    }
    debug_assert!(stripped.starts_with(char::from(drive).to_ascii_uppercase()));
    Cow::Owned(PathBuf::from(stripped))
}

#[cfg(test)]
mod tests {
    use super::without_verbatim_prefix;
    use std::path::{Path, PathBuf};

    /// A backslash, built rather than written so no editing step can eat the escape.
    const B: char = char::from_u32(92).unwrap();

    #[test]
    fn a_canonicalized_drive_path_loses_the_verbatim_escape() {
        // What `fs::canonicalize` returns for an ordinary file, and what Media Foundation refuses.
        let verbatim = PathBuf::from(format!("{B}{B}?{B}C:{B}media{B}clip.mp4"));
        let usable = without_verbatim_prefix(&verbatim);
        assert_eq!(
            usable.as_ref(),
            Path::new(&format!("C:{B}media{B}clip.mp4"))
        );
    }

    #[test]
    fn an_ordinary_path_is_returned_untouched() {
        let plain = PathBuf::from(format!("C:{B}media{B}clip.mp4"));
        assert_eq!(without_verbatim_prefix(&plain).as_ref(), plain.as_path());
    }

    #[test]
    fn a_verbatim_unc_path_keeps_its_prefix() {
        // Stripping this one would name a different location entirely, not a differently spelled
        // one, so it is left alone even though Media Foundation may still refuse it.
        let unc = PathBuf::from(format!("{B}{B}?{B}UNC{B}server{B}share{B}clip.mp4"));
        assert_eq!(without_verbatim_prefix(&unc).as_ref(), unc.as_path());
    }

    #[test]
    fn a_path_too_long_without_the_escape_keeps_it() {
        // The prefix is load-bearing here: removing it would produce a path the platform cannot
        // open at all, trading a wrong spelling for a wrong length.
        let long = format!("{B}{B}?{B}C:{B}{}{B}clip.mp4", "d".repeat(300));
        let path = PathBuf::from(&long);
        assert_eq!(without_verbatim_prefix(&path).as_ref(), path.as_path());
    }

    #[test]
    fn the_real_canonical_form_of_a_file_becomes_openable() {
        // Not a synthetic string: this is the exact spelling the storage layer records, because it
        // canonicalizes every media location before writing it down.
        let directory = tempfile::tempdir().expect("temp dir");
        let file = directory.path().join("clip.mp4");
        std::fs::write(&file, b"not really media").expect("write");
        let canonical = std::fs::canonicalize(&file).expect("canonicalize");

        let usable = without_verbatim_prefix(&canonical);
        assert!(
            !usable
                .as_os_str()
                .to_string_lossy()
                .starts_with(&format!("{B}{B}?")),
            "a canonicalized local path must not reach the platform in its verbatim form",
        );
        assert!(
            usable.exists(),
            "the rewritten spelling must name the same file"
        );
    }
}
