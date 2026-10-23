//! Shared actor handles, FIFO request ordering, and online backup.

use super::*;

#[test]
fn cloned_handles_share_one_actor_owned_connection() {
    let (_directory, database) = database();
    let clone = database.clone();
    database
        .put_setting("app", "locale", &json!("ko"))
        .expect("save through original");

    assert_eq!(
        clone
            .get_setting("app", "locale")
            .expect("load through clone"),
        Some(json!("ko"))
    );
}

#[test]
fn clear_with_info_is_ordered_before_a_queued_cache_writer() {
    let (_directory, database) = database();
    let cleared_category = CacheCategory::new("videos").expect("cleared category");
    let later_category = CacheCategory::new("videoTemp").expect("later category");
    let cleared_artifact = publish_durable_artifact(&database, b"before clear");
    let later_artifact = publish_durable_artifact(&database, b"after clear");
    let cleared_key = CacheKey::derive(&cleared_category, 1, &[b"first"]).expect("cleared key");
    let later_key = CacheKey::derive(&later_category, 1, &[b"second"]).expect("later key");
    database
        .put_cache_entry(
            &CacheWrite::new(cleared_key, cleared_artifact, cleared_category, 1, None)
                .expect("initial cache write"),
        )
        .expect("put initial cache entry");
    let later_write = CacheWrite::new(later_key, later_artifact, later_category, 1, None)
        .expect("later cache write");

    // Queue both operations without waiting for either reply. FIFO processing guarantees the
    // writer runs after the complete before/clear/after actor operation, not between snapshots.
    let (clear_reply, clear_response) = sync_channel(1);
    database
        .inner
        .sender
        .send(Request::Artifacts(ArtifactRequest::ClearCacheWithInfo {
            category: None,
            reply: clear_reply,
        }))
        .expect("queue aggregate clear");
    let (write_reply, write_response) = sync_channel(1);
    database
        .inner
        .sender
        .send(Request::Artifacts(ArtifactRequest::PutCache {
            write: later_write,
            reply: write_reply,
        }))
        .expect("queue later writer");

    let outcome = clear_response
        .recv()
        .expect("receive aggregate clear")
        .expect("aggregate clear succeeds");
    write_response
        .recv()
        .expect("receive later writer")
        .expect("later writer succeeds");

    assert_eq!(outcome.before.total_count, 1);
    assert_eq!(outcome.after.total_count, 0);
    assert_eq!(outcome.clear.category, None);
    let final_info = database.cache_info().expect("final cache info");
    assert_eq!(final_info.total_count, 1);
    assert_eq!(final_info.categories.len(), 1);
    assert_eq!(final_info.categories[0].category, "videoTemp");
}

#[test]
fn online_backup_contains_committed_state_without_wal_copying() {
    let (directory, database) = database();
    database
        .put_setting("app", "locale", &json!("ko"))
        .expect("save setting");
    let backup_path = directory.path().join("backups/pre-upgrade.sqlite3");

    database.backup_to(&backup_path).expect("online backup");

    let backup = rusqlite::Connection::open(backup_path).expect("open backup");
    let value_json: String = backup
        .query_row(
            "SELECT value_json FROM app_settings WHERE scope = 'app' AND key = 'locale'",
            [],
            |row| row.get(0),
        )
        .expect("read backup setting");
    assert_eq!(value_json, "\"ko\"");
    assert_eq!(
        backup
            .pragma_query_value(None, "application_id", |row| row.get::<_, i64>(0))
            .expect("backup application id"),
        APPLICATION_ID
    );
}
