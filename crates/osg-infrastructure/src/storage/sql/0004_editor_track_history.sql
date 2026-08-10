CREATE TABLE editor_track_revisions (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id BLOB REFERENCES editor_track_revisions(id) ON DELETE SET NULL,
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  track_zstd BLOB NOT NULL CHECK(length(track_zstd) > 0),
  track_hash BLOB NOT NULL CHECK(length(track_hash) = 32),
  cue_count INTEGER NOT NULL CHECK(cue_count >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
) STRICT;

CREATE INDEX editor_track_revisions_project_idx
  ON editor_track_revisions(project_id, created_at_ms);

CREATE TABLE editor_track_navigation (
  project_id BLOB PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  track_label TEXT NOT NULL CHECK(length(trim(track_label)) BETWEEN 1 AND 200),
  track_origin TEXT NOT NULL CHECK(track_origin IN ('legacyJson', 'srt')),
  current_revision_id BLOB NOT NULL REFERENCES editor_track_revisions(id) ON DELETE CASCADE,
  redo_stack_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(redo_stack_json)),
  history_version INTEGER NOT NULL DEFAULT 0 CHECK(history_version >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;
