'use strict';

// Content-addressed snapshot trees: inventory, manifest bytes and hash, exclusive copies, and the
// atomic/immutable file writes used for manifests and receipts.

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const { assertNotRedirected, assertRealDirectory } = require('../publication-paths');
const { HASH_ALGORITHM, SNAPSHOT_SCHEMA_VERSION } = require('./constants');

const toPortableRelative = (relative) => relative.split(path.sep).join('/');

const listTree = (root) => {
  assertRealDirectory(root, 'frontend source');
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
  assertRealDirectory(directory, 'frontend snapshot destination');
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
    assertNotRedirected(destination, 'frontend snapshot manifest');
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

module.exports = {
  atomicWrite,
  copyTree,
  createDirectoryStrict,
  installImmutableFile,
  listTree,
  manifestBytes,
  snapshotHash,
  verifySnapshot,
};
