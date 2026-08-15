CREATE TABLE media_artifacts (
  media_id BLOB NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  artifact_id BLOB NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  job_id BLOB REFERENCES jobs(id) ON DELETE SET NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  PRIMARY KEY(media_id, artifact_id)
) STRICT;

CREATE INDEX media_artifacts_artifact_idx
ON media_artifacts(artifact_id, media_id);

CREATE INDEX media_artifacts_job_idx
ON media_artifacts(job_id)
WHERE job_id IS NOT NULL;

CREATE UNIQUE INDEX project_media_single_project_idx
ON project_media(media_id);

CREATE TABLE media_project_owners (
  media_id BLOB PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
  project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
) STRICT;

INSERT INTO media_project_owners(media_id, project_id, created_at_ms)
SELECT project_media.media_id, project_media.project_id, projects.created_at_ms
FROM project_media
JOIN projects ON projects.id = project_media.project_id;

CREATE TRIGGER project_media_requires_lifetime_owner
BEFORE INSERT ON project_media
WHEN NOT EXISTS(
  SELECT 1 FROM media_project_owners
  WHERE media_id = NEW.media_id AND project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'media asset belongs to another project');
END;

INSERT OR IGNORE INTO media_artifacts(media_id, artifact_id, job_id, created_at_ms)
SELECT media.id, artifact.id, artifact.job_id,
       CASE
         WHEN media.created_at_ms > artifact.created_at_ms THEN media.created_at_ms
         ELSE artifact.created_at_ms
       END
FROM media_assets AS media
JOIN artifacts AS artifact
 ON artifact.content_hash = media.content_hash
 AND artifact.size_bytes = media.size_bytes
 AND artifact.state = 'ready'
 AND artifact.retention = 'durable'
WHERE media.content_hash IS NOT NULL
  AND json_type(artifact.metadata_json, '$.osgMediaArtifact') = 'true'
  AND json_extract(artifact.metadata_json, '$.osgMediaArtifact') = true;

UPDATE artifacts
SET metadata_json = json_set(metadata_json, '$.osgMediaArtifact', true)
WHERE EXISTS(
  SELECT 1 FROM media_artifacts WHERE artifact_id = artifacts.id
);

UPDATE media_assets
SET metadata_json = json_remove(
  json_set(metadata_json, '$.osgMediaLifecycle', 'project'),
  '$.osgMediaCandidateExpiresAtMs'
)
WHERE EXISTS(SELECT 1 FROM media_project_owners WHERE media_id = media_assets.id)
  AND COALESCE(json_extract(metadata_json, '$.osgMediaLifecycle'), '') <> 'project';

UPDATE media_assets
SET metadata_json = json_set(
  metadata_json,
  '$.osgMediaCandidateExpiresAtMs',
  CASE
    WHEN created_at_ms > 9223372036768375807 THEN 9223372036854775807
    ELSE created_at_ms + 86400000
  END
)
WHERE json_extract(metadata_json, '$.osgMediaLifecycle') = 'candidate'
  AND json_extract(metadata_json, '$.osgMediaCandidateExpiresAtMs') IS NULL;
