'use strict';

// Bounded snapshot retention: the current receipt, the retention receipt, and journal-authorized
// pruning down to the current plus one previous verified snapshot.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const { assertNotRedirected, assertRealDirectory, samePath } = require('../publication-paths');
const { readExactJsonFile, reassertMutationAuthority } = require('./authority');
const {
  HASH_ALGORITHM,
  HASH_PATTERN,
  MANAGED_CACHE_OWNER,
  RETAINED_SNAPSHOT_COUNT,
  RETENTION_RECEIPT_NAME,
  SNAPSHOT_SCHEMA_VERSION,
} = require('./constants');
const { assertDirectChild, removeOwnedPath, writeJournal } = require('./layout');
const { atomicWrite, manifestBytes, verifySnapshot } = require('./snapshot-tree');

const readCurrentReceipt = (roots) => {
  const receiptPath = path.join(roots.receiptsRoot, 'current.json');
  if (!fs.existsSync(receiptPath)) return null;
  const receipt = readExactJsonFile(
    receiptPath,
    'frontend snapshot receipt',
    [
      'schemaVersion',
      'hashAlgorithm',
      'snapshotHash',
      'snapshotRoot',
      'manifestPath',
      'fileCount',
      'totalBytes',
    ],
  );
  if (
    receipt.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || receipt.hashAlgorithm !== HASH_ALGORITHM
    || !HASH_PATTERN.test(receipt.snapshotHash ?? '')
    || !samePath(receipt.snapshotRoot, path.join(roots.snapshotsRoot, receipt.snapshotHash))
    || !samePath(receipt.manifestPath, path.join(roots.manifestsRoot, `${receipt.snapshotHash}.json`))
  ) {
    throw new Error('frontend snapshot receipt points outside the owned immutable layout');
  }
  return receipt;
};

const readRetentionReceipt = (roots) => {
  const receiptPath = path.join(roots.receiptsRoot, RETENTION_RECEIPT_NAME);
  if (!fs.existsSync(receiptPath)) return null;
  const receipt = readExactJsonFile(
    receiptPath,
    'frontend snapshot retention receipt',
    ['schemaVersion', 'currentSnapshotHash', 'previousSnapshotHash'],
  );
  if (
    receipt.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || !HASH_PATTERN.test(receipt.currentSnapshotHash ?? '')
    || (receipt.previousSnapshotHash !== null && !HASH_PATTERN.test(receipt.previousSnapshotHash ?? ''))
    || receipt.previousSnapshotHash === receipt.currentSnapshotHash
  ) {
    throw new Error('frontend snapshot retention receipt is invalid');
  }
  return receipt;
};

const verifySnapshotAndManifest = (roots, hash) => {
  const snapshotRoot = path.join(roots.snapshotsRoot, hash);
  const manifestPath = path.join(roots.manifestsRoot, `${hash}.json`);
  assertRealDirectory(snapshotRoot, `immutable frontend snapshot ${hash}`);
  const entries = verifySnapshot(snapshotRoot, hash);
  if (!fs.existsSync(manifestPath)) throw new Error(`immutable frontend snapshot ${hash} has no manifest`);
  assertNotRedirected(manifestPath, `immutable frontend snapshot manifest ${hash}`);
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`immutable frontend snapshot manifest ${hash} must be a real file`);
  }
  if (!fs.readFileSync(manifestPath).equals(manifestBytes(entries))) {
    throw new Error(`immutable frontend snapshot manifest ${hash} does not describe its bytes`);
  }
  return Object.freeze({
    hash,
    snapshotRoot,
    manifestPath,
    modifiedMs: fs.statSync(snapshotRoot).mtimeMs,
  });
};

const inventoryVerifiedSnapshots = (roots) => {
  const snapshots = [];
  for (const child of fs.readdirSync(roots.snapshotsRoot, { withFileTypes: true })) {
    if (!HASH_PATTERN.test(child.name) || !child.isDirectory() || child.isSymbolicLink()) {
      throw new Error(`unrecognized frontend snapshot entry: ${child.name}`);
    }
    snapshots.push(verifySnapshotAndManifest(roots, child.name));
  }
  const snapshotHashes = new Set(snapshots.map(({ hash }) => hash));
  const orphanManifests = [];
  for (const child of fs.readdirSync(roots.manifestsRoot, { withFileTypes: true })) {
    const match = /^([0-9a-f]{64})\.json$/u.exec(child.name);
    if (match === null || !child.isFile() || child.isSymbolicLink()) {
      throw new Error(`unrecognized frontend snapshot manifest entry: ${child.name}`);
    }
    if (!snapshotHashes.has(match[1])) orphanManifests.push(match[1]);
  }
  return Object.freeze({ snapshots, orphanManifests });
};

const retentionJournal = (roots, authority, hash) => {
  const transactionId = randomBytes(16).toString('hex');
  const ownedLeaf = `prune-${hash}-${transactionId}`;
  const journalPath = writeJournal(roots.journalsRoot, {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    owner: MANAGED_CACHE_OWNER,
    rootId: authority.rootId,
    transactionId,
    kind: 'snapshot-retention',
    snapshotHash: hash,
    ownedLeaf,
  });
  return Object.freeze({ transactionId, ownedLeaf, journalPath });
};

const pruneSnapshot = (cacheRoot, roots, authority, hash, hasSnapshot) => {
  const transaction = retentionJournal(roots, authority, hash);
  const trashUnit = path.join(roots.trashRoot, transaction.ownedLeaf);
  assertDirectChild(roots.trashRoot, trashUnit, transaction.ownedLeaf, 'frontend retention trash');
  reassertMutationAuthority(cacheRoot, authority);
  fs.mkdirSync(trashUnit, { recursive: false });
  const snapshotRoot = path.join(roots.snapshotsRoot, hash);
  const manifestPath = path.join(roots.manifestsRoot, `${hash}.json`);
  // If any operation throws, the durable journal deliberately remains. A later publisher holding
  // the exact lane lease can remove only the transaction's quarantined bytes; it never guesses at
  // live paths.
  if (hasSnapshot) {
    assertDirectChild(roots.snapshotsRoot, snapshotRoot, hash, 'frontend retention snapshot');
    fs.renameSync(snapshotRoot, path.join(trashUnit, 'snapshot'));
  }
  if (fs.existsSync(manifestPath)) {
    assertDirectChild(roots.manifestsRoot, manifestPath, `${hash}.json`, 'frontend retention manifest');
    fs.renameSync(manifestPath, path.join(trashUnit, 'manifest.json'));
  }
  reassertMutationAuthority(cacheRoot, authority);
  removeOwnedPath(trashUnit, 'frontend retention trash unit', true);
  removeOwnedPath(transaction.journalPath, 'frontend retention journal');
};

const enforceSnapshotRetention = ({
  cacheRoot,
  roots,
  authority,
  currentHash,
  previousCurrentHash,
}) => {
  if (authority === null) return Object.freeze({ retainedHashes: [], prunedHashes: [] });
  reassertMutationAuthority(cacheRoot, authority);
  const priorRetention = readRetentionReceipt(roots);
  const inventory = inventoryVerifiedSnapshots(roots);
  const byHash = new Map(inventory.snapshots.map((snapshot) => [snapshot.hash, snapshot]));
  if (!byHash.has(currentHash)) throw new Error('current frontend snapshot is not a verified immutable snapshot');
  const previousCandidates = [
    previousCurrentHash,
    priorRetention?.currentSnapshotHash,
    priorRetention?.previousSnapshotHash,
    ...inventory.snapshots
      .filter(({ hash }) => hash !== currentHash)
      .sort((left, right) => right.modifiedMs - left.modifiedMs || left.hash.localeCompare(right.hash))
      .map(({ hash }) => hash),
  ];
  const previousHash = previousCandidates.find((candidate) => (
    candidate !== null
    && candidate !== undefined
    && candidate !== currentHash
    && byHash.has(candidate)
  )) ?? null;
  const keep = new Set([currentHash]);
  if (previousHash !== null) keep.add(previousHash);
  if (keep.size > RETAINED_SNAPSHOT_COUNT) throw new Error('frontend snapshot retention selected too many snapshots');
  const retentionPath = path.join(roots.receiptsRoot, RETENTION_RECEIPT_NAME);
  const retentionBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    currentSnapshotHash: currentHash,
    previousSnapshotHash: previousHash,
  }, null, 2)}\n`, 'utf8');
  reassertMutationAuthority(cacheRoot, authority);
  atomicWrite(retentionPath, retentionBytes);
  const prunedHashes = [];
  for (const snapshot of inventory.snapshots) {
    if (keep.has(snapshot.hash)) continue;
    reassertMutationAuthority(cacheRoot, authority);
    pruneSnapshot(cacheRoot, roots, authority, snapshot.hash, true);
    prunedHashes.push(snapshot.hash);
  }
  for (const hash of inventory.orphanManifests) {
    if (keep.has(hash)) throw new Error(`retained frontend snapshot ${hash} is missing its bytes`);
    reassertMutationAuthority(cacheRoot, authority);
    pruneSnapshot(cacheRoot, roots, authority, hash, false);
  }
  const finalInventory = inventoryVerifiedSnapshots(roots);
  if (
    finalInventory.snapshots.length !== keep.size
    || finalInventory.snapshots.some(({ hash }) => !keep.has(hash))
    || finalInventory.orphanManifests.length !== 0
  ) {
    throw new Error('frontend snapshot retention did not converge on current plus previous');
  }
  return Object.freeze({ retainedHashes: [...keep], prunedHashes });
};

module.exports = {
  enforceSnapshotRetention,
  readCurrentReceipt,
};
