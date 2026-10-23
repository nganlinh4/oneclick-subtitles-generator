//! The word-native transcript schema: strict tables and cascades.

use super::*;

#[test]
#[allow(clippy::too_many_lines)]
fn word_native_transcripts_migration_creates_strict_tables_and_cascades() {
    let mut connection = Connection::open_in_memory().expect("open database");
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .expect("enable foreign keys");
    migrations()
        .to_latest(&mut connection)
        .expect("apply migrations to latest");

    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("schema version");
    assert_eq!(version, 17);

    // Verify table existence
    let tables: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("collect");

    for expected in [
        "transcript_revisions",
        "transcript_turns",
        "transcript_words",
        "cue_word_mappings",
    ] {
        assert!(
            tables.contains(&expected.to_string()),
            "missing table: {expected}"
        );
    }

    // Verify indices existence
    let indices: Vec<String> = connection
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("collect");

    for expected in [
        "transcript_revisions_project_idx",
        "transcript_turns_timeline_idx",
        "transcript_words_timeline_idx",
        "transcript_words_speaker_idx",
        "cue_word_mappings_word_idx",
    ] {
        assert!(
            indices.contains(&expected.to_string()),
            "missing index: {expected}"
        );
    }

    // Seed project
    let project_id = Uuid::now_v7();
    connection
        .execute(
            "INSERT INTO projects(id, title, state_version, created_at_ms, updated_at_ms)
                 VALUES (?1, 'Transcript Test', 0, 1000, 1000)",
            [project_id],
        )
        .expect("seed project");

    // Seed transcript revision
    let revision_id = Uuid::now_v7();
    connection
        .execute(
            "INSERT INTO transcript_revisions(
                   id, project_id, media_id, provider, model, source_range_start_ms,
                   source_range_end_ms, state, fingerprint, word_count, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, NULL, 'gemini', 'gemini-3.5-transcribe', 0, 60000, 'completed', 'fp123', 2, 1000, 1000)",
            params![revision_id, project_id],
        )
        .expect("seed transcript revision");

    // Seed transcript turn
    let turn_id = Uuid::now_v7();
    connection
        .execute(
            "INSERT INTO transcript_turns(
                   id, revision_id, ordinal, speaker_id, start_ms, end_ms, text,
                   start_word_ordinal, end_word_ordinal
                 ) VALUES (?1, ?2, 0, 'w0:speaker_0', 100, 800, 'Hello world', 0, 1)",
            params![turn_id, revision_id],
        )
        .expect("seed turn");

    // Seed transcript words
    let word1_id = Uuid::now_v7();
    let word2_id = Uuid::now_v7();
    connection
        .execute(
            "INSERT INTO transcript_words(
                   id, revision_id, turn_id, ordinal, text, raw_start_ns, raw_end_ns,
                   start_ms, end_ms, speaker_id, confidence, is_unaligned, alignment_status
                 ) VALUES
                 (?1, ?3, ?4, 0, 'Hello', 100000000, 400000000, 100, 400, 'w0:speaker_0', 0.98, 0, 'aligned'),
                 (?2, ?3, ?4, 1, 'world', 450000000, 800000000, 450, 800, 'w0:speaker_0', 0.95, 0, 'aligned')",
            params![word1_id, word2_id, revision_id, turn_id],
        )
        .expect("seed words");

    // Seed track and cue
    let track_id = Uuid::now_v7();
    connection
        .execute(
            "INSERT INTO tracks(id, project_id, ordinal, role, label, origin, state_version, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, 0, 'user', 'Subtitles', 'srt', 0, 1000, 1000)",
            params![track_id, project_id],
        )
        .expect("seed track");

    let cue_id = Uuid::now_v7();
    connection
        .execute(
            "INSERT INTO cues(track_id, id, ordinal, start_ms, end_ms, text)
                 VALUES (?1, ?2, 1, 100, 800, 'Hello world')",
            params![track_id, cue_id],
        )
        .expect("seed cue");

    // Seed cue word mappings
    connection
        .execute(
            "INSERT INTO cue_word_mappings(cue_id, word_id, word_ordinal)
                 VALUES (?1, ?2, 0), (?1, ?3, 1)",
            params![cue_id, word1_id, word2_id],
        )
        .expect("seed cue mappings");

    // Verify range query seeking
    let active_word: String = connection
        .query_row(
            "SELECT text FROM transcript_words
                 WHERE revision_id = ?1 AND start_ms <= 250 AND end_ms >= 250",
            [revision_id],
            |row| row.get(0),
        )
        .expect("query active word at 250ms");
    assert_eq!(active_word, "Hello");

    // Test foreign key cascading from projects
    connection
        .execute("DELETE FROM projects WHERE id = ?1", [project_id])
        .expect("delete project");

    let remaining_words: i64 = connection
        .query_row(
            "SELECT count(*) FROM transcript_words WHERE revision_id = ?1",
            [revision_id],
            |row| row.get(0),
        )
        .expect("count remaining words");
    assert_eq!(remaining_words, 0, "cascade delete must clear words");

    let remaining_mappings: i64 = connection
        .query_row(
            "SELECT count(*) FROM cue_word_mappings WHERE cue_id = ?1",
            [cue_id],
            |row| row.get(0),
        )
        .expect("count remaining mappings");
    assert_eq!(remaining_mappings, 0, "cascade delete must clear mappings");
}
