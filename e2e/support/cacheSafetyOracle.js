import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { withDatabase } from './database.js';

/**
 * An independent, read-only witness for the customer state a cache clear must never erase.
 *
 * The Settings surface and cache service both consume the native cache response, so asking either
 * one whether a project survived would let one implementation vouch for itself. This oracle reads
 * SQLite directly, decodes every active media location, and hashes the bytes at those locations.
 * It never inserts a cache row: a cache artifact counts as product proof only when the product
 * itself created it before the customer pressed Clear Cache.
 */

const hex = (value) => (
  value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value
);

const rows = (database, statement, parameters = []) => database.prepare(statement)
  .all(...parameters)
  .map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, hex(value)]),
  ));

const one = (database, statement, parameters = []) => {
  const row = database.prepare(statement).get(...parameters);
  if (row === undefined) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, hex(value)]));
};

const decodeLocation = ({ path_bytes: pathBytes, path_encoding: encoding }) => {
  const bytes = Buffer.from(pathBytes, 'hex');
  if (encoding === 'windows-utf16le') return bytes.toString('utf16le').replace(/\0+$/u, '');
  if (encoding === 'unix-bytes') return bytes.toString('utf8');
  throw new Error(`unsupported media-location encoding: ${encoding}`);
};

export const fingerprintFile = (path) => {
  if (!existsSync(path)) throw new Error(`customer media bytes disappeared: ${path}`);
  const bytes = readFileSync(path);
  return {
    path,
    sizeBytes: statSync(path).size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

export const cacheSafetySnapshot = (root) => withDatabase(root, (database) => {
  const active = one(
    database,
    `SELECT lower(hex(projects.id)) AS project_id,
            projects.title,
            projects.state_version AS project_state_version,
            lower(hex(project_state.active_media_id)) AS active_media_id,
            lower(hex(project_state.active_track_id)) AS active_track_id,
            lower(hex(project_state.current_revision_id)) AS current_revision_id,
            project_state.state_version AS active_state_version
       FROM projects
       JOIN project_state ON project_state.project_id = projects.id
      ORDER BY projects.created_at_ms DESC
      LIMIT 1`,
  );
  if (active === null) throw new Error('cache-safety oracle found no active project');

  const media = one(
    database,
    `SELECT lower(hex(id)) AS id, kind, display_name, extension, size_bytes,
            lower(hex(content_hash)) AS content_hash
       FROM media_assets WHERE id = ?1`,
    [Buffer.from(active.active_media_id, 'hex')],
  );
  if (media === null || media.content_hash === null) {
    throw new Error('the active media has no durable content identity');
  }

  const rawLocations = database.prepare(
    `SELECT lower(hex(id)) AS id, lower(hex(media_id)) AS media_id,
            path_bytes, path_encoding, platform, available
       FROM media_locations
      WHERE media_id = ?1 AND available = 1
      ORDER BY id`,
  ).all(Buffer.from(active.active_media_id, 'hex'));
  if (rawLocations.length === 0) throw new Error('the active media has no available location');
  const locations = rawLocations.map((location) => {
    const path = decodeLocation({
      path_bytes: Buffer.from(location.path_bytes).toString('hex'),
      path_encoding: location.path_encoding,
    });
    return {
      id: location.id,
      mediaId: location.media_id,
      encoding: location.path_encoding,
      platform: location.platform,
      ...fingerprintFile(path),
    };
  });
  const artifacts = rows(
    database,
    `SELECT lower(hex(id)) AS id, lower(hex(project_id)) AS project_id,
            kind, relative_path, lower(hex(content_hash)) AS content_hash,
            size_bytes, retention, state
       FROM artifacts
      ORDER BY id`,
  ).map((artifact) => ({
    ...artifact,
    artifactExists: existsSync(join(root, 'data', 'artifacts', artifact.relative_path)),
  }));

  const protectedState = {
    active,
    media,
    locations,
    projectMedia: rows(
      database,
      `SELECT lower(hex(project_id)) AS project_id, lower(hex(media_id)) AS media_id,
              role, ordinal
         FROM project_media WHERE project_id = ?1 ORDER BY role, ordinal, media_id`,
      [Buffer.from(active.project_id, 'hex')],
    ),
    tracks: rows(
      database,
      `SELECT lower(hex(id)) AS id, lower(hex(project_id)) AS project_id,
              ordinal, role, language, label, origin, state_version
         FROM tracks WHERE project_id = ?1 ORDER BY ordinal`,
      [Buffer.from(active.project_id, 'hex')],
    ),
    cues: rows(
      database,
      `SELECT lower(hex(cues.track_id)) AS track_id, lower(hex(cues.id)) AS id,
              cues.ordinal, cues.start_ms, cues.end_ms, cues.text
         FROM cues
         JOIN tracks ON tracks.id = cues.track_id
        WHERE tracks.project_id = ?1
        ORDER BY cues.track_id, cues.ordinal`,
      [Buffer.from(active.project_id, 'hex')],
    ),
    revisions: rows(
      database,
      `SELECT lower(hex(id)) AS id, lower(hex(project_id)) AS project_id,
              lower(hex(parent_id)) AS parent_id, reason, state_version,
              lower(hex(snapshot_hash)) AS snapshot_hash, cue_count
         FROM project_revisions WHERE project_id = ?1 ORDER BY state_version`,
      [Buffer.from(active.project_id, 'hex')],
    ),
    renderScene: one(
      database,
      `SELECT lower(hex(project_id)) AS project_id, scene_revision, schema_version, scene_json
         FROM project_render_scenes WHERE project_id = ?1`,
      [Buffer.from(active.project_id, 'hex')],
    ),
    durableArtifacts: artifacts.filter(({ retention }) => retention === 'durable'),
    mediaArtifactOwnership: rows(
      database,
      `SELECT lower(hex(media_id)) AS media_id, lower(hex(artifact_id)) AS artifact_id
         FROM media_artifacts ORDER BY media_id, artifact_id`,
    ),
  };

  const cacheEntries = rows(
    database,
    `SELECT lower(hex(cache_entries.cache_key)) AS cache_key,
            lower(hex(cache_entries.artifact_id)) AS artifact_id,
            cache_entries.category,
            cache_entries.algorithm_version,
            artifacts.kind,
            artifacts.relative_path,
            lower(hex(artifacts.content_hash)) AS content_hash,
            artifacts.size_bytes,
            artifacts.retention,
            artifacts.state,
            CASE WHEN EXISTS(
              SELECT 1 FROM media_artifacts
               WHERE media_artifacts.artifact_id = cache_entries.artifact_id
            ) THEN 1 ELSE 0 END AS media_owned
       FROM cache_entries
       JOIN artifacts ON artifacts.id = cache_entries.artifact_id
      ORDER BY cache_entries.cache_key`,
  ).map((entry) => ({
    ...entry,
    artifactExists: existsSync(join(root, 'data', 'artifacts', entry.relative_path)),
  }));

  return { protectedState, cacheEntries, artifacts };
});
