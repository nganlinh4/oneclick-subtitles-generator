CREATE TABLE project_create_receipts (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  project_id BLOB UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_name TEXT NOT NULL CHECK(length(trim(requested_name)) BETWEEN 1 AND 200),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
) STRICT;
