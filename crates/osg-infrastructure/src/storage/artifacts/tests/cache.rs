//! Cache keys, commits, retention boundaries, leases, and orphan cleanup.

use super::*;

#[test]
fn cache_keys_are_framed_and_category_clear_preserves_shared_content() {
    let fixture = Fixture::new();
    let artifact = publish_cache(fixture.database(), "waveform", b"peak data");
    let first_category = CacheCategory::new("videos").expect("first category");
    let second_category = CacheCategory::new("videoTemp").expect("second category");
    let first_key = CacheKey::derive(&first_category, 1, &[b"ab", b"c"]).expect("first key");
    let ambiguous = CacheKey::derive(&first_category, 1, &[b"a", b"bc"]).expect("framed key");
    assert_ne!(first_key, ambiguous);
    let second_key = CacheKey::derive(&second_category, 2, &[b"ab", b"c"]).expect("second key");

    fixture
        .database()
        .put_cache_entry(
            &CacheWrite::new(
                first_key,
                artifact.record().id(),
                first_category.clone(),
                1,
                None,
            )
            .expect("first entry"),
        )
        .expect("put first cache");
    fixture
        .database()
        .put_cache_entry(
            &CacheWrite::new(
                second_key,
                artifact.record().id(),
                second_category.clone(),
                2,
                None,
            )
            .expect("second entry"),
        )
        .expect("put second cache");
    let info = fixture.database().cache_info().expect("cache info");
    assert_eq!(info.total_count, 1);
    assert_eq!(info.total_size_bytes, 9);
    assert_eq!(info.categories.len(), 2);

    let first_clear = fixture
        .database()
        .clear_cache_category(&first_category)
        .expect("clear first category");
    assert_eq!(first_clear.removed_count, 0);
    assert_eq!(first_clear.retained_shared_count, 1);
    assert!(
        fixture
            .database()
            .lookup_cache(first_key)
            .expect("first miss")
            .is_none()
    );
    assert!(
        fixture
            .database()
            .lookup_cache(second_key)
            .expect("second hit")
            .is_some()
    );

    let all_clear = fixture.database().clear_all_cache().expect("clear all");
    assert_eq!(all_clear.removed_count, 1);
    assert_eq!(all_clear.removed_size_bytes, 9);
    assert_eq!(
        fixture
            .database()
            .cache_info()
            .expect("empty info")
            .total_count,
        0
    );
    assert!(
        fixture
            .database()
            .get_artifact(artifact.record().id())
            .expect("artifact lookup")
            .is_none()
    );
}

#[test]
fn cache_commit_never_exposes_ready_artifact_without_its_requested_key() {
    let fixture = Fixture::new();
    let category = CacheCategory::new("waveform").expect("category");
    let key = CacheKey::derive(&category, 1, &[b"source-and-options"]).expect("key");
    let existing = publish_cache(fixture.database(), "waveformCache", b"existing bytes");
    fixture
        .database()
        .put_cache_entry(
            &CacheWrite::new(key, existing.record().id(), category.clone(), 1, None)
                .expect("existing write"),
        )
        .expect("existing cache row");

    let proposed_bytes = b"different staged bytes";
    let proposed = ArtifactDraft::new_cache(
        ArtifactKind::new("waveformCache").expect("kind"),
        ContentHash::digest(proposed_bytes),
        proposed_bytes.len() as u64,
        json!({"fixture": "atomic-cache-commit"}),
    )
    .expect("draft");
    let proposed = staging(
        fixture
            .database()
            .register_artifact(&proposed)
            .expect("register proposed cache"),
    );
    fs::write(proposed.path(), proposed_bytes).expect("stage proposed bytes");
    let proposed_id = proposed.record().id();
    let conflicting = CacheWrite::new(key, proposed_id, category, 1, None).expect("write");

    assert!(matches!(
        fixture.database().commit_cache_artifact(&conflicting),
        Err(DatabaseError::CacheKeyConflict)
    ));
    assert_eq!(
        fixture
            .database()
            .get_artifact(proposed_id)
            .expect("proposed record")
            .expect("pending proposed record")
            .state(),
        ArtifactState::Pending
    );
    assert_eq!(
        fixture
            .database()
            .lookup_cache(key)
            .expect("existing lookup")
            .expect("existing cache remains")
            .record()
            .id(),
        existing.record().id()
    );
}

#[test]
fn durable_content_can_back_cache_but_cache_content_cannot_become_durable_implicitly() {
    let fixture = Fixture::new();
    let bytes = b"shared durable bytes";
    let durable = publish(fixture.database(), "albumArt", bytes);
    let cache_draft = ArtifactDraft::new_cache(
        ArtifactKind::new("albumArt").expect("kind"),
        ContentHash::digest(bytes),
        bytes.len() as u64,
        json!({}),
    )
    .expect("cache draft");
    assert!(matches!(
        fixture.database().register_artifact(&cache_draft).expect("reuse durable"),
        ArtifactRegistration::Existing(record) if record.id() == durable.record().id()
    ));
    let category = CacheCategory::new("albumArt").expect("category");
    let key = CacheKey::derive(&category, 1, &[b"shared"]).expect("key");
    fixture
        .database()
        .put_cache_entry(
            &CacheWrite::new(key, durable.record().id(), category.clone(), 1, None)
                .expect("cache entry"),
        )
        .expect("put cache");
    let cleared = fixture
        .database()
        .clear_cache_category(&category)
        .expect("clear cache link");
    assert_eq!(cleared.removed_count, 0);
    assert_eq!(cleared.retained_shared_count, 1);
    assert!(
        fixture
            .database()
            .resolve_artifact(durable.record().id())
            .expect("resolve durable")
            .is_some()
    );

    let cached = publish_cache(fixture.database(), "waveform", b"derived only");
    let durable_draft = draft("waveform", b"derived only");
    assert!(matches!(
        fixture.database().register_artifact(&durable_draft),
        Err(DatabaseError::ArtifactReuseConflict(id)) if id == cached.record().id()
    ));
    fixture
        .database()
        .remove_artifact(durable.record().id())
        .expect("remove durable");
    fixture
        .database()
        .remove_artifact(cached.record().id())
        .expect("remove cache artifact");
}

#[test]
fn media_ownership_cannot_be_registered_with_cache_retention() {
    let fixture = Fixture::new();
    let bytes = b"media bytes must outlive cache keys";
    let draft = ArtifactDraft::new_cache(
        ArtifactKind::new("mediaSafetyFixture").expect("kind"),
        ContentHash::digest(bytes),
        bytes.len() as u64,
        json!({"fixture": true}),
    )
    .expect("cache draft");

    assert!(matches!(
        fixture
            .database()
            .register_media_artifact(&draft, AssetId::new(), JobId::new(),),
        Err(DatabaseError::InvalidArtifactMetadata)
    ));
    assert_eq!(
        fixture
            .database()
            .cache_info()
            .expect("cache remains empty")
            .total_count,
        0
    );
}

#[test]
fn active_cache_leases_prevent_clear_until_released() {
    let fixture = Fixture::new();
    let artifact = publish_cache(fixture.database(), "waveform", b"leased peaks");
    let category = CacheCategory::new("waveform").expect("category");
    let key = CacheKey::derive(&category, 1, &[b"media-hash"]).expect("key");
    fixture
        .database()
        .put_cache_entry(
            &CacheWrite::new(key, artifact.record().id(), category.clone(), 1, None)
                .expect("entry"),
        )
        .expect("put cache");
    let leased = fixture
        .database()
        .lease_cache(key, "waveformPlayer", 60_000)
        .expect("lease cache")
        .expect("cache hit");
    assert_eq!(leased.artifact().record().id(), artifact.record().id());
    fixture
        .database()
        .put_cache_entry(
            &CacheWrite::new(key, artifact.record().id(), category.clone(), 1, Some(0))
                .expect("expire entry"),
        )
        .expect("mark entry expired");
    assert!(
        fixture
            .database()
            .lookup_cache(key)
            .expect("expired lookup")
            .is_none()
    );

    let blocked = fixture
        .database()
        .clear_all_cache()
        .expect("clear while leased");
    assert_eq!(blocked.leased_count, 1);
    assert_eq!(blocked.removed_count, 0);
    assert!(
        fixture
            .database()
            .get_artifact(artifact.record().id())
            .expect("leased artifact")
            .is_some()
    );
    assert!(
        fixture
            .database()
            .release_cache_lease(leased.lease().id())
            .expect("release")
    );
    assert!(
        !fixture
            .database()
            .release_cache_lease(leased.lease().id())
            .expect("idempotent release")
    );
    assert_eq!(
        fixture
            .database()
            .cache_info()
            .expect("expire after release")
            .total_count,
        0
    );
    assert!(
        fixture
            .database()
            .get_artifact(artifact.record().id())
            .expect("expired artifact removed")
            .is_none()
    );
}

#[test]
fn startup_removes_cache_artifacts_never_linked_to_an_entry() {
    let mut fixture = Fixture::new();
    let artifact = publish_cache(fixture.database(), "waveform", b"abandoned peaks");
    let id = artifact.record().id();
    let path = artifact.path().to_owned();

    fixture.reopen();
    assert!(
        fixture
            .database()
            .get_artifact(id)
            .expect("lookup")
            .is_none()
    );
    assert!(!path.exists());
}
