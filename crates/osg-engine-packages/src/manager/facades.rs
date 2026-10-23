//! Typed public managers: each one binds one builtin catalog to the generic manager.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use osg_runtime_staging::RuntimeStagingAuthority;

use crate::ProgressSink;
use crate::asset_catalog::{AssetDeliveryCatalog, AssetPackageId};
use crate::catalog::{DeliveryCatalog, EngineId, catalog};
use crate::speech_catalog::{SpeechDeliveryCatalog, SpeechPackageId, speech_catalog};
use crate::ui_font_catalog::{UiFontDeliveryCatalog, UiFontPackageId};
use crate::{CancellationToken, Result};

use super::legacy::LegacyLayout;
use super::runtime::{
    InstalledAssetRuntime, InstalledRuntime, InstalledSpeechRuntime, InstalledUiFontRuntime,
};
use super::state::ManagedPackageManager;
use super::{
    AssetPackageManager, AssetPackageStatus, EnginePackageManager, EnginePackageStatus,
    RemovalOutcome, RuntimeCoordinator, SpeechPackageManager, SpeechPackageStatus,
    SpeechRuntimeCoordinator, UiFontPackageManager, UiFontPackageStatus,
};
impl fmt::Debug for EnginePackageManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EnginePackageManager")
            .field("inner", &self.0)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for SpeechPackageManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechPackageManager")
            .field("inner", &self.0)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for AssetPackageManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AssetPackageManager")
            .field("inner", &self.0)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for UiFontPackageManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UiFontPackageManager")
            .field("inner", &self.0)
            .finish_non_exhaustive()
    }
}

impl EnginePackageManager {
    pub fn new(root: impl AsRef<Path>, coordinator: Arc<dyn RuntimeCoordinator>) -> Result<Self> {
        let catalog = DeliveryCatalog::builtin()?;
        let quiesce = Arc::new(move |engine| coordinator.quiesce(engine));
        Ok(Self(ManagedPackageManager::new(
            root.as_ref(),
            catalog,
            quiesce,
        )?))
    }

    pub fn new_with_staging_authority(
        root: impl AsRef<Path>,
        coordinator: Arc<dyn RuntimeCoordinator>,
        staging_authority: RuntimeStagingAuthority,
    ) -> Result<Self> {
        let catalog = DeliveryCatalog::builtin()?;
        let quiesce = Arc::new(move |engine| coordinator.quiesce(engine));
        Ok(Self(ManagedPackageManager::new_with_staging_authority(
            root.as_ref(),
            catalog,
            quiesce,
            staging_authority,
        )?))
    }

    /// `true` when the most recent attempt to persist `engine`'s fast-path verification receipt
    /// failed. See `ManagedPackageManager::receipt_write_degraded`.
    #[must_use]
    pub fn receipt_write_degraded(&self, engine: EngineId) -> bool {
        self.0.receipt_write_degraded(engine)
    }

    #[must_use]
    pub fn statuses(&self) -> Vec<EnginePackageStatus> {
        catalog().iter().map(|info| self.status(info.id)).collect()
    }

    #[must_use]
    pub fn status(&self, engine: EngineId) -> EnginePackageStatus {
        self.0.status(engine)
    }

    pub fn install(
        &self,
        engine: EngineId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<EnginePackageStatus> {
        self.0.install(engine, cancellation, progress)
    }

    pub fn adopt_legacy(
        &self,
        engine: EngineId,
        layout: &LegacyLayout,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<EnginePackageStatus> {
        self.0.adopt_legacy(engine, layout, cancellation, progress)
    }

    pub fn remove(
        &self,
        engine: EngineId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<RemovalOutcome> {
        self.0.remove(engine, cancellation, progress)
    }

    pub fn resolve_for_launch(
        &self,
        engine: EngineId,
        cancellation: &CancellationToken,
    ) -> Result<InstalledRuntime> {
        self.0.resolve_for_launch(engine, cancellation)
    }
}

impl SpeechPackageManager {
    pub fn new(
        root: impl AsRef<Path>,
        coordinator: Arc<dyn SpeechRuntimeCoordinator>,
    ) -> Result<Self> {
        let catalog = SpeechDeliveryCatalog::builtin()?;
        let quiesce = Arc::new(move |backend| coordinator.quiesce(backend));
        Ok(Self(ManagedPackageManager::new(
            root.as_ref(),
            catalog,
            quiesce,
        )?))
    }

    pub fn new_with_staging_authority(
        root: impl AsRef<Path>,
        coordinator: Arc<dyn SpeechRuntimeCoordinator>,
        staging_authority: RuntimeStagingAuthority,
    ) -> Result<Self> {
        let catalog = SpeechDeliveryCatalog::builtin()?;
        let quiesce = Arc::new(move |backend| coordinator.quiesce(backend));
        Ok(Self(ManagedPackageManager::new_with_staging_authority(
            root.as_ref(),
            catalog,
            quiesce,
            staging_authority,
        )?))
    }

    /// `true` when the most recent attempt to persist `backend`'s fast-path verification receipt
    /// failed. See `ManagedPackageManager::receipt_write_degraded`.
    #[must_use]
    pub fn receipt_write_degraded(&self, backend: SpeechPackageId) -> bool {
        self.0.receipt_write_degraded(backend)
    }

    #[must_use]
    pub fn statuses(&self) -> Vec<SpeechPackageStatus> {
        speech_catalog()
            .iter()
            .map(|info| self.status(info.id))
            .collect()
    }

    #[must_use]
    pub fn status(&self, backend: SpeechPackageId) -> SpeechPackageStatus {
        self.0.status(backend)
    }

    pub fn install(
        &self,
        backend: SpeechPackageId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<SpeechPackageStatus> {
        self.0.install(backend, cancellation, progress)
    }

    pub fn remove(
        &self,
        backend: SpeechPackageId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<RemovalOutcome> {
        self.0.remove(backend, cancellation, progress)
    }

    pub fn resolve_for_launch(
        &self,
        backend: SpeechPackageId,
        cancellation: &CancellationToken,
    ) -> Result<InstalledSpeechRuntime> {
        self.0.resolve_for_launch(backend, cancellation)
    }
}

impl AssetPackageManager {
    pub fn new(
        root: impl AsRef<Path>,
        quiesce: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    ) -> Result<Self> {
        let catalog = AssetDeliveryCatalog::builtin()?;
        let quiesce = Arc::new(move |_| quiesce());
        Ok(Self(ManagedPackageManager::new(
            root.as_ref(),
            catalog,
            quiesce,
        )?))
    }

    pub fn new_with_staging_authority(
        root: impl AsRef<Path>,
        quiesce: Arc<dyn Fn() -> Result<()> + Send + Sync>,
        staging_authority: RuntimeStagingAuthority,
    ) -> Result<Self> {
        let catalog = AssetDeliveryCatalog::builtin()?;
        let quiesce = Arc::new(move |_| quiesce());
        Ok(Self(ManagedPackageManager::new_with_staging_authority(
            root.as_ref(),
            catalog,
            quiesce,
            staging_authority,
        )?))
    }

    #[must_use]
    pub fn status(&self) -> AssetPackageStatus {
        self.0.status(AssetPackageId::GeminiVoiceSamples)
    }

    /// `true` when the most recent attempt to persist this package's fast-path verification
    /// receipt failed. See `ManagedPackageManager::receipt_write_degraded`.
    #[must_use]
    pub fn receipt_write_degraded(&self) -> bool {
        self.0
            .receipt_write_degraded(AssetPackageId::GeminiVoiceSamples)
    }

    pub fn install(
        &self,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<AssetPackageStatus> {
        self.0
            .install(AssetPackageId::GeminiVoiceSamples, cancellation, progress)
    }

    pub fn remove(
        &self,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<RemovalOutcome> {
        self.0
            .remove(AssetPackageId::GeminiVoiceSamples, cancellation, progress)
    }

    pub fn resolve(&self, cancellation: &CancellationToken) -> Result<InstalledAssetRuntime> {
        self.0
            .resolve_for_launch(AssetPackageId::GeminiVoiceSamples, cancellation)
    }
}

impl UiFontPackageManager {
    pub fn new(
        root: impl AsRef<Path>,
        quiesce: Arc<dyn Fn() -> Result<()> + Send + Sync>,
    ) -> Result<Self> {
        Self::with_bundled_sources(root, quiesce, None)
    }

    pub fn new_with_staging_authority(
        root: impl AsRef<Path>,
        quiesce: Arc<dyn Fn() -> Result<()> + Send + Sync>,
        staging_authority: RuntimeStagingAuthority,
    ) -> Result<Self> {
        Self::with_bundled_sources_and_staging_authority(root, quiesce, None, staging_authority)
    }

    /// As `new`, but installing from font bytes shipped with the application when they are present.
    ///
    /// This is what makes the default subtitle font work on a clean offline install: the same
    /// catalog, the same digests, no network. `bundle` is a directory of files named by their
    /// SHA-256; anything else in it is ignored.
    pub fn with_bundled_sources(
        root: impl AsRef<Path>,
        quiesce: Arc<dyn Fn() -> Result<()> + Send + Sync>,
        bundle: Option<PathBuf>,
    ) -> Result<Self> {
        let catalog = UiFontDeliveryCatalog::builtin()?;
        let quiesce = Arc::new(move |_| quiesce());
        Ok(Self(ManagedPackageManager::with_bundled_sources(
            root.as_ref(),
            catalog,
            quiesce,
            bundle,
        )?))
    }

    pub fn with_bundled_sources_and_staging_authority(
        root: impl AsRef<Path>,
        quiesce: Arc<dyn Fn() -> Result<()> + Send + Sync>,
        bundle: Option<PathBuf>,
        staging_authority: RuntimeStagingAuthority,
    ) -> Result<Self> {
        let catalog = UiFontDeliveryCatalog::builtin()?;
        let quiesce = Arc::new(move |_| quiesce());
        Ok(Self(
            ManagedPackageManager::with_bundled_sources_and_staging_authority(
                root.as_ref(),
                catalog,
                quiesce,
                bundle,
                staging_authority,
            )?,
        ))
    }

    #[must_use]
    pub fn status(&self) -> UiFontPackageStatus {
        self.0.status(UiFontPackageId::GoogleSansFlex)
    }

    /// `true` when the most recent attempt to persist this package's fast-path verification
    /// receipt failed. See `ManagedPackageManager::receipt_write_degraded`.
    #[must_use]
    pub fn receipt_write_degraded(&self) -> bool {
        self.0
            .receipt_write_degraded(UiFontPackageId::GoogleSansFlex)
    }

    pub fn install(
        &self,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<UiFontPackageStatus> {
        self.0
            .install(UiFontPackageId::GoogleSansFlex, cancellation, progress)
    }

    pub fn remove(
        &self,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<RemovalOutcome> {
        self.0
            .remove(UiFontPackageId::GoogleSansFlex, cancellation, progress)
    }

    pub fn resolve(&self, cancellation: &CancellationToken) -> Result<InstalledUiFontRuntime> {
        self.0
            .resolve_for_launch(UiFontPackageId::GoogleSansFlex, cancellation)
    }
}
