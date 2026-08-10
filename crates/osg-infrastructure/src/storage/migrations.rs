use rusqlite_migration::{M, Migrations};

pub(super) fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("sql/0001_initial.sql")),
        M::up(include_str!("sql/0002_youtube_oauth_token.sql")),
        M::up(include_str!("sql/0003_job_restore_window.sql")),
        M::up(include_str!("sql/0004_editor_track_history.sql")),
    ])
}
