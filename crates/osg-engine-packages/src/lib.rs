//! Native-only, manifest-gated lifecycle for optional ASR and speech packs.
//!
//! The `WebView` can select a reviewed typed package ID, but cannot provide a
//! URL, archive, filesystem path, process argument, or package manifest. A
//! release is installable only when its complete content-addressed inventory is
//! embedded in the application build. The checked-in catalog intentionally has
//! no published releases until real packs and their hashes exist.

mod archive;
mod cancellation;
mod catalog;
mod delivery_manifest;
mod download;
mod error;
mod manager;
mod path_security;
mod progress;
mod receipt;
mod render_catalog;
mod speech_catalog;
mod upstream_lock;

pub use cancellation::CancellationToken;
pub use catalog::{EngineId, EnginePackageInfo, EngineRuntimeKind, catalog};
pub use error::{PackageError, Result};
pub use manager::{
    EnginePackageManager, EnginePackageState, EnginePackageStatus, InstalledRenderRuntime,
    InstalledRuntime, InstalledSpeechRuntime, LegacyLayout, PackageState, RemovalOutcome,
    RenderPackageManager, RenderPackageState, RenderPackageStatus, RenderRuntimeCoordinator,
    RuntimeCoordinator, SpeechPackageManager, SpeechPackageState, SpeechPackageStatus,
    SpeechRuntimeCoordinator,
};
pub use progress::{OperationPhase, OperationProgress, ProgressSink};
pub use render_catalog::{RenderPackageId, RenderPackageInfo, render_catalog};
pub use speech_catalog::{SpeechPackageId, SpeechPackageInfo, SpeechRuntimeKind, speech_catalog};
