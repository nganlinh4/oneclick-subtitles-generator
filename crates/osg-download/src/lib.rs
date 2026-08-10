//! Managed URL-media downloads through a single typed `yt-dlp` adapter.
//!
//! URLs and filesystem destinations are native-only capability values. They
//! intentionally do not implement deserialization, and their debug output is
//! redacted. The crate never accepts arbitrary process arguments.

mod binary;
mod engine;
mod error;
mod inventory;
mod path;
mod plan;
mod process;
mod progress;
mod registry;
mod url_guard;

pub use binary::{
    BinaryOrigin, JsRuntimeResolver, JsRuntimeSearch, ResolvedJsRuntime, ResolvedYtDlp,
    YtDlpResolver, YtDlpSearch,
};
pub use engine::{DownloadEngine, DownloadResult, DownloadSummary, ToolVersion};
pub use error::{DownloadError, Result};
pub use inventory::{
    AudioFormatOption, FormatContainer, FormatInventory, MediaInventory, QualityOption,
    SelectedFormat, SelectedSubtitle, SubtitleFormat, SubtitleSource, SubtitleTrackOption,
    VideoFormatOption,
};
pub use path::{DownloadDestination, FfmpegDirectory, SafeFileStem};
pub use plan::{
    AudioDownloadFormat, AudioQuality, BrowserCookieSource, DownloadPlan, MediaSelection,
    SubtitleSelection, VideoHeight, VideoQuality,
};
pub use process::{CancellationToken, RunControl};
pub use progress::{DownloadPhase, DownloadProgress, ProgressSink};
pub use registry::{
    InventoryCapability, InventoryId, InventoryRegistration, InventoryRegistry,
    MAX_INVENTORY_CAPABILITIES,
};
pub use url_guard::{AddressResolver, SystemResolver, UrlPolicy, UrlValidator, ValidatedMediaUrl};
