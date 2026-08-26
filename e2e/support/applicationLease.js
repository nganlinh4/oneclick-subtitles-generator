import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  DEVELOPMENT_CACHE_ROOT, E2E_APPLICATIONS_CACHE_ROOT, E2E_ASSET_CACHE_ROOT, REPOSITORY_ROOT,
} from './environment.js';

const require = createRequire(import.meta.url);
const {
  acquireE2eLease: acquireManagedE2eLease,
  pruneManagedCache,
  releaseE2eLease: releaseManagedE2eLease,
} = require('../../scripts/build-e2e-binary.js');
const { assertWindowsProcessIdentity } = require('../../scripts/windows-process-identity.js');

const samePath = (left, right) => (
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
);

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const LEASE_PATTERN = /^[0-9a-f]{32}$/u;
export const INHERITED_APPLICATION_LEASE = 'OSG_E2E_LEASED_APPLICATION';

/**
 * Keep the manager-owned apps/e2e lane alive while a verified application is copied or running.
 * The lease owner is this real Node process; a crashed launcher is reclaimed through its recorded
 * PID plus creation time instead of leaving a permanent lock.
 */
export const acquireE2eApplicationLease = ({
  acquire = acquireManagedE2eLease,
  prune = pruneManagedCache,
  release = releaseManagedE2eLease,
  processId = process.pid,
  repositoryRoot = REPOSITORY_ROOT,
  cacheRoot = DEVELOPMENT_CACHE_ROOT,
  applicationsCacheRoot = E2E_APPLICATIONS_CACHE_ROOT,
} = {}) => {
  const lease = acquire({ repositoryRoot, cacheRoot, processId });
  if (!samePath(lease.appPublicationRoot, applicationsCacheRoot)) {
    try {
      release({ repositoryRoot, cacheRoot, leaseId: lease.leaseId });
    } catch (cleanupError) {
      throw new AggregateError(
        [new Error('managed E2E lease selected the wrong application publication root'), cleanupError],
        'the invalid managed E2E application lease could not be released',
      );
    }
    throw new Error('managed E2E lease selected the wrong application publication root');
  }
  if (!samePath(lease.assetCacheRoot, E2E_ASSET_CACHE_ROOT)) {
    try {
      release({ repositoryRoot, cacheRoot, leaseId: lease.leaseId });
    } catch (cleanupError) {
      throw new AggregateError(
        [new Error('managed E2E lease selected the wrong asset cache root'), cleanupError],
        'the invalid managed E2E asset lease could not be released',
      );
    }
    throw new Error('managed E2E lease selected the wrong asset cache root');
  }
  let released = false;
  return Object.freeze({
    leaseId: lease.leaseId,
    leaseOwnerProcessId: lease.leaseProcessId,
    leaseOwnerProcessCreatedUtc: lease.leaseProcessCreatedUtc,
    applicationsCacheRoot: lease.appPublicationRoot,
    managedPaths: Object.freeze([
      lease.cargoTargetDir,
      lease.frontendCacheRoot,
      lease.appPublicationRoot,
      lease.assetCacheRoot,
    ]),
    release: () => {
      if (released) return false;
      release({ repositoryRoot, cacheRoot, leaseId: lease.leaseId });
      released = true;
      prune({
        repositoryRoot,
        cacheRoot,
        protectE2e: false,
        protectApplication: true,
      });
      return true;
    },
  });
};

export const serializeInheritedApplicationLease = ({ lease, publication }) => {
  if (
    lease === null
    || typeof lease !== 'object'
    || !LEASE_PATTERN.test(lease.leaseId ?? '')
    || lease.leaseOwnerProcessId !== process.pid
    || typeof lease.leaseOwnerProcessCreatedUtc !== 'string'
    || publication === null
    || typeof publication !== 'object'
    || !HASH_PATTERN.test(publication.applicationHash ?? '')
    || !samePath(publication.applicationRoot, join(
      lease.applicationsCacheRoot,
      'applications',
      publication.applicationHash,
    ))
  ) {
    throw new Error('cannot serialize an unverified or unowned E2E application lease');
  }
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    leaseId: lease.leaseId,
    leaseOwnerProcessId: lease.leaseOwnerProcessId,
    leaseOwnerProcessCreatedUtc: lease.leaseOwnerProcessCreatedUtc,
    applicationHash: publication.applicationHash,
    applicationRoot: publication.applicationRoot,
    binaryPath: publication.binaryPath,
  }), 'utf8').toString('base64');
};

export const readInheritedApplicationLease = ({
  environment = process.env,
  readPublication,
} = {}) => {
  const encoded = environment[INHERITED_APPLICATION_LEASE];
  let inherited;
  try {
    inherited = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error('the E2E child has no valid inherited application lease provenance', {
      cause: error,
    });
  }
  if (
    inherited === null
    || typeof inherited !== 'object'
    || Object.keys(inherited).sort().join('|')
      !== 'applicationHash|applicationRoot|binaryPath|leaseId|leaseOwnerProcessCreatedUtc|leaseOwnerProcessId|schemaVersion'
    || inherited.schemaVersion !== 1
    || !LEASE_PATTERN.test(inherited.leaseId ?? '')
    || !HASH_PATTERN.test(inherited.applicationHash ?? '')
    || !Number.isSafeInteger(inherited.leaseOwnerProcessId)
    || inherited.leaseOwnerProcessId < 1
    || typeof inherited.leaseOwnerProcessCreatedUtc !== 'string'
  ) {
    throw new Error('the E2E child inherited an invalid application lease provenance contract');
  }
  try {
    assertWindowsProcessIdentity({
      processId: inherited.leaseOwnerProcessId,
      processCreatedUtc: inherited.leaseOwnerProcessCreatedUtc,
    });
  } catch (error) {
    throw new Error('the E2E application lease owner identity is stale or was reused', {
      cause: error,
    });
  }
  const marker = JSON.parse(readFileSync(join(E2E_APPLICATIONS_CACHE_ROOT, '.osg-cache-lease'), 'utf8'));
  if (
    marker.leaseId !== inherited.leaseId
    || marker.laneGroup !== 'e2e'
    || marker.processId !== inherited.leaseOwnerProcessId
    || marker.processCreatedUtc !== inherited.leaseOwnerProcessCreatedUtc
  ) {
    throw new Error('the inherited E2E application lease does not own the active cache marker');
  }
  if (typeof readPublication !== 'function') {
    throw new Error('inherited E2E application validation requires immutable publication verification');
  }
  const publication = readPublication();
  if (
    publication.applicationHash !== inherited.applicationHash
    || !samePath(publication.applicationRoot, inherited.applicationRoot)
    || !samePath(publication.binaryPath, inherited.binaryPath)
  ) {
    throw new Error('the inherited E2E application provenance no longer matches the verified bytes');
  }
  return Object.freeze({ inherited: Object.freeze(inherited), publication });
};

export const withE2eApplicationLease = (operation, options) => {
  const lease = acquireE2eApplicationLease(options);
  let value;
  let primaryError;
  try {
    value = operation(lease);
  } catch (error) {
    primaryError = error;
  }
  try {
    lease.release();
  } catch (error) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, error],
        'the E2E application operation and its lease release both failed',
      );
    }
    throw error;
  }
  if (primaryError !== undefined) throw primaryError;
  return value;
};
