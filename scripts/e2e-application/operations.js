'use strict';

// Managed-cache lease ownership and the operation journal that makes every publish or retirement
// recoverable after a hard kill.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const { assertWindowsProcessIdentity } = require('../windows-process-identity.js');
const {
  APPLICATION_OPERATIONS,
  APPLICATION_OPERATIONS_MARKER,
  APPLICATION_SCHEMA_VERSION,
  APPLICATION_TRASH,
  HASH_PATTERN,
  OPERATION_ID_PATTERN,
} = require('./manifest');
const { assertNotRedirected, assertPublishedFile, assertRealDirectory } = require('../publication-paths');
const {
  assertOwnedPrivateTemporaryFile,
  parseExactJsonFile,
  writePrivateFileAtomically,
} = require('./private-files');

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

module.exports = {
  assertCurrentProcessOwnsApplicationLease,
  authorizeManagedApplicationMutation,
  recoverApplicationOperations,
  removeJournalAuthorizedTree,
  writeApplicationOperation,
};
