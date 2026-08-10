CREATE TABLE app_meta (
  singleton INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK(singleton = 1),
  install_id BLOB NOT NULL CHECK(length(install_id) = 16),
  clean_shutdown INTEGER NOT NULL DEFAULT 1 CHECK(clean_shutdown IN (0, 1)),
  previous_shutdown_clean INTEGER NOT NULL DEFAULT 1 CHECK(previous_shutdown_clean IN (0, 1)),
  last_writer_version TEXT NOT NULL CHECK(length(last_writer_version) BETWEEN 1 AND 64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE projects (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE media_assets (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  kind TEXT NOT NULL CHECK(kind IN ('audio', 'video')),
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 512),
  extension TEXT NOT NULL CHECK(length(extension) BETWEEN 1 AND 32),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  content_hash BLOB CHECK(content_hash IS NULL OR length(content_hash) = 32),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
) STRICT;

CREATE INDEX media_assets_content_hash_idx ON media_assets(content_hash) WHERE content_hash IS NOT NULL;

CREATE TABLE project_media (
  project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  media_id BLOB NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('primary', 'source', 'reference', 'background')),
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal >= 0),
  PRIMARY KEY(project_id, media_id, role),
  UNIQUE(project_id, role, ordinal)
) STRICT;

CREATE INDEX project_media_asset_idx ON project_media(media_id);

CREATE TABLE media_locations (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  media_id BLOB NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  path_bytes BLOB NOT NULL CHECK(length(path_bytes) > 0),
  path_encoding TEXT NOT NULL CHECK(path_encoding IN ('unix-bytes', 'windows-utf16le')),
  platform TEXT NOT NULL CHECK(platform IN ('linux', 'macos', 'windows')),
  available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0, 1)),
  last_verified_at_ms INTEGER CHECK(last_verified_at_ms IS NULL OR last_verified_at_ms >= 0),
  UNIQUE(media_id, path_bytes, path_encoding)
) STRICT;

CREATE INDEX media_locations_media_idx ON media_locations(media_id, available);

CREATE TABLE media_aliases (
  namespace TEXT NOT NULL CHECK(length(namespace) BETWEEN 1 AND 64),
  alias TEXT NOT NULL CHECK(length(alias) BETWEEN 1 AND 2048),
  media_id BLOB NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  PRIMARY KEY(namespace, alias)
) STRICT;

CREATE TABLE tracks (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  role TEXT NOT NULL CHECK(role IN ('original', 'translated', 'user', 'narration', 'auxiliary')),
  language TEXT,
  label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 200),
  origin TEXT NOT NULL CHECK(length(origin) BETWEEN 1 AND 64),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX tracks_project_idx ON tracks(project_id, role);
CREATE UNIQUE INDEX tracks_project_ordinal_idx ON tracks(project_id, ordinal);

CREATE TABLE cues (
  track_id BLOB NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  id BLOB NOT NULL CHECK(length(id) = 16),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
  text TEXT NOT NULL CHECK(length(text) <= 1000000),
  source_cue_id BLOB CHECK(source_cue_id IS NULL OR length(source_cue_id) = 16),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  PRIMARY KEY(track_id, id),
  UNIQUE(track_id, ordinal)
) STRICT;

CREATE INDEX cues_timeline_idx ON cues(track_id, start_ms, end_ms);
CREATE UNIQUE INDEX cues_global_id_idx ON cues(id);

CREATE TABLE project_options (
  project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 128),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  PRIMARY KEY(project_id, key)
) STRICT;

CREATE TABLE project_revisions (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id BLOB REFERENCES project_revisions(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  state_version INTEGER NOT NULL CHECK(state_version >= 0),
  snapshot_zstd BLOB NOT NULL CHECK(length(snapshot_zstd) > 0),
  snapshot_hash BLOB NOT NULL CHECK(length(snapshot_hash) = 32),
  cue_count INTEGER NOT NULL CHECK(cue_count >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  UNIQUE(project_id, state_version)
) STRICT;

CREATE INDEX project_revisions_project_idx ON project_revisions(project_id, created_at_ms);

CREATE TABLE revision_navigation (
  project_id BLOB PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  current_revision_id BLOB NOT NULL REFERENCES project_revisions(id) ON DELETE CASCADE,
  redo_stack_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(redo_stack_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

CREATE TABLE project_state (
  project_id BLOB PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  active_media_id BLOB REFERENCES media_assets(id) ON DELETE SET NULL,
  active_track_id BLOB REFERENCES tracks(id) ON DELETE SET NULL,
  current_revision_id BLOB REFERENCES project_revisions(id) ON DELETE SET NULL,
  state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

CREATE TABLE app_settings (
  scope TEXT NOT NULL CHECK(length(scope) BETWEEN 1 AND 128),
  key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 128),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  PRIMARY KEY(scope, key)
) STRICT;

CREATE TABLE credential_refs (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  purpose TEXT NOT NULL CHECK(purpose IN ('gemini_api_key', 'genius_access_token', 'youtube_api_key', 'youtube_oauth_client')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'unavailable')),
  last_four TEXT CHECK(last_four IS NULL OR length(last_four) <= 4),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX credential_refs_purpose_idx ON credential_refs(purpose, created_at_ms, id);
CREATE UNIQUE INDEX credential_refs_singleton_purpose_idx ON credential_refs(purpose)
  WHERE purpose IN ('genius_access_token', 'youtube_api_key', 'youtube_oauth_client');

CREATE TABLE credential_cooldowns (
  credential_id BLOB NOT NULL REFERENCES credential_refs(id) ON DELETE CASCADE,
  resource TEXT NOT NULL CHECK(length(resource) BETWEEN 1 AND 256),
  until_ms INTEGER NOT NULL CHECK(until_ms >= 0),
  reason TEXT,
  PRIMARY KEY(credential_id, resource)
) STRICT;

CREATE TABLE jobs (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  kind TEXT NOT NULL CHECK(kind IN ('importMedia', 'probeMedia', 'generateWaveform', 'downloadMedia', 'exportMedia', 'transcribe', 'translate', 'analyzeSubtitles', 'generateImage', 'synthesizeNarration', 'alignNarration', 'renderVideo', 'installEngine')),
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  sequence BLOB NOT NULL CHECK(length(sequence) = 8),
  progress_basis_points INTEGER NOT NULL DEFAULT 0 CHECK(progress_basis_points BETWEEN 0 AND 10000),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX jobs_state_idx ON jobs(state, created_at_ms);

CREATE TABLE artifacts (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  project_id BLOB REFERENCES projects(id) ON DELETE CASCADE,
  job_id BLOB REFERENCES jobs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),
  relative_path TEXT NOT NULL CHECK(length(relative_path) BETWEEN 1 AND 2048),
  content_hash BLOB NOT NULL CHECK(length(content_hash) = 32),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  retention TEXT NOT NULL CHECK(retention IN ('durable', 'cache')),
  state TEXT NOT NULL CHECK(state IN ('pending', 'ready', 'failed')),
  failure_code TEXT CHECK(failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  UNIQUE(kind, content_hash),
  UNIQUE(relative_path),
  CHECK((state = 'failed' AND failure_code IS NOT NULL) OR (state != 'failed' AND failure_code IS NULL))
) STRICT;

CREATE INDEX artifacts_state_idx ON artifacts(state, created_at_ms);
CREATE INDEX artifacts_retention_state_idx ON artifacts(retention, state, created_at_ms);

CREATE TABLE cache_entries (
  cache_key BLOB PRIMARY KEY NOT NULL CHECK(length(cache_key) = 32),
  artifact_id BLOB NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(length(category) BETWEEN 1 AND 64),
  algorithm_version INTEGER NOT NULL CHECK(algorithm_version > 0),
  last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= 0),
  expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms >= 0)
) STRICT;

CREATE INDEX cache_entries_category_access_idx ON cache_entries(category, last_accessed_at_ms);

CREATE TABLE cache_leases (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  cache_key BLOB NOT NULL REFERENCES cache_entries(cache_key) ON DELETE CASCADE,
  owner TEXT NOT NULL CHECK(length(owner) BETWEEN 1 AND 128),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0)
) STRICT;

CREATE INDEX cache_leases_expiry_idx ON cache_leases(expires_at_ms);

CREATE TABLE legacy_import_sources (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  source_kind TEXT NOT NULL CHECK(length(source_kind) BETWEEN 1 AND 64),
  source_fingerprint BLOB NOT NULL CHECK(length(source_fingerprint) = 32),
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'failed')),
  discovered_at_ms INTEGER NOT NULL CHECK(discovered_at_ms >= 0),
  completed_at_ms INTEGER CHECK(completed_at_ms IS NULL OR completed_at_ms >= discovered_at_ms),
  UNIQUE(source_kind, source_fingerprint)
) STRICT;

CREATE TABLE legacy_import_items (
  source_id BLOB NOT NULL REFERENCES legacy_import_sources(id) ON DELETE CASCADE,
  legacy_key TEXT NOT NULL CHECK(length(legacy_key) BETWEEN 1 AND 2048),
  item_kind TEXT NOT NULL CHECK(length(item_kind) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK(status IN ('pending', 'imported', 'skipped', 'failed')),
  target_id BLOB CHECK(target_id IS NULL OR length(target_id) = 16),
  error_message TEXT,
  imported_at_ms INTEGER CHECK(imported_at_ms IS NULL OR imported_at_ms >= 0),
  PRIMARY KEY(source_id, legacy_key, item_kind)
) STRICT;
