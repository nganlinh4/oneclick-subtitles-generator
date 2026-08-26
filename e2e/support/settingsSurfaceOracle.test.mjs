import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  directoryShapeDigest,
  durableCustomerIdentity,
  durableSettings,
  durableWorkspaceIdentity,
} from './settingsSurfaceOracle.js';

const utf16Path = (path) => Buffer.from(`${path}\0`, 'utf16le');

const withFixture = (run) => {
  const root = mkdtempSync(join(tmpdir(), 'osg-settings-oracle-'));
  const databaseDirectory = join(root, 'data', 'db');
  const inputDirectory = join(root, 'input');
  mkdirSync(databaseDirectory, { recursive: true });
  mkdirSync(inputDirectory, { recursive: true });
  const database = new DatabaseSync(join(databaseDirectory, 'osg.sqlite3'));
  try {
    database.exec(`
      CREATE TABLE app_settings(scope TEXT, key TEXT, value_json TEXT);
      CREATE TABLE projects(id BLOB, title TEXT, state_version INTEGER, created_at_ms INTEGER);
      CREATE TABLE media_assets(
        id BLOB, kind TEXT, display_name TEXT, extension TEXT, size_bytes INTEGER,
        content_hash BLOB, created_at_ms INTEGER
      );
      CREATE TABLE project_media(project_id BLOB, media_id BLOB, role TEXT, ordinal INTEGER);
      CREATE TABLE project_state(
        project_id BLOB, active_media_id BLOB, active_track_id BLOB, state_version INTEGER
      );
      CREATE TABLE tracks(
        id BLOB, project_id BLOB, ordinal INTEGER, role TEXT, state_version INTEGER
      );
      CREATE TABLE cues(
        track_id BLOB, id BLOB, ordinal INTEGER, start_ms INTEGER, end_ms INTEGER, text TEXT
      );
      CREATE TABLE media_locations(
        id BLOB, media_id BLOB, path_bytes BLOB, path_encoding TEXT, available INTEGER
      );
    `);
    run({ root, database, inputDirectory });
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
};

test('reads exact durable settings and independently hashes isolated customer media', () => {
  withFixture(({ root, database, inputDirectory }) => {
    const project = Buffer.alloc(16, 0x11);
    const media = Buffer.alloc(16, 0x22);
    const track = Buffer.alloc(16, 0x33);
    const cue = Buffer.alloc(16, 0x44);
    const source = join(inputDirectory, 'customer.mp4');
    const bytes = Buffer.from('real fixture bytes');
    writeFileSync(source, bytes);
    database.prepare('INSERT INTO app_settings VALUES (?, ?, ?)')
      .run('app', 'theme', JSON.stringify('dark'));
    database.prepare('INSERT INTO app_settings VALUES (?, ?, ?)').run(
      'active_workspace',
      'initialized',
      'true',
    );
    database.prepare('INSERT INTO app_settings VALUES (?, ?, ?)').run(
      'active_workspace',
      'current',
      JSON.stringify({
        schemaVersion: 1,
        cacheId: 'exact-cache',
        projectId: '11111111-1111-1111-1111-111111111111',
        mediaId: '22222222-2222-2222-2222-222222222222',
      }),
    );
    database.prepare('INSERT INTO app_settings VALUES (?, ?, ?)').run(
      'active_workspace',
      'project.subtitleCacheIndex.v1',
      JSON.stringify({
        schemaVersion: 1,
        activeCacheId: 'exact-cache',
        entries: [{
          cacheId: 'exact-cache',
          projectId: '11111111-1111-1111-1111-111111111111',
          lastOpenedAt: 7,
        }],
      }),
    );
    database.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)')
      .run(project, 'Project', 4, 1);
    database.prepare('INSERT INTO media_assets VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(media, 'video', 'customer.mp4', 'mp4', bytes.length, createHash('sha256').update(bytes).digest(), 1);
    database.prepare('INSERT INTO project_media VALUES (?, ?, ?, ?)')
      .run(project, media, 'primary', 0);
    database.prepare('INSERT INTO project_state VALUES (?, ?, ?, ?)')
      .run(project, media, track, 4);
    database.prepare('INSERT INTO tracks VALUES (?, ?, ?, ?, ?)')
      .run(track, project, 0, 'original', 2);
    database.prepare('INSERT INTO cues VALUES (?, ?, ?, ?, ?, ?)')
      .run(track, cue, 1, 0, 1_000, 'fixture cue');
    database.prepare('INSERT INTO media_locations VALUES (?, ?, ?, ?, ?)')
      .run(Buffer.alloc(16, 0x55), media, utf16Path(source), 'windows-utf16le', 1);

    assert.deepEqual(durableSettings(root, ['theme', 'missing']), {
      theme: 'dark',
      missing: null,
    });
    const identity = durableCustomerIdentity(root);
    assert.equal(identity.projects[0].id, project.toString('hex').toUpperCase());
    assert.equal(identity.media[0].content_hash, createHash('sha256').update(bytes).digest('hex').toUpperCase());
    assert.equal(identity.cues[0].text_hash.length, 64);
    assert.deepEqual(identity.sourceFiles, [{
      mediaId: media.toString('hex').toUpperCase(),
      relativePath: 'input/customer.mp4',
      available: true,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }]);
    assert.deepEqual(durableWorkspaceIdentity(root), {
      initialized: true,
      current: {
        schemaVersion: 1,
        cacheId: 'exact-cache',
        projectId: project.toString('hex').toUpperCase(),
        mediaId: media.toString('hex').toUpperCase(),
      },
      aliases: {
        schemaVersion: 1,
        activeCacheId: 'exact-cache',
        entries: [{
          cacheId: 'exact-cache',
          projectId: project.toString('hex').toUpperCase(),
        }],
      },
      projectState: {
        projectId: project.toString('hex').toUpperCase(),
        mediaId: media.toString('hex').toUpperCase(),
        trackId: track.toString('hex').toUpperCase(),
        stateVersion: 4,
      },
    });
  });
});

test('refuses to inspect a media location outside the isolated run root', () => {
  withFixture(({ root, database }) => {
    const outside = join(tmpdir(), 'not-owned-by-this-run.mp4');
    database.prepare('INSERT INTO media_locations VALUES (?, ?, ?, ?, ?)')
      .run(Buffer.alloc(16, 0x11), Buffer.alloc(16, 0x22), utf16Path(outside), 'windows-utf16le', 0);
    assert.throws(() => durableCustomerIdentity(root), /escaped the isolated run root/);
  });
});

test('treats a Windows verbatim spelling as the same isolated source path', () => {
  withFixture(({ root, database, inputDirectory }) => {
    const source = join(inputDirectory, 'verbatim.mp4');
    writeFileSync(source, 'video');
    const verbatim = `\\\\?\\${source}`;
    database.prepare('INSERT INTO media_locations VALUES (?, ?, ?, ?, ?)')
      .run(Buffer.alloc(16, 0x11), Buffer.alloc(16, 0x22), utf16Path(verbatim), 'windows-utf16le', 1);
    assert.equal(durableCustomerIdentity(root).sourceFiles[0].relativePath, 'input/verbatim.mp4');
  });
});

test('directory shape digest notices truncation and never reads file contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-settings-packages-'));
  try {
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'nested', 'tool.exe'), Buffer.alloc(32, 0xaa));
    const before = directoryShapeDigest(root);
    assert.deepEqual({ entries: before.entries, files: before.files, bytes: before.bytes }, {
      entries: 2,
      files: 1,
      bytes: 32,
    });
    writeFileSync(join(root, 'nested', 'tool.exe'), Buffer.alloc(31, 0xbb));
    const after = directoryShapeDigest(root);
    assert.notEqual(after.sha256, before.sha256);
    assert.throws(() => directoryShapeDigest(root, 1), /exceeded 1 entries/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
