'use strict';

// The content-addressed application inventory: what a Cargo profile contributes, the manifest bytes
// whose hash names a publication, and verification of a published tree against them.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const {
  assertPublishedFile,
  assertRealDirectory,
  assertRealFile,
  checkedRelativePath,
  resolveAbsoluteInput,
  samePath,
} = require('../publication-paths');
const { writePrivateFile } = require('./private-files');

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

/**
 * Verify one retained content-addressed application without consulting the mutable current receipt.
 * This is the read-only trust boundary used by inventory/evidence audits.
 */
const readAndVerifyPublishedE2eApplication = ({ applicationsRoot, applicationHash }) => {
  const root = resolveAbsoluteInput(applicationsRoot, 'E2E applications directory');
  if (!HASH_PATTERN.test(applicationHash)) throw new Error('E2E application hash is invalid');
  assertRealDirectory(root, 'E2E applications directory');
  const applicationRoot = path.join(root, applicationHash);
  assertRealDirectory(applicationRoot, `immutable E2E application ${applicationHash}`);
  if (!samePath(path.dirname(applicationRoot), root)) {
    throw new Error(`immutable E2E application escaped its store: ${applicationHash}`);
  }
  const manifestPath = path.join(applicationRoot, APPLICATION_MANIFEST);
  assertPublishedFile(manifestPath, 'immutable E2E application manifest');
  const manifest = fs.readFileSync(manifestPath);
  if (manifestHash(manifest) !== applicationHash) {
    throw new Error(`immutable E2E application manifest hash mismatch: ${applicationHash}`);
  }
  const application = verifyApplicationTree({
    applicationRoot,
    expectedHash: applicationHash,
    expectedManifestBytes: manifest,
  });
  const binary = application.files.find(({ path: relative }) => relative === APPLICATION_BINARY);
  if (binary === undefined) {
    throw new Error(`immutable E2E application has no entrypoint: ${applicationHash}`);
  }
  return Object.freeze({
    applicationHash,
    applicationRoot,
    manifestPath,
    binarySha256: binary.sha256,
    sourceProvenance: application.sourceProvenance,
  });
};

module.exports = {
  APPLICATION_BINARY,
  APPLICATION_MANIFEST,
  APPLICATION_OPERATIONS,
  APPLICATION_OPERATIONS_MARKER,
  APPLICATION_SCHEMA_VERSION,
  APPLICATION_TRASH,
  APPLICATION_TRASH_MARKER,
  HASH_ALGORITHM,
  HASH_PATTERN,
  OPERATION_ID_PATTERN,
  RESOURCE_DIRECTORIES,
  applicationManifestBytes,
  collectCargoProfileApplication,
  collectPublishedApplication,
  copyApplicationTree,
  manifestHash,
  normalizeSourceProvenance,
  readAndVerifyPublishedE2eApplication,
  sortText,
  verifyApplicationTree,
};
