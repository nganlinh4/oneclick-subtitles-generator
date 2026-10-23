use rusqlite_migration::{M, Migrations};

pub(super) fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("sql/0001_initial.sql")),
        M::up(include_str!("sql/0002_youtube_oauth_token.sql")),
        M::up(include_str!("sql/0003_job_restore_window.sql")),
        M::up(include_str!("sql/0004_editor_track_history.sql")),
        M::up(include_str!("sql/0005_process_media_job.sql")),
        M::up(include_str!("sql/0006_media_artifact_ownership.sql")),
        M::up(include_str!("sql/0007_media_artifact_repair.sql")),
        M::up(include_str!(
            "sql/0008_media_artifact_duplicate_key_repair.sql"
        )),
        M::up(include_str!("sql/0009_job_result_deliveries.sql")),
        M::up(include_str!("sql/0010_project_speech_references.sql")),
        M::up(include_str!("sql/0011_project_render_scenes.sql")),
        M::up(include_str!("sql/0012_project_create_receipts.sql")),
        M::up(include_str!("sql/0013_legacy_default_subtitle_scale.sql")),
        M::up(include_str!(
            "sql/0014_sparse_legacy_default_subtitle_scale.sql"
        )),
        M::up(include_str!("sql/0015_word_native_transcripts.sql")),
        M::up(include_str!(
            "sql/0016_late_legacy_default_subtitle_scale.sql"
        )),
        M::up(include_str!("sql/0017_readable_default_subtitle_scale.sql")),
    ])
}

#[cfg(test)]
mod tests;
