//! The one implementation of the safety primitives every OSG delivery store relies on.
//!
//! `osg-engine-packages` and `osg-native-tools` keep their own catalogs, receipts, and store
//! layouts, but path validation, link/reparse refusal, store markers and locks, bounded archive
//! extraction, content hashing, trusted-URL checks, and cancellable HTTP transfer live here so
//! the two stores cannot drift apart again. Errors are path- and URL-free.

pub mod archive;
mod error;
pub mod files;
pub mod http;
pub mod identity;
pub mod paths;
mod progress;
pub mod store;
pub mod url_policy;

// Delivery work honors the same cooperative stop signal as supervised processes.
pub use error::{DeliveryError, Result};
pub use osg_process::{CancellationToken, Cancelled};
pub use progress::{OperationPhase, OperationProgress, ProgressSink};
