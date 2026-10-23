//! Opaque artifact and cache identifiers plus validated names: IDs, content hashes, cache keys,
//! kinds, categories, and failure codes.

use std::io::Read;

use serde::Serialize;
use uuid::{Uuid, Variant, Version};

use super::rows::{hex, validate_name};
use super::{MAX_CACHE_KEY_INPUT_BYTES, MAX_CACHE_KEY_PARTS};
use crate::storage::DatabaseError;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ArtifactId(Uuid);

impl ArtifactId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Result<Self, DatabaseError> {
        if value.get_version() == Some(Version::SortRand) && value.get_variant() == Variant::RFC4122
        {
            Ok(Self(value))
        } else {
            Err(DatabaseError::InvalidArtifactMetadata)
        }
    }

    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl Default for ArtifactId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for ArtifactId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

impl std::fmt::Display for ArtifactId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ContentHash([u8; 32]);

impl ContentHash {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub fn digest(bytes: &[u8]) -> Self {
        Self(*blake3::hash(bytes).as_bytes())
    }

    /// Computes a content hash incrementally without retaining the artifact in
    /// memory. The reader and any filesystem location remain native-only.
    pub fn digest_reader(mut reader: impl Read) -> std::io::Result<Self> {
        let mut hasher = blake3::Hasher::new();
        let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        Ok(Self(*hasher.finalize().as_bytes()))
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for ContentHash {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&hex(&self.0))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct CacheKey([u8; 32]);

impl CacheKey {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn derive(
        category: &CacheCategory,
        algorithm_version: u32,
        parts: &[&[u8]],
    ) -> Result<Self, DatabaseError> {
        if algorithm_version == 0
            || parts.is_empty()
            || parts.len() > MAX_CACHE_KEY_PARTS
            || parts
                .iter()
                .try_fold(0_usize, |total, part| {
                    total.checked_add(part.len()).filter(|total| {
                        *total <= MAX_CACHE_KEY_INPUT_BYTES && u32::try_from(part.len()).is_ok()
                    })
                })
                .is_none()
        {
            return Err(DatabaseError::InvalidCacheKey);
        }
        let category_length =
            u32::try_from(category.as_str().len()).map_err(|_| DatabaseError::InvalidCacheKey)?;
        let part_count = u32::try_from(parts.len()).map_err(|_| DatabaseError::InvalidCacheKey)?;
        let mut hasher = blake3::Hasher::new_derive_key("osg-cache-key-v1");
        hasher.update(&category_length.to_be_bytes());
        hasher.update(category.as_str().as_bytes());
        hasher.update(&algorithm_version.to_be_bytes());
        hasher.update(&part_count.to_be_bytes());
        for part in parts {
            let part_length =
                u32::try_from(part.len()).map_err(|_| DatabaseError::InvalidCacheKey)?;
            hasher.update(&part_length.to_be_bytes());
            hasher.update(part);
        }
        Ok(Self(*hasher.finalize().as_bytes()))
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for CacheKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&hex(&self.0))
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct CacheLeaseId(Uuid);

impl CacheLeaseId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl Default for CacheLeaseId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for CacheLeaseId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactKind(String);

impl ArtifactKind {
    pub fn new(value: impl Into<String>) -> Result<Self, DatabaseError> {
        let value = value.into();
        validate_name(&value)
            .then_some(Self(value))
            .ok_or(DatabaseError::InvalidArtifactKind)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheCategory(String);

impl CacheCategory {
    pub fn new(value: impl Into<String>) -> Result<Self, DatabaseError> {
        let value = value.into();
        validate_name(&value)
            .then_some(Self(value))
            .ok_or(DatabaseError::InvalidCacheCategory)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactFailureCode(String);

impl ArtifactFailureCode {
    pub fn new(value: impl Into<String>) -> Result<Self, DatabaseError> {
        let value = value.into();
        if !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            Ok(Self(value))
        } else {
            Err(DatabaseError::InvalidArtifactFailureCode)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
