//! Verified file access and durable publication: path encoding, snapshots, bounded digests, and
//! shared publications.

use super::*;

#[test]
fn native_path_encoding_is_lossless() {
    let path = std::env::current_dir()
        .expect("current directory")
        .join("unicode-한글-media.mp4");
    let encoded = encode_path(&path).expect("encoded path");
    assert_eq!(
        decode_path(&encoded, path_encoding()).as_deref(),
        Some(path.as_path())
    );
    assert!(decode_path(&encoded, "wrong-encoding").is_none());
}

#[test]
fn durable_location_uses_an_immutable_snapshot_even_when_source_mtime_is_restored() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database_path = directory.path().join("osg.sqlite3");
    let database = crate::storage::Database::open(&database_path).expect("database");
    let path = directory.path().join("selected.mp4");
    std::fs::write(&path, b"media").expect("fixture");
    let source_mtime = std::fs::metadata(&path)
        .expect("source metadata")
        .modified()
        .expect("source mtime");
    let asset = MediaAsset::new("selected.mp4", "mp4", 5, MediaKind::Video).expect("asset");

    database.remember_media(&asset, &path).expect("remember");
    let stored_hash: Vec<u8> = rusqlite::Connection::open(&database_path)
        .expect("inspect database")
        .query_row(
            "SELECT content_hash FROM media_assets WHERE id = ?1",
            [asset.id().as_uuid()],
            |row| row.get(0),
        )
        .expect("stored media hash");
    assert_eq!(stored_hash, ContentHash::digest(b"media").as_bytes());
    let snapshot_path = database
        .resolve_media(asset.id())
        .expect("resolve")
        .expect("managed snapshot")
        .path()
        .to_owned();
    assert_ne!(
        snapshot_path,
        std::fs::canonicalize(&path).expect("canonical source")
    );
    assert_eq!(
        std::fs::read(&snapshot_path).expect("snapshot bytes"),
        b"media"
    );

    let mismatch = MediaAsset::with_id(asset.id(), "different.mp4", "mp4", 5, MediaKind::Video)
        .expect("mismatch asset");
    assert!(matches!(
        database.remember_media(&mismatch, &path),
        Err(crate::storage::DatabaseError::MediaAssetMismatch(id)) if id == asset.id()
    ));

    std::fs::write(&path, b"other").expect("replace with same-size content");
    filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(source_mtime))
        .expect("restore source mtime");
    assert_eq!(
        database
            .resolve_media(asset.id())
            .expect("resolve changed source")
            .expect("immutable snapshot")
            .path(),
        snapshot_path
    );
    assert!(matches!(
        database.remember_media(&asset, &path),
        Err(DatabaseError::MediaAssetMismatch(id)) if id == asset.id()
    ));

    std::fs::write(&path, b"media").expect("restore original content");
    assert!(
        database
            .resolve_media(asset.id())
            .expect("resolve restored content")
            .is_some()
    );
}

#[test]
fn bounded_media_digest_rejects_growth_and_shrinkage() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("bounded.mp4");
    std::fs::write(&path, b"media").expect("fixture");
    let canonical = std::fs::canonicalize(&path).expect("canonical fixture");

    let verified = digest_media_file(&canonical, 5).expect("exact digest");
    assert_eq!(verified.content_hash, ContentHash::digest(b"media"));
    assert!(matches!(
        digest_media_file(&canonical, 4),
        Err(DatabaseError::InvalidMediaLocation)
    ));
    assert!(matches!(
        digest_media_file(&canonical, 6),
        Err(DatabaseError::InvalidMediaLocation)
    ));
}

#[test]
fn bounded_media_digest_rejects_a_path_replaced_after_the_handle_was_hashed() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("selected.mp4");
    let displaced = directory.path().join("displaced.mp4");
    std::fs::write(&path, b"media").expect("fixture");
    let canonical = std::fs::canonicalize(&path).expect("canonical fixture");

    let result = digest_media_file_with_post_hash(&canonical, 5, || {
        std::fs::rename(&canonical, &displaced).expect("displace opened file");
        std::fs::write(&canonical, b"media").expect("same-size replacement");
    });

    assert!(matches!(result, Err(DatabaseError::InvalidMediaLocation)));
}

#[test]
#[cfg(unix)]
fn unix_snapshot_rejects_same_length_post_copy_mutation_with_restored_mtime() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("mutable.mp4");
    std::fs::write(&path, b"before").expect("source fixture");
    let modified = std::fs::metadata(&path)
        .expect("source metadata")
        .modified()
        .expect("source mtime");
    let result = snapshot_media_file_with_post_copy(&path, 6, || {
        std::fs::write(&path, b"after!").expect("same-length hostile mutation");
        filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(modified))
            .expect("restore original mtime");
    });

    assert!(matches!(result, Err(DatabaseError::InvalidArtifactFile)));
}

#[test]
fn registered_handle_revalidation_rejects_same_size_in_place_mutation() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("mutable.mp4");
    std::fs::write(&path, b"before").expect("fixture");
    let canonical = std::fs::canonicalize(&path).expect("canonical fixture");
    // Use a normally shared handle to model a hostile writer which was already open before
    // registration.  Production Windows opens additionally deny later write sharing.
    let file = std::fs::File::open(&canonical).expect("open shared fixture");
    let asset = MediaAsset::new("mutable.mp4", "mp4", 6, MediaKind::Video).expect("asset");
    let resolved = crate::storage::media::ResolvedMedia::new(
        asset,
        canonical,
        file,
        ContentHash::digest(b"before"),
    );

    std::fs::write(&path, b"after!").expect("same-size mutation");

    assert!(matches!(
        resolved.revalidate_verified_file(),
        Err(DatabaseError::InvalidMediaLocation)
    ));
}

#[test]
fn known_media_publication_requires_metadata_to_match_the_published_asset() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database =
        crate::storage::Database::open(directory.path().join("osg.sqlite3")).expect("database");
    let source = directory.path().join("actual.mp4");
    std::fs::write(&source, b"media").expect("source fixture");
    let job = JobSnapshot::new(JobKind::DownloadMedia);
    database.create_job(&job).expect("job");
    let asset = MediaAsset::new("actual.mp4", "mp4", 5, MediaKind::Video).expect("asset");

    assert!(matches!(
        publish_durable_media_candidate(
            &database,
            job.id(),
            ArtifactKind::new("downloadedMedia").expect("kind"),
            asset.clone(),
            &source,
            serde_json::json!({
                "source": "urlDownload", "filename": "different.mp4"
            }),
        ),
        Err(DatabaseError::InvalidArtifactMetadata)
    ));
    assert!(
        database
            .resolve_media(asset.id())
            .expect("media lookup")
            .is_none()
    );
}

#[test]
fn durable_media_publication_retains_extensions_as_metadata_and_reuses_bytes() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = crate::storage::Database::open_with_artifact_root(
        directory.path().join("db/osg.sqlite3"),
        directory.path().join("artifacts"),
    )
    .expect("database");
    let job_id = JobId::new();
    database
        .create_job(&JobSnapshot::with_id(job_id, JobKind::RenderVideo))
        .expect("job");
    let source = directory.path().join("clip.mp4");
    std::fs::write(&source, b"durable clip bytes").expect("source");
    let first_asset =
        MediaAsset::new("clip.mp4", "mp4", 18, MediaKind::Video).expect("first asset");
    let first = publish_durable_media(
        &database,
        job_id,
        ArtifactKind::new("analysisClipTest").expect("kind"),
        first_asset.clone(),
        &source,
        serde_json::json!({"purpose": "geminiSegment"}),
    )
    .expect("first publication");
    assert!(first.path().extension().is_none());
    assert_eq!(first.asset(), &first_asset);
    assert!(!format!("{first:?}").contains(directory.path().to_string_lossy().as_ref()));

    let second_asset =
        MediaAsset::new("clip.mp4", "mp4", 18, MediaKind::Video).expect("second opaque asset");
    let second = publish_durable_media(
        &database,
        job_id,
        ArtifactKind::new("analysisClipTest").expect("kind"),
        second_asset.clone(),
        &source,
        serde_json::json!({"purpose": "geminiSegment"}),
    )
    .expect("deduplicated publication");
    assert_ne!(first_asset.id(), second_asset.id());
    assert_eq!(first.artifact_id(), second.artifact_id());
    assert_eq!(first.path(), second.path());

    std::fs::remove_file(&source).expect("remove transient source");
    database.clear_all_cache().expect("clear derived cache");
    for asset in [first_asset, second_asset] {
        let resolved = database
            .resolve_media(asset.id())
            .expect("resolve")
            .expect("durable media");
        assert_eq!(resolved.asset(), &asset);
        assert_eq!(
            std::fs::read(resolved.path()).expect("durable bytes"),
            b"durable clip bytes"
        );
    }
}

#[test]
fn concurrent_same_content_media_publications_share_one_ready_artifact() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = crate::storage::Database::open_with_artifact_root(
        directory.path().join("db/osg.sqlite3"),
        directory.path().join("artifacts"),
    )
    .expect("database");
    let job_id = JobId::new();
    database
        .create_job(&JobSnapshot::with_id(job_id, JobKind::DownloadMedia))
        .expect("job");
    let source = directory.path().join("shared.mp4");
    let bytes = vec![0x5d; 2 * 1024 * 1024];
    std::fs::write(&source, &bytes).expect("source");
    let size = u64::try_from(bytes.len()).expect("fixture size");
    let assets = [
        MediaAsset::new("first.mp4", "mp4", size, MediaKind::Video).expect("first asset"),
        MediaAsset::new("second.mp4", "mp4", size, MediaKind::Video).expect("second asset"),
    ];

    let publication_guard = crate::storage::media::MEDIA_PUBLICATION_LOCK
        .lock()
        .expect("publication lock");
    let (started, waiting) = std::sync::mpsc::sync_channel(2);
    let mut workers = Vec::new();
    for asset in assets.clone() {
        let database = database.clone();
        let source = source.clone();
        let started = started.clone();
        workers.push(std::thread::spawn(move || {
            started.send(()).expect("announce publisher");
            publish_durable_media(
                &database,
                job_id,
                ArtifactKind::new("concurrentMedia").expect("kind"),
                asset,
                &source,
                serde_json::json!({"fixture": "concurrent"}),
            )
        }));
    }
    waiting.recv().expect("first publisher waiting");
    waiting.recv().expect("second publisher waiting");
    drop(publication_guard);

    let first = workers
        .remove(0)
        .join()
        .expect("first thread")
        .expect("first publication");
    let second = workers
        .remove(0)
        .join()
        .expect("second thread")
        .expect("second publication");
    assert_eq!(first.artifact_id(), second.artifact_id());
    assert_eq!(
        database
            .get_artifact(first.artifact_id())
            .expect("artifact lookup")
            .expect("artifact exists")
            .state(),
        ArtifactState::Ready
    );
    for asset in assets {
        assert!(
            database
                .resolve_media(asset.id())
                .expect("resolve media")
                .is_some()
        );
    }
}
