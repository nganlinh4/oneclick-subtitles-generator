import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A read-only look at what the application actually wrote down.
 *
 * WHY A JOURNEY NEEDS THIS. Everything else a journey can see is the interface reporting on itself.
 * A cue visible in the editor proves React rendered something; it does not prove a customer will
 * find their work after closing the application. Durability is a property of the database, so it is
 * checked in the database — independently of the code that wrote it, and after the fact.
 *
 * STRICTLY READ-ONLY, and not only by flag. Nothing here inserts, updates or repairs: a fixture that
 * writes application state is a fixture that stops testing the application. If a journey needs a
 * project to exist, it makes one through the interface.
 *
 * WAL: the application commits through a write-ahead log, so recent transactions live in the `-wal`
 * file until a checkpoint. SQLite reads that transparently, but only when the sidecar files are
 * present, which is why the whole `db` directory is opened rather than the main file copied.
 */

const relative = (root) => join(root, 'data', 'db', 'osg.sqlite3');

/** Whether the application has created its database yet. */
export const databaseExists = (root) => existsSync(relative(root));

/**
 * Run `read` against the application's database and close it again.
 *
 * The handle is opened per call rather than held: a journey that kept one open would hold a file
 * lock across a relaunch and change the behaviour it is trying to observe.
 */
export const withDatabase = (root, read) => {
  const database = new DatabaseSync(relative(root), { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
};

/**
 * What the application durably knows, reduced to the things a customer would notice losing.
 *
 * Deliberately a small, stable projection rather than a schema dump: a journey asserting on this
 * should fail when a customer's work is lost, not when a column is added.
 */
export const durableState = (root) => withDatabase(root, (database) => {
  /**
   * Identifiers are stored as BLOBs, and `node:sqlite` hands them back as byte arrays.
   *
   * Two reads of the same row therefore produce two DIFFERENT objects holding the same bytes, so
   * comparing them with `assert.equal` compares object identity and fails on a project that
   * restored perfectly -- with a diff printed as two lists of numbers, which names nothing. Read as
   * hex they compare by value and a failure names the id that differs.
   */
  const readable = (row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [
    column,
    value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value,
  ]));
  const all = (sql) => database.prepare(sql).all().map(readable);
  const one = (sql) => {
    const row = database.prepare(sql).get();
    return row === undefined ? row : readable(row);
  };

  const projects = all('SELECT id, title, state_version FROM projects ORDER BY created_at_ms');
  const media = all(
    'SELECT id, kind, display_name, extension, size_bytes, content_hash FROM media_assets'
    + ' ORDER BY created_at_ms',
  );
  const cues = all(
    'SELECT track_id, id, ordinal, start_ms, end_ms, text FROM cues ORDER BY track_id, ordinal',
  );
  const revisions = all(
    'SELECT id, project_id, reason, state_version, cue_count FROM project_revisions'
    + ' ORDER BY created_at_ms',
  );
  const jobs = all(
    'SELECT id, kind, state, progress_basis_points, created_at_ms, updated_at_ms FROM jobs'
    + ' ORDER BY created_at_ms',
  );
  const artifacts = all(
    'SELECT id, project_id, job_id, kind, relative_path, content_hash, size_bytes, state'
    + ' FROM artifacts ORDER BY created_at_ms',
  );
  const links = all('SELECT project_id, media_id, role FROM project_media');

  return {
    projects,
    media,
    cues,
    revisions,
    jobs,
    artifacts,
    links,
    counts: {
      projects: projects.length,
      media: media.length,
      cues: cues.length,
      revisions: revisions.length,
      jobs: jobs.length,
      artifacts: artifacts.length,
    },
    latestRevision: one(
      'SELECT id, project_id, reason, state_version, cue_count FROM project_revisions'
      + ' ORDER BY created_at_ms DESC LIMIT 1',
    ) ?? null,
    latestJob: jobs.at(-1) ?? null,
  };
});

/** The project-owned translation records, decoded independently from the app's JSON reader. */
export const durableTranslations = (root) => withDatabase(root, (database) => (
  database.prepare(
    "SELECT key, value_json FROM app_settings WHERE scope = 'app'"
      + " AND key LIKE 'project.legacyAux.v1.%' ORDER BY key",
  ).all().map(({ key, value_json: valueJson }) => {
    const auxiliary = JSON.parse(valueJson);
    return { key, translation: auxiliary?.translation ?? null };
  })
));

/** Project-owned render scenes, decoded independently from the app's command boundary. */
export const durableRenderScenes = (root) => withDatabase(root, (database) => (
  database.prepare(
    'SELECT hex(project_id) AS project_id, scene_revision, schema_version, scene_json'
      + ' FROM project_render_scenes ORDER BY updated_at_ms',
  ).all().map((row) => ({
    projectId: String(row.project_id).toLowerCase(),
    sceneRevision: row.scene_revision,
    schemaVersion: row.schema_version,
    scene: JSON.parse(row.scene_json),
  }))
));
