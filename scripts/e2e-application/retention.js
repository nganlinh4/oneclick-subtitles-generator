'use strict';

// Bounded retention: keep the current and one previous verified publication, retire everything
// else (including verified schema-v1 trees) through journal-authorized deletion.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const {
  APPLICATION_BINARY,
  APPLICATION_MANIFEST,
  APPLICATION_SCHEMA_VERSION,
  APPLICATION_TRASH,
  APPLICATION_TRASH_MARKER,
  HASH_ALGORITHM,
  HASH_PATTERN,
  RESOURCE_DIRECTORIES,
  collectPublishedApplication,
  manifestHash,
  sortText,
  verifyApplicationTree,
} = require('./manifest');
const {
  assertCurrentProcessOwnsApplicationLease,
  recoverApplicationOperations,
  removeJournalAuthorizedTree,
  writeApplicationOperation,
} = require('./operations');
const {
  assertNotRedirected,
  assertPublishedFile,
  assertRealDirectory,
  resolveAbsoluteInput,
  samePath,
} = require('../publication-paths');
const { parseExactJsonFile, writePrivateFile } = require('./private-files');
const { publicationPaths, readAndVerifyE2eApplicationReceipt } = require('./receipt');

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

module.exports = {
  ensureApplicationTrash,
  retainBoundedE2eApplications,
};
