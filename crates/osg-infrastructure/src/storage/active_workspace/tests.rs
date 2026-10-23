use rusqlite::{Connection, params};
use uuid::Uuid;

use osg_domain::{AssetId, ProjectId, TrackId};

use super::{
    ActiveWorkspacePointer, ProjectAliasEntry, ProjectAliasIndex, activate_alias_in_index,
    activate_project_alias, begin_active_workspace_intent, clear_active_workspace,
    get_active_workspace, get_project_alias_index, migrate_legacy_project_alias_index,
    remove_project_alias, set_active_workspace, set_project_alias_index,
};
use crate::storage::DatabaseError;

fn fixture() -> Connection {
    let connection = Connection::open_in_memory().expect("in-memory database");
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .expect("foreign keys");
    connection
        .execute_batch(include_str!("../sql/0001_initial.sql"))
        .expect("schema");
    connection
}

fn seed_project(
    connection: &Connection,
    project_id: ProjectId,
    media_id: AssetId,
    track_id: TrackId,
    hash: &[u8; 32],
    timestamp: i64,
) {
    connection
        .execute(
            "INSERT INTO projects(id, title, state_version, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 7, ?3, ?3)",
            params![
                project_id.as_uuid(),
                format!("Project {timestamp}"),
                timestamp
            ],
        )
        .expect("project");
    connection
        .execute(
            "INSERT INTO media_assets(
                   id, kind, display_name, extension, size_bytes, content_hash,
                   metadata_json, created_at_ms
                 ) VALUES (?1, 'video', 'same.mp4', 'mp4', 8, ?2, '{}', ?3)",
            params![media_id.as_uuid(), hash.as_slice(), timestamp],
        )
        .expect("media");
    connection
        .execute(
            "INSERT INTO project_media(project_id, media_id, role, ordinal)
                 VALUES (?1, ?2, 'primary', 0)",
            params![project_id.as_uuid(), media_id.as_uuid()],
        )
        .expect("project media");
    connection
        .execute(
            "INSERT INTO tracks(
                   id, project_id, ordinal, role, language, label, origin,
                   state_version, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, 0, 'original', 'en', 'Cached subtitles',
                           'legacyJson', 1, ?3, ?3)",
            params![track_id.as_uuid(), project_id.as_uuid(), timestamp],
        )
        .expect("track");
    connection
        .execute(
            "INSERT INTO project_state(
                   project_id, active_media_id, active_track_id, current_revision_id,
                   state_version, updated_at_ms
                 ) VALUES (?1, ?2, ?3, NULL, 7, ?4)",
            params![
                project_id.as_uuid(),
                media_id.as_uuid(),
                track_id.as_uuid(),
                timestamp,
            ],
        )
        .expect("project state");
}

fn begin(connection: &mut Connection) -> Uuid {
    let intent = Uuid::now_v7();
    begin_active_workspace_intent(connection, intent).expect("begin workspace intent");
    intent
}

#[test]
fn exact_project_media_and_track_survive_preference_clear_without_content_dedupe() {
    let mut connection = fixture();
    let shared_hash = [41_u8; 32];
    let project_a = ProjectId::new();
    let media_a = AssetId::new();
    let track_a = TrackId::new();
    let project_b = ProjectId::new();
    let media_b = AssetId::new();
    let track_b = TrackId::new();
    seed_project(&connection, project_a, media_a, track_a, &shared_hash, 1);
    seed_project(&connection, project_b, media_b, track_b, &shared_hash, 2);
    let initially_empty = get_active_workspace(&connection).expect("initial workspace state");
    assert!(!initially_empty.initialized);
    assert!(initially_empty.workspace.is_none());
    connection
        .execute(
            "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
                 VALUES ('app', 'theme', '\"dark\"', 3)",
            [],
        )
        .expect("preference");
    connection
        .execute(
            "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
                 VALUES ('app', 'project.subtitleCacheIndex.v1', ?1, 3)",
            [format!(
                "{{\"schemaVersion\":1,\"activeCacheId\":\"asset-b\",\"entries\":[{{\"cacheId\":\"asset-a\",\"projectId\":\"{project_a}\",\"lastOpenedAt\":1}},{{\"cacheId\":\"asset-b\",\"projectId\":\"{project_b}\",\"lastOpenedAt\":2}}]}}"
            )],
        )
        .expect("legacy alias index");

    let pointer =
        ActiveWorkspacePointer::new("asset-b", project_b, media_b).expect("workspace pointer");
    let intent = begin(&mut connection);
    let stored = set_active_workspace(&mut connection, &pointer, intent).expect("store workspace");
    assert_eq!(stored.project_id, project_b);
    assert_eq!(stored.media_id, media_b);
    assert_eq!(stored.track_id, Some(track_b));

    migrate_legacy_project_alias_index(&mut connection).expect("migrate alias index");

    connection
        .execute("DELETE FROM app_settings WHERE scope = 'app'", [])
        .expect("clear preferences");
    let restored = get_active_workspace(&connection)
        .expect("read workspace")
        .workspace
        .expect("workspace survives");
    assert_eq!(restored.project_id, project_b);
    assert_eq!(restored.media_id, media_b);
    assert_eq!(restored.track_id, Some(track_b));
    assert_ne!(restored.project_id, project_a);
    assert_ne!(restored.media_id, media_a);
    assert_ne!(restored.track_id, Some(track_a));
    let aliases = get_project_alias_index(&mut connection)
        .expect("read aliases")
        .expect("aliases survive");
    assert_eq!(aliases.entries.len(), 2);
    assert_eq!(aliases.entries[0].project_id, project_a);
    assert_eq!(aliases.entries[1].project_id, project_b);
    assert_eq!(aliases.active_cache_id.as_deref(), Some("asset-b"));

    let reopened_a = activate_project_alias(
        &mut connection,
        &ProjectAliasEntry {
            cache_id: "asset-a".to_owned(),
            project_id: project_a,
            last_opened_at: 3,
        },
    )
    .expect("reopen inactive A by exact alias");
    assert_eq!(reopened_a.active_cache_id.as_deref(), Some("asset-a"));
    assert!(
        reopened_a
            .entries
            .iter()
            .any(|entry| { entry.cache_id == "asset-b" && entry.project_id == project_b })
    );
    let reopened_b = activate_project_alias(
        &mut connection,
        &ProjectAliasEntry {
            cache_id: "asset-b".to_owned(),
            project_id: project_b,
            last_opened_at: 4,
        },
    )
    .expect("reopen B by exact alias");
    assert_eq!(reopened_b.active_cache_id.as_deref(), Some("asset-b"));
    assert!(
        reopened_b
            .entries
            .iter()
            .any(|entry| { entry.cache_id == "asset-a" && entry.project_id == project_a })
    );
    assert_eq!(
        get_active_workspace(&connection)
            .expect("read restored winner")
            .workspace
            .expect("winner remains durable")
            .project_id,
        project_b
    );
}

#[test]
fn cross_project_media_is_refused_and_conditional_clear_cannot_erase_a_new_winner() {
    let mut connection = fixture();
    let shared_hash = [9_u8; 32];
    let project_a = ProjectId::new();
    let media_a = AssetId::new();
    let track_a = TrackId::new();
    let project_b = ProjectId::new();
    let media_b = AssetId::new();
    let track_b = TrackId::new();
    seed_project(&connection, project_a, media_a, track_a, &shared_hash, 1);
    seed_project(&connection, project_b, media_b, track_b, &shared_hash, 2);

    let invalid = ActiveWorkspacePointer::new("bad", project_a, media_b).expect("bounded");
    let invalid_intent = begin(&mut connection);
    assert!(matches!(
        set_active_workspace(&mut connection, &invalid, invalid_intent),
        Err(DatabaseError::InvalidActiveWorkspace)
    ));

    let winner = ActiveWorkspacePointer::new("winner", project_b, media_b).expect("winner");
    let stale_intent = begin(&mut connection);
    let winner_intent = begin(&mut connection);
    assert!(matches!(
        set_active_workspace(&mut connection, &winner, stale_intent),
        Err(DatabaseError::StaleActiveWorkspaceIntent)
    ));
    set_active_workspace(&mut connection, &winner, winner_intent).expect("store winner");
    let ownerless_clear_intent = begin(&mut connection);
    assert!(
        !clear_active_workspace(&mut connection, None, ownerless_clear_intent)
            .expect("ownerless clear")
    );
    assert_eq!(
        get_active_workspace(&connection)
            .expect("read winner after ownerless clear")
            .workspace
            .expect("winner survives ownerless clear")
            .project_id,
        project_b
    );
    let stale = ActiveWorkspacePointer::new("stale", project_a, media_a).expect("stale");
    let stale_clear_intent = begin(&mut connection);
    assert!(
        !clear_active_workspace(&mut connection, Some(&stale), stale_clear_intent)
            .expect("stale clear")
    );
    assert_eq!(
        get_active_workspace(&connection)
            .expect("read winner")
            .workspace
            .expect("winner remains")
            .project_id,
        project_b
    );
    let winner_clear_intent = begin(&mut connection);
    assert!(
        clear_active_workspace(&mut connection, Some(&winner), winner_clear_intent)
            .expect("winner clear")
    );
    let empty = get_active_workspace(&connection).expect("empty read");
    assert!(empty.initialized);
    assert!(empty.workspace.is_none());
    let idempotent_clear_intent = begin(&mut connection);
    assert!(
        clear_active_workspace(&mut connection, Some(&winner), idempotent_clear_intent)
            .expect("idempotent clear")
    );
}

#[test]
fn malformed_or_future_records_fail_closed() {
    let connection = fixture();
    connection
        .execute(
            "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
                 VALUES ('active_workspace', 'current', ?1, 1)",
            [format!(
                "{{\"schemaVersion\":2,\"cacheId\":\"x\",\"projectId\":\"{}\",\"mediaId\":\"{}\"}}",
                Uuid::now_v7(),
                Uuid::now_v7(),
            )],
        )
        .expect("future record");
    assert!(matches!(
        get_active_workspace(&connection),
        Err(DatabaseError::InvalidActiveWorkspace)
    ));
    connection
        .execute(
            "UPDATE app_settings SET value_json = '{\"schemaVersion\":1}'
                 WHERE scope = 'active_workspace' AND key = 'current'",
            [],
        )
        .expect("truncated record");
    assert!(matches!(
        get_active_workspace(&connection),
        Err(DatabaseError::InvalidActiveWorkspace)
    ));
}

#[test]
fn malformed_empty_tombstone_fails_closed() {
    let connection = fixture();
    connection
        .execute(
            "INSERT INTO app_settings(scope, key, value_json, updated_at_ms)
                 VALUES ('active_workspace', 'initialized', 'false', 1)",
            [],
        )
        .expect("malformed tombstone");
    assert!(matches!(
        get_active_workspace(&connection),
        Err(DatabaseError::InvalidActiveWorkspace)
    ));
}

#[test]
fn workspace_state_version_must_round_trip_through_javascript_exactly() {
    let mut connection = fixture();
    let project = ProjectId::new();
    let media = AssetId::new();
    let track = TrackId::new();
    seed_project(&connection, project, media, track, &[5_u8; 32], 1);
    connection
        .execute(
            "UPDATE project_state SET state_version = 9007199254740992
                 WHERE project_id = ?1",
            [project.as_uuid()],
        )
        .expect("unsafe JavaScript state version");
    let pointer =
        ActiveWorkspacePointer::new("unsafe-version", project, media).expect("bounded pointer");
    let intent = begin(&mut connection);
    assert!(matches!(
        set_active_workspace(&mut connection, &pointer, intent),
        Err(DatabaseError::InvalidActiveWorkspace)
    ));
}

#[test]
fn alias_bounds_match_javascript_and_stale_projects_are_pruned_individually() {
    let mut connection = fixture();
    let project = ProjectId::new();
    let media = AssetId::new();
    let track = TrackId::new();
    seed_project(&connection, project, media, track, &[3_u8; 32], 1);
    let boundary_alias = "😀".repeat(4_096);
    let valid = ProjectAliasIndex {
        schema_version: 1,
        active_cache_id: Some(boundary_alias.clone()),
        entries: vec![ProjectAliasEntry {
            cache_id: boundary_alias,
            project_id: project,
            last_opened_at: 9_007_199_254_740_991,
        }],
    };
    set_project_alias_index(&mut connection, &valid).expect("UTF-16 boundary index");

    for invalid in [
        ProjectAliasIndex {
            schema_version: 1,
            active_cache_id: None,
            entries: vec![ProjectAliasEntry {
                cache_id: format!("{}x", "😀".repeat(4_096)),
                project_id: project,
                last_opened_at: 1,
            }],
        },
        ProjectAliasIndex {
            schema_version: 1,
            active_cache_id: None,
            entries: vec![ProjectAliasEntry {
                cache_id: "line\nbreak".to_owned(),
                project_id: project,
                last_opened_at: 1,
            }],
        },
        ProjectAliasIndex {
            schema_version: 1,
            active_cache_id: None,
            entries: vec![ProjectAliasEntry {
                cache_id: "cache\u{0085}id".to_owned(),
                project_id: project,
                last_opened_at: 1,
            }],
        },
        ProjectAliasIndex {
            schema_version: 1,
            active_cache_id: None,
            entries: vec![ProjectAliasEntry {
                cache_id: "too-new".to_owned(),
                project_id: project,
                last_opened_at: 9_007_199_254_740_992,
            }],
        },
    ] {
        assert!(matches!(
            set_project_alias_index(&mut connection, &invalid),
            Err(DatabaseError::InvalidProjectAliasIndex)
        ));
    }

    let stale_project = ProjectId::new();
    let raw = format!(
        "{{\"schemaVersion\":1,\"activeCacheId\":\"stale\",\"entries\":[{{\"cacheId\":\"valid\",\"projectId\":\"{project}\",\"lastOpenedAt\":1}},{{\"cacheId\":\"stale\",\"projectId\":\"{stale_project}\",\"lastOpenedAt\":2}}]}}"
    );
    connection
        .execute(
            "UPDATE app_settings SET value_json = ?1
                 WHERE scope = 'active_workspace'
                   AND key = 'project.subtitleCacheIndex.v1'",
            [raw],
        )
        .expect("stage stale alias");
    let pruned = get_project_alias_index(&mut connection)
        .expect("read pruned index")
        .expect("index exists");
    assert_eq!(pruned.entries.len(), 1);
    assert_eq!(pruned.entries[0].project_id, project);
    assert_eq!(pruned.active_cache_id, None);
}

#[test]
fn atomic_alias_mutations_preserve_inactive_projects_and_refuse_stale_removal() {
    let mut connection = fixture();
    let shared_hash = [4_u8; 32];
    let project_a = ProjectId::new();
    let media_a = AssetId::new();
    let track_a = TrackId::new();
    let project_b = ProjectId::new();
    let media_b = AssetId::new();
    let track_b = TrackId::new();
    seed_project(&connection, project_a, media_a, track_a, &shared_hash, 1);
    seed_project(&connection, project_b, media_b, track_b, &shared_hash, 2);

    activate_project_alias(
        &mut connection,
        &ProjectAliasEntry {
            cache_id: "inactive-a".to_owned(),
            project_id: project_a,
            last_opened_at: 10,
        },
    )
    .expect("activate A");
    let both = activate_project_alias(
        &mut connection,
        &ProjectAliasEntry {
            cache_id: "active-b".to_owned(),
            project_id: project_b,
            last_opened_at: 11,
        },
    )
    .expect("activate B");
    assert_eq!(both.entries.len(), 2);
    assert_eq!(both.active_cache_id.as_deref(), Some("active-b"));

    let stale = remove_project_alias(&mut connection, "active-b", project_a)
        .expect("stale exact-owner removal");
    assert!(!stale.changed);
    assert_eq!(stale.index.entries.len(), 2);
    assert_eq!(stale.index.active_cache_id.as_deref(), Some("active-b"));

    let removed =
        remove_project_alias(&mut connection, "inactive-a", project_a).expect("remove inactive A");
    assert!(removed.changed);
    assert_eq!(removed.index.entries.len(), 1);
    assert_eq!(removed.index.entries[0].project_id, project_b);
    assert_eq!(removed.index.active_cache_id.as_deref(), Some("active-b"));
}

#[test]
fn activating_alias_keeps_its_slot_when_the_wall_clock_moves_backwards() {
    let project_a = ProjectId::new();
    let project_b = ProjectId::new();
    let activating_project = ProjectId::new();
    let mut index = ProjectAliasIndex {
        schema_version: 1,
        active_cache_id: Some("new-b".to_owned()),
        entries: vec![
            ProjectAliasEntry {
                cache_id: "old-a".to_owned(),
                project_id: project_a,
                last_opened_at: 100,
            },
            ProjectAliasEntry {
                cache_id: "new-b".to_owned(),
                project_id: project_b,
                last_opened_at: 200,
            },
        ],
    };
    let activating = ProjectAliasEntry {
        cache_id: "clock-rolled-back".to_owned(),
        project_id: activating_project,
        last_opened_at: 1,
    };

    activate_alias_in_index(&mut index, &activating, 2);

    assert_eq!(index.entries.len(), 2);
    assert!(index.entries.contains(&activating));
    assert!(
        index
            .entries
            .iter()
            .any(|entry| entry.project_id == project_b)
    );
    assert_eq!(index.active_cache_id.as_deref(), Some("clock-rolled-back"));
}
