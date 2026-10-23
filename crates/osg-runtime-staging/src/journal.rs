//! The authenticated central ownership journal that authorizes reclaiming one exact entry.

use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::authority::RuntimeStagingAuthority;
use crate::filesystem::{encode_path, root_identity};
use crate::kind::{EntryType, StagingKind};
use crate::{JOURNAL_OWNER, JOURNAL_SCHEMA_VERSION, MAX_ENCODED_PATH_UNITS};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RootIdentity {
    pub(crate) volume: u64,
    pub(crate) file: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OwnershipJournal {
    pub(crate) schema_version: u32,
    pub(crate) owner: String,
    pub(crate) kind: String,
    pub(crate) nonce: String,
    pub(crate) entry_type: EntryType,
    pub(crate) entry_name: String,
    pub(crate) target_root: Vec<u16>,
    pub(crate) target_identity: RootIdentity,
    pub(crate) authority_tag: String,
}

impl OwnershipJournal {
    pub(crate) fn new(
        authority: &RuntimeStagingAuthority,
        kind: StagingKind,
        nonce: String,
        target_root: &Path,
    ) -> io::Result<Self> {
        let target_identity = root_identity(target_root)?;
        let target_root = encode_path(target_root)?;
        let mut record = Self {
            schema_version: JOURNAL_SCHEMA_VERSION,
            owner: JOURNAL_OWNER.to_owned(),
            kind: kind.label().to_owned(),
            entry_type: kind.entry_type(),
            entry_name: kind.entry_name(&nonce),
            target_root,
            target_identity,
            authority_tag: String::new(),
            nonce,
        };
        record.authority_tag = record.expected_tag(&authority.inner.secret);
        Ok(record)
    }

    pub(crate) fn validate(
        &self,
        authority: &RuntimeStagingAuthority,
        journal_name: &str,
    ) -> io::Result<StagingKind> {
        let kind = StagingKind::parse(&self.kind).ok_or_else(invalid_journal)?;
        let valid_nonce = self.nonce.len() == 32
            && self
                .nonce
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
        if self.schema_version != JOURNAL_SCHEMA_VERSION
            || self.owner != JOURNAL_OWNER
            || self.entry_type != kind.entry_type()
            || !valid_nonce
            || self.entry_name != kind.entry_name(&self.nonce)
            || journal_name != kind.journal_name(&self.nonce)
            || self.target_root.is_empty()
            || self.target_root.len() > MAX_ENCODED_PATH_UNITS
            || self.authority_tag != self.expected_tag(&authority.inner.secret)
        {
            return Err(invalid_journal());
        }
        Ok(kind)
    }

    pub(crate) fn expected_tag(&self, secret: &[u8; 32]) -> String {
        let mut bytes = Vec::with_capacity(256 + self.target_root.len() * 2);
        bytes.extend_from_slice(&self.schema_version.to_le_bytes());
        for value in [
            self.owner.as_bytes(),
            self.kind.as_bytes(),
            self.nonce.as_bytes(),
            self.entry_name.as_bytes(),
        ] {
            bytes.extend_from_slice(&(value.len() as u64).to_le_bytes());
            bytes.extend_from_slice(value);
        }
        bytes.push(match self.entry_type {
            EntryType::Directory => 1,
            EntryType::File => 2,
        });
        bytes.extend_from_slice(&(self.target_root.len() as u64).to_le_bytes());
        for unit in &self.target_root {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes.extend_from_slice(&self.target_identity.volume.to_le_bytes());
        bytes.extend_from_slice(&self.target_identity.file.to_le_bytes());
        blake3::keyed_hash(secret, &bytes).to_hex().to_string()
    }
}

pub(crate) fn invalid_journal() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "runtime staging journal is invalid",
    )
}
