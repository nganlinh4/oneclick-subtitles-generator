//! Undo/redo, branching, bounded retention, legacy-graph upgrades, and startup reconciliation.

use super::*;

#[test]
fn undo_redo_and_branching_keep_monotonic_versions_and_clear_redo() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("History").expect("valid project");
    let base = database.create_project(&metadata).expect("create project");
    let a = edit(&base, "A", Vec::new(), vec![track("A", "first")]);
    let commit_a = database.commit_project(&a, &reason("A")).expect("commit A");
    let at_a = database
        .load_project(metadata.id())
        .expect("load A")
        .expect("project exists");
    let b = edit(&at_a, "B", Vec::new(), vec![track("B", "second")]);
    let commit_b = database.commit_project(&b, &reason("B")).expect("commit B");
    let at_b = database
        .project_history_status(metadata.id())
        .expect("status at B");
    assert_eq!(at_b.state_version, 2);
    assert_eq!(
        at_b.undo_reason.as_ref().map(RevisionReason::as_str),
        Some("B")
    );
    assert!(!at_b.can_redo);

    assert!(
        database
            .undo_project_guarded(metadata.id(), 2, &reason("not B"))
            .expect("mismatched guarded undo")
            .is_none()
    );
    assert_eq!(
        database
            .project_history_status(metadata.id())
            .expect("status after rejected guard")
            .state_version,
        2
    );

    let undone = database
        .undo_project_guarded(metadata.id(), 2, &reason("B"))
        .expect("undo B")
        .expect("parent exists");
    assert_eq!(undone.state_version(), 3);
    assert_eq!(undone.metadata().name(), "A");
    let after_undo = database
        .project_history_status(metadata.id())
        .expect("status after undo");
    assert_eq!(after_undo.state_version, 3);
    assert_eq!(
        after_undo.undo_reason.as_ref().map(RevisionReason::as_str),
        Some("A")
    );
    assert_eq!(
        after_undo.redo_reason.as_ref().map(RevisionReason::as_str),
        Some("B")
    );
    assert!(after_undo.can_undo);
    assert!(after_undo.can_redo);
    assert!(
        database
            .redo_project_guarded(metadata.id(), 3, &reason("not B"))
            .expect("mismatched guarded redo")
            .is_none()
    );
    let redone = database
        .redo_project_guarded(metadata.id(), 3, &reason("B"))
        .expect("redo B")
        .expect("redo exists");
    assert_eq!(redone.state_version(), 4);
    assert_eq!(redone.metadata().name(), "B");

    let branch_base = database
        .undo_project(metadata.id(), 4)
        .expect("undo B again")
        .expect("parent exists");
    let c = edit(&branch_base, "C", Vec::new(), vec![track("C", "branch")]);
    let commit_c = database
        .commit_project(&c, &reason("Branch C"))
        .expect("commit branch C");
    assert_eq!(commit_c.state_version, 6);
    let on_branch = database
        .project_history_status(metadata.id())
        .expect("status on branch");
    assert_eq!(on_branch.state_version, 6);
    assert_eq!(
        on_branch.undo_reason.as_ref().map(RevisionReason::as_str),
        Some("Branch C")
    );
    assert!(!on_branch.can_redo);
    assert!(
        database
            .redo_project(metadata.id(), 6)
            .expect("empty redo")
            .is_none()
    );

    drop(database);
    let connection = Connection::open(path).expect("open database directly");
    let parent: Uuid = connection
        .query_row(
            "SELECT parent_id FROM project_revisions WHERE id = ?1",
            [commit_c.revision_id.as_uuid()],
            |row| row.get(0),
        )
        .expect("read branch parent");
    assert_eq!(parent, commit_a.revision_id.into_uuid());
    assert_ne!(parent, commit_b.revision_id.into_uuid());
}

#[test]
fn long_linear_history_is_pruned_to_the_latest_256_revisions_and_reopens() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("Bounded history").expect("valid project");
    let mut current = database.create_project(&metadata).expect("create project");

    for index in 1..=(MAX_CURRENT_REVISIONS + 32) {
        current = commit_numbered_revision(&database, &current, index);
    }
    assert_eq!(
        revision_count(&path, metadata.id()),
        EXPECTED_RETAINED_REVISIONS
    );
    assert_eq!(
        database.load_project(metadata.id()).expect("load latest"),
        Some(current.clone())
    );

    drop(database);
    let reopened = Database::open(&path).expect("reopen bounded database");
    assert_eq!(
        reopened
            .load_project(metadata.id())
            .expect("load latest after restart"),
        Some(current)
    );
    assert_eq!(
        revision_count(&path, metadata.id()),
        EXPECTED_RETAINED_REVISIONS
    );
}

#[test]
fn v4_upgrade_prunes_legacy_ancestors_and_detached_branches_before_load() {
    let directory = TempDir::new().expect("temporary v3 directory");
    let path = directory.path().join("db/osg.sqlite3");
    let metadata = ProjectMetadata::new("Legacy retention").expect("valid project");
    let (current, detached) = seed_v3_unbounded_graph(&path, &metadata);
    assert!(revision_count(&path, metadata.id()) > EXPECTED_RETAINED_REVISIONS);

    let upgraded = Database::open(&path).expect("migrate and reconcile v3 database");
    assert_eq!(
        upgraded
            .load_project(metadata.id())
            .expect("load reconciled project"),
        Some(current)
    );
    drop(upgraded);
    assert_eq!(
        revision_count(&path, metadata.id()),
        EXPECTED_RETAINED_REVISIONS
    );

    let connection = Connection::open(path).expect("inspect upgraded database");
    let schema_version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("read schema version");
    assert_eq!(schema_version, 17);
    for revision in detached {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM project_revisions WHERE id = ?1)",
                [revision.as_uuid()],
                |row| row.get(0),
            )
            .expect("check detached revision");
        assert!(!exists);
    }
}

#[test]
fn v15_upgrade_leaves_legacy_tracks_without_synthetic_words() {
    let directory = TempDir::new().expect("temporary v14 directory");
    let path = directory.path().join("db/osg.sqlite3");
    std::fs::create_dir_all(path.parent().expect("database parent"))
        .expect("create database parent");

    let mut connection = Connection::open(&path).expect("open v14 fixture");
    migrations()
        .to_version(&mut connection, 14)
        .expect("apply migrations up to 14");
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .expect("enable foreign keys");

    let metadata = ProjectMetadata::new("Legacy v14 Subtitle Project").expect("valid project");
    let transaction = connection
        .transaction()
        .expect("start v14 fixture transaction");
    let created =
        create_project_in_transaction(&transaction, &metadata).expect("create v14 project");
    transaction.commit().expect("commit v14 project");
    drop(connection);

    // Open database with v15 runtime, upgrading schema to v15
    let upgraded = Database::open(&path).expect("migrate to v15");
    let loaded = upgraded
        .load_project(metadata.id())
        .expect("load upgraded project")
        .expect("project exists");
    assert_eq!(loaded, created);
    drop(upgraded);

    let connection = Connection::open(&path).expect("inspect v15 database");
    let schema_version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("read schema version");
    assert_eq!(schema_version, 17);

    // Verify zero rows in transcript tables
    let rev_count: i64 = connection
        .query_row("SELECT count(*) FROM transcript_revisions", [], |r| {
            r.get(0)
        })
        .expect("count transcript revisions");
    assert_eq!(
        rev_count, 0,
        "legacy projects must have zero transcript revisions"
    );

    let turn_count: i64 = connection
        .query_row("SELECT count(*) FROM transcript_turns", [], |r| r.get(0))
        .expect("count transcript turns");
    assert_eq!(
        turn_count, 0,
        "legacy projects must have zero transcript turns"
    );

    let word_count: i64 = connection
        .query_row("SELECT count(*) FROM transcript_words", [], |r| r.get(0))
        .expect("count transcript words");
    assert_eq!(
        word_count, 0,
        "legacy projects must not synthesize word timings"
    );

    let mapping_count: i64 = connection
        .query_row("SELECT count(*) FROM cue_word_mappings", [], |r| r.get(0))
        .expect("count cue word mappings");
    assert_eq!(
        mapping_count, 0,
        "legacy projects must have zero cue word mappings"
    );
}

#[test]
fn startup_reconciliation_rejects_oversized_redo_json_before_parsing() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("Oversized navigation").expect("valid project");
    database.create_project(&metadata).expect("create project");
    drop(database);

    let repeated = vec![RevisionId::new(); MAX_REDO_REVISIONS * 8];
    let oversized = serde_json::to_string(&repeated).expect("serialize oversized redo");
    assert!(oversized.len() > MAX_REDO_STACK_JSON_BYTES);
    let connection = Connection::open(&path).expect("open database directly");
    connection
        .execute(
            "UPDATE revision_navigation SET redo_stack_json = ?1 WHERE project_id = ?2",
            params![oversized, metadata.id().as_uuid()],
        )
        .expect("store oversized redo JSON");
    drop(connection);

    assert!(matches!(
        Database::open(&path),
        Err(DatabaseError::CorruptRevisionNavigation(id)) if id == metadata.id()
    ));
    assert_eq!(revision_count(&path, metadata.id()), 1);
}

#[test]
fn startup_reconciliation_rejects_an_active_cycle_without_deleting_rows() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("Cyclic navigation").expect("valid project");
    let root = database.create_project(&metadata).expect("create project");
    database
        .commit_project(
            &edit(&root, "Second", Vec::new(), Vec::new()),
            &reason("Second"),
        )
        .expect("commit second revision");
    drop(database);

    let connection = Connection::open(&path).expect("open database directly");
    connection
        .execute(
            "UPDATE project_revisions
                 SET parent_id = (SELECT current_revision_id FROM revision_navigation
                                  WHERE project_id = ?1)
                 WHERE project_id = ?1 AND parent_id IS NULL",
            [metadata.id().as_uuid()],
        )
        .expect("create active cycle");
    drop(connection);

    assert!(matches!(
        Database::open(&path),
        Err(DatabaseError::CorruptRevisionNavigation(id)) if id == metadata.id()
    ));
    assert_eq!(revision_count(&path, metadata.id()), 2);
}

#[test]
fn undo_stops_at_the_retained_root_and_redo_survives_restart() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("Undo retention").expect("valid project");
    let mut current = database.create_project(&metadata).expect("create project");
    for index in 1..=(MAX_CURRENT_REVISIONS + 8) {
        current = commit_numbered_revision(&database, &current, index);
    }

    for _ in 1..MAX_CURRENT_REVISIONS {
        current = database
            .undo_project(metadata.id(), current.state_version())
            .expect("undo retained revision")
            .expect("retained parent exists");
    }
    assert!(
        database
            .undo_project(metadata.id(), current.state_version())
            .expect("undo at retained root")
            .is_none()
    );
    assert_eq!(
        revision_count(&path, metadata.id()),
        EXPECTED_RETAINED_REVISIONS
    );

    drop(database);
    let reopened = Database::open(&path).expect("reopen undone database");
    assert_eq!(
        reopened
            .load_project(metadata.id())
            .expect("load retained root"),
        Some(current.clone())
    );
    let status = reopened
        .project_history_status(metadata.id())
        .expect("load restarted navigation");
    assert!(!status.can_undo);
    assert!(status.can_redo);
    assert!(
        reopened
            .redo_project(metadata.id(), current.state_version())
            .expect("redo after restart")
            .is_some()
    );
    assert_eq!(
        revision_count(&path, metadata.id()),
        EXPECTED_RETAINED_REVISIONS
    );
}

#[test]
fn branch_commit_deletes_abandoned_redo_rows_and_reopens_cleanly() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("Bounded branch").expect("valid project");
    let mut current = database.create_project(&metadata).expect("create project");
    let mut commits = Vec::new();
    for index in 1..=4 {
        let edited = edit(
            &current,
            &format!("Revision {index}"),
            Vec::new(),
            Vec::new(),
        );
        let commit = database
            .commit_project(&edited, &reason(&format!("Revision {index}")))
            .expect("commit linear revision");
        current = edited
            .with_state_version(commit.state_version)
            .expect("apply committed version");
        commits.push(commit.revision_id);
    }
    for _ in 0..2 {
        current = database
            .undo_project(metadata.id(), current.state_version())
            .expect("undo before branch")
            .expect("parent exists");
    }

    let branch = edit(&current, "Branch", Vec::new(), Vec::new());
    let branch_commit = database
        .commit_project(&branch, &reason("Branch"))
        .expect("commit branch");
    let expected = branch
        .with_state_version(branch_commit.state_version)
        .expect("apply branch version");
    assert_eq!(revision_count(&path, metadata.id()), 4);
    let connection = Connection::open(&path).expect("inspect branch rows");
    for abandoned in &commits[2..] {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM project_revisions WHERE id = ?1)",
                [abandoned.as_uuid()],
                |row| row.get(0),
            )
            .expect("check abandoned revision");
        assert!(!exists);
    }
    let redo: String = connection
        .query_row(
            "SELECT redo_stack_json FROM revision_navigation WHERE project_id = ?1",
            [metadata.id().as_uuid()],
            |row| row.get(0),
        )
        .expect("read cleared redo stack");
    assert_eq!(redo, "[]");
    drop(connection);

    drop(database);
    let reopened = Database::open(path).expect("reopen branched database");
    assert_eq!(
        reopened.load_project(metadata.id()).expect("load branch"),
        Some(expected)
    );
}

#[test]
fn bounded_redo_reports_the_oldest_revision_for_deletion() {
    let mut redo = (0..MAX_REDO_REVISIONS)
        .map(|_| RevisionId::new())
        .collect::<Vec<_>>();
    let oldest = redo[0];
    let newest = RevisionId::new();

    assert_eq!(push_bounded(&mut redo, newest), Some(oldest));
    assert_eq!(redo.len(), MAX_REDO_REVISIONS);
    assert_eq!(redo.last(), Some(&newest));
    assert!(!redo.contains(&oldest));
}

#[test]
fn history_status_survives_restart_and_rejects_a_corrupt_reason() {
    let (_directory, path, database) = database();
    let metadata = ProjectMetadata::new("History status").expect("valid project");
    let root = database.create_project(&metadata).expect("create project");
    let root_status = database
        .project_history_status(metadata.id())
        .expect("root status");
    assert_eq!(root_status.state_version, 0);
    assert!(!root_status.can_undo);
    assert!(!root_status.can_redo);

    database
        .commit_project(
            &edit(&root, "Edited", Vec::new(), vec![track("A", "edited")]),
            &reason("Lyrics edit"),
        )
        .expect("commit edit");
    drop(database);

    let reopened = Database::open(&path).expect("reopen database");
    let reopened_status = reopened
        .project_history_status(metadata.id())
        .expect("reopened status");
    assert_eq!(
        reopened_status
            .undo_reason
            .as_ref()
            .map(RevisionReason::as_str),
        Some("Lyrics edit")
    );
    drop(reopened);

    let connection = Connection::open(&path).expect("open directly");
    connection
        .execute(
            "UPDATE project_revisions SET reason = char(10) WHERE reason = 'Lyrics edit'",
            [],
        )
        .expect("corrupt reason");
    drop(connection);
    let corrupted = Database::open(path).expect("reopen corrupt database");
    assert!(matches!(
        corrupted.project_history_status(metadata.id()),
        Err(DatabaseError::CorruptRevisionNavigation(id)) if id == metadata.id()
    ));
}
