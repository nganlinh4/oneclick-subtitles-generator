#!/usr/bin/env node

// Publish a built frontend as an immutable, content-addressed E2E snapshot. The cache layout,
// authority, retention, and workspace building blocks live in scripts/e2e-frontend/.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const {
  assertNotRedirected,
  assertRealDirectory,
  pathsOverlap,
  resolveAbsoluteInput,
} = require('./publication-paths');
const { assertManagedMutationAuthority, reassertMutationAuthority } = require('./e2e-frontend/authority');
const {
  HASH_ALGORITHM,
  MANAGED_CACHE_OWNER,
  PUBLISHER_WORKSPACE_ROOT,
  SNAPSHOT_SCHEMA_VERSION,
} = require('./e2e-frontend/constants');
const {
  ensurePublisherLayout,
  recoverPublisherTransactions,
  writeJournal,
} = require('./e2e-frontend/layout');
const { enforceSnapshotRetention, readCurrentReceipt } = require('./e2e-frontend/retention');
const {
  atomicWrite,
  copyTree,
  installImmutableFile,
  listTree,
  manifestBytes,
  snapshotHash,
  verifySnapshot,
} = require('./e2e-frontend/snapshot-tree');
const {
  createManagedFrontendWorkspace,
  isOwnedManagedWorkspaceSource,
  releaseManagedFrontendWorkspace,
} = require('./e2e-frontend/workspaces');

const publishFrontendSnapshot = ({
  sourceRoot,
  cacheRoot,
  retentionLeaseId,
  failAt = null,
}) => {
  const source = resolveAbsoluteInput(sourceRoot, 'frontend source');
  const cache = resolveAbsoluteInput(cacheRoot, 'frontend cache root');
  const overlaps = pathsOverlap(source, cache, 'frontend source/cache overlap check');
  const authority = assertManagedMutationAuthority(cache, retentionLeaseId);
  if (overlaps) {
    const workspaceRoots = { workspacesRoot: path.join(cache, PUBLISHER_WORKSPACE_ROOT) };
    if (!isOwnedManagedWorkspaceSource(source, workspaceRoots, authority)) {
      throw new Error('frontend source and cache root must not overlap');
    }
  }
  assertNotRedirected(source, 'frontend source');
  assertNotRedirected(cache, 'frontend cache root');
  const entries = listTree(source);
  const hash = snapshotHash(entries);
  reassertMutationAuthority(cache, authority);
  const roots = ensurePublisherLayout(cache, authority);
  recoverPublisherTransactions(cache, roots, authority);
  const previousReceipt = readCurrentReceipt(roots);
  const destination = path.join(roots.snapshotsRoot, hash);
  const manifest = manifestBytes(entries);
  const manifestPath = path.join(roots.manifestsRoot, `${hash}.json`);
  const receiptPath = path.join(roots.receiptsRoot, 'current.json');
  const receipt = Buffer.from(`${JSON.stringify({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    hashAlgorithm: HASH_ALGORITHM,
    snapshotHash: hash,
    snapshotRoot: destination,
    manifestPath,
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
  }, null, 2)}\n`, 'utf8');

  let snapshotCreated = false;
  if (fs.existsSync(destination)) {
    assertRealDirectory(destination, 'immutable frontend snapshot');
    verifySnapshot(destination, hash);
  } else {
    const transactionId = randomBytes(16).toString('hex');
    const temporaryLeaf = `.publish-${hash}-${transactionId}`;
    const temporary = path.join(roots.snapshotsRoot, temporaryLeaf);
    let journalPath = null;
    try {
      if (authority !== null) {
        reassertMutationAuthority(cache, authority);
        journalPath = writeJournal(roots.journalsRoot, {
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          owner: MANAGED_CACHE_OWNER,
          rootId: authority.rootId,
          transactionId,
          kind: 'snapshot-publication',
          snapshotHash: hash,
          ownedLeaf: temporaryLeaf,
        });
      }
      copyTree(entries, temporary);
      verifySnapshot(temporary, hash);
      if (failAt === 'before-snapshot-commit') throw new Error('injected interruption before snapshot commit');
      reassertMutationAuthority(cache, authority);
      try {
        fs.renameSync(temporary, destination);
        snapshotCreated = true;
      } catch (error) {
        if (!fs.existsSync(destination)) throw error;
        assertRealDirectory(destination, 'concurrent immutable frontend snapshot');
        verifySnapshot(destination, hash);
      }
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
      if (journalPath !== null && fs.existsSync(journalPath)) fs.rmSync(journalPath, { force: true });
    }
  }

  reassertMutationAuthority(cache, authority);
  installImmutableFile(manifestPath, manifest);
  if (failAt === 'before-receipt-commit') throw new Error('injected interruption before receipt commit');
  let receiptChanged = true;
  if (fs.existsSync(receiptPath)) {
    assertNotRedirected(receiptPath, 'frontend snapshot receipt');
    const stat = fs.lstatSync(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('frontend snapshot receipt must be a real file');
    receiptChanged = !fs.readFileSync(receiptPath).equals(receipt);
  }
  if (receiptChanged) {
    reassertMutationAuthority(cache, authority);
    atomicWrite(receiptPath, receipt);
  }
  const retention = enforceSnapshotRetention({
    cacheRoot: cache,
    roots,
    authority,
    currentHash: hash,
    previousCurrentHash: previousReceipt?.snapshotHash ?? null,
  });
  return Object.freeze({
    snapshotHash: hash,
    snapshotRoot: destination,
    manifestPath,
    receiptPath,
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
    snapshotCreated,
    receiptChanged,
    retainedSnapshotHashes: retention.retainedHashes,
    prunedSnapshotHashes: retention.prunedHashes,
  });
};

const parseCli = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--source', '--cache-root'].includes(name) || value === undefined || values.has(name)) {
      throw new Error('usage: e2e-frontend-snapshot.js --source ABSOLUTE --cache-root ABSOLUTE');
    }
    values.set(name, value);
  }
  if (values.size !== 2) {
    throw new Error('usage: e2e-frontend-snapshot.js --source ABSOLUTE --cache-root ABSOLUTE');
  }
  return { sourceRoot: values.get('--source'), cacheRoot: values.get('--cache-root') };
};

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(publishFrontendSnapshot(parseCli(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  createManagedFrontendWorkspace,
  manifestBytes,
  parseCli,
  publishFrontendSnapshot,
  releaseManagedFrontendWorkspace,
  resolveAbsoluteInput,
  snapshotHash,
};
