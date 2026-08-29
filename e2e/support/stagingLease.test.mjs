import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { acquireStagingLease, parseStagingLeaseContract } from './stagingLease.js';

const scratch = mkdtempSync(join(tmpdir(), 'osg-staging-lease-test-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const cacheRoot = join(scratch, 'cache');
const stagingRoot = join(cacheRoot, 'staging');
const leaseId = 'a'.repeat(32);
const contract = (overrides = {}) => ({
  schemaVersion: 1,
  cacheRoot,
  rootId: 'b'.repeat(32),
  lane: 'staging',
  primaryPath: stagingRoot,
  cargoTargetDir: null,
  frontendCacheRoot: null,
  appPublicationRoot: null,
  assetCacheRoot: null,
  evidenceRoot: join(cacheRoot, 'evidence'),
  stagingRoot,
  leasePaths: [join(stagingRoot, '.osg-cache-lease')],
  leaseId,
  leaseProcessId: process.pid,
  leaseProcessCreatedUtc: '2026-08-26T00:00:00.0000000Z',
  ...overrides,
});

test('staging lease parser accepts only the exact manager-owned lane and owner process', () => {
  assert.equal(parseStagingLeaseContract({
    stdout: JSON.stringify(contract()), cacheRoot, stagingRoot, repositoryRoot,
  }).leaseId, leaseId);
  for (const hostile of [
    contract({ lane: 'evidence' }),
    contract({ stagingRoot: repositoryRoot, primaryPath: repositoryRoot }),
    contract({ leaseProcessId: process.pid + 1 }),
    contract({ leasePaths: [join(cacheRoot, 'evidence', '.osg-cache-lease')] }),
  ]) {
    assert.throws(() => parseStagingLeaseContract({
      stdout: JSON.stringify(hostile), cacheRoot, stagingRoot, repositoryRoot,
    }), /invalid/u);
  }
});

test('staging lease is held through work and releases before bounded pruning', () => {
  const calls = [];
  const spawn = (_command, arguments_) => {
    calls.push([...arguments_]);
    if (arguments_.includes('Acquire')) {
      return { status: 0, stdout: JSON.stringify(contract()), stderr: '' };
    }
    return { status: 0, stdout: '{}', stderr: '' };
  };
  const lease = acquireStagingLease({
    cacheRoot, stagingRoot, repositoryRoot, spawn,
  });
  assert.deepEqual(lease.managedPaths, [stagingRoot]);
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  assert.deepEqual(calls.map((arguments_) => arguments_[arguments_.indexOf('-Action') + 1]), [
    'Prune', 'Lease', 'Lease', 'Prune',
  ]);
  assert.ok(calls[2].includes(leaseId));
});

test('external maintenance preserves acquire and release while suppressing both prunes', () => {
  const calls = [];
  const spawn = (_command, arguments_) => {
    calls.push([...arguments_]);
    if (arguments_.includes('Acquire')) {
      return { status: 0, stdout: JSON.stringify(contract()), stderr: '' };
    }
    return { status: 0, stdout: '{}', stderr: '' };
  };
  const lease = acquireStagingLease({
    cacheMaintenance: 'external', cacheRoot, stagingRoot, repositoryRoot, spawn,
  });
  assert.equal(lease.release(), true);
  assert.deepEqual(calls.map((arguments_) => [
    arguments_[arguments_.indexOf('-Action') + 1],
    arguments_[arguments_.indexOf('-LeaseOperation') + 1],
  ]), [
    ['Lease', 'Acquire'],
    ['Lease', 'Release'],
  ]);
  assert.throws(
    () => acquireStagingLease({
      cacheMaintenance: 'typo', cacheRoot, stagingRoot, repositoryRoot, spawn,
    }),
    /standalone or external/u,
  );
});
