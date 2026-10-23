// Source (git) and application-binary provenance recorded in every attempt manifest.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { REPOSITORY_ROOT } from './paths.js';

const MAX_DIRTY_ENTRIES = 200;
const boundedGitState = () => {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  assert.match(commit, /^[0-9a-f]{40,64}$/i, 'workflow evidence requires an exact git commit');
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  assert.match(tree, /^[0-9a-f]{40,64}$/i, 'workflow evidence requires an exact git tree');
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  }).split(/\r?\n/).filter(Boolean);
  return {
    commit,
    tree,
    dirty: status.length > 0,
    dirtyEntries: status.slice(0, MAX_DIRTY_ENTRIES),
    dirtyEntriesTruncated: status.length > MAX_DIRTY_ENTRIES,
  };
};

const safeDerivativePath = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 260
  && !value.includes('\\')
  && !value.includes('\0')
  && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

const normalizeDerivativeIdentity = (value) => {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== 'sha256|size'
    || !Number.isSafeInteger(value.size)
    || value.size < 0
    || !/^[0-9a-f]{64}$/u.test(value.sha256 ?? '')
  ) return null;
  return Object.freeze({ size: value.size, sha256: value.sha256 });
};

export const normalizeApplicationDerivative = (value) => {
  if (value === undefined || value === null) return null;
  const validShape = (
    typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('|')
      !== 'baseApplicationHash|delta|directories|files|kind|treeSha256'
  );
  const directories = !validShape && Array.isArray(value.directories)
    && value.directories.length <= 64
    && value.directories.every(safeDerivativePath)
    && value.directories.every((path, index) => index === 0 || value.directories[index - 1] < path)
    ? [...value.directories]
    : null;
  const files = !validShape && Array.isArray(value.files) && value.files.length > 0
    && value.files.length <= 128
    ? value.files.map((entry) => {
      if (
        entry === null
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || Object.keys(entry).sort().join('|') !== 'path|sha256|size'
        || !safeDerivativePath(entry.path)
      ) return null;
      const identity = normalizeDerivativeIdentity({ size: entry.size, sha256: entry.sha256 });
      return identity === null ? null : Object.freeze({ path: entry.path, ...identity });
    })
    : [];
  const paths = files.map((entry) => entry?.path);
  const canonicalFiles = files.length === value.files?.length
    && files.every(Boolean)
    && paths.every((path, index) => index === 0 || paths[index - 1] < path);
  const delta = value?.delta;
  const base = normalizeDerivativeIdentity(delta?.base);
  const derived = delta?.derived === null ? null : normalizeDerivativeIdentity(delta?.derived);
  const deltaShape = delta !== null
    && typeof delta === 'object'
    && !Array.isArray(delta)
    && Object.keys(delta).sort().join('|') === 'base|change|derived|path'
    && ['changed', 'deleted'].includes(delta.change)
    && safeDerivativePath(delta.path)
    && delta.path.startsWith('ui-fonts/')
    && base !== null
    && ((delta.change === 'deleted' && delta.derived === null)
      || (delta.change === 'changed' && derived !== null
        && (derived.size !== base.size || derived.sha256 !== base.sha256)))
    && (delta.change === 'changed') === paths.includes(delta.path);
  const treeSha256 = canonicalFiles && directories !== null
    ? createHash('sha256').update(`${JSON.stringify({ directories, files })}\n`).digest('hex')
    : null;
  if (
    validShape
    || value.kind !== 'staged-damage'
    || !/^[0-9a-f]{64}$/u.test(value.baseApplicationHash ?? '')
    || !/^[0-9a-f]{64}$/u.test(value.treeSha256 ?? '')
    || !canonicalFiles
    || directories === null
    || !deltaShape
    || value.treeSha256 !== treeSha256
  ) {
    throw new Error('workflow evidence application derivative is invalid');
  }
  return Object.freeze({
    kind: value.kind,
    baseApplicationHash: value.baseApplicationHash,
    treeSha256: value.treeSha256,
    directories: Object.freeze(directories),
    files: Object.freeze(files),
    delta: Object.freeze({
      change: delta.change,
      path: delta.path,
      base,
      derived,
    }),
  });
};

export const collectEvidenceProvenance = ({
  applicationDerivative = null,
  applicationHash = null,
  binaryPath,
  requireBinary = true,
}) => {
  assert.equal(typeof binaryPath, 'string', 'workflow evidence requires the E2E binary path');
  assert.ok(
    applicationHash === null || /^[0-9a-f]{64}$/u.test(applicationHash),
    'workflow evidence application hash must be an exact SHA-256 or null',
  );
  const derivative = normalizeApplicationDerivative(applicationDerivative);
  assert.ok(
    derivative === null || derivative.baseApplicationHash === applicationHash,
    'workflow evidence derivative must name the exact base application hash',
  );
  const path = resolve(binaryPath);
  if (!existsSync(path)) {
    assert.equal(requireBinary, false, `workflow evidence binary does not exist: ${path}`);
    return {
      applicationHash,
      applicationDerivative: derivative,
      source: boundedGitState(),
      binary: { path, exists: false, sha256: null, size: null },
    };
  }
  const bytes = readFileSync(path);
  return {
    applicationHash,
    applicationDerivative: derivative,
    source: boundedGitState(),
    binary: {
      path,
      exists: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    },
  };
};
