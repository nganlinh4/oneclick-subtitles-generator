import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { cacheSafetySnapshot, fingerprintFile } from './cacheSafetyOracle.js';

const identifier = (byte) => Buffer.alloc(16, byte);

test('reads project protection and cache deletion evidence without writing the application database', () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-cache-oracle-'));
  const databaseDirectory = join(root, 'data', 'db');
  const artifactDirectory = join(root, 'data', 'artifacts', 'cache');
  const sourceDirectory = join(root, 'input');
  mkdirSync(databaseDirectory, { recursive: true });
  mkdirSync(artifactDirectory, { recursive: true });
  mkdirSync(sourceDirectory, { recursive: true });
  const source = join(sourceDirectory, 'real.mp4');
  const sourceBytes = Buffer.from('real-media-byte-identity');
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  // The product's content identity is BLAKE3-256. Keep it deliberately different from the
  // oracle's independent SHA-256 so this fixture cannot teach a caller to compare algorithms.
  const opaqueProductHash = Buffer.alloc(32, 0xa5);
  writeFileSync(source, sourceBytes);
  writeFileSync(join(artifactDirectory, 'waveform.bin'), 'rebuildable-waveform');

  const database = new DatabaseSync(join(databaseDirectory, 'osg.sqlite3'));
  try {
    database.exec(`
      CREATE TABLE projects(id BLOB, title TEXT, state_version INTEGER, created_at_ms INTEGER);
      CREATE TABLE project_state(project_id BLOB, active_media_id BLOB, active_track_id BLOB,
        current_revision_id BLOB, state_version INTEGER);
      CREATE TABLE media_assets(id BLOB, kind TEXT, display_name TEXT, extension TEXT,
        size_bytes INTEGER, content_hash BLOB);
      CREATE TABLE media_locations(id BLOB, media_id BLOB, path_bytes BLOB,
        path_encoding TEXT, platform TEXT, available INTEGER);
      CREATE TABLE project_media(project_id BLOB, media_id BLOB, role TEXT, ordinal INTEGER);
      CREATE TABLE tracks(id BLOB, project_id BLOB, ordinal INTEGER, role TEXT, language TEXT,
        label TEXT, origin TEXT, state_version INTEGER);
      CREATE TABLE cues(track_id BLOB, id BLOB, ordinal INTEGER, start_ms INTEGER,
        end_ms INTEGER, text TEXT);
      CREATE TABLE project_revisions(id BLOB, project_id BLOB, parent_id BLOB, reason TEXT,
        state_version INTEGER, snapshot_hash BLOB, cue_count INTEGER);
      CREATE TABLE project_render_scenes(project_id BLOB, scene_revision INTEGER,
        schema_version INTEGER, scene_json TEXT);
      CREATE TABLE artifacts(id BLOB, project_id BLOB, kind TEXT, relative_path TEXT,
        content_hash BLOB, size_bytes INTEGER, retention TEXT, state TEXT);
      CREATE TABLE media_artifacts(media_id BLOB, artifact_id BLOB);
      CREATE TABLE cache_entries(cache_key BLOB, artifact_id BLOB, category TEXT,
        algorithm_version INTEGER);
    `);
    const project = identifier(1);
    const media = identifier(2);
    const track = identifier(3);
    const revision = identifier(4);
    const cue = identifier(5);
    const location = identifier(6);
    const artifact = identifier(7);
    database.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)')
      .run(project, 'Cache safety', 2, 1);
    database.prepare('INSERT INTO project_state VALUES (?, ?, ?, ?, ?)')
      .run(project, media, track, revision, 2);
    database.prepare('INSERT INTO media_assets VALUES (?, ?, ?, ?, ?, ?)')
      .run(media, 'video', 'real.mp4', 'mp4', sourceBytes.length, opaqueProductHash);
    database.prepare('INSERT INTO media_locations VALUES (?, ?, ?, ?, ?, ?)')
      .run(location, media, Buffer.from(source, 'utf16le'), 'windows-utf16le', 'windows', 1);
    database.prepare('INSERT INTO project_media VALUES (?, ?, ?, ?)')
      .run(project, media, 'primary', 0);
    database.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(track, project, 0, 'user', 'en', 'Imported', 'srt', 1);
    database.prepare('INSERT INTO cues VALUES (?, ?, ?, ?, ?, ?)')
      .run(track, cue, 1, 500, 3_000, 'First cue for the preview');
    database.prepare('INSERT INTO project_revisions VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(revision, project, null, 'save', 2, Buffer.alloc(32, 8), 1);
    database.prepare('INSERT INTO project_render_scenes VALUES (?, ?, ?, ?)')
      .run(project, 1, 1, '{"source":"original"}');
    database.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(artifact, null, 'waveform', 'cache/waveform.bin', Buffer.alloc(32, 9), 20,
        'cache', 'ready');
    database.prepare('INSERT INTO cache_entries VALUES (?, ?, ?, ?)')
      .run(Buffer.alloc(32, 10), artifact, 'waveform', 1);
  } finally {
    database.close();
  }

  try {
    const beforeStat = fingerprintFile(join(databaseDirectory, 'osg.sqlite3'));
    const snapshot = cacheSafetySnapshot(root);
    const afterStat = fingerprintFile(join(databaseDirectory, 'osg.sqlite3'));
    assert.deepEqual(afterStat, beforeStat, 'the read-only oracle changed the database file');
    assert.equal(snapshot.protectedState.active.project_id, identifier(1).toString('hex'));
    assert.equal(
      snapshot.protectedState.media.content_hash,
      opaqueProductHash.toString('hex'),
      'the product content identity remains an opaque BLAKE3 value',
    );
    assert.equal(snapshot.protectedState.locations[0].sha256, sourceSha256);
    assert.equal(snapshot.protectedState.cues[0].text, 'First cue for the preview');
    assert.equal(snapshot.cacheEntries[0].category, 'waveform');
    assert.equal(snapshot.cacheEntries[0].retention, 'cache');
    assert.equal(snapshot.cacheEntries[0].media_owned, 0);
    assert.equal(snapshot.cacheEntries[0].artifactExists, true);
    assert.equal(snapshot.artifacts[0].id, identifier(7).toString('hex'));
    assert.equal(snapshot.artifacts[0].artifactExists, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
