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
  const all = (sql) => database.prepare(sql).all();
  const one = (sql) => database.prepare(sql).get();

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
  const links = all('SELECT project_id, media_id, role FROM project_media');

  return {
    projects,
    media,
    cues,
    revisions,
    links,
    counts: {
      projects: projects.length,
      media: media.length,
      cues: cues.length,
      revisions: revisions.length,
    },
    latestRevision: one(
      'SELECT id, project_id, reason, state_version, cue_count FROM project_revisions'
      + ' ORDER BY created_at_ms DESC LIMIT 1',
    ) ?? null,
  };
});
