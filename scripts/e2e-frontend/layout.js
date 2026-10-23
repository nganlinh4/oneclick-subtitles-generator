'use strict';

// The publisher-owned cache layout and its transaction journal: adoption, owned-path removal, and
// recovery of interrupted publications and retentions.

const fs = require('node:fs');
const path = require('node:path');

const {
  assertNotRedirected,
  assertRealDirectory,
  isWithin,
  samePath,
} = require('../publication-paths');
const { readExactJsonFile, reassertMutationAuthority } = require('./authority');
const {
  HASH_PATTERN,
  MANAGED_CACHE_OWNER,
  MANAGED_ENTRY_MARKER,
  MANAGED_LEASE_MARKER,
  PUBLISHER_JOURNAL_ROOT,
  PUBLISHER_LAYOUT_KIND,
  PUBLISHER_LAYOUT_MARKER,
  PUBLISHER_TRASH_ROOT,
  PUBLISHER_WORKSPACE_ROOT,
  SNAPSHOT_SCHEMA_VERSION,
} = require('./constants');
const { createDirectoryStrict, installImmutableFile } = require('./snapshot-tree');

const layoutMarkerBytes = (authority) => Buffer.from(`${JSON.stringify({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  owner: MANAGED_CACHE_OWNER,
  cacheKind: PUBLISHER_LAYOUT_KIND,
  rootId: authority?.rootId ?? null,
}, null, 2)}\n`, 'utf8');

const ensurePublisherLayout = (cacheRoot, authority) => {
  if (!fs.existsSync(cacheRoot)) {
    if (authority !== null) throw new Error('managed frontend cache lane disappeared during publication');
    fs.mkdirSync(cacheRoot, { recursive: true });
  }
  assertRealDirectory(cacheRoot, 'frontend cache root');
  const markerPath = path.join(cacheRoot, PUBLISHER_LAYOUT_MARKER);
  const expectedBytes = layoutMarkerBytes(authority);
  if (fs.existsSync(markerPath)) {
    const marker = readExactJsonFile(
      markerPath,
      'frontend snapshot cache ownership marker',
      ['schemaVersion', 'owner', 'cacheKind', 'rootId'],
    );
    if (
      marker.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
      || marker.owner !== MANAGED_CACHE_OWNER
      || marker.cacheKind !== PUBLISHER_LAYOUT_KIND
      || marker.rootId !== (authority?.rootId ?? null)
      || !fs.readFileSync(markerPath).equals(expectedBytes)
    ) {
      throw new Error('frontend snapshot cache ownership marker does not match this cache lane');
    }
  } else {
    const allowedBeforeAdoption = new Set([
      MANAGED_ENTRY_MARKER,
      MANAGED_LEASE_MARKER,
      'snapshots',
      'manifests',
      'receipts',
      PUBLISHER_JOURNAL_ROOT,
      PUBLISHER_TRASH_ROOT,
      PUBLISHER_WORKSPACE_ROOT,
    ]);
    for (const child of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
      const concurrentMarkerTemporary = /^\.osg-frontend-snapshot-cache\.json\.publish-\d+-[0-9a-f]{24}$/u
        .test(child.name);
      if (!allowedBeforeAdoption.has(child.name) && !concurrentMarkerTemporary) {
        throw new Error(`refusing to adopt unmanaged frontend cache bytes: ${child.name}`);
      }
      if (
        ['snapshots', 'manifests', 'receipts', PUBLISHER_JOURNAL_ROOT,
          PUBLISHER_TRASH_ROOT, PUBLISHER_WORKSPACE_ROOT].includes(child.name)
        && (!child.isDirectory() || child.isSymbolicLink())
      ) {
        throw new Error(
          `frontend cache layout entry must be a real directory without a symlink, junction, or reparse point: ${child.name}`,
        );
      }
      if (concurrentMarkerTemporary && (!child.isFile() || child.isSymbolicLink())) {
        throw new Error(`frontend cache marker temporary must be a real file: ${child.name}`);
      }
    }
    reassertMutationAuthority(cacheRoot, authority);
    installImmutableFile(markerPath, expectedBytes);
  }
  const roots = Object.freeze({
    snapshotsRoot: path.join(cacheRoot, 'snapshots'),
    manifestsRoot: path.join(cacheRoot, 'manifests'),
    receiptsRoot: path.join(cacheRoot, 'receipts'),
    journalsRoot: path.join(cacheRoot, PUBLISHER_JOURNAL_ROOT),
    trashRoot: path.join(cacheRoot, PUBLISHER_TRASH_ROOT),
    workspacesRoot: path.join(cacheRoot, PUBLISHER_WORKSPACE_ROOT),
  });
  reassertMutationAuthority(cacheRoot, authority);
  for (const directory of Object.values(roots)) createDirectoryStrict(directory);
  return roots;
};

const journalBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

const writeJournal = (journalsRoot, value) => {
  const transactionId = value.transactionId;
  const destination = path.join(journalsRoot, `${transactionId}.json`);
  const temporary = path.join(journalsRoot, `.new-${transactionId}.json`);
  const bytes = journalBytes(value);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      const openDescriptor = descriptor;
      descriptor = undefined;
      fs.closeSync(openDescriptor);
    }
    fs.renameSync(temporary, destination);
    return destination;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
};

const assertDirectChild = (parent, candidate, expectedLeaf, label) => {
  const expected = path.join(parent, expectedLeaf);
  if (!samePath(candidate, expected) || !isWithin(parent, candidate)) {
    throw new Error(`${label} escaped its owned directory`);
  }
};

const removeOwnedPath = (candidate, label, recursive = false) => {
  if (!fs.existsSync(candidate)) return false;
  assertNotRedirected(candidate, label);
  const stat = fs.lstatSync(candidate);
  if (recursive ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`${label} has the wrong filesystem type`);
  }
  fs.rmSync(candidate, { recursive, force: true });
  return true;
};

const recoverGeneratedFileResidues = (cacheRoot, roots) => {
  const locations = [
    {
      root: cacheRoot,
      pattern: /^\.osg-frontend-snapshot-cache\.json\.publish-\d+-[0-9a-f]{24}$/u,
      recursive: false,
      label: 'frontend layout marker temporary',
    },
    {
      root: roots.snapshotsRoot,
      pattern: /^\.publish-[0-9a-f]{64}-\d+-[0-9a-f]{24}$/u,
      recursive: true,
      label: 'legacy frontend snapshot publication temporary',
    },
    {
      root: roots.manifestsRoot,
      pattern: /^[0-9a-f]{64}\.json\.publish-\d+-[0-9a-f]{24}$/u,
      recursive: false,
      label: 'frontend manifest publication temporary',
    },
    {
      root: roots.receiptsRoot,
      pattern: /^\.receipt-\d+-[0-9a-f]{24}$/u,
      recursive: false,
      label: 'frontend receipt publication temporary',
    },
  ];
  for (const location of locations) {
    for (const child of fs.readdirSync(location.root, { withFileTypes: true })) {
      if (!location.pattern.test(child.name)) continue;
      if (
        (location.recursive && (!child.isDirectory() || child.isSymbolicLink()))
        || (!location.recursive && (!child.isFile() || child.isSymbolicLink()))
      ) {
        throw new Error(`${location.label} has the wrong filesystem type: ${child.name}`);
      }
      const candidate = path.join(location.root, child.name);
      assertDirectChild(location.root, candidate, child.name, location.label);
      throw new Error(
        `${location.label} has no durable operation allocation and will not be removed: ${child.name}`,
      );
    }
  }
};

const recoverPublisherTransactions = (cacheRoot, roots, authority) => {
  if (authority === null) return;
  reassertMutationAuthority(cacheRoot, authority);
  for (const child of fs.readdirSync(roots.journalsRoot, { withFileTypes: true })) {
    const atomicMatch = /^\.new-([0-9a-f]{32})\.json$/u.exec(child.name);
    if (atomicMatch !== null) {
      if (!child.isFile() || child.isSymbolicLink()) {
        throw new Error(`frontend publisher journal temporary has the wrong type: ${child.name}`);
      }
      throw new Error(
        `frontend publisher journal temporary has no committed ownership authority: ${child.name}`,
      );
    }
    const match = /^([0-9a-f]{32})\.json$/u.exec(child.name);
    if (match === null || !child.isFile() || child.isSymbolicLink()) {
      throw new Error(`unrecognized frontend publisher journal entry: ${child.name}`);
    }
    const journalPath = path.join(roots.journalsRoot, child.name);
    const journal = readExactJsonFile(
      journalPath,
      'frontend publisher journal',
      ['schemaVersion', 'owner', 'rootId', 'transactionId', 'kind', 'snapshotHash', 'ownedLeaf'],
    );
    if (
      journal.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
      || journal.owner !== MANAGED_CACHE_OWNER
      || journal.rootId !== authority.rootId
      || journal.transactionId !== match[1]
      || !HASH_PATTERN.test(journal.snapshotHash ?? '')
    ) {
      throw new Error(`frontend publisher journal ownership is invalid: ${child.name}`);
    }
    let ownedRoot;
    let expectedLeaf;
    if (journal.kind === 'snapshot-publication') {
      ownedRoot = roots.snapshotsRoot;
      expectedLeaf = `.publish-${journal.snapshotHash}-${journal.transactionId}`;
    } else if (journal.kind === 'snapshot-retention') {
      ownedRoot = roots.trashRoot;
      expectedLeaf = `prune-${journal.snapshotHash}-${journal.transactionId}`;
    } else {
      throw new Error(`frontend publisher journal kind is invalid: ${journal.kind}`);
    }
    if (journal.ownedLeaf !== expectedLeaf) {
      throw new Error(`frontend publisher journal path is invalid: ${child.name}`);
    }
    const ownedPath = path.join(ownedRoot, journal.ownedLeaf);
    assertDirectChild(ownedRoot, ownedPath, journal.ownedLeaf, 'frontend publisher recovery path');
    reassertMutationAuthority(cacheRoot, authority);
    removeOwnedPath(ownedPath, 'frontend publisher interrupted transaction', true);
    removeOwnedPath(journalPath, 'frontend publisher journal');
  }
  recoverGeneratedFileResidues(cacheRoot, roots);
  for (const child of fs.readdirSync(roots.trashRoot, { withFileTypes: true })) {
    throw new Error(`unowned frontend publisher trash cannot be reclaimed automatically: ${child.name}`);
  }
};

module.exports = {
  assertDirectChild,
  ensurePublisherLayout,
  journalBytes,
  recoverPublisherTransactions,
  removeOwnedPath,
  writeJournal,
};
