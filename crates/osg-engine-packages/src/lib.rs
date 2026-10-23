//! Native-only, manifest-gated lifecycle for optional ASR and speech packs, F5 language
//! checkpoints, voice samples, and the UI font.
//!
//! The `WebView` can select a reviewed typed package ID, but cannot provide a
//! URL, archive, filesystem path, process argument, or package manifest. A
//! release is installable only when its complete content-addressed inventory is
//! embedded in the application build. The checked-in catalog intentionally has
//! no published releases until real packs and their hashes exist.
//!
//! A published package's status and launch checks are backed by a full content-hash
//! verification (`receipt`), but a cold status probe pays that cost only once per
//! install: `verified_install` caches a completed verification as a durable, bounded
//! metadata-only receipt outside the published tree, so a later process's first probe
//! can confirm existence and size instead of re-hashing potentially tens of thousands
//! of files. See `verified_install`'s module documentation for the trade-off this
//! accepts and how it is bounded.

mod archive;
mod asset_catalog;
mod catalog;
mod delivery_manifest;
mod download;
mod error;
mod f5_catalog;
mod f5_models;
mod manager;
mod path_security;
mod receipt;
mod speech_catalog;
mod ui_font_catalog;
mod upstream_lock;
mod verified_install;

pub use asset_catalog::{AssetPackageId, AssetPackageInfo, VOICE_SAMPLE_IDS, asset_catalog};
pub use catalog::{EngineId, EnginePackageInfo, EngineRuntimeKind, catalog};
pub use error::{PackageError, Result};
pub use f5_catalog::{F5ModelInfo, f5_model_catalog};
pub use f5_models::F5ModelManager;
pub use manager::{
    AssetPackageManager, AssetPackageState, AssetPackageStatus, EnginePackageManager,
    EnginePackageState, EnginePackageStatus, InstalledAssetRuntime, InstalledRuntime,
    InstalledSpeechRuntime, InstalledUiFontRuntime, LegacyLayout, PackageState, RemovalOutcome,
    RuntimeCoordinator, SpeechPackageManager, SpeechPackageState, SpeechPackageStatus,
    SpeechRuntimeCoordinator, UiFontPackageManager, UiFontPackageState, UiFontPackageStatus,
};
pub use osg_delivery_core::{CancellationToken, OperationPhase, OperationProgress, ProgressSink};
pub use speech_catalog::{SpeechPackageId, SpeechPackageInfo, SpeechRuntimeKind, speech_catalog};
pub use ui_font_catalog::{UI_FONT_SUBSETS, UiFontPackageId, UiFontPackageInfo, ui_font_catalog};
