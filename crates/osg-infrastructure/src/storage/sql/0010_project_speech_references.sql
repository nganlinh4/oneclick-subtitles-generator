CREATE TABLE project_speech_references (
  project_id BLOB PRIMARY KEY NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE
    CHECK(length(project_id) = 16),
  artifact_id BLOB NOT NULL
    REFERENCES artifacts(id) ON DELETE CASCADE
    CHECK(length(artifact_id) = 16),
  reference_version INTEGER NOT NULL CHECK(reference_version > 0),
  committed_project_state_version INTEGER NOT NULL
    CHECK(committed_project_state_version >= 0),
  transcript TEXT NOT NULL CHECK(length(CAST(transcript AS BLOB)) <= 65536),
  language TEXT NOT NULL
    CHECK(length(CAST(language AS BLOB)) BETWEEN 1 AND 128),
  delivery_job_id BLOB CHECK(delivery_job_id IS NULL OR length(delivery_job_id) = 16),
  delivery_id BLOB CHECK(delivery_id IS NULL OR length(delivery_id) = 16),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  CHECK((delivery_job_id IS NULL) = (delivery_id IS NULL))
) STRICT;

CREATE UNIQUE INDEX project_speech_references_artifact_idx
ON project_speech_references(artifact_id);
