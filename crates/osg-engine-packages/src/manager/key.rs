//! The closed set of package-ID types one generic manager serves.

use std::fmt;
use std::hash::Hash;

use crate::PackageError;
use crate::asset_catalog::{AssetPackageId, asset_catalog};
use crate::catalog::{EngineId, catalog};
use crate::speech_catalog::{SpeechPackageId, speech_catalog};
use crate::ui_font_catalog::{UiFontPackageId, ui_font_catalog};

pub(super) trait ManagedPackageKey:
    Copy + Eq + Hash + fmt::Display + fmt::Debug + Send + Sync + 'static
{
    fn as_str(self) -> &'static str;
    fn label(self) -> &'static str;
    fn requires_aligner(self) -> bool;
    fn operation_in_progress(self) -> PackageError;
}

impl ManagedPackageKey for EngineId {
    fn as_str(self) -> &'static str {
        self.as_str()
    }

    fn label(self) -> &'static str {
        catalog()
            .iter()
            .find(|info| info.id == self)
            .map_or("Unknown ASR engine", |info| info.label)
    }

    fn requires_aligner(self) -> bool {
        self.requires_aligner()
    }

    fn operation_in_progress(self) -> PackageError {
        PackageError::OperationInProgress(self)
    }
}

impl ManagedPackageKey for SpeechPackageId {
    fn as_str(self) -> &'static str {
        self.as_str()
    }

    fn label(self) -> &'static str {
        speech_catalog()
            .iter()
            .find(|info| info.id == self)
            .map_or("Unknown speech backend", |info| info.label)
    }

    fn requires_aligner(self) -> bool {
        false
    }

    fn operation_in_progress(self) -> PackageError {
        PackageError::SpeechOperationInProgress(self)
    }
}

impl ManagedPackageKey for AssetPackageId {
    fn as_str(self) -> &'static str {
        self.as_str()
    }

    fn label(self) -> &'static str {
        asset_catalog()
            .iter()
            .find(|info| info.id == self)
            .map_or("Unknown asset package", |info| info.label)
    }

    fn requires_aligner(self) -> bool {
        false
    }

    fn operation_in_progress(self) -> PackageError {
        PackageError::AssetOperationInProgress(self)
    }
}

impl ManagedPackageKey for UiFontPackageId {
    fn as_str(self) -> &'static str {
        self.as_str()
    }

    fn label(self) -> &'static str {
        ui_font_catalog()
            .iter()
            .find(|info| info.id == self)
            .map_or("Unknown UI font package", |info| info.label)
    }

    fn requires_aligner(self) -> bool {
        false
    }

    fn operation_in_progress(self) -> PackageError {
        PackageError::UiFontOperationInProgress(self)
    }
}
