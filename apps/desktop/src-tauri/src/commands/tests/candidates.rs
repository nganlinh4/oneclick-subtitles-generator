//! Media clearing, candidate staging and fail-closed durable identity.

use super::*;
use crate::commands::{MAX_MEDIA_FILE_SIZE_BYTES, MediaCandidateResponse};
use crate::error::{CommandError, CommandResult};

#[test]
fn clear_advances_the_intent_and_invalidates_in_flight_activation() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let active_path = directory.path().join("active.mp4");
    let pending_path = directory.path().join("pending.mp4");
    fs::write(&active_path, vec![0x51; 1024]).expect("active fixture");
    fs::write(&pending_path, vec![0x52; 2048]).expect("pending fixture");
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

    let pending = inspect_media(&pending_path).expect("pending media");
    let pending_id = pending.asset().id();
    let pending_playback = media_server
        .register(pending.canonical_path())
        .expect("pending playback");
    let pending_playback_id = pending_playback.id;
    let pending_sequence = begin_media_activation(&editor, pending_id, false)
        .expect("begin pending")
        .expect("pending intent");

    let cleared = clear_activated_media(&editor, &media_server, None).expect("clear media");
    assert!(cleared.session.media.is_none());
    assert!(cleared.playback.is_none());
    assert!(
        !media_server
            .unregister(active_playback_id)
            .expect("active capability already removed")
    );
    assert!(
        commit_activated_media(
            &editor,
            &media_server,
            pending_sequence,
            pending_id,
            pending,
            pending_playback,
        )
        .expect("finish invalidated activation")
        .is_none()
    );
    assert!(
        !media_server
            .unregister(pending_playback_id)
            .expect("invalidated capability already removed")
    );
    let editor = editor.read().expect("editor read");
    assert!(editor.pending_media_activation.is_none());
    assert!(editor.snapshot().session.media.is_none());
}

#[test]
fn discarding_one_candidate_does_not_cancel_another_assets_intent() {
    let editor = RwLock::new(EditorSession::default());
    let discarded = AssetId::new();
    let winner = AssetId::new();
    let sequence = begin_media_activation(&editor, winner, false)
        .expect("begin winner")
        .expect("winner intent");

    invalidate_pending_media_activation(&editor, Some(discarded))
        .expect("discard unrelated candidate");
    {
        let editor = editor.read().expect("editor read");
        assert_eq!(editor.media_intent, sequence);
        assert_eq!(
            editor
                .pending_media_activation
                .map(|pending| pending.asset_id),
            Some(winner)
        );
    }

    invalidate_pending_media_activation(&editor, Some(winner)).expect("discard winner");
    let editor = editor.read().expect("editor read");
    assert!(editor.media_intent > sequence);
    assert!(editor.pending_media_activation.is_none());
}

#[test]
fn candidate_staging_is_path_free_and_leaves_the_editor_untouched() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(directory.path().join("database.sqlite3")).expect("database");
    let media_path = directory.path().join("private-recording.mp4");
    fs::write(&media_path, vec![0x2a; 32 * 1024]).expect("media fixture");
    let editor = EditorSession::default();
    let before = editor.snapshot();

    let candidate =
        prepare_media_candidate(&database, &media_path).expect("prepare media candidate");

    assert_eq!(editor.snapshot(), before);
    assert!(
        database
            .resolve_media(candidate.asset().id())
            .expect("resolve staged media")
            .is_some()
    );
    let value = serde_json::to_value(&candidate).expect("serialize candidate");
    let object = value.as_object().expect("candidate object");
    assert_eq!(
        object.keys().map(String::as_str).collect::<Vec<_>>(),
        ["asset", "contentIdentity"]
    );
    assert_eq!(value["contentIdentity"]["algorithm"], "blake3-256");
    assert_eq!(
        value["contentIdentity"]["digest"]
            .as_str()
            .expect("digest")
            .len(),
        64
    );
    assert_eq!(value["contentIdentity"]["sizeBytes"], 32 * 1024);
    let json = serde_json::to_string(&value).expect("candidate JSON");
    assert!(!json.contains(media_path.to_string_lossy().as_ref()));
    assert!(!json.to_ascii_lowercase().contains("path"));
    assert!(object.get("playback").is_none());
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let metadata = ProjectMetadata::new("Detached candidate").expect("project metadata");
    let project = database.create_project(&metadata).expect("create project");
    let authorization = ProjectMediaAuthorization {
        project_id: metadata.id(),
        expected_state_version: project.state_version(),
    };
    let error = reopen_media_asset(
        &database,
        &media_server,
        authorization,
        candidate.asset().id(),
    )
    .expect_err("detached candidates must not activate");
    assert_eq!(error.code(), "mediaUnavailable");
}

#[test]
fn missing_durable_media_identity_fails_closed() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(directory.path().join("database.sqlite3")).expect("database");
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");

    let metadata = ProjectMetadata::new("Missing media").expect("project metadata");
    let project = database.create_project(&metadata).expect("create project");
    let error = reopen_media_asset(
        &database,
        &media_server,
        ProjectMediaAuthorization {
            project_id: metadata.id(),
            expected_state_version: project.state_version(),
        },
        AssetId::new(),
    )
    .expect_err("unknown media must not reopen");

    assert_eq!(error.code(), "mediaUnavailable");
}

/// Stages a file as a path-free media candidate so the candidate wire shape stays covered.
fn prepare_media_candidate(
    database: &Database,
    path: &std::path::Path,
) -> CommandResult<MediaCandidateResponse> {
    let media = inspect_media(path)?;
    if media.asset().size_bytes() > MAX_MEDIA_FILE_SIZE_BYTES {
        return Err(CommandError::media_too_large());
    }
    let content_hash = database.remember_media_candidate(media.asset(), media.canonical_path())?;
    Ok(MediaCandidateResponse::new(
        media.asset().clone(),
        content_hash,
    ))
}
