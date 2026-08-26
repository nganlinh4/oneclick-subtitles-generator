import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  downloadDurabilityState, downloadScratchFiles, managedArtifactFiles, resolveManagedArtifact,
  sha256File,
} from './downloadJourneyOracle.js';

test('download byte oracle distinguishes scratch files from managed durable bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-download-oracle-test-'));
  try {
    const scratchRoot = join(root, 'cache', 'downloads', 'v1', 'attempt');
    const artifactRoot = join(root, 'data', 'artifacts');
    mkdirSync(scratchRoot, { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    writeFileSync(join(artifactRoot, '.root-identity'), 'identity');
    writeFileSync(join(scratchRoot, 'partial.mp4'), 'partial');
    writeFileSync(join(artifactRoot, 'durable'), 'durable bytes');

    assert.deepEqual(downloadScratchFiles(root), [join(scratchRoot, 'partial.mp4')]);
    assert.deepEqual(managedArtifactFiles(root), [join(artifactRoot, 'durable')]);
    assert.equal(resolveManagedArtifact(root, 'durable'), join(artifactRoot, 'durable'));
    assert.equal(sha256File(join(artifactRoot, 'durable')).length, 64);
    assert.throws(() => resolveManagedArtifact(root, '../outside'), /escaped/u);
    assert.throws(() => resolveManagedArtifact(root, ''), /invalid/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('download durability oracle includes ownership edges, claims, and the native alias ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-download-durability-test-'));
  const databaseRoot = join(root, 'data', 'db');
  mkdirSync(databaseRoot, { recursive: true });
  const database = new DatabaseSync(join(databaseRoot, 'osg.sqlite3'));
  try {
    database.exec(`
      CREATE TABLE projects(id BLOB, title TEXT, state_version INTEGER, created_at_ms INTEGER);
      CREATE TABLE media_assets(id BLOB, display_name TEXT, extension TEXT, size_bytes INTEGER,
        content_hash BLOB, created_at_ms INTEGER);
      CREATE TABLE project_media(project_id BLOB, media_id BLOB, role TEXT, ordinal INTEGER);
      CREATE TABLE jobs(id BLOB, kind TEXT, state TEXT, progress_basis_points INTEGER,
        created_at_ms INTEGER);
      CREATE TABLE artifacts(id BLOB, project_id BLOB, job_id BLOB, kind TEXT, relative_path TEXT,
        content_hash BLOB, size_bytes INTEGER, state TEXT, created_at_ms INTEGER);
      CREATE TABLE cache_entries(cache_key BLOB, artifact_id BLOB, category TEXT,
        algorithm_version INTEGER);
      CREATE TABLE media_artifacts(media_id BLOB, artifact_id BLOB);
      CREATE TABLE media_artifact_job_claims(media_id BLOB, artifact_id BLOB, job_id BLOB);
      CREATE TABLE app_settings(scope TEXT, key TEXT, value_json TEXT);
      INSERT INTO projects VALUES(x'00000000000000000000000000000001', 'A', 1, 1);
      INSERT INTO media_assets VALUES(x'00000000000000000000000000000002', 'a.mp4', 'mp4', 7,
        x'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2);
      INSERT INTO project_media VALUES(x'00000000000000000000000000000001',
        x'00000000000000000000000000000002', 'primary', 0);
      INSERT INTO jobs VALUES(x'00000000000000000000000000000003', 'downloadMedia', 'succeeded', 10000, 3);
      INSERT INTO artifacts VALUES(x'00000000000000000000000000000004',
        x'00000000000000000000000000000001', x'00000000000000000000000000000003',
        'downloadedMedia', 'a.mp4',
        x'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 7, 'ready', 4);
      INSERT INTO artifacts VALUES(x'00000000000000000000000000000005', NULL, NULL,
        'waveformCache', 'waveform.cache',
        x'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 9, 'ready', 5);
      INSERT INTO cache_entries VALUES(
        x'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        x'00000000000000000000000000000005', 'waveform', 1);
      INSERT INTO media_artifacts VALUES(x'00000000000000000000000000000002',
        x'00000000000000000000000000000004');
      INSERT INTO media_artifact_job_claims VALUES(x'00000000000000000000000000000002',
        x'00000000000000000000000000000004', x'00000000000000000000000000000003');
      INSERT INTO app_settings VALUES('active_workspace', 'project.subtitleCacheIndex.v1',
        '{"schemaVersion":1,"activeCacheId":"a","entries":[{"cacheId":"a"}]}');
    `);
  } finally {
    database.close();
  }

  try {
    const state = downloadDurabilityState(root);
    assert.equal(state.projects.length, 1);
    assert.equal(state.media[0].content_hash, 'a'.repeat(64));
    assert.equal(state.jobs[0].state, 'succeeded');
    assert.equal(state.artifacts[0].state, 'ready');
    assert.deepEqual(state.managedArtifacts.map(({ kind }) => kind), [
      'downloadedMedia', 'waveformCache',
    ]);
    assert.equal(state.cacheEntries[0].category, 'waveform');
    assert.equal(state.cacheEntries[0].algorithm_version, 1);
    assert.equal(state.mediaArtifacts.length, 1);
    assert.equal(state.jobClaims.length, 1);
    assert.equal(state.alias.activeCacheId, 'a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
