'use strict';

// The mutable current receipt: its atomic replacement, orphan recovery, and full verification
// against the immutable publication it names.

const fs = require('node:fs');
const path = require('node:path');

const {
  APPLICATION_BINARY,
  APPLICATION_MANIFEST,
  APPLICATION_SCHEMA_VERSION,
  HASH_ALGORITHM,
  HASH_PATTERN,
  manifestHash,
  normalizeSourceProvenance,
  verifyApplicationTree,
} = require('./manifest');
const {
  assertNotRedirected,
  assertPublishedFile,
  resolveAbsoluteInput,
  samePath,
} = require('../publication-paths');
const {
  assertOwnedPrivateTemporaryFile,
  safeTemporaryLeaf,
  waitBriefly,
  writePrivateFile,
} = require('./private-files');

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

module.exports = {
  applicationReceiptBytes,
  publicationPaths,
  readAndVerifyE2eApplicationReceipt,
  recoverManagedReceiptTemporaries,
  replaceReceiptAtomically,
};
