//! Media activation: revision scoping, replacement and restore ordering.

use super::*;

#[test]
fn reopens_extensionless_durable_media_from_trusted_asset_metadata() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(directory.path().join("database.sqlite3")).expect("database");
    let extensionless = directory.path().join("durable-media-object");
    let bytes = vec![0x5a; 32 * 1024];
    fs::write(&extensionless, &bytes).expect("durable media");
    let asset = MediaAsset::new(
        "download.mp4",
        "mp4",
        u64::try_from(bytes.len()).expect("fixture size"),
        MediaKind::Video,
    )
    .expect("asset");
    database
        .remember_media(&asset, &extensionless)
        .expect("remember media");
    let authorization = attach_media_to_project(&database, &asset);
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");

    let (media, playback) = reopen_media_asset(&database, &media_server, authorization, asset.id())
        .expect("reopen extensionless media");

    assert_eq!(media.asset(), &asset);
    assert_eq!(playback.mime_type, "video/mp4");
    assert_eq!(playback.byte_length, asset.size_bytes());
}

#[test]
fn activation_is_project_revision_scoped_and_rechecked_after_handle_verification() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(directory.path().join("database.sqlite3")).expect("database");
    let media_path = directory.path().join("authorized.mp4");
    fs::write(&media_path, vec![0x45; 32 * 1024]).expect("media fixture");
    let imported = inspect_media(&media_path).expect("inspect media");
    let asset = imported.asset().clone();
    database
        .remember_media_candidate(&asset, imported.canonical_path())
        .expect("stage media");

    let owner = ProjectMetadata::new("Owner project").expect("owner metadata");
    let base = database.create_project(&owner).expect("create owner");
    let attach = ProjectSnapshot::new(
        owner.clone(),
        base.state_version(),
        vec![asset.clone()],
        Vec::new(),
    )
    .expect("attach snapshot");
    let attached = database
        .commit_project(
            &attach,
            &RevisionReason::new("attach media").expect("revision reason"),
        )
        .expect("attach media");
    let authorization = ProjectMediaAuthorization {
        project_id: owner.id(),
        expected_state_version: attached.state_version,
    };
    let other = ProjectMetadata::new("Other project").expect("other metadata");
    let other_base = database.create_project(&other).expect("create other");
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");

    let cross_project = reopen_media_asset(
        &database,
        &media_server,
        ProjectMediaAuthorization {
            project_id: other.id(),
            expected_state_version: other_base.state_version(),
        },
        asset.id(),
    )
    .expect_err("another project cannot authorize this media");
    assert_eq!(cross_project.code(), "mediaUnavailable");

    let (media, playback) = reopen_media_asset(&database, &media_server, authorization, asset.id())
        .expect("hash and register authorized media");
    let playback_id = playback.id;
    let editor = RwLock::new(EditorSession::default());
    let sequence = begin_media_activation(&editor, asset.id(), false)
        .expect("begin activation")
        .expect("activation intent");

    let detach = ProjectSnapshot::new(owner, attached.state_version, Vec::new(), Vec::new())
        .expect("detach snapshot");
    database
        .commit_project(
            &detach,
            &RevisionReason::new("detach before activation commit").expect("revision reason"),
        )
        .expect("detach media");

    let error = commit_authorized_activated_media(
        &editor,
        &media_server,
        (&database, authorization),
        sequence,
        asset.id(),
        media,
        playback,
    )
    .expect_err("stale revision authorization must fail at final commit");
    assert_eq!(error.code(), "mediaUnavailable");
    assert!(
        editor
            .read()
            .expect("editor")
            .snapshot()
            .session
            .media
            .is_none()
    );
    assert!(
        !media_server
            .unregister(playback_id)
            .expect("stale playback was removed")
    );
}

#[test]
fn explicit_activation_replaces_the_previous_native_media() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let first_path = directory.path().join("persisted.mp4");
    let winner_path = directory.path().join("winner.mp4");
    fs::write(&first_path, vec![0x41; 1024]).expect("persisted fixture");
    fs::write(&winner_path, vec![0x42; 2048]).expect("winner fixture");
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let editor = RwLock::new(EditorSession::default());

    let persisted = inspect_media(&first_path).expect("persisted media");
    let persisted_id = persisted.asset().id();
    let persisted_playback = media_server
        .register(persisted.canonical_path())
        .expect("persisted playback");
    let persisted_playback_id = persisted_playback.id;
    let persisted_sequence = begin_media_activation(&editor, persisted_id, false)
        .expect("begin initial activation")
        .expect("initial activation intent");
    let restored = commit_activated_media(
        &editor,
        &media_server,
        persisted_sequence,
        persisted_id,
        persisted,
        persisted_playback,
    )
    .expect("initial activation")
    .expect("initial activation won");
    assert_eq!(
        restored.session.media.as_ref().map(MediaAsset::id),
        Some(persisted_id)
    );
    assert!(restored.playback.is_some());

    let winner = inspect_media(&winner_path).expect("winner media");
    let winner_id = winner.asset().id();
    let winner_playback = media_server
        .register(winner.canonical_path())
        .expect("winner playback");
    let winner_sequence = begin_media_activation(&editor, winner_id, false)
        .expect("begin winner activation")
        .expect("winner activation intent");
    let selected = commit_activated_media(
        &editor,
        &media_server,
        winner_sequence,
        winner_id,
        winner,
        winner_playback,
    )
    .expect("replacement activation")
    .expect("replacement activation won");
    assert_eq!(
        selected.session.media.as_ref().map(MediaAsset::id),
        Some(winner_id)
    );

    let final_snapshot = editor.read().expect("editor read").snapshot();
    assert_eq!(
        final_snapshot.session.media.as_ref().map(MediaAsset::id),
        Some(winner_id)
    );
    assert!(
        !media_server
            .unregister(persisted_playback_id)
            .expect("inspect previous playback cleanup")
    );
}

#[test]
fn delayed_restore_cannot_overwrite_a_newer_explicit_activation() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let restore_path = directory.path().join("restore.mp4");
    let winner_path = directory.path().join("winner.mp4");
    fs::write(&restore_path, vec![0x31; 1024]).expect("restore fixture");
    fs::write(&winner_path, vec![0x32; 2048]).expect("winner fixture");
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let editor = RwLock::new(EditorSession::default());

    let restore = inspect_media(&restore_path).expect("restore media");
    let restore_id = restore.asset().id();
    let restore_playback = media_server
        .register(restore.canonical_path())
        .expect("restore playback");
    let restore_playback_id = restore_playback.id;
    let restore_sequence = begin_media_activation(&editor, restore_id, true)
        .expect("begin restore")
        .expect("restore intent");

    let winner = inspect_media(&winner_path).expect("winner media");
    let winner_id = winner.asset().id();
    let winner_playback = media_server
        .register(winner.canonical_path())
        .expect("winner playback");
    let winner_sequence = begin_media_activation(&editor, winner_id, false)
        .expect("begin winner")
        .expect("winner intent");
    let winner_snapshot = commit_activated_media(
        &editor,
        &media_server,
        winner_sequence,
        winner_id,
        winner,
        winner_playback,
    )
    .expect("commit winner")
    .expect("winner remains current");
    assert_eq!(
        winner_snapshot.session.media.as_ref().map(MediaAsset::id),
        Some(winner_id)
    );

    assert!(
        commit_activated_media(
            &editor,
            &media_server,
            restore_sequence,
            restore_id,
            restore,
            restore_playback,
        )
        .expect("finish delayed restore")
        .is_none()
    );
    assert_eq!(
        editor
            .read()
            .expect("editor read")
            .snapshot()
            .session
            .media
            .as_ref()
            .map(MediaAsset::id),
        Some(winner_id)
    );
    assert!(
        !media_server
            .unregister(restore_playback_id)
            .expect("stale capability already removed")
    );
    assert!(
        begin_media_activation(&editor, restore_id, true)
            .expect("attempt occupied restore")
            .is_none()
    );
}

#[test]
fn conditional_clear_refuses_stale_or_in_flight_media_and_releases_only_the_exact_active_pair() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let active_path = directory.path().join("active.mp4");
    fs::write(&active_path, vec![0x51; 1024]).expect("active fixture");
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let editor = RwLock::new(EditorSession::default());

    let active = inspect_media(&active_path).expect("active media");
    let active_id = active.asset().id();
    let active_playback = media_server
        .register(active.canonical_path())
        .expect("active playback");
    let active_playback_id = active_playback.id;
    let active_sequence = begin_media_activation(&editor, active_id, false)
        .expect("begin active")
        .expect("active intent");
    commit_activated_media(
        &editor,
        &media_server,
        active_sequence,
        active_id,
        active,
        active_playback,
    )
    .expect("commit active")
    .expect("active wins");

    let stale = clear_activated_media(
        &editor,
        &media_server,
        Some((AssetId::new(), active_playback_id)),
    )
    .expect_err("stale asset must not clear active media");
    assert_eq!(stale.code(), "mediaSelectionChanged");

    let pending_id = AssetId::new();
    begin_media_activation(&editor, pending_id, false)
        .expect("begin replacement")
        .expect("replacement intent");
    let pending = clear_activated_media(
        &editor,
        &media_server,
        Some((active_id, active_playback_id)),
    )
    .expect_err("a newer in-flight selection must win");
    assert_eq!(pending.code(), "mediaSelectionChanged");
    assert_eq!(
        editor
            .read()
            .expect("editor read")
            .snapshot()
            .session
            .media
            .as_ref()
            .map(MediaAsset::id),
        Some(active_id),
    );

    invalidate_pending_media_activation(&editor, Some(pending_id)).expect("cancel replacement");
    let cleared = clear_activated_media(
        &editor,
        &media_server,
        Some((active_id, active_playback_id)),
    )
    .expect("clear exact media");
    assert!(cleared.session.media.is_none());
    assert!(cleared.playback.is_none());
    assert!(
        !media_server
            .unregister(active_playback_id)
            .expect("exact clear already withdrew capability")
    );
}
