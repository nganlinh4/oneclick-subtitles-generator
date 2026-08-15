//! Wrapping caller bytes as a timestamped Media Foundation sample.
//!
//! The whole of the crate's pointer-level `unsafe` lives here, in two places: acquiring the lock on
//! a media buffer, and viewing the locked region as a slice. Everything that decides *what* to
//! write is safe code running inside the `fill` closure.

use core::ptr;
use core::slice;

use windows::Win32::Media::MediaFoundation::{
    IMFMediaBuffer, IMFSample, MFCreateMemoryBuffer, MFCreateSample,
};

use crate::error::{EncodeError, MfStage};
use crate::mf::platform::platform_error;

/// Builds a sample of `length` bytes at `timestamp_100ns` lasting `duration_100ns`, filled by
/// `fill`.
///
/// `fill` receives a mutable slice over the platform's buffer that is exactly `length` bytes long
/// and is expected to write all of it. The buffer's current length is set afterwards, so a short
/// write would be visible to the encoder as valid-but-stale bytes rather than as an error — which
/// is why every caller of this function hands over a total copy.
pub(crate) fn build_sample<Fill>(
    length: usize,
    timestamp_100ns: i64,
    duration_100ns: i64,
    fill: Fill,
) -> Result<IMFSample, EncodeError>
where
    Fill: FnOnce(&mut [u8]),
{
    let capacity = u32::try_from(length).map_err(|_| EncodeError::MediaFoundation {
        stage: MfStage::AllocateBuffer,
        code: 0,
    })?;

    // SAFETY: `MFCreateMemoryBuffer` takes a byte count by value and returns an owned,
    // reference-counted buffer that the bindings release on drop. Nothing is borrowed.
    let buffer = unsafe { MFCreateMemoryBuffer(capacity) }
        .map_err(|error| platform_error(MfStage::AllocateBuffer, &error))?;

    {
        let mut lock = BufferLock::acquire(&buffer, capacity)?;
        fill(lock.as_mut_slice());
    }

    // SAFETY: the buffer was allocated with `capacity` bytes and the lock above has been released,
    // so declaring `capacity` valid bytes is exactly the amount just written.
    unsafe { buffer.SetCurrentLength(capacity) }
        .map_err(|error| platform_error(MfStage::AllocateBuffer, &error))?;

    // SAFETY: `MFCreateSample` takes no arguments and returns an owned, reference-counted sample.
    let sample = unsafe { MFCreateSample() }
        .map_err(|error| platform_error(MfStage::CreateSample, &error))?;

    // SAFETY: `buffer` is a live interface for the duration of the call; the sample takes its own
    // reference rather than borrowing ours.
    unsafe { sample.AddBuffer(&buffer) }
        .map_err(|error| platform_error(MfStage::CreateSample, &error))?;

    // SAFETY: the timestamp is passed by value into a live sample.
    unsafe { sample.SetSampleTime(timestamp_100ns) }
        .map_err(|error| platform_error(MfStage::CreateSample, &error))?;

    // SAFETY: the duration is passed by value into a live sample.
    unsafe { sample.SetSampleDuration(duration_100ns) }
        .map_err(|error| platform_error(MfStage::CreateSample, &error))?;

    Ok(sample)
}

/// An acquired lock on a media buffer, released on drop.
///
/// The guard exists so the buffer is unlocked on every exit path, including a panic inside `fill`.
/// A media buffer that stays locked is never released by the platform and the sink writer deadlocks
/// on it.
#[derive(Debug)]
struct BufferLock<'buffer> {
    buffer: &'buffer IMFMediaBuffer,
    data: *mut u8,
    length: usize,
}

impl<'buffer> BufferLock<'buffer> {
    /// Locks `buffer` and checks that the platform really gave us `capacity` writable bytes.
    fn acquire(buffer: &'buffer IMFMediaBuffer, capacity: u32) -> Result<Self, EncodeError> {
        let mut data: *mut u8 = ptr::null_mut();
        let mut max_length: u32 = 0;

        // SAFETY: both out-parameters are live locals for the duration of the call. `Lock` writes a
        // pointer to the buffer's storage and its capacity, and the pointer stays valid until the
        // matching `Unlock`, which this guard's `Drop` performs.
        unsafe { buffer.Lock(&raw mut data, Some(&raw mut max_length), None) }
            .map_err(|error| platform_error(MfStage::LockBuffer, &error))?;

        // Constructed with a zero length first, so that any rejection below still unlocks.
        let mut guard = Self {
            buffer,
            data,
            length: 0,
        };
        let refused = EncodeError::MediaFoundation {
            stage: MfStage::LockBuffer,
            code: 0,
        };
        if guard.data.is_null() || max_length < capacity {
            return Err(refused);
        }
        guard.length = usize::try_from(capacity).map_err(|_| refused)?;
        Ok(guard)
    }

    /// The locked region, as a slice safe code can write into.
    fn as_mut_slice(&mut self) -> &mut [u8] {
        // SAFETY: `acquire` established that `data` is non-null and that the platform reported at
        // least `length` writable bytes behind it. The lock is held for as long as `self` lives, and
        // `&mut self` guarantees this is the only live view of the region.
        unsafe { slice::from_raw_parts_mut(self.data, self.length) }
    }
}

impl Drop for BufferLock<'_> {
    fn drop(&mut self) {
        // SAFETY: this guard is only constructed after a successful `Lock` on the same buffer, and
        // it is constructed exactly once per lock, so this is the matching `Unlock`. A failure here
        // cannot be reported from `drop` and cannot be recovered from either.
        let _ = unsafe { self.buffer.Unlock() };
    }
}
