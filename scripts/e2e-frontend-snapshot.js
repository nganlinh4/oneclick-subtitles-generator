#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { assertWindowsProcessIdentity } = require('./windows-process-identity.js');

const SNAPSHOT_SCHEMA_VERSION = 1;
const HASH_ALGORITHM = 'sha256';
const MANAGED_CACHE_SCHEMA_VERSION = 1;
const MANAGED_CACHE_OWNER = 'oneclick-subtitles-generator';
const MANAGED_ENTRY_MARKER = '.osg-cache-entry.json';
const MANAGED_AREA_MARKER = '.osg-cache-area.json';
const MANAGED_LEASE_MARKER = '.osg-cache-lease';
const MANAGED_FRONTEND_LANE = 'frontend-e2e';
const MANAGED_LANE_GROUP = 'e2e';
const ID_PATTERN = /^[0-9a-f]{32}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLISHER_LAYOUT_MARKER = '.osg-frontend-snapshot-cache.json';
const PUBLISHER_LAYOUT_KIND = 'e2e-frontend-snapshots';
const PUBLISHER_JOURNAL_ROOT = '.osg-frontend-journals';
const PUBLISHER_TRASH_ROOT = '.osg-frontend-trash';
const PUBLISHER_WORKSPACE_ROOT = '.osg-frontend-workspaces';
const RETENTION_RECEIPT_NAME = 'retention.json';
const RETAINED_SNAPSHOT_COUNT = 2;

const hasTraversalSegment = (input) => String(input).split(/[\\/]+/u).includes('..');

const windowsNamespaceKind = (input) => {
  const normalized = String(input).replaceAll('/', '\\').toLowerCase();
  if (normalized.startsWith('\\\\?\\')) return 'verbatim';
  if (normalized.startsWith('\\\\.\\')) return 'device';
  if (normalized.startsWith('\\??\\') || normalized.startsWith('\\\\??\\')) return 'nt';
  if (normalized.startsWith('\\device\\') || normalized.startsWith('\\global??\\')) return 'nt';
  return null;
};

const hasAmbiguousWin32Segment = (input) => String(input)
  .replaceAll('/', '\\')
  .split('\\')
  .some((segment) => segment !== '' && /[ .]$/u.test(segment));

const assertSafeCallerPathSpelling = (input, label) => {
  const namespace = windowsNamespaceKind(input);
  if (namespace !== null) {
    throw new Error(`${label} must not use a Windows ${namespace} namespace spelling`);
  }
  if (hasAmbiguousWin32Segment(input)) {
    throw new Error(`${label} must not contain a Win32 trailing-dot or trailing-space segment`);
  }
};

const resolveAbsoluteInput = (input, label) => {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new Error(`${label} must be a nonempty path`);
  }
  if (hasTraversalSegment(input)) throw new Error(`${label} must not contain traversal segments`);
  assertSafeCallerPathSpelling(input, label);
  if (!path.isAbsolute(input)) throw new Error(`${label} must be absolute`);
  const resolved = path.resolve(input);
  if (resolved === path.parse(resolved).root) throw new Error(`${label} must not be a filesystem root`);
  return resolved;
};

const samePath = (left, right) => (
  process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right)
);

const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const normalizeSystemPath = (input, label) => {
  if (process.platform !== 'win32') return String(input);
  let normalized = String(input).replaceAll('/', '\\');
  const folded = normalized.toLowerCase();
  if (folded.startsWith('\\\\?\\unc\\')) {
    normalized = `\\\\${normalized.slice('\\\\?\\UNC\\'.length)}`;
  } else if (folded.startsWith('\\??\\unc\\')) {
    normalized = `\\\\${normalized.slice('\\??\\UNC\\'.length)}`;
  } else if (folded.startsWith('\\\\?\\')) {
    normalized = normalized.slice('\\\\?\\'.length);
  } else if (folded.startsWith('\\??\\')) {
    normalized = normalized.slice('\\??\\'.length);
  } else if (windowsNamespaceKind(normalized) !== null) {
    throw new Error(`${label} has an ambiguous system-reported Windows namespace`);
  }
  if (!path.win32.isAbsolute(normalized)) {
    throw new Error(`${label} did not resolve to an absolute DOS or UNC path`);
  }
  return normalized;
};

const canonicalPathIdentity = (input, label) => {
  const normalized = normalizeSystemPath(input, label);
  let cursor = path.resolve(normalized);
  const tail = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`${label} has no resolvable filesystem ancestor`);
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
  const ancestor = normalizeSystemPath(fs.realpathSync.native(cursor), label);
  return path.resolve(ancestor, ...tail);
};

const pathsOverlap = (left, right, label) => {
  const leftIdentity = canonicalPathIdentity(left, `${label} left path`);
  const rightIdentity = canonicalPathIdentity(right, `${label} right path`);
  return samePath(leftIdentity, rightIdentity)
    || isWithin(leftIdentity, rightIdentity)
    || isWithin(rightIdentity, leftIdentity);
};

const existingAncestors = (input) => {
  const values = [];
  let current = path.resolve(input);
  while (true) {
    if (fs.existsSync(current)) values.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return values.reverse();
};

const assertNoReparsePoint = (input, label) => {
  for (const candidate of existingAncestors(input)) {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} crosses a symlink, junction, or reparse point: ${candidate}`);
    }
    const real = fs.realpathSync.native(candidate);
    if (!samePath(real, candidate)) {
      throw new Error(`${label} crosses a redirected filesystem path: ${candidate}`);
    }
  }
};

const assertDirectory = (input, label) => {
  assertNoReparsePoint(input, label);
  const stat = fs.lstatSync(input);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
};

const exactKeys = (value, expected) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
);

const readExactJsonFile = (filePath, label, expectedKeys) => {
  assertNoReparsePoint(filePath, label);
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

const toPortableRelative = (relative) => relative.split(path.sep).join('/');

const listTree = (root) => {
  assertDirectory(root, 'frontend source');
  const entries = [];
  const visit = (directory) => {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute);
      const portable = toPortableRelative(relative);
      if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`frontend source entry escaped its root: ${relative}`);
      }
      const stat = fs.lstatSync(absolute);
      if (child.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`frontend source cannot contain a symlink, junction, or reparse point: ${portable}`);
      }
      if (child.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!child.isFile() || !stat.isFile()) {
        throw new Error(`frontend source contains an unsupported entry: ${portable}`);
      }
      const bytes = fs.readFileSync(absolute);
      entries.push(Object.freeze({
        path: portable,
        size: bytes.length,
        sha256: createHash(HASH_ALGORITHM).update(bytes).digest('hex'),
        source: absolute,
      }));
    }
  };
  visit(root);
  if (entries.length === 0) throw new Error('frontend source must contain at least one file');
  return entries;
};

const publicManifest = (entries) => entries.map(({ path: relative, size, sha256 }) => ({
  path: relative,
  size,
  sha256,
}));

const manifestBytes = (entries) => Buffer.from(`${JSON.stringify({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  hashAlgorithm: HASH_ALGORITHM,
  files: publicManifest(entries),
}, null, 2)}\n`, 'utf8');

const snapshotHash = (entries) => createHash(HASH_ALGORITHM).update(manifestBytes(entries)).digest('hex');

const safeGeneratedLeaf = (prefix) => `${prefix}-${process.pid}-${randomBytes(12).toString('hex')}`;

const createDirectoryStrict = (directory) => {
  fs.mkdirSync(directory, { recursive: true });
  assertDirectory(directory, 'frontend snapshot destination');
};

const copyTree = (entries, destination) => {
  fs.mkdirSync(destination, { recursive: false });
  for (const entry of entries) {
    const output = path.join(destination, ...entry.path.split('/'));
    const relative = path.relative(destination, output);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`frontend snapshot output escaped its root: ${entry.path}`);
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(entry.source, output, fs.constants.COPYFILE_EXCL);
  }
};

const verifySnapshot = (snapshotRoot, expectedHash) => {
  const entries = listTree(snapshotRoot);
  const actualHash = snapshotHash(entries);
  if (actualHash !== expectedHash) {
    throw new Error(`immutable frontend snapshot ${expectedHash} contains ${actualHash}`);
  }
  return entries;
};

const atomicWrite = (destination, bytes) => {
  const parent = path.dirname(destination);
  createDirectoryStrict(parent);
  const temporary = path.join(parent, safeGeneratedLeaf('.receipt'));
  try {
    const descriptor = fs.openSync(temporary, 'wx');
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
};

const installImmutableFile = (destination, bytes) => {
  if (fs.existsSync(destination)) {
    assertNoReparsePoint(destination, 'frontend snapshot manifest');
    if (!fs.lstatSync(destination).isFile() || !fs.readFileSync(destination).equals(bytes)) {
      throw new Error(`immutable frontend snapshot manifest conflicts with ${destination}`);
    }
    return false;
  }
  const temporary = `${destination}.${safeGeneratedLeaf('publish')}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    try {
      fs.renameSync(temporary, destination);
      return true;
    } catch (error) {
      if (!fs.existsSync(destination)) throw error;
      if (!fs.readFileSync(destination).equals(bytes)) {
        throw new Error(`concurrent immutable manifest publication disagreed at ${destination}`, { cause: error });
      }
      return false;
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
};

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
  assertDirectory(cacheRoot, 'frontend cache root');
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
  assertNoReparsePoint(candidate, label);
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
  assertDirectory(snapshotRoot, `immutable frontend snapshot ${hash}`);
  const entries = verifySnapshot(snapshotRoot, hash);
  if (!fs.existsSync(manifestPath)) throw new Error(`immutable frontend snapshot ${hash} has no manifest`);
  assertNoReparsePoint(manifestPath, `immutable frontend snapshot manifest ${hash}`);
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

const workspaceJournalKeys = [
  'schemaVersion',
  'owner',
  'rootId',
  'leaseId',
  'processId',
  'workspaceId',
  'directoryLeaf',
];

const workspaceJournalPath = (workspacesRoot, workspaceId) => (
  path.join(workspacesRoot, `workspace-${workspaceId}.json`)
);

const readWorkspaceJournal = (workspacesRoot, workspaceId) => {
  const journalPath = workspaceJournalPath(workspacesRoot, workspaceId);
  const journal = readExactJsonFile(
    journalPath,
    'frontend build workspace journal',
    workspaceJournalKeys,
  );
  if (
    journal.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || journal.owner !== MANAGED_CACHE_OWNER
    || !ID_PATTERN.test(journal.rootId ?? '')
    || !ID_PATTERN.test(journal.leaseId ?? '')
    || !Number.isInteger(journal.processId)
    || journal.processId < 1
    || journal.workspaceId !== workspaceId
    || journal.directoryLeaf !== `workspace-${workspaceId}`
  ) {
    throw new Error(`frontend build workspace journal is invalid: ${journalPath}`);
  }
  return Object.freeze({ journal, journalPath });
};

const recoverFrontendWorkspaces = (cacheRoot, roots, authority) => {
  const journals = new Map();
  const directories = new Map();
  for (const child of fs.readdirSync(roots.workspacesRoot, { withFileTypes: true })) {
    const atomicMatch = /^\.new-workspace-([0-9a-f]{32})\.json$/u.exec(child.name);
    if (atomicMatch !== null) {
      if (!child.isFile() || child.isSymbolicLink()) {
        throw new Error(`frontend workspace journal temporary has the wrong type: ${child.name}`);
      }
      reassertMutationAuthority(cacheRoot, authority);
      removeOwnedPath(path.join(roots.workspacesRoot, child.name), 'frontend workspace journal temporary');
      continue;
    }
    const journalMatch = /^workspace-([0-9a-f]{32})\.json$/u.exec(child.name);
    if (journalMatch !== null && child.isFile() && !child.isSymbolicLink()) {
      journals.set(journalMatch[1], child.name);
      continue;
    }
    const directoryMatch = /^workspace-([0-9a-f]{32})$/u.exec(child.name);
    if (directoryMatch !== null && child.isDirectory() && !child.isSymbolicLink()) {
      directories.set(directoryMatch[1], child.name);
      continue;
    }
    throw new Error(`unrecognized frontend build workspace entry: ${child.name}`);
  }
  for (const [workspaceId, journalLeaf] of journals) {
    const { journal, journalPath } = readWorkspaceJournal(roots.workspacesRoot, workspaceId);
    if (journal.rootId !== authority.rootId) {
      throw new Error(`frontend build workspace belongs to a different cache root: ${journalLeaf}`);
    }
    if (journal.leaseId === authority.leaseId) {
      throw new Error(`the active E2E lease already owns an unfinished frontend workspace: ${journal.directoryLeaf}`);
    }
    const directory = path.join(roots.workspacesRoot, journal.directoryLeaf);
    assertDirectChild(
      roots.workspacesRoot,
      directory,
      journal.directoryLeaf,
      'frontend build workspace recovery path',
    );
    reassertMutationAuthority(cacheRoot, authority);
    removeOwnedPath(directory, 'interrupted frontend build workspace', true);
    removeOwnedPath(journalPath, 'frontend build workspace journal');
    directories.delete(workspaceId);
  }
  if (directories.size !== 0) {
    throw new Error(
      `frontend build workspace has no ownership journal: ${[...directories.values()].join(', ')}`,
    );
  }
};

const createManagedFrontendWorkspace = ({ cacheRoot, retentionLeaseId }) => {
  const cache = resolveAbsoluteInput(cacheRoot, 'managed frontend cache root');
  const authority = assertManagedMutationAuthority(cache, retentionLeaseId);
  if (authority === null) throw new Error('frontend build workspace requires a managed frontend cache lane');
  const roots = ensurePublisherLayout(cache, authority);
  recoverPublisherTransactions(cache, roots, authority);
  recoverFrontendWorkspaces(cache, roots, authority);
  const workspaceId = randomBytes(16).toString('hex');
  const directoryLeaf = `workspace-${workspaceId}`;
  const directory = path.join(roots.workspacesRoot, directoryLeaf);
  const journalPath = workspaceJournalPath(roots.workspacesRoot, workspaceId);
  const temporaryJournal = path.join(roots.workspacesRoot, `.new-workspace-${workspaceId}.json`);
  const bytes = journalBytes({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    owner: MANAGED_CACHE_OWNER,
    rootId: authority.rootId,
    leaseId: authority.leaseId,
    processId: process.pid,
    workspaceId,
    directoryLeaf,
  });
  reassertMutationAuthority(cache, authority);
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryJournal, 'wx');
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      const openDescriptor = descriptor;
      descriptor = undefined;
      fs.closeSync(openDescriptor);
    }
    fs.renameSync(temporaryJournal, journalPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryJournal)) fs.rmSync(temporaryJournal, { force: true });
  }
  try {
    fs.mkdirSync(directory, { recursive: false });
  } catch (error) {
    // The directory was never ours if creation failed. Remove only our exact journal and preserve
    // any colliding bytes for inspection.
    if (fs.existsSync(journalPath)) fs.rmSync(journalPath, { force: true });
    throw error;
  }
  return Object.freeze({
    cacheRoot: cache,
    rootId: authority.rootId,
    leaseId: authority.leaseId,
    workspaceId,
    workspaceRoot: directory,
    journalPath,
  });
};

const releaseManagedFrontendWorkspace = (workspace) => {
  if (
    workspace === null
    || typeof workspace !== 'object'
    || !ID_PATTERN.test(workspace.workspaceId ?? '')
    || !ID_PATTERN.test(workspace.rootId ?? '')
    || !ID_PATTERN.test(workspace.leaseId ?? '')
  ) {
    throw new Error('frontend build workspace release requires its exact creation contract');
  }
  const cache = resolveAbsoluteInput(workspace.cacheRoot, 'managed frontend cache root');
  const authority = assertManagedMutationAuthority(cache, workspace.leaseId);
  if (authority === null || authority.rootId !== workspace.rootId) {
    throw new Error('frontend build workspace release does not own the managed lane');
  }
  const roots = ensurePublisherLayout(cache, authority);
  const { journal, journalPath } = readWorkspaceJournal(roots.workspacesRoot, workspace.workspaceId);
  if (
    journal.rootId !== workspace.rootId
    || journal.leaseId !== workspace.leaseId
    || journal.processId !== process.pid
    || !samePath(journalPath, workspace.journalPath)
    || !samePath(path.join(roots.workspacesRoot, journal.directoryLeaf), workspace.workspaceRoot)
  ) {
    throw new Error('frontend build workspace release contract changed');
  }
  reassertMutationAuthority(cache, authority);
  removeOwnedPath(workspace.workspaceRoot, 'frontend build workspace', true);
  removeOwnedPath(journalPath, 'frontend build workspace journal');
};

const isOwnedManagedWorkspaceSource = (source, roots, authority) => {
  if (authority === null || !isWithin(roots.workspacesRoot, source)) return false;
  const relative = path.relative(roots.workspacesRoot, source);
  const [directoryLeaf] = relative.split(path.sep);
  const match = /^workspace-([0-9a-f]{32})$/u.exec(directoryLeaf);
  if (match === null) return false;
  const workspaceRoot = path.join(roots.workspacesRoot, directoryLeaf);
  if (!samePath(workspaceRoot, source) && !isWithin(workspaceRoot, source)) return false;
  const { journal } = readWorkspaceJournal(roots.workspacesRoot, match[1]);
  return journal.rootId === authority.rootId
    && journal.leaseId === authority.leaseId
    && journal.processId === process.pid;
};

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
  assertNoReparsePoint(source, 'frontend source');
  assertNoReparsePoint(cache, 'frontend cache root');
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
    assertDirectory(destination, 'immutable frontend snapshot');
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
        assertDirectory(destination, 'concurrent immutable frontend snapshot');
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
    assertNoReparsePoint(receiptPath, 'frontend snapshot receipt');
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
