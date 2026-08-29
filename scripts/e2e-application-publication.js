#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { assertWindowsProcessIdentity } = require('./windows-process-identity.js');
const { readCleanGitSourceProvenance } = require('./git-source-provenance.js');

const APPLICATION_SCHEMA_VERSION = 2;
const HASH_ALGORITHM = 'sha256';
const APPLICATION_BINARY = 'osg-desktop.exe';
const APPLICATION_MANIFEST = '.osg-application-manifest.json';
const APPLICATION_TRASH = '.osg-application-trash';
const APPLICATION_TRASH_MARKER = '.osg-application-trash.json';
const APPLICATION_OPERATIONS = '.osg-application-operations';
const APPLICATION_OPERATIONS_MARKER = '.osg-application-operations.json';
const RESOURCE_DIRECTORIES = Object.freeze(['licenses', 'ui-fonts', 'workers']);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const OPERATION_ID_PATTERN = /^[0-9a-f]{32}$/u;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40,64}$/u;

const normalizeSourceProvenance = (source, { allowMissing = false } = {}) => {
  if (source === undefined && allowMissing) return null;
  if (
    source === null
    || typeof source !== 'object'
    || Array.isArray(source)
    || Object.keys(source).sort().join('|') !== 'commit|dirty|tree'
    || !GIT_OBJECT_PATTERN.test(source.commit ?? '')
    || !GIT_OBJECT_PATTERN.test(source.tree ?? '')
    || source.dirty !== false
  ) {
    throw new Error('E2E application source provenance must name one clean Git commit and tree');
  }
  return Object.freeze({ commit: source.commit, tree: source.tree, dirty: false });
};

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

/** Resolve a caller-controlled path without silently normalising traversal away. */
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
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
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
  const ancestors = [];
  let candidate = path.resolve(input);
  while (true) {
    if (fs.existsSync(candidate)) ancestors.push(candidate);
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return ancestors.reverse();
};

const assertNotRedirected = (input, label) => {
  for (const candidate of existingAncestors(input)) {
    const status = fs.lstatSync(candidate);
    if (status.isSymbolicLink()) {
      throw new Error(`${label} crosses a symlink, junction, or reparse point: ${candidate}`);
    }
    const canonical = fs.realpathSync.native(candidate);
    if (!samePath(canonical, candidate)) {
      throw new Error(`${label} crosses a redirected filesystem path: ${candidate}`);
    }
  }
};

const assertRealDirectory = (directory, label) => {
  assertNotRedirected(directory, label);
  const status = fs.lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
};

const assertRealFile = (file, label) => {
  assertNotRedirected(file, label);
  const status = fs.lstatSync(file);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a real file`);
  }
};

const assertPublishedFile = (file, label) => {
  assertRealFile(file, label);
  if (fs.lstatSync(file).nlink !== 1) {
    throw new Error(`${label} must not be hard-linked to externally mutable bytes`);
  }
};

const createManagedDirectory = (directory, label) => {
  assertNotRedirected(directory, label);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRealDirectory(directory, label);
};

const toPortablePath = (relative) => relative.split(path.sep).join('/');

const checkedRelativePath = (root, absolute, label) => {
  const relative = path.relative(root, absolute);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escaped its root: ${relative}`);
  }
  return toPortablePath(relative);
};

const hashFile = (file) => {
  const bytes = fs.readFileSync(file);
  return Object.freeze({
    size: bytes.length,
    sha256: createHash(HASH_ALGORITHM).update(bytes).digest('hex'),
  });
};

const fileEntry = (root, absolute, label) => {
  assertRealFile(absolute, label);
  const identity = hashFile(absolute);
  return Object.freeze({
    path: checkedRelativePath(root, absolute, label),
    size: identity.size,
    sha256: identity.sha256,
    source: absolute,
  });
};

const sortText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const walkDirectory = ({ root, directory, files, directories, label }) => {
  assertRealDirectory(directory, label);
  directories.push(checkedRelativePath(root, directory, label));
  const children = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
    sortText(left.name, right.name)
  ));
  for (const child of children) {
    const absolute = path.join(directory, child.name);
    const relative = checkedRelativePath(root, absolute, label);
    const status = fs.lstatSync(absolute);
    if (child.isSymbolicLink() || status.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink, junction, or reparse point: ${relative}`);
    }
    const canonical = fs.realpathSync.native(absolute);
    if (!samePath(canonical, absolute)) {
      throw new Error(`${label} contains a redirected filesystem path: ${relative}`);
    }
    if (child.isDirectory() && status.isDirectory()) {
      walkDirectory({ root, directory: absolute, files, directories, label });
    } else if (child.isFile() && status.isFile()) {
      files.push(fileEntry(root, absolute, label));
    } else {
      throw new Error(`${label} contains an unsupported or reparse entry: ${relative}`);
    }
  }
};

/** Collect only the executable and reviewed runtime resource directories from a Cargo profile. */
const collectCargoProfileApplication = (profileRoot) => {
  const root = resolveAbsoluteInput(profileRoot, 'Cargo profile root');
  assertRealDirectory(root, 'Cargo profile root');
  const binary = fileEntry(root, path.join(root, APPLICATION_BINARY), 'E2E application binary');
  if (binary.size === 0) throw new Error('E2E application binary must not be empty');
  const files = [binary];
  const directories = [];
  for (const name of RESOURCE_DIRECTORIES) {
    walkDirectory({
      root,
      directory: path.join(root, name),
      files,
      directories,
      label: `E2E application resource ${name}`,
    });
  }
  files.sort((left, right) => sortText(left.path, right.path));
  directories.sort(sortText);
  return Object.freeze({ root, files, directories });
};

const publicFiles = (files) => files.map(({ path: relative, size, sha256 }) => ({
  path: relative,
  size,
  sha256,
}));

const applicationManifestBytes = ({ files, directories, sourceProvenance = null }) => {
  const source = sourceProvenance === null
    ? null
    : normalizeSourceProvenance(sourceProvenance);
  const manifest = {
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    hashAlgorithm: HASH_ALGORITHM,
    entrypoint: APPLICATION_BINARY,
    resourceDirectories: RESOURCE_DIRECTORIES,
  };
  if (source !== null) manifest.source = source;
  manifest.directories = directories;
  manifest.files = publicFiles(files);
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
};

const manifestHash = (bytes) => createHash(HASH_ALGORITHM).update(bytes).digest('hex');

const safeTemporaryLeaf = (prefix) => (
  `${prefix}-${process.pid}-${randomBytes(16).toString('hex')}`
);

const outputPath = (root, portable, label) => {
  if (
    typeof portable !== 'string'
    || portable.length === 0
    || portable.includes('\\')
    || portable.includes('\0')
    || portable.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} is not a safe portable relative path: ${portable}`);
  }
  const output = path.join(root, ...portable.split('/'));
  checkedRelativePath(root, output, label);
  return output;
};

const copyApplicationTree = ({ files, directories }, destination, manifest) => {
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const relative of directories) {
    fs.mkdirSync(outputPath(destination, relative, 'application directory'), {
      recursive: true,
      mode: 0o700,
    });
  }
  for (const entry of files) {
    const output = outputPath(destination, entry.path, 'application file');
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.copyFileSync(entry.source, output, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(output, 0o600);
  }
  writePrivateFile(path.join(destination, APPLICATION_MANIFEST), manifest);
};

const collectPublishedApplication = (applicationRoot) => {
  assertRealDirectory(applicationRoot, 'published E2E application');
  const files = [];
  const directories = [];
  const visit = (directory) => {
    const children = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => (
      sortText(left.name, right.name)
    ));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = checkedRelativePath(
        applicationRoot,
        absolute,
        'published E2E application entry',
      );
      if (relative === APPLICATION_MANIFEST) {
        assertPublishedFile(absolute, 'immutable E2E application manifest');
        continue;
      }
      const status = fs.lstatSync(absolute);
      if (child.isSymbolicLink() || status.isSymbolicLink()) {
        throw new Error(
          `published E2E application contains a symlink, junction, or reparse point: ${relative}`,
        );
      }
      if (!samePath(fs.realpathSync.native(absolute), absolute)) {
        throw new Error(`published E2E application contains a redirected entry: ${relative}`);
      }
      if (child.isDirectory() && status.isDirectory()) {
        directories.push(relative);
        visit(absolute);
      } else if (child.isFile() && status.isFile()) {
        assertPublishedFile(absolute, 'published E2E application file');
        files.push(fileEntry(
          applicationRoot,
          absolute,
          'published E2E application file',
        ));
      } else {
        throw new Error(`published E2E application contains an unsupported entry: ${relative}`);
      }
    }
  };
  visit(applicationRoot);
  files.sort((left, right) => sortText(left.path, right.path));
  directories.sort(sortText);
  return Object.freeze({ root: applicationRoot, files, directories });
};

const verifyApplicationTree = ({ applicationRoot, expectedHash, expectedManifestBytes }) => {
  if (!HASH_PATTERN.test(expectedHash)) throw new Error('E2E application hash is invalid');
  const manifestPath = path.join(applicationRoot, APPLICATION_MANIFEST);
  assertPublishedFile(manifestPath, 'immutable E2E application manifest');
  if (!fs.readFileSync(manifestPath).equals(expectedManifestBytes)) {
    throw new Error(`immutable E2E application ${expectedHash} has a corrupted manifest`);
  }
  let recordedManifest;
  try {
    recordedManifest = JSON.parse(expectedManifestBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`immutable E2E application ${expectedHash} has an invalid manifest`, {
      cause: error,
    });
  }
  const sourceProvenance = normalizeSourceProvenance(recordedManifest.source, {
    // Schema-v2 applications published before source binding remain valid historical bytes.
    allowMissing: true,
  });
  const collected = collectPublishedApplication(applicationRoot);
  const actualManifest = applicationManifestBytes({ ...collected, sourceProvenance });
  const actualHash = manifestHash(actualManifest);
  if (actualHash !== expectedHash || !actualManifest.equals(expectedManifestBytes)) {
    throw new Error(
      `immutable E2E application ${expectedHash} has corrupted inventory ${actualHash}`,
    );
  }
  return Object.freeze({ ...collected, sourceProvenance });
};

const writePrivateFile = (file, bytes) => {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const assertOwnedPrivateTemporaryFile = (file, label) => {
  assertPublishedFile(file, label);
  const status = fs.lstatSync(file);
  if (process.platform !== 'win32' && (status.mode & 0o077) !== 0) {
    throw new Error(`${label} is not private to its owner`);
  }
};

const writePrivateFileAtomically = ({ destination, bytes, temporaryLeaf }) => {
  const directory = path.dirname(destination);
  const temporary = path.join(directory, temporaryLeaf);
  if (path.dirname(temporary) !== directory || temporary === destination) {
    throw new Error('atomic private-file temporary path escaped its owned directory');
  }
  try {
    writePrivateFile(temporary, bytes);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
};

const waitBriefly = (milliseconds) => {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waiter, 0, 0, milliseconds);
};

// Node maps rename to MoveFileExW with replacement on Windows. Antivirus and concurrent readers can
// still transiently deny that call, so retry the atomic operation; never unlink the old receipt.
const replaceReceiptAtomically = ({ destination, bytes, failBeforeCommit = false }) => {
  const temporary = path.join(path.dirname(destination), safeTemporaryLeaf('.receipt'));
  try {
    writePrivateFile(temporary, bytes);
    if (failBeforeCommit) throw new Error('injected interruption before receipt commit');
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporary, destination);
        return;
      } catch (error) {
        if (
          fs.existsSync(destination)
          && fs.lstatSync(destination).isFile()
          && fs.readFileSync(destination).equals(bytes)
        ) {
          return;
        }
        const transient = process.platform === 'win32'
          && ['EACCES', 'EBUSY', 'EEXIST', 'EPERM'].includes(error.code);
        if (!transient || attempt >= 12) throw error;
        waitBriefly(5 * (attempt + 1));
      }
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
};

const recoverManagedReceiptTemporaries = (receiptsRoot) => {
  for (const entry of fs.readdirSync(receiptsRoot, { withFileTypes: true })) {
    if (entry.name === 'current.json') continue;
    const temporary = /^\.receipt-([1-9][0-9]*)-([0-9a-f]{32})$/u.exec(entry.name);
    if (!entry.isFile() || temporary === null) {
      throw new Error(`unrecognized E2E application receipt entry: ${entry.name}`);
    }
    const temporaryPath = path.join(receiptsRoot, entry.name);
    assertOwnedPrivateTemporaryFile(temporaryPath, 'orphaned E2E application receipt temporary');
    fs.rmSync(temporaryPath, { force: false });
  }
};

const publicationPaths = (applicationsCacheRoot, applicationHash) => {
  const cacheRoot = resolveAbsoluteInput(applicationsCacheRoot, 'E2E applications cache root');
  if (!HASH_PATTERN.test(applicationHash)) throw new Error('E2E application hash is invalid');
  return Object.freeze({
    cacheRoot,
    applicationsRoot: path.join(cacheRoot, 'applications'),
    receiptsRoot: path.join(cacheRoot, 'receipts'),
    applicationRoot: path.join(cacheRoot, 'applications', applicationHash),
    manifestPath: path.join(cacheRoot, 'applications', applicationHash, APPLICATION_MANIFEST),
    receiptPath: path.join(cacheRoot, 'receipts', 'current.json'),
  });
};

const applicationReceiptBytes = ({ paths, applicationHash, files, sourceProvenance }) => {
  const source = normalizeSourceProvenance(sourceProvenance);
  return Buffer.from(`${JSON.stringify({
    schemaVersion: APPLICATION_SCHEMA_VERSION,
    hashAlgorithm: HASH_ALGORITHM,
    applicationHash,
    source,
    applicationRoot: paths.applicationRoot,
    binaryPath: path.join(paths.applicationRoot, APPLICATION_BINARY),
    manifestPath: paths.manifestPath,
    fileCount: files.length,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
  }, null, 2)}\n`, 'utf8');
};

const parseExactJsonFile = (file, expectedKeys, label) => {
  assertPublishedFile(file, label);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...expectedKeys].sort().join('|')
  ) {
    throw new Error(`${label} has an unexpected schema`);
  }
  return value;
};

const assertCurrentProcessOwnsApplicationLease = ({ cacheRoot, leaseId }) => {
  if (!/^[0-9a-f]{32}$/u.test(leaseId ?? '')) {
    throw new Error('application retention requires the exact managed-cache lease id');
  }
  const entry = parseExactJsonFile(
    path.join(cacheRoot, '.osg-cache-entry.json'),
    ['schemaVersion', 'owner', 'rootId', 'lane'],
    'managed app-publication lane marker',
  );
  const lease = parseExactJsonFile(
    path.join(cacheRoot, '.osg-cache-lease'),
    [
      'schemaVersion', 'owner', 'rootId', 'laneGroup', 'leaseId', 'processId',
      'processCreatedUtc',
    ],
    'managed app-publication lease',
  );
  if (
    entry.schemaVersion !== 1
    || entry.owner !== 'oneclick-subtitles-generator'
    || entry.lane !== 'apps-e2e'
    || !/^[0-9a-f]{32}$/u.test(entry.rootId ?? '')
    || lease.schemaVersion !== entry.schemaVersion
    || lease.owner !== entry.owner
    || lease.rootId !== entry.rootId
    || lease.laneGroup !== 'e2e'
    || lease.leaseId !== leaseId
    || lease.processId !== process.pid
  ) {
    throw new Error('application retention is not owned by this process and managed-cache lease');
  }
  try {
    assertWindowsProcessIdentity({
      processId: lease.processId,
      processCreatedUtc: lease.processCreatedUtc,
    });
  } catch (error) {
    throw new Error('application retention lease owner identity is stale or was reused', {
      cause: error,
    });
  }
};

const authorizeManagedApplicationMutation = ({ cacheRoot, leaseId }) => {
  const entryPath = path.join(cacheRoot, '.osg-cache-entry.json');
  const leasePath = path.join(cacheRoot, '.osg-cache-lease');
  const entryExists = fs.existsSync(entryPath);
  const leaseExists = fs.existsSync(leasePath);
  if (!entryExists && !leaseExists && leaseId === null) return false;
  if (!entryExists || !leaseExists || leaseId === null) {
    throw new Error('managed E2E application mutation requires its exact active cache lease');
  }
  assertCurrentProcessOwnsApplicationLease({ cacheRoot, leaseId });
  return true;
};

const ensureApplicationOperations = (cacheRoot) => {
  const operationsRoot = path.join(cacheRoot, APPLICATION_OPERATIONS);
  const markerPath = path.join(operationsRoot, APPLICATION_OPERATIONS_MARKER);
  assertNotRedirected(operationsRoot, 'E2E application operation journal');
  if (!fs.existsSync(operationsRoot)) fs.mkdirSync(operationsRoot, { mode: 0o700 });
  assertRealDirectory(operationsRoot, 'E2E application operation journal');
  for (const entry of fs.readdirSync(operationsRoot, { withFileTypes: true })) {
    const markerTemporary = /^\.osg-application-operations\.json\.tmp-([1-9][0-9]*)-([0-9a-f]{32})$/u
      .exec(entry.name);
    if (markerTemporary === null) continue;
    if (!entry.isFile()) {
      throw new Error(`invalid E2E application operation marker temporary: ${entry.name}`);
    }
    const temporaryPath = path.join(operationsRoot, entry.name);
    assertOwnedPrivateTemporaryFile(
      temporaryPath,
      'orphaned E2E application operation marker temporary',
    );
    fs.rmSync(temporaryPath, { force: false });
  }
  if (!fs.existsSync(markerPath)) {
    if (fs.readdirSync(operationsRoot).length !== 0) {
      throw new Error('refusing to adopt nonempty E2E application operation journal');
    }
    writePrivateFileAtomically({
      destination: markerPath,
      temporaryLeaf: `.osg-application-operations.json.tmp-${process.pid}-${randomBytes(16).toString('hex')}`,
      bytes: Buffer.from(`${JSON.stringify({
        schemaVersion: APPLICATION_SCHEMA_VERSION,
        owner: 'oneclick-subtitles-generator',
        kind: 'e2e-application-operation-journal',
      })}\n`, 'utf8'),
    });
  }
  const marker = parseExactJsonFile(
    markerPath,
    ['schemaVersion', 'owner', 'kind'],
    'E2E application operation journal marker',
  );
  if (
    marker.schemaVersion !== APPLICATION_SCHEMA_VERSION
    || marker.owner !== 'oneclick-subtitles-generator'
    || marker.kind !== 'e2e-application-operation-journal'
  ) {
    throw new Error('E2E application operation journal marker is foreign or obsolete');
  }
  return operationsRoot;
};

const operationJournalPath = (operationsRoot, operationId) => {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error('E2E application operation id is invalid');
  }
  return path.join(operationsRoot, `.operation-${operationId}.json`);
};

const writeApplicationOperation = ({ operationsRoot, operation }) => {
  const journalPath = operationJournalPath(operationsRoot, operation.operationId);
  writePrivateFileAtomically({
    destination: journalPath,
    temporaryLeaf: `.operation-${operation.operationId}.json.tmp-${process.pid}-${randomBytes(16).toString('hex')}`,
    bytes: Buffer.from(`${JSON.stringify(operation)}\n`, 'utf8'),
  });
  return journalPath;
};

const removeJournalAuthorizedTree = (tree, label) => {
  assertNotRedirected(tree, label);
  const status = fs.lstatSync(tree);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  const pending = [tree];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const childStatus = fs.lstatSync(child);
      if (childStatus.isSymbolicLink()) {
        throw new Error(`${label} contains a symlink, junction, or reparse point: ${child}`);
      }
      assertNotRedirected(child, label);
      if (childStatus.isDirectory()) pending.push(child);
      else if (!childStatus.isFile()) {
        throw new Error(`${label} contains an unsupported filesystem entry: ${child}`);
      }
    }
  }
  fs.rmSync(tree, { recursive: true, force: false, maxRetries: 5 });
};

const recoverApplicationOperations = ({ cacheRoot, leaseId }) => {
  assertCurrentProcessOwnsApplicationLease({ cacheRoot, leaseId });
  const operationsRoot = ensureApplicationOperations(cacheRoot);
  const applicationsRoot = path.join(cacheRoot, 'applications');
  const trashRoot = path.join(cacheRoot, APPLICATION_TRASH);
  for (const entry of fs.readdirSync(operationsRoot, { withFileTypes: true })) {
    if (entry.name === APPLICATION_OPERATIONS_MARKER) continue;
    const temporaryMatch = /^\.operation-([0-9a-f]{32})\.json\.tmp-([1-9][0-9]*)-([0-9a-f]{32})$/u
      .exec(entry.name);
    if (temporaryMatch !== null) {
      if (!entry.isFile()) {
        throw new Error(`invalid E2E application operation temporary: ${entry.name}`);
      }
      const temporaryPath = path.join(operationsRoot, entry.name);
      assertOwnedPrivateTemporaryFile(
        temporaryPath,
        'orphaned E2E application operation temporary',
      );
      fs.rmSync(temporaryPath, { force: false });
      continue;
    }
    const match = /^\.operation-([0-9a-f]{32})\.json$/u.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw new Error(`unrecognized E2E application operation journal entry: ${entry.name}`);
    }
    const journalPath = path.join(operationsRoot, entry.name);
    assertPublishedFile(journalPath, 'E2E application operation journal');
    const operation = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (
      operation === null
      || typeof operation !== 'object'
      || operation.schemaVersion !== APPLICATION_SCHEMA_VERSION
      || operation.owner !== 'oneclick-subtitles-generator'
      || operation.operationId !== match[1]
      || !['publish', 'retire', 'retire-legacy'].includes(operation.kind)
    ) {
      throw new Error(`invalid E2E application operation journal: ${entry.name}`);
    }
    assertCurrentProcessOwnsApplicationLease({ cacheRoot, leaseId });
    if (operation.kind === 'publish') {
      if (
        Object.keys(operation).sort().join('|')
          !== ['schemaVersion', 'owner', 'kind', 'operationId', 'temporaryLeaf'].sort().join('|')
        || !new RegExp(`^\\.publish-[0-9a-f]{64}-${operation.operationId}$`, 'u')
          .test(operation.temporaryLeaf ?? '')
      ) {
        throw new Error(`invalid E2E application publish journal: ${entry.name}`);
      }
      const temporary = path.join(applicationsRoot, operation.temporaryLeaf);
      if (fs.existsSync(temporary)) {
        removeJournalAuthorizedTree(temporary, 'journal-authorized E2E application publication');
      }
    } else if (operation.kind === 'retire') {
      if (
        Object.keys(operation).sort().join('|') !== [
          'schemaVersion', 'owner', 'kind', 'operationId', 'applicationHash',
          'sourceLeaf', 'trashLeaf',
        ].sort().join('|')
        || !HASH_PATTERN.test(operation.applicationHash ?? '')
        || operation.sourceLeaf !== operation.applicationHash
        || operation.trashLeaf !== `${operation.applicationHash}--${operation.operationId}`
      ) {
        throw new Error(`invalid E2E application retirement journal: ${entry.name}`);
      }
      const source = path.join(applicationsRoot, operation.sourceLeaf);
      const retired = path.join(trashRoot, operation.trashLeaf);
      if (fs.existsSync(source) && fs.existsSync(retired)) {
        throw new Error('journal-authorized application exists in both live and retirement roots');
      }
      if (fs.existsSync(retired)) {
        const receiptPath = path.join(cacheRoot, 'receipts', 'current.json');
        if (fs.existsSync(receiptPath)) {
          const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
          if (receipt?.applicationHash === operation.applicationHash) {
            throw new Error('refusing to recover a retirement journal for the current application');
          }
        }
        removeJournalAuthorizedTree(retired, 'journal-authorized E2E application retirement');
      }
    } else {
      if (
        Object.keys(operation).sort().join('|') !== [
          'schemaVersion', 'owner', 'kind', 'operationId', 'applicationHash',
          'sourceLeaf', 'trashLeaf', 'manifestLeaf',
        ].sort().join('|')
        || !HASH_PATTERN.test(operation.applicationHash ?? '')
        || operation.sourceLeaf !== operation.applicationHash
        || operation.trashLeaf !== `${operation.applicationHash}--${operation.operationId}`
        || operation.manifestLeaf !== `${operation.applicationHash}.json`
      ) {
        throw new Error(`invalid legacy E2E application retirement journal: ${entry.name}`);
      }
      const source = path.join(applicationsRoot, operation.sourceLeaf);
      const retired = path.join(trashRoot, operation.trashLeaf);
      const legacyManifest = path.join(cacheRoot, 'manifests', operation.manifestLeaf);
      if (fs.existsSync(source) && fs.existsSync(retired)) {
        throw new Error('journal-authorized legacy application exists in live and retirement roots');
      }
      if (fs.existsSync(retired)) {
        removeJournalAuthorizedTree(retired, 'journal-authorized legacy E2E application retirement');
      }
      if (!fs.existsSync(source) && fs.existsSync(legacyManifest)) {
        assertPublishedFile(legacyManifest, 'legacy E2E application manifest retirement');
        fs.rmSync(legacyManifest, { force: false });
      }
    }
    fs.rmSync(journalPath, { force: false });
  }
  return operationsRoot;
};

const ensureApplicationTrash = (cacheRoot) => {
  const trashRoot = path.join(cacheRoot, APPLICATION_TRASH);
  const markerPath = path.join(trashRoot, APPLICATION_TRASH_MARKER);
  assertNotRedirected(trashRoot, 'E2E application retirement directory');
  if (!fs.existsSync(trashRoot)) fs.mkdirSync(trashRoot, { mode: 0o700 });
  assertRealDirectory(trashRoot, 'E2E application retirement directory');
  if (!fs.existsSync(markerPath)) {
    if (fs.readdirSync(trashRoot).length !== 0) {
      throw new Error('refusing to adopt nonempty E2E application retirement bytes');
    }
    writePrivateFile(markerPath, Buffer.from(`${JSON.stringify({
      schemaVersion: APPLICATION_SCHEMA_VERSION,
      owner: 'oneclick-subtitles-generator',
      kind: 'e2e-application-retirement',
    })}\n`, 'utf8'));
  }
  const marker = parseExactJsonFile(
    markerPath,
    ['schemaVersion', 'owner', 'kind'],
    'E2E application retirement marker',
  );
  if (
    marker.schemaVersion !== APPLICATION_SCHEMA_VERSION
    || marker.owner !== 'oneclick-subtitles-generator'
    || marker.kind !== 'e2e-application-retirement'
  ) {
    throw new Error('E2E application retirement marker is foreign or obsolete');
  }
  return trashRoot;
};

const verifyRetirement = ({ trashRoot, name }) => {
  const match = /^([0-9a-f]{64})--([0-9a-f]{32})$/u.exec(name);
  if (match === null) throw new Error(`unrecognized E2E application retirement bytes: ${name}`);
  const retiredRoot = path.join(trashRoot, name);
  const manifestPath = path.join(retiredRoot, APPLICATION_MANIFEST);
  assertPublishedFile(manifestPath, 'retired E2E application manifest');
  const manifest = fs.readFileSync(manifestPath);
  if (manifestHash(manifest) !== match[1]) {
    throw new Error(`retired E2E application has an invalid content identity: ${name}`);
  }
  verifyApplicationTree({
    applicationRoot: retiredRoot,
    expectedHash: match[1],
    expectedManifestBytes: manifest,
  });
  return Object.freeze({
    applicationHash: match[1],
    operationId: match[2],
    retiredRoot,
  });
};

const verifyLegacyApplication = ({ cacheRoot, applicationRoot, hash, manifestPath }) => {
  assertPublishedFile(manifestPath, 'legacy E2E application manifest');
  const manifestBytes = fs.readFileSync(manifestPath);
  if (manifestHash(manifestBytes) !== hash) {
    throw new Error(`unverifiable legacy E2E application manifest: ${hash}`);
  }
  const manifest = parseExactJsonFile(
    manifestPath,
    ['schemaVersion', 'hashAlgorithm', 'entrypoint', 'resourceDirectories', 'directories', 'files'],
    'legacy E2E application manifest',
  );
  if (
    manifest.schemaVersion !== 1
    || manifest.hashAlgorithm !== HASH_ALGORITHM
    || manifest.entrypoint !== APPLICATION_BINARY
    || JSON.stringify(manifest.resourceDirectories) !== JSON.stringify(RESOURCE_DIRECTORIES)
    || !Array.isArray(manifest.directories)
    || !Array.isArray(manifest.files)
  ) {
    throw new Error(`unverifiable legacy E2E application entry: ${hash}`);
  }
  const collected = collectPublishedApplication(applicationRoot);
  const expectedDirectories = [...manifest.directories].sort(sortText);
  const expectedFiles = [...manifest.files]
    .map(({ path: relative, size, sha256 }) => ({ path: relative, size, sha256 }))
    .sort((left, right) => sortText(left.path, right.path));
  if (
    JSON.stringify(collected.directories) !== JSON.stringify(expectedDirectories)
    || JSON.stringify(collected.files.map(({ path: relative, size, sha256 }) => ({
      path: relative, size, sha256,
    }))) !== JSON.stringify(expectedFiles)
  ) {
    throw new Error(`legacy E2E application inventory changed: ${hash}`);
  }
  if (!samePath(path.dirname(applicationRoot), path.join(cacheRoot, 'applications'))) {
    throw new Error(`legacy E2E application escaped its cache root: ${hash}`);
  }
  return Object.freeze({ applicationRoot, hash, manifestPath });
};

/** Keep the current and one explicitly selected previous verified v2 publication. */
const retainBoundedE2eApplications = ({ applicationsCacheRoot, leaseId, previousHash = null }) => {
  const cacheRoot = resolveAbsoluteInput(applicationsCacheRoot, 'E2E applications cache root');
  assertCurrentProcessOwnsApplicationLease({ cacheRoot, leaseId });
  const current = readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cacheRoot });
  const paths = publicationPaths(cacheRoot, current.applicationHash);
  const trashRoot = ensureApplicationTrash(cacheRoot);
  const operationsRoot = recoverApplicationOperations({ cacheRoot, leaseId });

  for (const entry of fs.readdirSync(trashRoot, { withFileTypes: true })) {
    if (entry.name === APPLICATION_TRASH_MARKER) continue;
    if (!entry.isDirectory()) {
      throw new Error(`unrecognized E2E application retirement bytes: ${entry.name}`);
    }
    const retirement = verifyRetirement({ trashRoot, name: entry.name });
    const journalPath = writeApplicationOperation({
      operationsRoot,
      operation: {
        schemaVersion: APPLICATION_SCHEMA_VERSION,
        owner: 'oneclick-subtitles-generator',
        kind: 'retire',
        operationId: retirement.operationId,
        applicationHash: retirement.applicationHash,
        sourceLeaf: retirement.applicationHash,
        trashLeaf: entry.name,
      },
    });
    removeJournalAuthorizedTree(retirement.retiredRoot, 'journal-authorized legacy retirement');
    fs.rmSync(journalPath, { force: false });
  }

  const verified = [];
  const verifiedLegacy = [];
  for (const entry of fs.readdirSync(paths.applicationsRoot, { withFileTypes: true })) {
    if (/^\.publish-[0-9a-f]{64}-\d+-[0-9a-f]{32}$/u.test(entry.name) && entry.isDirectory()) {
      throw new Error(`unowned interrupted E2E application publication: ${entry.name}`);
    }
    if (/^\.publish-[0-9a-f]{64}-[0-9a-f]{32}$/u.test(entry.name) && entry.isDirectory()) {
      throw new Error(`unjournaled interrupted E2E application publication: ${entry.name}`);
    }
    if (!entry.isDirectory() || !HASH_PATTERN.test(entry.name)) {
      throw new Error(`unrecognized immutable E2E application entry: ${entry.name}`);
    }
    if (entry.name === current.applicationHash) continue;
    const applicationRoot = path.join(paths.applicationsRoot, entry.name);
    const manifestPath = path.join(applicationRoot, APPLICATION_MANIFEST);
    if (!fs.existsSync(manifestPath)) {
      const legacyManifestPath = path.join(cacheRoot, 'manifests', `${entry.name}.json`);
      if (!fs.existsSync(legacyManifestPath)) {
        throw new Error(`unverifiable immutable E2E application entry: ${entry.name}`);
      }
      const legacy = verifyLegacyApplication({
        cacheRoot,
        applicationRoot,
        hash: entry.name,
        manifestPath: legacyManifestPath,
      });
      verifiedLegacy.push({
        ...legacy,
        modifiedMs: fs.lstatSync(applicationRoot).mtimeMs,
      });
      continue;
    }
    assertPublishedFile(manifestPath, 'retention candidate manifest');
    const manifest = fs.readFileSync(manifestPath);
    if (manifestHash(manifest) !== entry.name) {
      throw new Error(`retention candidate manifest hash mismatch: ${entry.name}`);
    }
    verifyApplicationTree({
      applicationRoot,
      expectedHash: entry.name,
      expectedManifestBytes: manifest,
    });
    verified.push({
      applicationRoot,
      hash: entry.name,
      modifiedMs: fs.lstatSync(applicationRoot).mtimeMs,
    });
  }

  const retainedLegacyHash = [...verifiedLegacy]
    .sort((left, right) => right.modifiedMs - left.modifiedMs || sortText(left.hash, right.hash))[0]
    ?.hash ?? null;
  const legacyCandidates = verifiedLegacy.filter(({ hash }) => hash !== retainedLegacyHash);
  for (const candidate of legacyCandidates) {
    assertCurrentProcessOwnsApplicationLease({ cacheRoot, leaseId });
    const operationId = randomBytes(16).toString('hex');
    const retiredName = `${candidate.hash}--${operationId}`;
    const retiredRoot = path.join(trashRoot, retiredName);
    const journalPath = writeApplicationOperation({
      operationsRoot,
      operation: {
        schemaVersion: APPLICATION_SCHEMA_VERSION,
        owner: 'oneclick-subtitles-generator',
        kind: 'retire-legacy',
        operationId,
        applicationHash: candidate.hash,
        sourceLeaf: candidate.hash,
        trashLeaf: retiredName,
        manifestLeaf: `${candidate.hash}.json`,
      },
    });
    fs.renameSync(candidate.applicationRoot, retiredRoot);
    removeJournalAuthorizedTree(retiredRoot, 'journal-authorized legacy E2E application retirement');
    fs.rmSync(candidate.manifestPath, { force: false });
    fs.rmSync(journalPath, { force: false });
  }

  const preferredPrevious = verified.some(({ hash }) => hash === previousHash)
    ? previousHash
    : [...verified].sort((left, right) => right.modifiedMs - left.modifiedMs)[0]?.hash ?? null;
  const candidates = verified.filter(({ hash }) => hash !== preferredPrevious);

  for (const candidate of candidates) {
    assertCurrentProcessOwnsApplicationLease({ cacheRoot, leaseId });
    const stillCurrent = readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cacheRoot });
    if (stillCurrent.applicationHash === candidate.hash) {
      throw new Error('application receipt changed during bounded retention');
    }
    const operationId = randomBytes(16).toString('hex');
    const retiredName = `${candidate.hash}--${operationId}`;
    const retiredRoot = path.join(trashRoot, retiredName);
    const journalPath = writeApplicationOperation({
      operationsRoot,
      operation: {
        schemaVersion: APPLICATION_SCHEMA_VERSION,
        owner: 'oneclick-subtitles-generator',
        kind: 'retire',
        operationId,
        applicationHash: candidate.hash,
        sourceLeaf: candidate.hash,
        trashLeaf: retiredName,
      },
    });
    fs.renameSync(candidate.applicationRoot, retiredRoot);
    removeJournalAuthorizedTree(retiredRoot, 'journal-authorized E2E application retirement');
    fs.rmSync(journalPath, { force: false });
  }
  return Object.freeze({
    currentHash: current.applicationHash,
    previousHash: preferredPrevious,
    removedHashes: candidates.map(({ hash }) => hash),
    retainedLegacyHash,
    removedLegacyHashes: legacyCandidates.map(({ hash }) => hash),
  });
};

/**
 * Publish one Cargo profile as an immutable, content-addressed E2E application.
 *
 * The cache root is always explicit and absolute. Build output and cache may not overlap, and only
 * osg-desktop.exe plus the three reviewed resource directories cross this boundary.
 */
const publishE2eApplication = ({
  profileRoot,
  applicationsCacheRoot,
  sourceProvenance,
  retentionLeaseId = null,
  failAt = null,
  afterCopy = null,
}) => {
  const source = normalizeSourceProvenance(sourceProvenance);
  const profile = collectCargoProfileApplication(profileRoot);
  const cache = resolveAbsoluteInput(applicationsCacheRoot, 'E2E applications cache root');
  if (
    pathsOverlap(profile.root, cache, 'Cargo profile/application cache overlap check')
  ) {
    throw new Error('Cargo profile root and E2E applications cache root must not overlap');
  }
  assertNotRedirected(cache, 'E2E applications cache root');
  const managedMutation = authorizeManagedApplicationMutation({
    cacheRoot: cache,
    leaseId: retentionLeaseId,
  });
  const manifest = applicationManifestBytes({ ...profile, sourceProvenance: source });
  const applicationHash = manifestHash(manifest);
  const paths = publicationPaths(cache, applicationHash);
  createManagedDirectory(paths.applicationsRoot, 'E2E applications directory');
  createManagedDirectory(paths.receiptsRoot, 'E2E application receipts directory');
  let operationsRoot = null;
  if (managedMutation) {
    recoverManagedReceiptTemporaries(paths.receiptsRoot);
    ensureApplicationTrash(cache);
    operationsRoot = recoverApplicationOperations({ cacheRoot: cache, leaseId: retentionLeaseId });
  }

  let previousHash = null;
  if (retentionLeaseId !== null && fs.existsSync(paths.receiptPath)) {
    try {
      previousHash = readAndVerifyE2eApplicationReceipt({ applicationsCacheRoot: cache }).applicationHash;
    } catch (error) {
      let legacyReceipt;
      try {
        legacyReceipt = JSON.parse(fs.readFileSync(paths.receiptPath, 'utf8'));
      } catch {
        throw error;
      }
      if (![1, 2].includes(legacyReceipt?.schemaVersion)) throw error;
      // Schema v1 stored its manifest outside the immutable tree. It cannot satisfy the v2 verifier,
      // but its exact application directory remains untouched while the new schema publishes beside it.
    }
  }

  let applicationCreated = false;
  if (fs.existsSync(paths.applicationRoot)) {
    verifyApplicationTree({
      applicationRoot: paths.applicationRoot,
      expectedHash: applicationHash,
      expectedManifestBytes: manifest,
    });
  } else {
    const operationId = managedMutation ? randomBytes(16).toString('hex') : null;
    const temporaryLeaf = managedMutation
      ? `.publish-${applicationHash}-${operationId}`
      : safeTemporaryLeaf(`.publish-${applicationHash}`);
    const temporary = path.join(paths.applicationsRoot, temporaryLeaf);
    const journalPath = managedMutation
      ? writeApplicationOperation({
        operationsRoot,
        operation: {
          schemaVersion: APPLICATION_SCHEMA_VERSION,
          owner: 'oneclick-subtitles-generator',
          kind: 'publish',
          operationId,
          temporaryLeaf,
        },
      })
      : null;
    try {
      copyApplicationTree(profile, temporary, manifest);
      verifyApplicationTree({
        applicationRoot: temporary,
        expectedHash: applicationHash,
        expectedManifestBytes: manifest,
      });
      if (afterCopy !== null) afterCopy();
      const sourceAfterCopy = collectCargoProfileApplication(profile.root);
      if (!applicationManifestBytes({ ...sourceAfterCopy, sourceProvenance: source }).equals(manifest)) {
        throw new Error('Cargo profile changed while its E2E application was being published');
      }
      if (failAt === 'before-application-commit') {
        throw new Error('injected interruption before application commit');
      }
      if (managedMutation) {
        assertCurrentProcessOwnsApplicationLease({ cacheRoot: cache, leaseId: retentionLeaseId });
      }
      try {
        fs.renameSync(temporary, paths.applicationRoot);
        applicationCreated = true;
      } catch (error) {
        if (!fs.existsSync(paths.applicationRoot)) throw error;
        verifyApplicationTree({
          applicationRoot: paths.applicationRoot,
          expectedHash: applicationHash,
          expectedManifestBytes: manifest,
        });
      }
    } finally {
      if (fs.existsSync(temporary)) {
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
      }
      if (journalPath !== null && fs.existsSync(journalPath)) {
        fs.rmSync(journalPath, { force: false });
      }
    }
  }

  const sourceBeforeReceipt = collectCargoProfileApplication(profile.root);
  if (!applicationManifestBytes({ ...sourceBeforeReceipt, sourceProvenance: source }).equals(manifest)) {
    throw new Error('Cargo profile changed before its E2E application receipt was published');
  }
  const receipt = applicationReceiptBytes({
    paths,
    applicationHash,
    files: profile.files,
    sourceProvenance: source,
  });
  let receiptChanged = true;
  if (fs.existsSync(paths.receiptPath)) {
    assertPublishedFile(paths.receiptPath, 'E2E application receipt');
    receiptChanged = !fs.readFileSync(paths.receiptPath).equals(receipt);
  }
  if (receiptChanged) {
    if (managedMutation) {
      assertCurrentProcessOwnsApplicationLease({ cacheRoot: cache, leaseId: retentionLeaseId });
    }
    replaceReceiptAtomically({
      destination: paths.receiptPath,
      bytes: receipt,
      failBeforeCommit: failAt === 'before-receipt-commit',
    });
  } else if (failAt === 'before-receipt-commit') {
    throw new Error('injected interruption before receipt commit');
  }

  const retention = retentionLeaseId === null
    ? null
    : retainBoundedE2eApplications({
      applicationsCacheRoot: cache,
      leaseId: retentionLeaseId,
      previousHash,
    });

  return Object.freeze({
    applicationHash,
    applicationRoot: paths.applicationRoot,
    binaryPath: path.join(paths.applicationRoot, APPLICATION_BINARY),
    manifestPath: paths.manifestPath,
    receiptPath: paths.receiptPath,
    fileCount: profile.files.length,
    totalBytes: profile.files.reduce((total, entry) => total + entry.size, 0),
    applicationCreated,
    receiptChanged,
    retention,
    sourceProvenance: source,
  });
};

/** Read the current receipt and prove its path, manifest, inventory, and every file digest. */
const readAndVerifyE2eApplicationReceipt = ({
  applicationsCacheRoot,
  receiptPath,
}) => {
  const cache = resolveAbsoluteInput(applicationsCacheRoot, 'E2E applications cache root');
  assertNotRedirected(cache, 'E2E applications cache root');
  const expectedReceiptPath = path.join(cache, 'receipts', 'current.json');
  const requestedReceiptPath = receiptPath === undefined
    ? expectedReceiptPath
    : resolveAbsoluteInput(receiptPath, 'E2E application receipt path');
  if (!samePath(requestedReceiptPath, expectedReceiptPath)) {
    throw new Error('E2E application receipt path does not match its applications cache root');
  }
  assertPublishedFile(requestedReceiptPath, 'E2E application receipt');
  const receiptBytes = fs.readFileSync(requestedReceiptPath);
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'));
  } catch (error) {
    throw new Error('E2E application receipt is not valid JSON', { cause: error });
  }
  if (
    receipt === null
    || typeof receipt !== 'object'
    || !HASH_PATTERN.test(receipt.applicationHash ?? '')
  ) {
    throw new Error('E2E application receipt has an invalid application hash');
  }
  const paths = publicationPaths(cache, receipt.applicationHash);
  assertPublishedFile(paths.manifestPath, 'immutable E2E application manifest');
  const manifest = fs.readFileSync(paths.manifestPath);
  if (manifestHash(manifest) !== receipt.applicationHash) {
    throw new Error('E2E application manifest path/hash mismatch');
  }
  const application = verifyApplicationTree({
    applicationRoot: paths.applicationRoot,
    expectedHash: receipt.applicationHash,
    expectedManifestBytes: manifest,
  });
  if (application.sourceProvenance === null) {
    throw new Error('E2E application receipt names a historical application without source provenance');
  }
  const expectedReceipt = applicationReceiptBytes({
    paths,
    applicationHash: receipt.applicationHash,
    files: application.files,
    sourceProvenance: application.sourceProvenance,
  });
  if (!receiptBytes.equals(expectedReceipt)) {
    throw new Error('E2E application receipt path/hash or inventory does not match its publication');
  }
  return Object.freeze({
    applicationHash: receipt.applicationHash,
    applicationRoot: paths.applicationRoot,
    binaryPath: path.join(paths.applicationRoot, APPLICATION_BINARY),
    manifestPath: paths.manifestPath,
    receiptPath: paths.receiptPath,
    fileCount: application.files.length,
    totalBytes: application.files.reduce((total, entry) => total + entry.size, 0),
    sourceProvenance: application.sourceProvenance,
  });
};

const parseCli = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      ![
        '--profile-root', '--applications-cache-root', '--repository-root',
      ].includes(name)
      || value === undefined
      || values.has(name)
    ) {
      throw new Error(
        'usage: e2e-application-publication.js '
        + '--profile-root ABSOLUTE --applications-cache-root ABSOLUTE --repository-root ABSOLUTE',
      );
    }
    values.set(name, value);
  }
  if (values.size !== 3) {
    throw new Error(
      'usage: e2e-application-publication.js '
      + '--profile-root ABSOLUTE --applications-cache-root ABSOLUTE --repository-root ABSOLUTE',
    );
  }
  return {
    profileRoot: values.get('--profile-root'),
    applicationsCacheRoot: values.get('--applications-cache-root'),
    sourceProvenance: readCleanGitSourceProvenance({
      repositoryRoot: resolveAbsoluteInput(values.get('--repository-root'), 'repository root'),
    }),
  };
};

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(publishE2eApplication(parseCli(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  APPLICATION_BINARY,
  APPLICATION_SCHEMA_VERSION,
  RESOURCE_DIRECTORIES,
  applicationManifestBytes,
  collectCargoProfileApplication,
  parseCli,
  publishE2eApplication,
  readAndVerifyE2eApplicationReceipt,
  retainBoundedE2eApplications,
  resolveAbsoluteInput,
};
