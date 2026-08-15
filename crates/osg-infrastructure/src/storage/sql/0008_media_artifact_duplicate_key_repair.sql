-- Version 7 accepted duplicate recognized keys because SQLite's path lookup reads the first
-- occurrence while serde_json retains the last.  Any duplicate decoded top-level key makes the
-- writer provenance non-exact, independent of which key was duplicated.
CREATE TABLE media_artifact_nonexact_v8 (
  artifact_id BLOB PRIMARY KEY NOT NULL,
  top_level_entry_count INTEGER NOT NULL CHECK(top_level_entry_count > 1)
) STRICT;

INSERT INTO media_artifact_nonexact_v8(artifact_id, top_level_entry_count)
SELECT artifact.id, (
  SELECT count(*) FROM json_each(artifact.metadata_json)
)
FROM artifacts AS artifact
WHERE json_type(artifact.metadata_json) = 'object'
  AND EXISTS(
    SELECT 1
    FROM json_each(artifact.metadata_json)
    GROUP BY key
    HAVING count(*) > 1
  );

-- For normally sized metadata, repeatedly remove a decoded marker occurrence until none remains.
-- Which occurrence json_each returns is irrelevant: every marker is removed, while unrelated raw
-- values and duplicate keys remain untouched.  This never materializes JSON primitives as SQLite
-- scalars, and json_remove does not have merge-patch's destructive treatment of JSON nulls.
UPDATE artifacts AS artifact
SET metadata_json = (
  WITH RECURSIVE unbranded(metadata_json) AS (
    SELECT artifact.metadata_json
    UNION ALL
    SELECT json_remove(
      unbranded.metadata_json,
      (
        SELECT item.fullkey
        FROM json_each(unbranded.metadata_json) AS item
        WHERE item.key = 'osgMediaArtifact'
        LIMIT 1
      )
    )
    FROM unbranded
    WHERE EXISTS(
      SELECT 1
      FROM json_each(unbranded.metadata_json)
      WHERE key = 'osgMediaArtifact'
    )
  )
  SELECT unbranded.metadata_json
  FROM unbranded
  WHERE NOT EXISTS(
    SELECT 1
    FROM json_each(unbranded.metadata_json)
    WHERE key = 'osgMediaArtifact'
  )
)
WHERE EXISTS(
    SELECT 1
    FROM media_artifact_nonexact_v8 AS nonexact
    WHERE nonexact.artifact_id = artifact.id
      AND nonexact.top_level_entry_count <= 256
  )
  AND EXISTS(
    SELECT 1
    FROM json_each(artifact.metadata_json)
    WHERE key = 'osgMediaArtifact'
  );

-- A corrupt but json_valid object can contain enough duplicates to make iterative preservation
-- quadratic during startup.  Genuine media provenance has at most seven top-level entries, so a
-- larger non-exact branded object fails closed to a bounded, canonical, unbranded value.
UPDATE artifacts AS artifact
SET metadata_json = '{}'
WHERE EXISTS(
    SELECT 1
    FROM media_artifact_nonexact_v8 AS nonexact
    WHERE nonexact.artifact_id = artifact.id
      AND nonexact.top_level_entry_count > 256
  )
  AND EXISTS(
    SELECT 1
    FROM json_each(artifact.metadata_json)
    WHERE key = 'osgMediaArtifact'
  );

-- Delete claims explicitly so the repair is consistent even if a legacy connection opened with
-- foreign-key enforcement disabled.  Claims on exact edges are never rewritten or coalesced.
DELETE FROM media_artifact_job_claims
WHERE EXISTS(
  SELECT 1
  FROM media_artifact_nonexact_v8 AS nonexact
  WHERE nonexact.artifact_id = media_artifact_job_claims.artifact_id
);

DELETE FROM media_artifacts
WHERE EXISTS(
  SELECT 1
  FROM media_artifact_nonexact_v8 AS nonexact
  WHERE nonexact.artifact_id = media_artifacts.artifact_id
);

-- Exact v7 edges have no duplicate decoded keys, so json_set updates or adds one canonical JSON
-- boolean marker without disturbing nulls or nested values.
UPDATE artifacts AS artifact
SET metadata_json = json_set(metadata_json, '$.osgMediaArtifact', json('true'))
WHERE EXISTS(
  SELECT 1
  FROM media_artifacts AS valid
  WHERE valid.artifact_id = artifact.id
);

DROP TABLE media_artifact_nonexact_v8;
