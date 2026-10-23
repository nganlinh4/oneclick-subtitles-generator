//! Location sets: legacy rows without hashes, overflow recovery, ordering, and snapshot reuse.

use super::*;

#[test]
fn legacy_media_without_a_content_hash_fails_closed_until_reselected() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let path = directory.path().join("legacy.mp4");
    std::fs::write(&path, b"legacy").expect("fixture");
    let asset = MediaAsset::new("legacy.mp4", "mp4", 6, MediaKind::Video).expect("asset");
    database.remember_media(&asset, &path).expect("remember");

    let connection = rusqlite::Connection::open(&database_path).expect("inspect database");
    connection
        .execute(
            "UPDATE media_assets SET content_hash = NULL WHERE id = ?1",
            params![asset.id().as_uuid()],
        )
        .expect("simulate legacy null hash");
    drop(connection);

    assert!(
        database
            .resolve_media(asset.id())
            .expect("legacy resolve")
            .is_none()
    );
    database
        .remember_media(&asset, &path)
        .expect("explicit reselection fills hash");
    assert!(
        database
            .resolve_media(asset.id())
            .expect("reselected resolve")
            .is_some()
    );
}

#[test]
fn repeated_native_selections_reuse_one_owned_snapshot_location() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");

    for index in 0..crate::storage::media::MAX_MEDIA_LOCATION_CANDIDATES {
        let path = directory.path().join(format!("clip-{index}.mp4"));
        std::fs::write(&path, b"media").expect("media fixture");
        database
            .remember_media(&asset, &path)
            .expect("bounded location");
    }
    let overflow = directory.path().join("clip-overflow.mp4");
    std::fs::write(&overflow, b"media").expect("overflow fixture");
    database
        .remember_media(&asset, &overflow)
        .expect("newest location compacts the oldest");
    let retained: i64 = rusqlite::Connection::open(&database_path)
        .expect("inspect compacted locations")
        .query_row(
            "SELECT count(*) FROM media_locations WHERE media_id = ?1",
            [asset.id().as_uuid()],
            |row| row.get(0),
        )
        .expect("retained count");
    assert_eq!(retained, 1);
    assert!(
        database
            .resolve_media(asset.id())
            .expect("bounded resolve")
            .is_some()
    );
}

#[test]
fn null_hash_legacy_overflow_can_be_reselected_and_keeps_the_selected_path() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let selected = directory.path().join("selected.mp4");
    std::fs::write(&selected, b"media").expect("selected fixture");
    let selected = std::fs::canonicalize(selected).expect("canonical selected fixture");
    let selected_bytes = encode_path(&selected).expect("encoded selected path");
    let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");
    database
        .remember_media(&asset, &selected)
        .expect("initial selection");

    let mut connection = rusqlite::Connection::open(&database_path).expect("seed legacy rows");
    let transaction = connection.transaction().expect("legacy transaction");
    transaction
        .execute(
            "UPDATE media_assets SET content_hash = NULL WHERE id = ?1",
            [asset.id().as_uuid()],
        )
        .expect("legacy null hash");
    let hostile_timestamp = i64::MAX - 1;
    for index in 0..crate::storage::media::MAX_MEDIA_LOCATION_CANDIDATES {
        let legacy_path = directory.path().join(format!("legacy-{index}.mp4"));
        std::fs::write(&legacy_path, b"media").expect("legacy fixture");
        let legacy_path = std::fs::canonicalize(legacy_path).expect("canonical legacy fixture");
        transaction
            .execute(
                "INSERT INTO media_locations(
                       id, media_id, path_bytes, path_encoding, platform, available,
                       last_verified_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                params![
                    Uuid::now_v7(),
                    asset.id().as_uuid(),
                    encode_path(&legacy_path).expect("encoded legacy path"),
                    path_encoding(),
                    platform_name(),
                    hostile_timestamp,
                ],
            )
            .expect("overflow legacy location");
    }
    transaction.commit().expect("legacy overflow");

    database
        .remember_media(&asset, &selected)
        .expect("explicit reselection repairs null hash and overflow");
    let (retained, selected_retained, hash): (i64, i64, Vec<u8>) = connection
        .query_row(
            "SELECT
                   (SELECT count(*) FROM media_locations WHERE media_id = ?1),
                   (SELECT count(*) FROM media_locations
                    WHERE media_id = ?1 AND path_bytes = ?2 AND path_encoding = ?3),
                   content_hash
                 FROM media_assets WHERE id = ?1",
            params![asset.id().as_uuid(), selected_bytes, path_encoding()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("repaired legacy state");
    assert_eq!(
        retained,
        i64::try_from(crate::storage::media::MAX_MEDIA_LOCATION_CANDIDATES).expect("cap")
    );
    assert_eq!(selected_retained, 0);
    assert_eq!(hash, ContentHash::digest(b"media").as_bytes());
    let resolved = database
        .resolve_media(asset.id())
        .expect("resolve repaired asset")
        .expect("repaired media");
    assert_eq!(
        std::fs::read(resolved.path()).expect("resolved repaired bytes"),
        b"media"
    );
}

#[test]
fn oversized_legacy_location_sets_recover_a_valid_tail_and_compact_to_the_cap() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let valid_path = directory.path().join("valid.mp4");
    std::fs::write(&valid_path, b"media").expect("valid fixture");
    let valid_path = std::fs::canonicalize(valid_path).expect("canonical valid fixture");
    let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");
    database
        .remember_media(&asset, &valid_path)
        .expect("remember valid tail");

    let mut connection = rusqlite::Connection::open(&database_path).expect("seed legacy rows");
    let transaction = connection.transaction().expect("legacy transaction");
    transaction
        .execute(
            "UPDATE media_locations
                 SET available = 0, last_verified_at_ms = 1
                 WHERE media_id = ?1",
            [asset.id().as_uuid()],
        )
        .expect("demote valid legacy tail");
    for index in 0..crate::storage::media::MAX_MEDIA_LOCATION_CANDIDATES {
        let invalid_path = directory.path().join(format!("invalid-{index}.mp4"));
        std::fs::write(&invalid_path, b"other").expect("invalid fixture");
        let invalid_path = std::fs::canonicalize(invalid_path).expect("canonical invalid fixture");
        transaction
            .execute(
                "INSERT INTO media_locations(
                       id, media_id, path_bytes, path_encoding, platform, available,
                       last_verified_at_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 1, 2)",
                params![
                    Uuid::now_v7(),
                    asset.id().as_uuid(),
                    encode_path(&invalid_path).expect("encoded invalid path"),
                    path_encoding(),
                    platform_name(),
                ],
            )
            .expect("legacy overflow location");
    }
    transaction.commit().expect("legacy rows");

    let resolved = database
        .resolve_media(asset.id())
        .expect("recover overflow")
        .expect("valid tail");
    assert_ne!(resolved.path(), valid_path);
    assert_eq!(
        std::fs::read(resolved.path()).expect("owned snapshot bytes"),
        b"media"
    );
    let retained: i64 = connection
        .query_row(
            "SELECT count(*) FROM media_locations WHERE media_id = ?1",
            [asset.id().as_uuid()],
            |row| row.get(0),
        )
        .expect("retained locations");
    assert_eq!(
        retained,
        i64::try_from(crate::storage::media::MAX_MEDIA_LOCATION_CANDIDATES).expect("cap")
    );
}

#[test]
fn available_location_precedes_a_newer_unavailable_same_size_candidate() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let good_path = directory.path().join("good.mp4");
    let bad_path = directory.path().join("bad.mp4");
    std::fs::write(&good_path, b"media").expect("good fixture");
    std::fs::write(&bad_path, b"other").expect("same-size bad fixture");
    let good_path = std::fs::canonicalize(good_path).expect("canonical good fixture");
    let bad_path = std::fs::canonicalize(bad_path).expect("canonical bad fixture");
    let asset = MediaAsset::new("clip.mp4", "mp4", 5, MediaKind::Video).expect("asset");
    database
        .remember_media(&asset, &good_path)
        .expect("remember good media");

    let connection = rusqlite::Connection::open(&database_path).expect("seed bad location");
    connection
        .execute(
            "INSERT INTO media_locations(
                   id, media_id, path_bytes, path_encoding, platform, available,
                   last_verified_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
            params![
                Uuid::now_v7(),
                asset.id().as_uuid(),
                encode_path(&bad_path).expect("encoded bad path"),
                path_encoding(),
                platform_name(),
                i64::MAX - 1,
            ],
        )
        .expect("newest unavailable location");

    let artifact_root =
        crate::storage::artifacts::ArtifactRoot::prepare(&directory.path().join("artifacts"))
            .expect("artifact root");
    let plan = crate::storage::media::resolution_plan(
        &connection,
        &artifact_root,
        asset.id(),
        false,
        None,
    )
    .expect("resolution plan")
    .expect("known media");
    assert_eq!(plan.candidates.len(), 3);
    assert!(plan.candidates[0].managed_snapshot);
    assert_eq!(plan.candidates[2].path.as_deref(), Some(bad_path.as_path()));
    let first = database
        .resolve_media(asset.id())
        .expect("first resolution")
        .expect("available media");
    assert_ne!(first.path(), good_path);
    assert_ne!(first.path(), bad_path);
    assert_eq!(
        std::fs::read(first.path()).expect("snapshot bytes"),
        b"media"
    );
    let snapshot_path = first.path().to_owned();
    assert_eq!(
        database
            .resolve_media(asset.id())
            .expect("repeat resolution")
            .expect("available media")
            .path(),
        snapshot_path
    );
}
