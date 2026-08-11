CREATE TEMP TABLE artifact_job_links_v5 (
  artifact_id BLOB PRIMARY KEY NOT NULL,
  job_id BLOB NOT NULL
) STRICT;

INSERT INTO artifact_job_links_v5 (artifact_id, job_id)
SELECT id, job_id FROM artifacts WHERE job_id IS NOT NULL;

UPDATE artifacts SET job_id = NULL WHERE job_id IS NOT NULL;

CREATE TABLE jobs_v5 (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  kind TEXT NOT NULL CHECK(kind IN ('importMedia', 'probeMedia', 'processMedia', 'generateWaveform', 'downloadMedia', 'exportMedia', 'transcribe', 'translate', 'analyzeSubtitles', 'generateImage', 'synthesizeNarration', 'alignNarration', 'renderVideo', 'installEngine')),
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  sequence BLOB NOT NULL CHECK(length(sequence) = 8),
  progress_basis_points INTEGER NOT NULL DEFAULT 0 CHECK(progress_basis_points BETWEEN 0 AND 10000),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT;

INSERT INTO jobs_v5 (
  id, kind, state, sequence, progress_basis_points, created_at_ms, updated_at_ms
)
SELECT id, kind, state, sequence, progress_basis_points, created_at_ms, updated_at_ms
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v5 RENAME TO jobs;
CREATE INDEX jobs_state_updated_idx ON jobs(state, updated_at_ms DESC, id DESC);

UPDATE artifacts
SET job_id = (
  SELECT links.job_id
  FROM artifact_job_links_v5 AS links
  WHERE links.artifact_id = artifacts.id
)
WHERE id IN (SELECT artifact_id FROM artifact_job_links_v5);

DROP TABLE artifact_job_links_v5;
