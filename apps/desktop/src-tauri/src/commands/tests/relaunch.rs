//! Relaunch restore: the host-owned active-workspace record reopens exactly its project's media in
//! a new process, and fails closed once that project no longer owns that media.

use std::path::Path;

use osg_infrastructure::storage::{ActiveWorkspace, ActiveWorkspacePointer};
use uuid::Uuid;

use super::*;

const URL_ALIAS: &str = "site_example_relaunch_clip_mp4";

#[derive(Clone, Copy)]
enum Acquisition {
    /// `select_media` / drop claim: remembered with no lifecycle until a project commit owns it.
    Picked,
    /// URL download: remembered as a disposable candidate until a project commit claims it.
    Downloaded,
}

struct OwnedMedia {
    asset: MediaAsset,
    metadata: ProjectMetadata,
    state_version: u64,
    pointer: ActiveWorkspacePointer,
}

fn import_media(
    database: &Database,
    directory: &Path,
    (name, fill): (&str, u8),
    how: Acquisition,
) -> MediaAsset {
    let path = directory.join(name);
    fs::write(&path, vec![fill; 32 * 1024]).expect("media fixture");
    let imported = inspect_media(&path).expect("inspect media");
    let asset = imported.asset().clone();
    match how {
        Acquisition::Picked => database.remember_media(&asset, imported.canonical_path()),
        Acquisition::Downloaded => {
            database.remember_media_candidate(&asset, imported.canonical_path())
        }
    }
    .expect("remember media");
    asset
}

fn commit_media(
    database: &Database,
    metadata: &ProjectMetadata,
    version: u64,
    media: Vec<MediaAsset>,
) -> u64 {
    let snapshot = ProjectSnapshot::new(metadata.clone(), version, media, Vec::new())
        .expect("project snapshot");
    database
        .commit_project(
            &snapshot,
            &RevisionReason::new("relaunch fixture").expect("revision reason"),
        )
        .expect("commit project media")
        .state_version
}

/// The activation path every acquisition takes: commit the asset into its alias project, then
/// record that exact triple as the host's active workspace.
fn activate(database: &Database, directory: &Path, how: Acquisition) -> OwnedMedia {
    let asset = import_media(database, directory, ("relaunch.mp4", 0x45), how);
    let metadata = ProjectMetadata::new("Relaunch fixture").expect("project metadata");
    let base = database.create_project(&metadata).expect("create project");
    let state_version = commit_media(
        database,
        &metadata,
        base.state_version(),
        vec![asset.clone()],
    );
    let alias = match how {
        Acquisition::Picked => asset.id().to_string(),
        Acquisition::Downloaded => URL_ALIAS.to_owned(),
    };
    let pointer =
        ActiveWorkspacePointer::new(alias, metadata.id(), asset.id()).expect("workspace pointer");
    let intent = Uuid::now_v7();
    database
        .begin_active_workspace_intent(intent)
        .expect("begin workspace intent");
    database
        .set_active_workspace(&pointer, intent)
        .expect("record active workspace");
    OwnedMedia {
        asset,
        metadata,
        state_version,
        pointer,
    }
}

fn recorded_workspace(database: &Database) -> Option<ActiveWorkspace> {
    let state = database
        .get_active_workspace()
        .expect("read active workspace");
    assert!(
        state.initialized,
        "an activated workspace leaves durable authority behind"
    );
    state.workspace
}

fn reopen(
    database: &Database,
    project: &ProjectMetadata,
    version: u64,
    asset: AssetId,
) -> &'static str {
    let media_server = MediaServer::start(std::iter::empty()).expect("media server");
    let authorization = ProjectMediaAuthorization {
        project_id: project.id(),
        expected_state_version: version,
    };
    match reopen_media_asset(database, &media_server, authorization, asset) {
        Ok((media, _playback)) => {
            assert_eq!(media.asset().id(), asset);
            "reopened"
        }
        Err(error) => error.code(),
    }
}

#[test]
fn a_new_process_reopens_picked_and_downloaded_media_through_the_recorded_workspace() {
    for how in [Acquisition::Picked, Acquisition::Downloaded] {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("database.sqlite3");
        let database = Database::open(&path).expect("database");
        let owned = activate(&database, directory.path(), how);
        drop(database);

        let relaunched = Database::open(&path).expect("relaunched database");
        let workspace = recorded_workspace(&relaunched).expect("workspace survives relaunch");
        assert_eq!(workspace.cache_id, owned.pointer.cache_id());
        assert_eq!(workspace.project_id, owned.metadata.id());
        assert_eq!(workspace.media_id, owned.asset.id());
        assert_eq!(workspace.project_state_version, owned.state_version);
        assert_eq!(
            reopen(
                &relaunched,
                &owned.metadata,
                workspace.project_state_version,
                workspace.media_id,
            ),
            "reopened"
        );
    }
}

#[test]
fn the_record_fails_closed_once_its_project_stops_owning_the_media() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("database.sqlite3");
    let database = Database::open(&path).expect("database");
    let owned = activate(&database, directory.path(), Acquisition::Picked);
    let detached = commit_media(&database, &owned.metadata, owned.state_version, Vec::new());
    drop(database);

    let relaunched = Database::open(&path).expect("relaunched database");
    assert!(recorded_workspace(&relaunched).is_none());
    // Neither the remembered revision nor the current one authorizes the detached asset.
    for version in [owned.state_version, detached] {
        assert_eq!(
            reopen(&relaunched, &owned.metadata, version, owned.asset.id()),
            "mediaUnavailable"
        );
    }
}

#[test]
fn replacing_the_project_media_invalidates_the_record_for_the_old_asset() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let database = Database::open(directory.path().join("database.sqlite3")).expect("database");
    let owned = activate(&database, directory.path(), Acquisition::Downloaded);
    let replacement = import_media(
        &database,
        directory.path(),
        ("replacement.mp4", 0x46),
        Acquisition::Picked,
    );
    let replaced = commit_media(
        &database,
        &owned.metadata,
        owned.state_version,
        vec![replacement],
    );

    assert!(recorded_workspace(&database).is_none());
    assert_eq!(
        reopen(
            &database,
            &owned.metadata,
            owned.state_version,
            owned.asset.id()
        ),
        "mediaUnavailable"
    );
    assert_eq!(
        reopen(&database, &owned.metadata, replaced, owned.asset.id()),
        "mediaUnavailable"
    );
}

#[test]
fn clearing_the_exact_record_leaves_a_tombstone_for_the_next_process() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("database.sqlite3");
    let database = Database::open(&path).expect("database");
    let owned = activate(&database, directory.path(), Acquisition::Picked);
    let intent = Uuid::now_v7();
    database
        .begin_active_workspace_intent(intent)
        .expect("begin clear intent");
    assert!(
        database
            .clear_active_workspace(Some(&owned.pointer), intent)
            .expect("clear exact workspace")
    );
    drop(database);

    let relaunched = Database::open(&path).expect("relaunched database");
    assert!(recorded_workspace(&relaunched).is_none());
}
