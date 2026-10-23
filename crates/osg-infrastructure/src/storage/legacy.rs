use std::fmt;

use serde::Serialize;
use uuid::{Uuid, Variant, Version};

use super::DatabaseError;

mod ledger;

pub(super) use ledger::{finish, interrupt_running, item_state, list, prepare, record_item};

pub const MAX_LEGACY_IMPORT_ITEMS: usize = 20_000;
const MAX_ITEM_KEY_BYTES: usize = 2_048;
const MAX_DETAIL_CODE_BYTES: usize = 128;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct LegacyImportId(Uuid);

impl LegacyImportId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub(crate) fn from_uuid(value: Uuid) -> Result<Self, DatabaseError> {
        if value.get_version() == Some(Version::SortRand) && value.get_variant() == Variant::RFC4122
        {
            Ok(Self(value))
        } else {
            Err(DatabaseError::InvalidLegacyImport)
        }
    }

    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl Default for LegacyImportId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for LegacyImportId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyImportSourceKind {
    ElectronRootV1,
}

impl LegacyImportSourceKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::ElectronRootV1 => "electronRootV1",
        }
    }

    fn parse(value: &str) -> Result<Self, DatabaseError> {
        match value {
            "electronRootV1" => Ok(Self::ElectronRootV1),
            _ => Err(DatabaseError::InvalidLegacyImport),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LegacyImportItemKind {
    Setting,
    Credential,
    Artifact,
    Ignored,
}

impl LegacyImportItemKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Setting => "setting",
            Self::Credential => "credential",
            Self::Artifact => "artifact",
            Self::Ignored => "ignored",
        }
    }

    fn parse(value: &str) -> Result<Self, DatabaseError> {
        match value {
            "setting" => Ok(Self::Setting),
            "credential" => Ok(Self::Credential),
            "artifact" => Ok(Self::Artifact),
            "ignored" => Ok(Self::Ignored),
            _ => Err(DatabaseError::InvalidLegacyImport),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyImportState {
    Running,
    Complete,
    Failed,
}

impl LegacyImportState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Complete => "complete",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self, DatabaseError> {
        match value {
            "pending" | "running" => Ok(Self::Running),
            "complete" => Ok(Self::Complete),
            "failed" => Ok(Self::Failed),
            _ => Err(DatabaseError::InvalidLegacyImport),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyImportItemState {
    Pending,
    Imported,
    Skipped,
    Failed,
}

impl LegacyImportItemState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Imported => "imported",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self, DatabaseError> {
        match value {
            "pending" => Ok(Self::Pending),
            "imported" => Ok(Self::Imported),
            "skipped" => Ok(Self::Skipped),
            "failed" => Ok(Self::Failed),
            _ => Err(DatabaseError::InvalidLegacyImport),
        }
    }

    const fn is_terminal(self) -> bool {
        matches!(self, Self::Imported | Self::Skipped)
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct LegacyImportItemKey(String);

impl LegacyImportItemKey {
    pub fn new(value: impl Into<String>) -> Result<Self, DatabaseError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_ITEM_KEY_BYTES
            || value.chars().any(char::is_control)
        {
            Err(DatabaseError::InvalidLegacyImport)
        } else {
            Ok(Self(value))
        }
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for LegacyImportItemKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted legacy item key>")
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct LegacyImportCandidate {
    key: LegacyImportItemKey,
    kind: LegacyImportItemKind,
}

impl LegacyImportCandidate {
    #[must_use]
    pub const fn new(key: LegacyImportItemKey, kind: LegacyImportItemKind) -> Self {
        Self { key, kind }
    }

    #[must_use]
    pub const fn key(&self) -> &LegacyImportItemKey {
        &self.key
    }

    #[must_use]
    pub const fn kind(&self) -> LegacyImportItemKind {
        self.kind
    }
}

impl fmt::Debug for LegacyImportCandidate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LegacyImportCandidate")
            .field("key", &self.key)
            .field("kind", &self.kind)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportCounts {
    pub pending: u64,
    pub imported: u64,
    pub skipped: u64,
    pub failed: u64,
}

impl LegacyImportCounts {
    fn increment(&mut self, state: LegacyImportItemState, count: u64) {
        match state {
            LegacyImportItemState::Pending => self.pending += count,
            LegacyImportItemState::Imported => self.imported += count,
            LegacyImportItemState::Skipped => self.skipped += count,
            LegacyImportItemState::Failed => self.failed += count,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportSummary {
    pub source_id: LegacyImportId,
    pub state: LegacyImportState,
    pub settings: LegacyImportCounts,
    pub credentials: LegacyImportCounts,
    pub artifacts: LegacyImportCounts,
    pub ignored: LegacyImportCounts,
}

impl LegacyImportSummary {
    #[must_use]
    pub const fn source_id(&self) -> LegacyImportId {
        self.source_id
    }

    #[must_use]
    pub const fn state(&self) -> LegacyImportState {
        self.state
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyImportItemOutcome {
    state: LegacyImportItemState,
    target_id: Option<Uuid>,
    detail_code: Option<&'static str>,
}

impl LegacyImportItemOutcome {
    #[must_use]
    pub const fn imported(target_id: Option<Uuid>) -> Self {
        Self {
            state: LegacyImportItemState::Imported,
            target_id,
            detail_code: None,
        }
    }

    #[must_use]
    pub const fn skipped(detail_code: &'static str) -> Self {
        Self {
            state: LegacyImportItemState::Skipped,
            target_id: None,
            detail_code: Some(detail_code),
        }
    }

    #[must_use]
    pub const fn failed(detail_code: &'static str) -> Self {
        Self {
            state: LegacyImportItemState::Failed,
            target_id: None,
            detail_code: Some(detail_code),
        }
    }
}

#[cfg(test)]
mod tests;
