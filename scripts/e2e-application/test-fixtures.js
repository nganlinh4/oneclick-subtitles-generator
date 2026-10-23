'use strict';

// Cargo-profile, legacy-store, and managed-lease fixtures shared by the E2E application tests.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const {
  APPLICATION_BINARY,
  RESOURCE_DIRECTORIES,
  applicationManifestBytes,
  collectCargoProfileApplication,
  publishE2eApplication: publishApplicationWithoutTestProvenance,
} = require('../e2e-application-publication');
const { readCurrentWindowsProcessIdentity } = require('../windows-process-identity.js');

const TEST_SOURCE_PROVENANCE = Object.freeze({
  commit: '1'.repeat(40),
  tree: '2'.repeat(40),
  dirty: false,
});
const publishE2eApplication = (input) => publishApplicationWithoutTestProvenance({
  ...input,
  sourceProvenance: input.sourceProvenance ?? TEST_SOURCE_PROVENANCE,
});

const temporaryRoot = (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-e2e-application-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  return root;
};

const writeFile = (root, relative, bytes) => {
  const output = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bytes);
  return output;
};

const writeProfile = (root, marker = 'alpha') => {
  fs.mkdirSync(root, { recursive: true });
  writeFile(root, 'osg-desktop.exe', Buffer.from(`MZ-e2e-${marker}`));
  writeFile(root, 'ui-fonts/font.woff2', Buffer.from(`font-${marker}`));
  writeFile(root, 'workers/osg_asr_worker.py', Buffer.from(`worker-${marker}`));
  writeFile(root, 'licenses/LICENSE', Buffer.from(`license-${marker}`));
  writeFile(root, 'deps/never-publish.dll', Buffer.from(`ignored-${marker}`));
  writeFile(root, 'osg_desktop.pdb', Buffer.from(`ignored-pdb-${marker}`));
};

const writeLegacyApplication = ({ cache, profile }) => {
  const collected = collectCargoProfileApplication(profile);
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    hashAlgorithm: 'sha256',
    entrypoint: APPLICATION_BINARY,
    resourceDirectories: RESOURCE_DIRECTORIES,
    directories: collected.directories,
    files: collected.files.map(({ path: relative, size, sha256 }) => ({
      path: relative, size, sha256,
    })),
  }, null, 2)}\n`, 'utf8');
  const hash = createHash('sha256').update(manifest).digest('hex');
  const applicationRoot = path.join(cache, 'applications', hash);
  for (const relative of collected.directories) {
    fs.mkdirSync(path.join(applicationRoot, ...relative.split('/')), { recursive: true });
  }
  for (const entry of collected.files) {
    const output = path.join(applicationRoot, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(entry.source, output);
  }
  const manifestPath = path.join(cache, 'manifests', `${hash}.json`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, manifest);
  return { applicationRoot, hash, manifest, manifestPath };
};

const writeHistoricalV2Application = ({ cache, profile }) => {
  const collected = collectCargoProfileApplication(profile);
  const manifest = applicationManifestBytes(collected);
  const hash = createHash('sha256').update(manifest).digest('hex');
  const applicationRoot = path.join(cache, 'applications', hash);
  for (const relative of collected.directories) {
    fs.mkdirSync(path.join(applicationRoot, ...relative.split('/')), { recursive: true });
  }
  for (const entry of collected.files) {
    const output = path.join(applicationRoot, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(entry.source, output);
  }
  const manifestPath = path.join(applicationRoot, '.osg-application-manifest.json');
  fs.writeFileSync(manifestPath, manifest);
  const receiptPath = path.join(cache, 'receipts', 'current.json');
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    schemaVersion: 2,
    hashAlgorithm: 'sha256',
    applicationHash: hash,
    applicationRoot,
    binaryPath: path.join(applicationRoot, APPLICATION_BINARY),
    manifestPath,
    fileCount: collected.files.length,
    totalBytes: collected.files.reduce((total, entry) => total + entry.size, 0),
  }, null, 2)}\n`);
  return { applicationRoot, hash };
};

const writeManagedAppLease = (cache, leaseId = 'a'.repeat(32)) => {
  fs.mkdirSync(cache, { recursive: true });
  const rootId = 'b'.repeat(32);
  fs.writeFileSync(path.join(cache, '.osg-cache-entry.json'), `${JSON.stringify({
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId,
    lane: 'apps-e2e',
  })}\n`);
  fs.writeFileSync(path.join(cache, '.osg-cache-lease'), `${JSON.stringify({
    schemaVersion: 1,
    owner: 'oneclick-subtitles-generator',
    rootId,
    laneGroup: 'e2e',
    leaseId,
    processId: process.pid,
    processCreatedUtc: readCurrentWindowsProcessIdentity().processCreatedUtc,
  })}\n`);
  return leaseId;
};

const verbatimPath = (absolute) => (
  absolute.startsWith('\\\\')
    ? `\\\\?\\UNC\\${absolute.slice(2)}`
    : `\\\\?\\${absolute}`
);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const byteSnapshot = (root) => {
  if (!fs.existsSync(root)) return [];
  const entries = [];
  const visit = (directory) => {
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (child.isDirectory()) {
        entries.push([`${relative}/`, null]);
        visit(absolute);
      } else {
        entries.push([relative, fs.readFileSync(absolute).toString('hex')]);
      }
    }
  };
  visit(root);
  return entries;
};

module.exports = {
  TEST_SOURCE_PROVENANCE,
  byteSnapshot,
  publishE2eApplication,
  sleep,
  temporaryRoot,
  verbatimPath,
  writeFile,
  writeHistoricalV2Application,
  writeLegacyApplication,
  writeManagedAppLease,
  writeProfile,
};
