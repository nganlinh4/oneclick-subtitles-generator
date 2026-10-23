'use strict';

// Caller-path validation shared by the E2E frontend and application publishers: no traversal,
// Windows namespace or trailing-dot spellings, redirected ancestors, links, or overlapping roots.

const fs = require('node:fs');
const path = require('node:path');

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

module.exports = {
  assertNotRedirected,
  assertPublishedFile,
  assertRealDirectory,
  assertRealFile,
  checkedRelativePath,
  createManagedDirectory,
  isWithin,
  pathsOverlap,
  resolveAbsoluteInput,
  samePath,
};
