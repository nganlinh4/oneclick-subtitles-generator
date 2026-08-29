import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  acquireE2eApplicationLease, assertLiveE2eAssetLease, withE2eApplicationLease,
  verifyE2eLeaseMarkerForTest,
} from './applicationLease.js';
import {
  E2E_APPLICATIONS_CACHE_ROOT, E2E_ASSET_CACHE_ROOT, REPOSITORY_ROOT,
} from './environment.js';

const require = createRequire(import.meta.url);
const { readCurrentWindowsProcessIdentity } = require('../../scripts/windows-process-identity.js');
const fakeManagerLease = (leaseId) => ({
  rootId: 'a'.repeat(32),
  leaseId,
  appPublicationRoot: E2E_APPLICATIONS_CACHE_ROOT,
  assetCacheRoot: E2E_ASSET_CACHE_ROOT,
  leaseProcessId: process.pid,
  leaseProcessCreatedUtc: readCurrentWindowsProcessIdentity().processCreatedUtc,
  cargoTargetDir: resolve(REPOSITORY_ROOT, 'target'),
  frontendCacheRoot: resolve(REPOSITORY_ROOT, 'node_modules', '.vite'),
});

test('the on-disk marker must name the exact cache generation with an exact schema', (context) => {
  const laneRoot = mkdtempSync(join(tmpdir(), 'osg-lease-marker-'));
  context.after(() => rmSync(laneRoot, { recursive: true, force: true }));
  const expected = {
    leaseId: 'b'.repeat(32),
    processId: process.pid,
    processCreatedUtc: '2026-08-30T00:00:00.0000000Z',
    rootId: 'c'.repeat(32),
  };
  const markerPath = join(laneRoot, '.osg-cache-lease');
  const writeMarker = (overrides = {}) => writeFileSync(markerPath, `${JSON.stringify({
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId: expected.rootId,
    laneGroup: 'e2e',
    leaseId: expected.leaseId,
    processId: expected.processId,
    processCreatedUtc: expected.processCreatedUtc,
    ...overrides,
  })}\n`);
  writeMarker();
  assert.equal(verifyE2eLeaseMarkerForTest({ laneRoot, expected }), laneRoot);

  writeMarker({ rootId: 'd'.repeat(32) });
  assert.throws(
    () => verifyE2eLeaseMarkerForTest({ laneRoot, expected }),
    /cache generation/u,
  );
  writeMarker({ extra: true });
  assert.throws(
    () => verifyE2eLeaseMarkerForTest({ laneRoot, expected }),
    /cache generation/u,
  );
});

test('asset authority rejects a structurally identical forgery and the exact released object', () => {
  const lease = acquireE2eApplicationLease({
    acquire: () => fakeManagerLease('1'.repeat(32)),
    applicationsCacheRoot: E2E_APPLICATIONS_CACHE_ROOT,
    cacheMaintenance: 'external',
    prune: () => {},
    release: () => {},
  });
  assert.throws(
    () => assertLiveE2eAssetLease({ ...lease }),
    /does not own the managed E2E asset lane/u,
  );
  assert.equal(lease.release(), true);
  assert.throws(
    () => assertLiveE2eAssetLease(lease),
    /does not own the managed E2E asset lane/u,
  );
});

test('the fundamental application wrapper rejects thenables before releasing authority', () => {
  const events = [];
  assert.throws(
    () => withE2eApplicationLease(() => {
      events.push('operation:return-thenable');
      return { then: () => {} };
    }, {
      acquire: () => fakeManagerLease('2'.repeat(32)),
      applicationsCacheRoot: E2E_APPLICATIONS_CACHE_ROOT,
      cacheMaintenance: 'external',
      release: () => events.push('release'),
    }),
    /must be synchronous/u,
  );
  assert.deepEqual(events, ['operation:return-thenable', 'release']);
});
