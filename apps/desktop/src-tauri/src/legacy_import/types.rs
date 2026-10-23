//! Planning errors and the immutable import plan built from a scanned legacy root.

use std::fs::{self, File};
use std::path::PathBuf;

use osg_infrastructure::secrets::{CredentialPurpose, CredentialSetRequest};
use osg_infrastructure::storage::{ContentHash, LegacyImportCandidate};
use same_file::Handle;
use serde_json::Value;

use crate::error::CommandError;

#[derive(Clone, Copy, Debug)]
pub(super) enum PlanningError {
    Invalid,
    TooLarge,
    Io,
}

impl From<std::io::Error> for PlanningError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}

impl From<serde_json::Error> for PlanningError {
    fn from(_: serde_json::Error) -> Self {
        Self::Invalid
    }
}

impl From<PlanningError> for CommandError {
    fn from(error: PlanningError) -> Self {
        match error {
            PlanningError::Invalid | PlanningError::Io => Self::legacy_import_invalid(),
            PlanningError::TooLarge => Self::legacy_import_too_large(),
        }
    }
}

pub(super) struct LegacyImportPlan {
    pub(super) source_root: SourceRoot,
    pub(super) fingerprint: ContentHash,
    pub(super) items: Vec<PlannedItem>,
}

pub(super) struct PlannedItem {
    pub(super) candidate: LegacyImportCandidate,
    pub(super) work: ImportWork,
}

pub(super) enum ImportWork {
    Setting {
        key: String,
        value: Value,
    },
    Credential {
        purpose: CredentialPurpose,
        secret_fingerprint: ContentHash,
        request: CredentialSetRequest,
    },
    Artifact(PlannedArtifact),
    Ignored(&'static str),
}

pub(super) struct PlannedArtifact {
    pub(super) source_path: PathBuf,
    pub(super) kind: &'static str,
    pub(super) extension: String,
    pub(super) content_hash: ContentHash,
    pub(super) size_bytes: u64,
}

pub(super) struct ScannedFile {
    pub(super) source_path: PathBuf,
    pub(super) relative_path: String,
    pub(super) size_bytes: u64,
    pub(super) import: Option<ScannedArtifact>,
}

pub(super) struct ScannedArtifact {
    pub(super) kind: &'static str,
    pub(super) extension: String,
    pub(super) content_hash: ContentHash,
}

pub(super) struct SourceRoot {
    pub(super) canonical: PathBuf,
    pub(super) identity: Handle,
}

pub(super) struct ValidatedSourceFile {
    pub(super) file: File,
    pub(super) identity: Handle,
    pub(super) metadata: fs::Metadata,
}

pub(super) struct SensitiveBytes(pub(super) Vec<u8>);

impl Drop for SensitiveBytes {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}
