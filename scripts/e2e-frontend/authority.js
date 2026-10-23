'use strict';

// Managed-lane mutation authority: the cache entry/area markers and the exact live E2E lease that
// must own every write to a managed frontend cache.

const fs = require('node:fs');
const path = require('node:path');

const { assertNotRedirected } = require('../publication-paths');
const { assertWindowsProcessIdentity } = require('../windows-process-identity.js');
const {
  ID_PATTERN,
  MANAGED_AREA_MARKER,
  MANAGED_CACHE_OWNER,
  MANAGED_CACHE_SCHEMA_VERSION,
  MANAGED_ENTRY_MARKER,
  MANAGED_FRONTEND_LANE,
  MANAGED_LANE_GROUP,
  MANAGED_LEASE_MARKER,
} = require('./constants');

const exactKeys = (value, expected) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
);

const readExactJsonFile = (filePath, label, expectedKeys) => {
  assertNotRedirected(filePath, label);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file`);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON`, { cause: error });
  }
  if (!exactKeys(value, expectedKeys)) throw new Error(`${label} has an unrecognized schema`);
  return value;
};

const assertManagedMutationAuthority = (cacheRoot, retentionLeaseId) => {
  const entryPath = path.join(cacheRoot, MANAGED_ENTRY_MARKER);
  const areaPath = path.join(path.dirname(cacheRoot), MANAGED_AREA_MARKER);
  const hasEntry = fs.existsSync(entryPath);
  const hasArea = fs.existsSync(areaPath);
  if (!hasEntry && !hasArea) {
    if (retentionLeaseId !== undefined && retentionLeaseId !== null) {
      throw new Error('frontend retention lease cannot authorize an unmanaged cache root');
    }
    return null;
  }
  if (!hasEntry || !hasArea) {
    throw new Error('managed frontend cache ownership markers are incomplete');
  }
  const entry = readExactJsonFile(
    entryPath,
    'managed frontend cache entry marker',
    ['schemaVersion', 'owner', 'rootId', 'lane'],
  );
  const area = readExactJsonFile(
    areaPath,
    'managed frontend cache area marker',
    ['schemaVersion', 'owner', 'rootId', 'area'],
  );
  if (
    entry.schemaVersion !== MANAGED_CACHE_SCHEMA_VERSION
    || entry.owner !== MANAGED_CACHE_OWNER
    || entry.lane !== MANAGED_FRONTEND_LANE
    || !ID_PATTERN.test(entry.rootId ?? '')
    || area.schemaVersion !== MANAGED_CACHE_SCHEMA_VERSION
    || area.owner !== MANAGED_CACHE_OWNER
    || area.area !== 'frontend'
    || area.rootId !== entry.rootId
  ) {
    throw new Error('managed frontend cache ownership does not match the E2E frontend lane');
  }
  if (!ID_PATTERN.test(retentionLeaseId ?? '')) {
    throw new Error('managed frontend publication requires the exact active E2E lease id');
  }
  const leasePath = path.join(cacheRoot, MANAGED_LEASE_MARKER);
  if (!fs.existsSync(leasePath)) {
    throw new Error('managed frontend publication requires an active E2E lease');
  }
  const lease = readExactJsonFile(
    leasePath,
    'managed frontend cache lease',
    [
      'schemaVersion',
      'owner',
      'rootId',
      'laneGroup',
      'leaseId',
      'processId',
      'processCreatedUtc',
    ],
  );
  const created = new Date(lease.processCreatedUtc);
  if (
    lease.schemaVersion !== MANAGED_CACHE_SCHEMA_VERSION
    || lease.owner !== MANAGED_CACHE_OWNER
    || lease.rootId !== entry.rootId
    || lease.laneGroup !== MANAGED_LANE_GROUP
    || lease.leaseId !== retentionLeaseId
    || lease.processId !== process.pid
    || !Number.isFinite(created.getTime())
  ) {
    throw new Error('frontend retention lease does not own the active managed frontend lane');
  }
  try {
    assertWindowsProcessIdentity({
      processId: lease.processId,
      processCreatedUtc: lease.processCreatedUtc,
    });
  } catch (error) {
    throw new Error('frontend retention lease owner identity is stale or was reused', {
      cause: error,
    });
  }
  return Object.freeze({
    cacheRoot,
    rootId: entry.rootId,
    leaseId: retentionLeaseId,
    processId: process.pid,
    processCreatedUtc: lease.processCreatedUtc,
  });
};

const reassertMutationAuthority = (cacheRoot, authority) => {
  const current = assertManagedMutationAuthority(cacheRoot, authority?.leaseId);
  if (authority === null) {
    if (current !== null) throw new Error('frontend cache became managed during an unmanaged publication');
    return;
  }
  if (
    current === null
    || current.rootId !== authority.rootId
    || current.processId !== authority.processId
    || current.processCreatedUtc !== authority.processCreatedUtc
  ) {
    throw new Error('managed frontend cache authority changed during publication');
  }
};

module.exports = {
  assertManagedMutationAuthority,
  readExactJsonFile,
  reassertMutationAuthority,
};
