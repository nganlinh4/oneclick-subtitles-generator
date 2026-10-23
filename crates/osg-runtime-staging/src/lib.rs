//! Crash-recoverable ownership for large runtime staging entries.
//!
//! `tempfile` cleans up only when Rust gets to unwind. A killed desktop process therefore used to
//! strand downloads, renders, multi-gigabyte speech jobs and customer export `.part` files. The
//! authority below lives in OSG's private cache. It publishes and locks a durable central journal
//! *before* creating the large entry, even when that entry is in a user-selected directory. A
//! later process reclaims only an unlocked journal authenticated by the private authority secret;
//! adjacent filenames and public JSON shapes are never deletion authority.

mod authority;
mod filesystem;
mod journal;
mod kind;
mod locks;
mod owned;

pub use authority::{ReconcileReport, RuntimeStagingAuthority};
pub use kind::StagingKind;
pub use owned::{OwnedStagingDirectory, OwnedStagingFile};

const AUTHORITY_FILE: &str = ".osg-runtime-authority-v1.bin";
const METADATA_LOCK_FILE: &str = ".osg-runtime-metadata.lock";
const AUTHORITY_MAGIC: &[u8; 8] = b"OSGRTA01";
const AUTHORITY_BYTES: usize = AUTHORITY_MAGIC.len() + 32;
const AUTHORITY_TEMP_PREFIX: &str = ".osg-runtime-authority-write-";
const JOURNAL_TEMP_PREFIX: &str = ".osg-runtime-journal-write-";
const JOURNAL_PREFIX: &str = ".osg-runtime-journal-";
const JOURNAL_SCHEMA_VERSION: u32 = 1;
const JOURNAL_OWNER: &str = "one-click-subtitles-generator";
const MAX_JOURNAL_BYTES: u64 = 256 * 1024;
const MAX_ENCODED_PATH_UNITS: usize = 32_768;

#[cfg(test)]
mod tests;
