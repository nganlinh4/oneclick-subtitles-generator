//! The registry

use std::fmt;
use std::sync::{Arc, Mutex};

use osg_domain::AssetId;

use super::refusal::StagingRefusal;
use super::{MAX_STAGED_ATLASES, MAX_STAGED_BYTES, StagedGlyphAtlas};

struct StagedEntry {
    atlas_id: AssetId,
    atlas: Arc<StagedGlyphAtlas>,
    resident_bytes: u64,
}

impl fmt::Debug for StagedEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StagedEntry")
            .field("atlas_id", &self.atlas_id)
            .field("resident_bytes", &self.resident_bytes)
            .finish_non_exhaustive()
    }
}

/// Recomputed after every change rather than adjusted, so the bound can never drift away from what
/// is actually resident. The registry holds at most [`MAX_STAGED_ATLASES`] entries, so this is free.
fn total_resident_bytes(entries: &[StagedEntry]) -> u64 {
    entries.iter().map(|entry| entry.resident_bytes).sum()
}

/// Least recently used first, so the front of `entries` is always the next eviction.
#[derive(Debug)]
struct GlyphAtlasRegistry {
    entries: Vec<StagedEntry>,
    total_bytes: u64,
    max_atlases: usize,
    max_bytes: u64,
}

/// A bounded, least-recently-used registry of staged glyph atlases.
///
/// Bounded twice, by count and by retained pixel bytes, because either alone leaves the other
/// unbounded. Eviction order matches the `WebView`'s own handle cache, so the two sides forget the
/// same atlas first and a `WebView` cache miss simply re-stages it.
#[derive(Clone)]
pub(crate) struct GlyphAtlasStore(Arc<Mutex<GlyphAtlasRegistry>>);

impl fmt::Debug for GlyphAtlasStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GlyphAtlasStore")
            .field("registry", &"<redacted>")
            .finish()
    }
}

impl GlyphAtlasStore {
    /// Creates the registry with the shipped bounds.
    pub(crate) fn new() -> Self {
        Self::with_limits(MAX_STAGED_ATLASES, MAX_STAGED_BYTES)
    }

    pub(super) fn with_limits(max_atlases: usize, max_bytes: u64) -> Self {
        Self(Arc::new(Mutex::new(GlyphAtlasRegistry {
            entries: Vec::new(),
            total_bytes: 0,
            max_atlases,
            max_bytes,
        })))
    }

    /// Retains one checked atlas under a fresh opaque identifier, evicting as far as it must.
    ///
    /// A well-formed frame always fits, because the frame budget is below the registry budget, so
    /// eviction never has to refuse an atlas that passed decoding.
    pub(super) fn stage(&self, atlas: StagedGlyphAtlas) -> Result<AssetId, StagingRefusal> {
        let resident_bytes = atlas.resident_bytes();
        let atlas_id = AssetId::new();
        let mut registry = self.0.lock().map_err(|_| StagingRefusal::Unavailable)?;
        while !registry.entries.is_empty()
            && (registry.entries.len() >= registry.max_atlases
                || registry.total_bytes.saturating_add(resident_bytes) > registry.max_bytes)
        {
            registry.entries.remove(0);
            registry.total_bytes = total_resident_bytes(&registry.entries);
        }
        registry.entries.push(StagedEntry {
            atlas_id,
            atlas: Arc::new(atlas),
            resident_bytes,
        });
        registry.total_bytes = total_resident_bytes(&registry.entries);
        Ok(atlas_id)
    }

    /// Resolves a staged atlas by its opaque identifier and marks it most recently used.
    ///
    /// This is what makes the bound least-recently-*used* rather than least-recently-staged: the
    /// compositor's own reads decide what survives.
    #[allow(
        dead_code,
        reason = "the compositor wave consumes staged atlases by id; staging lands first"
    )]
    pub(crate) fn resolve(
        &self,
        atlas_id: AssetId,
    ) -> Result<Option<Arc<StagedGlyphAtlas>>, StagingRefusal> {
        let mut registry = self.0.lock().map_err(|_| StagingRefusal::Unavailable)?;
        let Some(index) = registry
            .entries
            .iter()
            .position(|entry| entry.atlas_id == atlas_id)
        else {
            return Ok(None);
        };
        let entry = registry.entries.remove(index);
        let atlas = Arc::clone(&entry.atlas);
        registry.entries.push(entry);
        Ok(Some(atlas))
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::{stage, valid_frame};
    use super::super::{MAX_STAGED_ATLASES, MAX_STAGED_BYTES};
    use super::GlyphAtlasStore;

    #[test]
    fn the_registry_evicts_the_least_recently_used_atlas_by_count() {
        let store = GlyphAtlasStore::with_limits(2, MAX_STAGED_BYTES);
        let first = store
            .stage(stage(&valid_frame()).expect("first"))
            .expect("id");
        let second = store
            .stage(stage(&valid_frame()).expect("second"))
            .expect("id");

        // Resolving the older atlas makes it the most recently used, so the newer one goes first.
        assert!(store.resolve(first).expect("resolve").is_some());
        let third = store
            .stage(stage(&valid_frame()).expect("third"))
            .expect("id");

        assert!(store.resolve(second).expect("resolve").is_none());
        assert!(store.resolve(first).expect("resolve").is_some());
        assert!(store.resolve(third).expect("resolve").is_some());
        assert_eq!(store.0.lock().expect("registry").entries.len(), 2);
    }

    #[test]
    fn the_registry_evicts_by_retained_bytes_before_it_reaches_its_count() {
        // Three 32-byte atlases do not fit a 64-byte budget, though three entries would fit eight.
        let store = GlyphAtlasStore::with_limits(MAX_STAGED_ATLASES, 64);
        let first = store
            .stage(stage(&valid_frame()).expect("first"))
            .expect("id");
        let second = store
            .stage(stage(&valid_frame()).expect("second"))
            .expect("id");
        assert_eq!(store.0.lock().expect("registry").total_bytes, 64);

        let third = store
            .stage(stage(&valid_frame()).expect("third"))
            .expect("id");

        assert!(store.resolve(first).expect("resolve").is_none());
        assert!(store.resolve(second).expect("resolve").is_some());
        assert!(store.resolve(third).expect("resolve").is_some());
        let registry = store.0.lock().expect("registry");
        assert_eq!(registry.entries.len(), 2);
        assert_eq!(registry.total_bytes, 64);
        assert!(registry.total_bytes <= registry.max_bytes);
    }
}
