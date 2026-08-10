//! Content-addressed, direct-upstream delivery for optional native tools.
//!
//! Public status and lifecycle values contain no paths or URLs. Executable
//! paths only exist in an in-process [`ToolLease`] returned to trusted native
//! code. The embedded catalog is the sole authority for every downloaded byte.

mod archive;
mod cancellation;
mod catalog;
mod download;
mod error;
mod manager;
mod path_security;
mod progress;
mod receipt;
mod update;

pub use cancellation::CancellationToken;
pub use catalog::{ExecutableRole, NativeToolId, NativeToolInfo, catalog};
pub use error::{NativeToolError, Result};
pub use manager::{
    NativeToolManager, NativeToolState, NativeToolStatus, RemovalOutcome, RuntimeCoordinator,
    ToolLease,
};
pub use progress::{OperationPhase, OperationProgress, ProgressSink};
