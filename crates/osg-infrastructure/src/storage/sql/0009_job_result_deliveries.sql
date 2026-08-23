CREATE TABLE job_result_deliveries (
  job_id BLOB PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE
    CHECK(length(job_id) = 16),
  delivery_id BLOB UNIQUE NOT NULL CHECK(length(delivery_id) = 16),
  kind TEXT NOT NULL CHECK(kind IN ('asrTranscription', 'geminiText')),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  project_id BLOB REFERENCES projects(id) ON DELETE SET NULL
    CHECK(project_id IS NULL OR length(project_id) = 16),
  asset_id BLOB REFERENCES media_assets(id) ON DELETE SET NULL
    CHECK(asset_id IS NULL OR length(asset_id) = 16),
  payload_json TEXT CHECK(
    payload_json IS NULL OR (
      json_valid(payload_json)
      AND json_type(payload_json) = 'object'
      AND length(payload_json) BETWEEN 2 AND 33554432
    )
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  acknowledged_at_ms INTEGER CHECK(
    acknowledged_at_ms IS NULL OR acknowledged_at_ms >= created_at_ms
  ),
  CHECK(
    (acknowledged_at_ms IS NULL AND payload_json IS NOT NULL)
    OR (acknowledged_at_ms IS NOT NULL AND payload_json IS NULL)
  )
) STRICT;

CREATE INDEX job_result_deliveries_pending_idx
  ON job_result_deliveries(acknowledged_at_ms, created_at_ms, job_id);
