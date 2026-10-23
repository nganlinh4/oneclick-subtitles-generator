//! Manifest-gated install, verification, launch, and removal for every managed package kind.

use std::path::Path;

use serde::Serialize;

use crate::asset_catalog::AssetPackageId;
use crate::catalog::{EngineId, PackageDelivery};
use crate::speech_catalog::SpeechPackageId;
use crate::ui_font_catalog::UiFontPackageId;
use crate::{CancellationToken, Result};

mod facades;
mod files;
mod install;
mod key;
mod layout;
mod legacy;
mod recovery;
mod remove;
mod runtime;
mod state;
mod status;
mod verify;

pub use legacy::LegacyLayout;
pub use runtime::{
    InstalledAssetRuntime, InstalledRuntime, InstalledSpeechRuntime, InstalledUiFontRuntime,
};
use state::ManagedPackageManager;

const MIN_FREE_RESERVE_BYTES: u64 = 256 * 1024 * 1024;
type IntegrityVerifier =
    dyn Fn(&Path, &PackageDelivery, &CancellationToken) -> Result<()> + Send + Sync;

/// Desktop integration must terminate and reap the engine's supervised worker
/// process tree before package publication or removal can continue.
pub trait RuntimeCoordinator: Send + Sync {
    fn quiesce(&self, engine: EngineId) -> Result<()>;
}

/// Desktop integration must terminate and reap every worker using the speech
/// package before publication or removal can continue.
pub trait SpeechRuntimeCoordinator: Send + Sync {
    fn quiesce(&self, backend: SpeechPackageId) -> Result<()>;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackageState {
    Unavailable,
    Missing,
    Installed,
    UpdateAvailable,
    Corrupt,
}

pub type EnginePackageState = PackageState;
pub type SpeechPackageState = PackageState;
pub type AssetPackageState = PackageState;
pub type UiFontPackageState = PackageState;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageStatus<K> {
    pub id: K,
    pub label: &'static str,
    pub delivery_available: bool,
    pub installed: bool,
    pub update_available: bool,
    pub state: PackageState,
    pub version: Option<String>,
    pub available_version: Option<String>,
    pub installed_bytes: u64,
    pub download_bytes: u64,
    pub available_installed_bytes: u64,
}

pub type EnginePackageStatus = PackageStatus<EngineId>;
pub type SpeechPackageStatus = PackageStatus<SpeechPackageId>;
pub type AssetPackageStatus = PackageStatus<AssetPackageId>;
pub type UiFontPackageStatus = PackageStatus<UiFontPackageId>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemovalOutcome {
    Missing,
    Removed,
    PreservedModified,
}

#[derive(Clone)]
pub struct EnginePackageManager(ManagedPackageManager<EngineId>);

#[derive(Clone)]
pub struct SpeechPackageManager(ManagedPackageManager<SpeechPackageId>);

#[derive(Clone)]
pub struct AssetPackageManager(ManagedPackageManager<AssetPackageId>);

#[derive(Clone)]
pub struct UiFontPackageManager(ManagedPackageManager<UiFontPackageId>);

#[cfg(test)]
mod tests;
