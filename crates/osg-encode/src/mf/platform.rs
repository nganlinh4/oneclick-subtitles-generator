//! Bringing up COM and the Media Foundation platform, and translating their failures.
//!
//! This is one of the four files in the crate that contain `unsafe`. Each block below is a single
//! foreign call whose only precondition is the one the safety comment states.

use std::cell::Cell;
use std::path::Path;
use std::sync::OnceLock;

use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::Media::MediaFoundation::{MF_VERSION, MFSTARTUP_FULL, MFStartup};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

use crate::error::{EncodeError, MfStage, OutputRejection};

/// Translates a platform error into a typed, path-free failure.
///
/// The `HRESULT` is a fixed system status code, not caller data, so it is safe to keep; the
/// platform's human-readable message is dropped because it is locale-dependent and can quote
/// resource names.
pub(crate) fn platform_error(stage: MfStage, error: &windows::core::Error) -> EncodeError {
    EncodeError::MediaFoundation {
        stage,
        code: error.code().0.cast_unsigned(),
    }
}

thread_local! {
    /// Whether this thread has already joined the multithreaded apartment.
    static COM_APARTMENT: Cell<bool> = const { Cell::new(false) };
}

/// The result of the one-time platform startup, so a failure is reported identically every time.
static MEDIA_PLATFORM: OnceLock<Result<(), EncodeError>> = OnceLock::new();

/// Joins the multithreaded COM apartment for the calling thread, once.
///
/// A thread that is already in the multithreaded apartment succeeds; one that is in a
/// single-threaded apartment is left alone, because Media Foundation's free-threaded objects work
/// from either and forcing a change would break whatever put the thread there.
///
/// The matching `CoUninitialize` is deliberately never called. The reference implementation
/// records the same decision for `MFShutdown`: tearing the platform down under a process that may
/// still hold media objects is worse than letting the OS reclaim it at exit.
fn ensure_com_apartment() -> Result<(), EncodeError> {
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
            Err(EncodeError::MediaFoundation {
                stage: MfStage::ComApartment,
                code: status.0.cast_unsigned(),
            })
        }
    })
}

/// Starts the Media Foundation platform once per process.
///
/// `MFShutdown` is never called, for the reason recorded on [`ensure_com_apartment`].
pub(crate) fn ensure_media_foundation() -> Result<(), EncodeError> {
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
/// [`crate::output::check_output_path`] has already rejected interior NULs, so the terminator
/// pushed here is the only one in the buffer and the platform cannot see a truncated path.
///
/// # Errors
/// Returns [`EncodeError::OutputUnusable`] when the encoded path is longer than the platform
/// accepts.
pub(crate) fn wide_path(path: &Path) -> Result<Vec<u16>, EncodeError> {
    use std::os::windows::ffi::OsStrExt as _;

    let mut units: Vec<u16> = path.as_os_str().encode_wide().collect();
    if units.len() >= crate::output::MAX_OUTPUT_PATH_UNITS {
        return Err(EncodeError::OutputUnusable {
            reason: OutputRejection::TooLong,
        });
    }
    units.push(0);
    Ok(units)
}
