import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { withDatabase } from './database.js';

const walkRegularFiles = (root) => {
  if (!existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error('the download oracle refuses symbolic links');
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) files.push(path);
    }
  }
  return files.sort();
};

export const downloadScratchFiles = (runRoot) => walkRegularFiles(
  join(runRoot, 'cache', 'downloads', 'v1'),
);

export const managedArtifactFiles = (runRoot) => walkRegularFiles(
  join(runRoot, 'data', 'artifacts'),
).filter((path) => !path.endsWith(`${sep}.root-identity`));

export const resolveManagedArtifact = (runRoot, relativePath) => {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new Error('the durable artifact path is invalid');
  }
  const root = realpathSync(join(runRoot, 'data', 'artifacts'));
  const candidate = resolve(root, relativePath);
  const fromRoot = relative(root, candidate);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('the durable artifact escaped its managed root');
  }
  const canonical = realpathSync(candidate);
  const canonicalFromRoot = relative(root, canonical);
  if (canonicalFromRoot === '..' || canonicalFromRoot.startsWith(`..${sep}`)
      || isAbsolute(canonicalFromRoot) || !statSync(canonical).isFile()) {
    throw new Error('the durable artifact escaped its managed root');
  }
  return canonical;
};

export const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Read the complete durable ownership ledger for URL downloads without asking the application to
 * describe its own success. This intentionally includes the two join tables omitted by the broad
 * `durableState` projection: a ready artifact is not owned media until both edges exist.
 */
export const downloadDurabilityState = (runRoot) => withDatabase(runRoot, (database) => {
  const rows = (statement) => database.prepare(statement).all();
  const aliasRow = database.prepare(
    "SELECT value_json FROM app_settings WHERE scope = 'active_workspace'"
      + " AND key = 'project.subtitleCacheIndex.v1'",
  ).get();
  return {
    projects: rows(
      'SELECT lower(hex(id)) AS id, title, state_version FROM projects ORDER BY created_at_ms',
    ),
    media: rows(
      'SELECT lower(hex(id)) AS id, display_name, extension, size_bytes,'
        + ' lower(hex(content_hash)) AS content_hash FROM media_assets ORDER BY created_at_ms',
    ),
    links: rows(
      'SELECT lower(hex(project_id)) AS project_id, lower(hex(media_id)) AS media_id,'
        + ' role, ordinal FROM project_media ORDER BY project_id, role, ordinal',
    ),
    jobs: rows(
      "SELECT lower(hex(id)) AS id, state, progress_basis_points FROM jobs"
        + " WHERE kind = 'downloadMedia' ORDER BY created_at_ms",
    ),
    artifacts: rows(
      "SELECT lower(hex(id)) AS id, lower(hex(project_id)) AS project_id,"
        + " lower(hex(job_id)) AS job_id, relative_path, lower(hex(content_hash)) AS content_hash,"
        + " size_bytes, state FROM artifacts WHERE kind = 'downloadedMedia' ORDER BY created_at_ms",
    ),
    managedArtifacts: rows(
      'SELECT lower(hex(id)) AS id, kind, relative_path, size_bytes, state'
        + ' FROM artifacts ORDER BY created_at_ms',
    ),
    cacheEntries: rows(
      'SELECT lower(hex(cache_key)) AS cache_key, lower(hex(artifact_id)) AS artifact_id,'
        + ' category, algorithm_version FROM cache_entries ORDER BY category, cache_key',
    ),
    mediaArtifacts: rows(
      'SELECT lower(hex(media_id)) AS media_id, lower(hex(artifact_id)) AS artifact_id'
        + ' FROM media_artifacts ORDER BY media_id, artifact_id',
    ),
    jobClaims: rows(
      'SELECT lower(hex(media_id)) AS media_id, lower(hex(artifact_id)) AS artifact_id,'
        + ' lower(hex(job_id)) AS job_id FROM media_artifact_job_claims'
        + ' ORDER BY media_id, artifact_id, job_id',
    ),
    alias: aliasRow === undefined ? null : JSON.parse(aliasRow.value_json),
  };
});
