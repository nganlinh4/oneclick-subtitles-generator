// The workflow-evidence cache lease: lane validation, release ordering and prune suppression.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  acquireEvidenceLease, parseEvidenceLeaseContract, withEvidenceLease,
} from './evidenceLease.js';

const evidenceLeaseFixture = (() => {
  const cacheRoot = 'C:\\OSG-Test-Cache';
  const evidenceRoot = join(cacheRoot, 'evidence');
  const repositoryRoot = 'C:\\WORK\\oneclick-subtitles-generator';
  const leaseId = '1'.repeat(32);
  const contract = (overrides = {}) => ({
    schemaVersion: 1,
    cacheRoot,
    rootId: '2'.repeat(32),
    lane: 'evidence',
    primaryPath: evidenceRoot,
    cargoTargetDir: null,
    frontendCacheRoot: null,
    appPublicationRoot: null,
    appExecutablePath: null,
    assetCacheRoot: null,
    runtimeContentRoot: join(cacheRoot, 'runtime', 'hashes'),
    evidenceRoot,
    stagingRoot: join(cacheRoot, 'staging'),
    leasePaths: [join(evidenceRoot, '.osg-cache-lease')],
    leaseId,
    leaseProcessId: process.pid,
    leaseProcessCreatedUtc: '2026-08-26T00:00:00.0000000Z',
    ...overrides,
  });
  const managerDouble = ({ failRelease = false, calls = [] } = {}) => (
    (command, arguments_, options) => {
      calls.push({ command, arguments: arguments_, options });
      const operation = arguments_[arguments_.indexOf('-Action') + 1];
      const leaseOperation = arguments_[arguments_.indexOf('-LeaseOperation') + 1];
      if (operation === 'Lease' && leaseOperation === 'Acquire') {
        return { status: 0, stdout: `${JSON.stringify(contract())}\n`, stderr: '' };
      }
      if (operation === 'Lease' && leaseOperation === 'Release' && failRelease) {
        return { status: 17, stdout: '', stderr: 'release refused' };
      }
      return { status: 0, stdout: '{}\n', stderr: '' };
    }
  );
  return Object.freeze({ cacheRoot, contract, evidenceRoot, managerDouble, repositoryRoot });
})();
test('accepts only the manager evidence lane and its exact lease path', () => {
  const {
    cacheRoot, contract, evidenceRoot, repositoryRoot,
  } = evidenceLeaseFixture;
  assert.equal(parseEvidenceLeaseContract({
    stdout: JSON.stringify(contract()), cacheRoot, evidenceRoot, repositoryRoot,
  }).evidenceRoot, evidenceRoot);
  for (const hostile of [
    contract({ lane: 'e2e' }),
    contract({ evidenceRoot: repositoryRoot, primaryPath: repositoryRoot }),
    contract({ leasePaths: [join(cacheRoot, 'assets', 'e2e', '.osg-cache-lease')] }),
    contract({ evidenceRoot: '\\\\?\\C:\\OSG-Test-Cache\\evidence' }),
    contract({ evidenceRoot: '\\\\.\\C:\\OSG-Test-Cache\\evidence' }),
    contract({ evidenceRoot: '\\??\\C:\\OSG-Test-Cache\\evidence' }),
    contract({ evidenceRoot: '\\\\??\\C:\\OSG-Test-Cache\\evidence' }),
    contract({ evidenceRoot: '\\DeViCe\\HarddiskVolume1\\evidence' }),
    contract({ evidenceRoot: '\\\\GLOBAL??\\C:\\OSG-Test-Cache\\evidence' }),
    contract({ primaryPath: `${evidenceRoot}. ` }),
  ]) {
    assert.throws(
      () => parseEvidenceLeaseContract({
        stdout: JSON.stringify(hostile), cacheRoot, evidenceRoot, repositoryRoot,
      }),
      /invalid|unexpected|exact evidence lane/u,
    );
  }
});

test('holds the evidence lease through work, then releases before post-prune', () => {
  const {
    cacheRoot, evidenceRoot, managerDouble, repositoryRoot,
  } = evidenceLeaseFixture;
  const events = [];
  const calls = [];
  const value = withEvidenceLease(() => {
    events.push('operation');
    return 42;
  }, {
    cacheRoot,
    evidenceRoot,
    repositoryRoot,
    spawn: (command, arguments_, options) => {
      const action = arguments_[arguments_.indexOf('-Action') + 1];
      const leaseOperationIndex = arguments_.indexOf('-LeaseOperation');
      const leaseOperation = leaseOperationIndex < 0 ? undefined : arguments_[leaseOperationIndex + 1];
      events.push(leaseOperation === undefined ? action : `${action}:${leaseOperation}`);
      return managerDouble({ calls })(command, arguments_, options);
    },
  });
  assert.equal(value, 42);
  assert.deepEqual(events, ['Prune', 'Lease:Acquire', 'operation', 'Lease:Release', 'Prune']);
  assert.equal(calls.length, 4);
  assert.equal(calls.every(({ options }) => options.windowsHide === true), true);
  assert.equal(calls[3].arguments.includes('-ProtectLane'), false);
  const protectedUnit = calls[3].arguments.indexOf('-ProtectUnit');
  assert.equal(calls[3].arguments[protectedUnit + 1], 'apps-e2e');
});

test('preserves the workflow failure when evidence release also fails', () => {
  const {
    cacheRoot, evidenceRoot, managerDouble, repositoryRoot,
  } = evidenceLeaseFixture;
  const primary = new Error('journey failed');
  assert.throws(
    () => withEvidenceLease(() => { throw primary; }, {
      cacheRoot,
      evidenceRoot,
      repositoryRoot,
      spawn: managerDouble({ failRelease: true }),
    }),
    (error) => error instanceof AggregateError
      && error.errors[0] === primary
      && /release refused/u.test(error.errors[1].message),
  );
});

test('an evidence lease is idempotent but never prunes before its exact release', () => {
  const {
    cacheRoot, evidenceRoot, managerDouble, repositoryRoot,
  } = evidenceLeaseFixture;
  const calls = [];
  const lease = acquireEvidenceLease({
    cacheRoot, evidenceRoot, repositoryRoot, spawn: managerDouble({ calls }),
  });
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  assert.deepEqual(calls.map(({ arguments: arguments_ }) => (
    arguments_[arguments_.indexOf('-Action') + 1]
  )), ['Prune', 'Lease', 'Lease', 'Prune']);
});

test('external evidence maintenance preserves acquire and release with zero prune scans', () => {
  const {
    cacheRoot, evidenceRoot, managerDouble, repositoryRoot,
  } = evidenceLeaseFixture;
  const calls = [];
  const lease = acquireEvidenceLease({
    cacheMaintenance: 'external',
    cacheRoot,
    evidenceRoot,
    repositoryRoot,
    spawn: managerDouble({ calls }),
  });
  assert.equal(lease.release(), true);
  assert.deepEqual(calls.map(({ arguments: arguments_ }) => [
    arguments_[arguments_.indexOf('-Action') + 1],
    arguments_[arguments_.indexOf('-LeaseOperation') + 1],
  ]), [
    ['Lease', 'Acquire'],
    ['Lease', 'Release'],
  ]);
  assert.throws(
    () => acquireEvidenceLease({
      cacheMaintenance: 'typo',
      cacheRoot,
      evidenceRoot,
      repositoryRoot,
      spawn: managerDouble({ calls }),
    }),
    /standalone or external/u,
  );
});
