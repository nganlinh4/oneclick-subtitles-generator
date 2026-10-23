//! One supervision policy for every child process OSG starts: an allowlisted environment, a
//! console-free process group that dies with its owner, bounded output capture, and a shared
//! cooperative cancellation flag.

mod cancel;
mod capture;
pub mod environment;
mod group;
mod path;

pub use cancel::{CancellationToken, Cancelled};
pub use capture::{Capture, CaptureMode, LineObserver, capture_stream};
pub use group::{ManagedChild, Supervised, supervise};
pub use path::native_process_path;
