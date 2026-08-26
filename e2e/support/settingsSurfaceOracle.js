import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  existsSync, lstatSync, readFileSync, readdirSync, statSync,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { withDatabase } from './database.js';

const MAX_DIRECTORY_ENTRIES = 250_000;

const readableHex = (value) => (
  value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value
);

const ordinaryWindowsPath = (path) => {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
  if (path.startsWith('\\\\?\\')) return path.slice(4);
  return path;
};

const normalizedRelativePath = (root, candidate, label) => {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(ordinaryWindowsPath(candidate));
  const inside = relative(normalizedRoot, normalizedCandidate);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`)) {
    throw new Error(`${label} escaped the isolated run root`);
  }
  return inside.replaceAll('\\', '/');
};

const decodeMediaPath = ({ path_bytes: pathBytes, path_encoding: pathEncoding }) => {
  const bytes = Buffer.from(pathBytes);
  if (pathEncoding === 'windows-utf16le') {
    return ordinaryWindowsPath(bytes.toString('utf16le').replace(/\0+$/u, ''));
  }
  if (pathEncoding === 'unix-bytes') return bytes.toString('utf8');
  throw new Error(`unsupported media path encoding: ${pathEncoding}`);
};

/** Read only the exact durable application preferences a journey intends to prove. */
export const durableSettings = (root, keys) => {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('durable settings require an explicit non-empty key list');
  }
  const unique = [...new Set(keys)];
  if (unique.some((key) => typeof key !== 'string' || key.length === 0)) {
    throw new Error('durable setting keys must be non-empty strings');
  }

  return withDatabase(root, (database) => Object.fromEntries(unique.map((key) => {
    const row = database.prepare(
      "SELECT value_json FROM app_settings WHERE scope = 'app' AND key = ?",
    ).get(key);
    return [key, row === undefined ? null : JSON.parse(row.value_json)];
  })));
};

const uuidTextToHex = (value, label) => {
  if (typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`${label} is not a UUID`);
  }
  return value.replaceAll('-', '').toUpperCase();
};

/**
 * The exact native workspace authority which Settings reset must preserve.
 *
 * This deliberately reads the non-preference scope and independently joins its project pointer to
 * `project_state`. A content hash cannot satisfy this oracle: byte-identical media in two projects
 * still have different project, media, and track UUIDs.
 */
export const durableWorkspaceIdentity = (root) => withDatabase(root, (database) => {
  const readRecord = (key) => {
    const row = database.prepare(
      "SELECT value_json FROM app_settings WHERE scope = 'active_workspace' AND key = ?",
    ).get(key);
    return row === undefined ? null : JSON.parse(row.value_json);
  };
  const initialized = readRecord('initialized');
  const current = readRecord('current');
  const aliases = readRecord('project.subtitleCacheIndex.v1');
  if (current === null || aliases === null) {
    return {
      initialized, current, aliases, projectState: null,
    };
  }

  const projectId = uuidTextToHex(current.projectId, 'workspace projectId');
  const mediaId = uuidTextToHex(current.mediaId, 'workspace mediaId');
  const projectState = database.prepare(
    'SELECT hex(project_id) AS project_id, hex(active_media_id) AS media_id,'
      + ' hex(active_track_id) AS track_id, state_version'
      + ' FROM project_state WHERE hex(project_id) = ?',
  ).get(projectId);
  if (projectState === undefined) throw new Error('workspace project state is missing');
  if (projectState.media_id !== mediaId) {
    throw new Error('workspace media is not the project active media');
  }

  return {
    initialized,
    current: {
      schemaVersion: current.schemaVersion,
      cacheId: current.cacheId,
      projectId,
      mediaId,
    },
    aliases: {
      schemaVersion: aliases.schemaVersion,
      activeCacheId: aliases.activeCacheId,
      entries: aliases.entries.map((entry) => ({
        cacheId: entry.cacheId,
        projectId: uuidTextToHex(entry.projectId, 'alias projectId'),
      })),
    },
    projectState: {
      projectId: projectState.project_id,
      mediaId: projectState.media_id,
      trackId: projectState.track_id,
      stateVersion: projectState.state_version,
    },
  };
});

/**
 * Customer-owned state reduced to stable identities, plus a byte-level check of every available
 * source location. Paths are never returned and a location outside the disposable root is refused:
 * a test oracle must not inspect the developer's files just because a damaged database names one.
 */
export const durableCustomerIdentity = (root) => withDatabase(root, (database) => {
  const rows = (sql) => database.prepare(sql).all().map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, readableHex(value)]),
  ));
  const projects = rows(
    'SELECT hex(id) AS id, title, state_version FROM projects ORDER BY created_at_ms, id',
  );
  const media = rows(
    'SELECT hex(id) AS id, kind, display_name, extension, size_bytes,'
      + ' hex(content_hash) AS content_hash FROM media_assets ORDER BY created_at_ms, id',
  );
  const links = rows(
    'SELECT hex(project_id) AS project_id, hex(media_id) AS media_id, role, ordinal'
      + ' FROM project_media ORDER BY project_id, role, ordinal',
  );
  const tracks = rows(
    'SELECT hex(id) AS id, hex(project_id) AS project_id, ordinal, role, state_version'
      + ' FROM tracks ORDER BY project_id, ordinal',
  );
  const cues = database.prepare(
    'SELECT hex(track_id) AS track_id, hex(id) AS id, ordinal, start_ms, end_ms, text'
      + ' FROM cues ORDER BY track_id, ordinal',
  ).all().map(({ text, ...cue }) => ({
    ...cue,
    text_hash: createHash('sha256').update(text, 'utf8').digest('hex'),
  }));
  const locations = database.prepare(
    'SELECT hex(media_id) AS media_id, path_bytes, path_encoding, available'
      + ' FROM media_locations ORDER BY media_id, id',
  ).all();
  const sourceFiles = locations.map((location) => {
    const path = decodeMediaPath(location);
    const relativePath = normalizedRelativePath(root, path, 'media location');
    const available = location.available === 1;
    if (!available) {
      return { mediaId: location.media_id, relativePath, available, size: null, sha256: null };
    }
    if (!existsSync(path)) {
      throw new Error(`an available media location is missing inside the isolated root: ${relativePath}`);
    }
    const metadata = statSync(path);
    if (!metadata.isFile()) {
      throw new Error(`an available media location is not a regular file: ${relativePath}`);
    }
    return {
      mediaId: location.media_id,
      relativePath,
      available,
      size: metadata.size,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  });

  return { projects, media, links, tracks, cues, sourceFiles };
});

/**
 * A content-free shape digest for the large shared tool/model stores.
 *
 * File bytes may contain executables or model weights and are deliberately not read. Sorted paths,
 * entry types, and file sizes are sufficient to prove the Settings UI did not remove or truncate a
 * package. Reparse points are recorded but never followed, and an unexpectedly huge tree fails
 * before a destructive UI action instead of silently truncating the inventory.
 */
export const directoryShapeDigest = (directory, maximumEntries = MAX_DIRECTORY_ENTRIES) => {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new Error('directory inventory limit must be a positive safe integer');
  }
  const root = resolve(directory);
  if (!existsSync(root)) return { exists: false, entries: 0, files: 0, bytes: 0, sha256: null };

  const digest = createHash('sha256');
  let entries = 0;
  let files = 0;
  let bytes = 0;
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      entries += 1;
      if (entries > maximumEntries) {
        throw new Error(`directory inventory exceeded ${maximumEntries} entries: ${root}`);
      }
      const path = resolve(current, entry.name);
      const name = relative(root, path).replaceAll('\\', '/');
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        digest.update(`link\0${name}\0${metadata.size}\n`);
      } else if (metadata.isDirectory()) {
        digest.update(`directory\0${name}\n`);
        visit(path);
      } else if (metadata.isFile()) {
        files += 1;
        bytes += metadata.size;
        digest.update(`file\0${name}\0${metadata.size}\n`);
      } else {
        digest.update(`other\0${name}\0${metadata.size}\n`);
      }
    }
  };
  visit(root);
  return { exists: true, entries, files, bytes, sha256: digest.digest('hex') };
};
