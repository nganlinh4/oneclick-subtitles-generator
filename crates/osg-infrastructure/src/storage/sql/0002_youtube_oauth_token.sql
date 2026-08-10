CREATE TABLE credential_refs_v2 (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  purpose TEXT NOT NULL CHECK(purpose IN (
    'gemini_api_key',
    'genius_access_token',
    'youtube_api_key',
    'youtube_oauth_client',
    'youtube_oauth_token'
  )),
  status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'unavailable')),
  last_four TEXT CHECK(last_four IS NULL OR length(last_four) <= 4),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE credential_cooldowns_v2 (
  credential_id BLOB NOT NULL REFERENCES credential_refs_v2(id) ON DELETE CASCADE,
  resource TEXT NOT NULL CHECK(length(resource) BETWEEN 1 AND 256),
  until_ms INTEGER NOT NULL CHECK(until_ms >= 0),
  reason TEXT,
  PRIMARY KEY(credential_id, resource)
) STRICT;

INSERT INTO credential_refs_v2(
  id, purpose, status, last_four, created_at_ms, updated_at_ms
)
SELECT id, purpose, status, last_four, created_at_ms, updated_at_ms
FROM credential_refs;

INSERT INTO credential_cooldowns_v2(credential_id, resource, until_ms, reason)
SELECT credential_id, resource, until_ms, reason
FROM credential_cooldowns;

DROP TABLE credential_cooldowns;
DROP TABLE credential_refs;

ALTER TABLE credential_refs_v2 RENAME TO credential_refs;
ALTER TABLE credential_cooldowns_v2 RENAME TO credential_cooldowns;

CREATE INDEX credential_refs_purpose_idx ON credential_refs(purpose, created_at_ms, id);
CREATE UNIQUE INDEX credential_refs_singleton_purpose_idx ON credential_refs(purpose)
  WHERE purpose IN (
    'genius_access_token',
    'youtube_api_key',
    'youtube_oauth_client',
    'youtube_oauth_token'
  );
