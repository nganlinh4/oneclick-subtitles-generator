#!/usr/bin/env node

// Publish a Cargo profile as an immutable, content-addressed E2E application and verify receipts.
// The store's building blocks live in scripts/e2e-application/.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { readCleanGitSourceProvenance } = require('./git-source-provenance.js');
const {
  APPLICATION_BINARY,
  APPLICATION_SCHEMA_VERSION,
  RESOURCE_DIRECTORIES,
  applicationManifestBytes,
  collectCargoProfileApplication,
  copyApplicationTree,
  manifestHash,
  normalizeSourceProvenance,
  readAndVerifyPublishedE2eApplication,
  verifyApplicationTree,
} = require('./e2e-application/manifest');
const {
  assertCurrentProcessOwnsApplicationLease,
  authorizeManagedApplicationMutation,
  recoverApplicationOperations,
  writeApplicationOperation,
} = require('./e2e-application/operations');
const {
  assertNotRedirected,
  assertPublishedFile,
  createManagedDirectory,
  pathsOverlap,
  resolveAbsoluteInput,
} = require('./publication-paths');
const { safeTemporaryLeaf } = require('./e2e-application/private-files');
const {
  applicationReceiptBytes,
  publicationPaths,
  readAndVerifyE2eApplicationReceipt,
  recoverManagedReceiptTemporaries,
  replaceReceiptAtomically,
} = require('./e2e-application/receipt');
const {
  ensureApplicationTrash,
  retainBoundedE2eApplications,
} = require('./e2e-application/retention');

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
  readAndVerifyPublishedE2eApplication,
  readAndVerifyE2eApplicationReceipt,
  retainBoundedE2eApplications,
  resolveAbsoluteInput,
};
