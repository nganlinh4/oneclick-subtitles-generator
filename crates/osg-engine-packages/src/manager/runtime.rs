//! Leased handles to a verified installed runtime.

use std::fmt;
use std::hash::Hash;
use std::path::{Path, PathBuf};

use crate::asset_catalog::{AssetPackageId, VOICE_SAMPLE_IDS};
use crate::catalog::EngineId;
use crate::path_security::{require_regular_file, resolve_owned};
use crate::speech_catalog::SpeechPackageId;
use crate::ui_font_catalog::{UI_FONT_SUBSETS, UiFontPackageId};
use crate::{PackageError, Result};

use super::state::RuntimeLease;
pub struct InstalledPackageRuntime<K: Eq + Hash + 'static> {
    pub(super) _lease: RuntimeLease<K>,
    pub(super) id: K,
    pub(super) version: String,
    pub(super) root: PathBuf,
    pub(super) python: PathBuf,
    pub(super) model: Option<PathBuf>,
    pub(super) aligner: Option<PathBuf>,
}

pub type InstalledRuntime = InstalledPackageRuntime<EngineId>;
pub type InstalledSpeechRuntime = InstalledPackageRuntime<SpeechPackageId>;
pub type InstalledAssetRuntime = InstalledPackageRuntime<AssetPackageId>;
pub type InstalledUiFontRuntime = InstalledPackageRuntime<UiFontPackageId>;

impl<K> fmt::Debug for InstalledPackageRuntime<K>
where
    K: Eq + Hash + fmt::Debug,
{
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("InstalledPackageRuntime")
            .field("id", &self.id)
            .field("version", &self.version)
            .field("python", &"<redacted>")
            .field("model", &"<redacted>")
            .field("aligner", &self.aligner.as_ref().map(|_| "<redacted>"))
            .finish_non_exhaustive()
    }
}

impl InstalledPackageRuntime<EngineId> {
    #[must_use]
    pub const fn engine(&self) -> EngineId {
        self.id
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub fn python(&self) -> &Path {
        &self.python
    }

    #[must_use]
    pub fn model(&self) -> &Path {
        self.model
            .as_deref()
            .expect("validated ASR deliveries always contain a model")
    }

    #[must_use]
    pub fn aligner(&self) -> Option<&Path> {
        self.aligner.as_deref()
    }
}

impl InstalledPackageRuntime<SpeechPackageId> {
    #[must_use]
    pub const fn backend(&self) -> SpeechPackageId {
        self.id
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub fn python(&self) -> &Path {
        &self.python
    }

    #[must_use]
    pub fn model(&self) -> Option<&Path> {
        self.model.as_deref()
    }
}

impl InstalledPackageRuntime<AssetPackageId> {
    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn voice_sample(&self, voice: &str) -> Result<PathBuf> {
        if !VOICE_SAMPLE_IDS.contains(&voice) {
            return Err(PackageError::InvalidRequest);
        }
        let path = resolve_owned(&self.root, &format!("samples/chirp3-hd-{voice}.wav"))?;
        require_regular_file(&path)?;
        Ok(path)
    }
}

impl InstalledPackageRuntime<UiFontPackageId> {
    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub fn stylesheet(&self) -> &Path {
        &self.python
    }

    pub fn font_file(&self, subset: &str) -> Result<PathBuf> {
        if !UI_FONT_SUBSETS.contains(&subset) {
            return Err(PackageError::InvalidRequest);
        }
        let path = resolve_owned(
            &self.root,
            &format!("runtime/google-sans-flex-{subset}.woff2"),
        )?;
        require_regular_file(&path)?;
        Ok(path)
    }
}
