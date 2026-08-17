//! The exhaustive parity gate's parts.

use std::sync::{Mutex, MutexGuard, PoisonError};

pub(crate) mod bake;
pub(crate) mod case;
pub(crate) mod compare;
pub(crate) mod coverage;
pub(crate) mod documents;
pub(crate) mod effects;
#[cfg(windows)]
pub(crate) mod hard;
pub(crate) mod matrix;
pub(crate) mod plans;
pub(crate) mod preview;
pub(crate) mod refusals;
#[cfg(windows)]
pub(crate) mod roundtrip;
pub(crate) mod sweep;
#[cfg(windows)]
pub(crate) mod trim;

/// Serialises everything in this binary that acquires a graphics adapter or the platform codecs.
///
/// The same observation `support::media` records: several `wgpu` devices and several Media
/// Foundation readers alive at once in one process is a shape the product never has, and it faulted
/// inside the platform layers when the suites created it. One lock, taken by every test here.
static GATE: Mutex<()> = Mutex::new(());

/// Takes that lock, ignoring poisoning so one failing case does not fail the rest.
pub(crate) fn exclusive() -> MutexGuard<'static, ()> {
    GATE.lock().unwrap_or_else(PoisonError::into_inner)
}
