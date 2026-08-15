-- Version 6 was opened by pre-release databases, so its migration is immutable.  Rebuild the
-- ownership edge here, retaining only artifacts whose v5/v6 producer provenance is exact, and
-- split the lossy single job column into a plural claim relation.
ALTER TABLE media_artifacts RENAME TO media_artifacts_v6;

DROP INDEX media_artifacts_artifact_idx;
DROP INDEX media_artifacts_job_idx;

CREATE TABLE media_artifacts (
  media_id BLOB NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  artifact_id BLOB NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  PRIMARY KEY(media_id, artifact_id)
) STRICT;

CREATE INDEX media_artifacts_artifact_idx
ON media_artifacts(artifact_id, media_id);

CREATE TABLE media_artifact_job_claims (
  media_id BLOB NOT NULL,
  artifact_id BLOB NOT NULL,
  job_id BLOB NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  PRIMARY KEY(media_id, artifact_id, job_id),
  FOREIGN KEY(media_id, artifact_id)
    REFERENCES media_artifacts(media_id, artifact_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX media_artifact_job_claims_job_idx
ON media_artifact_job_claims(job_id, media_id, artifact_id);

CREATE INDEX media_artifact_job_claims_artifact_idx
ON media_artifact_job_claims(artifact_id, media_id, job_id);

-- This migration-only table records the exact v5 writer shapes.  A marker by itself is not
-- provenance: v6 incorrectly treated any durable same-content row carrying that marker as media.
CREATE TABLE media_artifact_repair_v7 (
  media_id BLOB NOT NULL,
  artifact_id BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  PRIMARY KEY(media_id, artifact_id)
) STRICT;

INSERT INTO media_artifact_repair_v7(media_id, artifact_id, created_at_ms)
SELECT media.id, artifact.id,
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
  AND json_type(artifact.metadata_json) = 'object'
  AND (
    (
      artifact.kind = 'downloadedMedia'
      AND json_type(artifact.metadata_json, '$.source') = 'text'
      AND json_extract(artifact.metadata_json, '$.source') = 'urlDownload'
      AND json_type(artifact.metadata_json, '$.filename') = 'text'
      AND json_extract(artifact.metadata_json, '$.filename') = media.display_name
      AND length(trim(json_extract(artifact.metadata_json, '$.filename'))) BETWEEN 1 AND 512
      AND EXISTS(
        SELECT 1 FROM jobs AS producer
        WHERE producer.id = artifact.job_id AND producer.kind = 'downloadMedia'
      )
      AND NOT EXISTS(
        SELECT 1 FROM json_each(artifact.metadata_json)
        WHERE key NOT IN ('source', 'filename', 'osgMediaArtifact', 'commitOnJobSuccess')
      )
    )
    OR (
      artifact.kind = 'preparedMedia'
      AND json_type(artifact.metadata_json, '$.operation') = 'text'
      AND json_extract(artifact.metadata_json, '$.operation') = 'preparePlayback'
      AND json_type(artifact.metadata_json, '$.sourceAssetId') = 'text'
      AND length(json_extract(artifact.metadata_json, '$.sourceAssetId')) = 36
      AND json_extract(artifact.metadata_json, '$.sourceAssetId')
            = lower(json_extract(artifact.metadata_json, '$.sourceAssetId'))
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 9, 1) = '-'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 14, 1) = '-'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 15, 1) = '7'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 19, 1) = '-'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 20, 1)
            IN ('8', '9', 'a', 'b')
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 24, 1) = '-'
      AND length(replace(lower(json_extract(artifact.metadata_json, '$.sourceAssetId')), '-', '')) = 32
      AND replace(lower(json_extract(artifact.metadata_json, '$.sourceAssetId')), '-', '')
            NOT GLOB '*[^0-9a-f]*'
      AND EXISTS(
        SELECT 1 FROM media_assets AS source_media
        WHERE lower(hex(source_media.id)) = replace(
          json_extract(artifact.metadata_json, '$.sourceAssetId'), '-', ''
        )
      )
      AND media.display_name = 'prepared-media.' || media.extension
      AND EXISTS(
        SELECT 1 FROM jobs AS producer
        WHERE producer.id = artifact.job_id AND producer.kind = 'processMedia'
      )
      AND NOT EXISTS(
        SELECT 1 FROM json_each(artifact.metadata_json)
        WHERE key NOT IN ('operation', 'sourceAssetId', 'osgMediaArtifact', 'commitOnJobSuccess')
      )
    )
    OR (
      artifact.kind = 'analysisClip'
      AND media.kind = 'video'
      AND media.display_name = 'analysis-clip.' || media.extension
      AND json_type(artifact.metadata_json, '$.operation') = 'text'
      AND json_extract(artifact.metadata_json, '$.operation') = 'analysisClip'
      AND json_type(artifact.metadata_json, '$.sourceAssetId') = 'text'
      AND length(json_extract(artifact.metadata_json, '$.sourceAssetId')) = 36
      AND json_extract(artifact.metadata_json, '$.sourceAssetId')
            = lower(json_extract(artifact.metadata_json, '$.sourceAssetId'))
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 9, 1) = '-'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 14, 1) = '-'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 15, 1) = '7'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 19, 1) = '-'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 20, 1)
            IN ('8', '9', 'a', 'b')
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 24, 1) = '-'
      AND length(replace(lower(json_extract(artifact.metadata_json, '$.sourceAssetId')), '-', '')) = 32
      AND replace(lower(json_extract(artifact.metadata_json, '$.sourceAssetId')), '-', '')
            NOT GLOB '*[^0-9a-f]*'
      AND EXISTS(
        SELECT 1 FROM media_assets AS source_media
        WHERE lower(hex(source_media.id)) = replace(
          json_extract(artifact.metadata_json, '$.sourceAssetId'), '-', ''
        )
      )
      AND json_type(artifact.metadata_json, '$.startUs') = 'integer'
      AND json_extract(artifact.metadata_json, '$.startUs') BETWEEN 0 AND 604800000000
      AND json_type(artifact.metadata_json, '$.endUs') = 'integer'
      AND json_extract(artifact.metadata_json, '$.endUs')
            > json_extract(artifact.metadata_json, '$.startUs')
      AND json_extract(artifact.metadata_json, '$.endUs') <= 604800000000
      AND EXISTS(
        SELECT 1 FROM jobs AS producer
        WHERE producer.id = artifact.job_id AND producer.kind = 'processMedia'
      )
      AND NOT EXISTS(
        SELECT 1 FROM json_each(artifact.metadata_json)
        WHERE key NOT IN (
          'operation', 'sourceAssetId', 'startUs', 'endUs',
          'osgMediaArtifact', 'commitOnJobSuccess'
        )
      )
    )
    OR (
      artifact.kind = 'extractedAudio'
      AND media.kind = 'audio'
      AND media.display_name = 'extracted-audio.' || media.extension
      AND json_type(artifact.metadata_json, '$.operation') = 'text'
      AND json_extract(artifact.metadata_json, '$.operation') = 'extractAudio'
      AND json_type(artifact.metadata_json, '$.sourceAssetId') = 'text'
      AND length(json_extract(artifact.metadata_json, '$.sourceAssetId')) = 36
      AND json_extract(artifact.metadata_json, '$.sourceAssetId')
            = lower(json_extract(artifact.metadata_json, '$.sourceAssetId'))
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 9, 1) = '-'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 14, 1) = '-'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 15, 1) = '7'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 19, 1) = '-'
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 20, 1)
            IN ('8', '9', 'a', 'b')
      AND substr(json_extract(artifact.metadata_json, '$.sourceAssetId'), 24, 1) = '-'
      AND length(replace(lower(json_extract(artifact.metadata_json, '$.sourceAssetId')), '-', '')) = 32
      AND replace(lower(json_extract(artifact.metadata_json, '$.sourceAssetId')), '-', '')
            NOT GLOB '*[^0-9a-f]*'
      AND EXISTS(
        SELECT 1 FROM media_assets AS source_media
        WHERE lower(hex(source_media.id)) = replace(
          json_extract(artifact.metadata_json, '$.sourceAssetId'), '-', ''
        )
      )
      AND json_type(artifact.metadata_json, '$.format') = 'text'
      AND json_extract(artifact.metadata_json, '$.format') IN ('wav', 'm4a', 'mp3', 'flac')
      AND json_extract(artifact.metadata_json, '$.format') = media.extension
      AND json_type(artifact.metadata_json, '$.startUs') = 'integer'
      AND json_extract(artifact.metadata_json, '$.startUs') BETWEEN 0 AND 604800000000
      AND (
        (
          json_type(artifact.metadata_json, '$.endUs') = 'integer'
          AND json_extract(artifact.metadata_json, '$.endUs')
                > json_extract(artifact.metadata_json, '$.startUs')
          AND json_extract(artifact.metadata_json, '$.endUs') <= 604800000000
        )
        OR (
          json_type(artifact.metadata_json, '$.endUs') = 'null'
          AND json_extract(artifact.metadata_json, '$.startUs') = 0
        )
      )
      AND EXISTS(
        SELECT 1 FROM jobs AS producer
        WHERE producer.id = artifact.job_id AND producer.kind = 'processMedia'
      )
      AND NOT EXISTS(
        SELECT 1 FROM json_each(artifact.metadata_json)
        WHERE key NOT IN (
          'operation', 'sourceAssetId', 'format', 'startUs', 'endUs',
          'osgMediaArtifact', 'commitOnJobSuccess'
        )
      )
    )
  )
  AND (
    json_type(artifact.metadata_json, '$.osgMediaArtifact') IS NULL
    OR json_type(artifact.metadata_json, '$.osgMediaArtifact') = 'true'
    -- v6 used json_set(..., true), which SQLite serialized as the JSON number 1.
    OR (
      json_type(artifact.metadata_json, '$.osgMediaArtifact') = 'integer'
      AND json_extract(artifact.metadata_json, '$.osgMediaArtifact') = 1
    )
  )
  AND (
    json_type(artifact.metadata_json, '$.commitOnJobSuccess') IS NULL
    OR json_type(artifact.metadata_json, '$.commitOnJobSuccess') = 'true'
  );

INSERT INTO media_artifacts(media_id, artifact_id, created_at_ms)
SELECT media_id, artifact_id, created_at_ms
FROM media_artifact_repair_v7;

-- Retain the v6 edge's job and the artifact producer's job.  They can differ after a retry, and
-- both claims are meaningful for discard/reconciliation decisions.
INSERT OR IGNORE INTO media_artifact_job_claims(
  media_id, artifact_id, job_id, created_at_ms
)
SELECT old.media_id, old.artifact_id, old.job_id, old.created_at_ms
FROM media_artifacts_v6 AS old
JOIN media_artifact_repair_v7 AS valid
  ON valid.media_id = old.media_id AND valid.artifact_id = old.artifact_id
JOIN jobs ON jobs.id = old.job_id
WHERE old.job_id IS NOT NULL;

INSERT OR IGNORE INTO media_artifact_job_claims(
  media_id, artifact_id, job_id, created_at_ms
)
SELECT valid.media_id, valid.artifact_id, artifact.job_id, valid.created_at_ms
FROM media_artifact_repair_v7 AS valid
JOIN artifacts AS artifact ON artifact.id = valid.artifact_id
JOIN jobs ON jobs.id = artifact.job_id
WHERE artifact.job_id IS NOT NULL;

UPDATE artifacts
SET metadata_json = json_set(metadata_json, '$.osgMediaArtifact', json('true'))
WHERE EXISTS(
  SELECT 1 FROM media_artifact_repair_v7 AS valid
  WHERE valid.artifact_id = artifacts.id
);

DROP TABLE media_artifacts_v6;
DROP TABLE media_artifact_repair_v7;
