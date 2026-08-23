CREATE TABLE project_render_scenes (
  project_id BLOB PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE
    CHECK(length(project_id) = 16),
  scene_revision INTEGER NOT NULL CHECK(scene_revision > 0),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  scene_json TEXT NOT NULL
    CHECK(length(CAST(scene_json AS BLOB)) BETWEEN 2 AND 65536)
    CHECK(json_valid(scene_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;
