// Staged application copies: their markers and the unredirected-tree proof a staged binary needs.

import {
  existsSync, lstatSync, readFileSync, realpathSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

import { E2E_APPLICATIONS_CACHE_ROOT, E2E_STAGING_ROOT } from './cacheRoots.js';
import {
  hasTraversalSegment, sameCanonicalPath, sameOrChildPath, sameResolvedPath,
} from './pathIdentity.js';

const STAGED_APPLICATION_MARKER = '.osg-e2e-staged-application.json';
const STAGED_APPLICATION_PARENT_MARKER = '.osg-e2e-staging-parent';
const STAGED_APPLICATION_SCHEMA_VERSION = 1;
const APPLICATION_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const STAGED_APPLICATION_ROOT_PATTERN = /^osg-e2e-app-/u;
const assertRealUnredirectedTree = (root) => {
  const canonicalRoot = realpathSync.native(root);
  const canonicalParent = realpathSync.native(dirname(canonicalRoot));
  const managedStagingRoot = existsSync(E2E_STAGING_ROOT)
    ? realpathSync.native(E2E_STAGING_ROOT)
    : null;
  let stagedParent;
  try {
    stagedParent = readFileSync(join(canonicalRoot, STAGED_APPLICATION_PARENT_MARKER), 'utf8').trim();
  } catch (error) {
    throw new Error('OSG_E2E_BINARY is not inside a direct private staged-application root', {
      cause: error,
    });
  }
  if (
    !sameCanonicalPath(stagedParent, canonicalParent)
    || (
      !(managedStagingRoot !== null && sameCanonicalPath(canonicalParent, managedStagingRoot))
      && !(process.env.NODE_TEST_CONTEXT && sameOrChildPath(canonicalParent, tmpdir()))
    )
    || !STAGED_APPLICATION_ROOT_PATTERN.test(basename(canonicalRoot))
  ) {
    throw new Error('OSG_E2E_BINARY is not inside a direct private staged-application root');
  }
  const pending = [canonicalRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    const directoryStatus = lstatSync(directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
      throw new Error(`The staged E2E application contains a redirected directory: ${directory}`);
    }
    if (!sameResolvedPath(realpathSync.native(directory), directory)) {
      throw new Error(`The staged E2E application crosses a redirected directory: ${directory}`);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const status = lstatSync(path);
      if (entry.isSymbolicLink() || status.isSymbolicLink()) {
        throw new Error(`The staged E2E application contains a link or reparse point: ${path}`);
      }
      if (!sameResolvedPath(realpathSync.native(path), path)) {
        throw new Error(`The staged E2E application contains a redirected entry: ${path}`);
      }
      if (entry.isDirectory() && status.isDirectory()) pending.push(path);
      else if (!entry.isFile() || !status.isFile() || status.nlink !== 1) {
        throw new Error(`The staged E2E application contains an unsafe entry: ${path}`);
      }
    }
  }
};

export const writeStagedApplicationParentMarker = ({ stagedRoot, stagingParent }) => {
  writeFileSync(
    join(stagedRoot, STAGED_APPLICATION_PARENT_MARKER),
    `${realpathSync.native(stagingParent)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
};

/** Prove an explicit override was created by stageApplication(), never selected from a build tree. */
export const assertStagedApplicationBinary = (binary) => {
  if (
    typeof binary !== 'string'
    || !isAbsolute(binary)
    || hasTraversalSegment(binary)
    || basename(binary).toLowerCase() !== 'osg-desktop.exe'
  ) {
    throw new Error('OSG_E2E_BINARY must name the staged osg-desktop.exe by an absolute safe path');
  }
  const root = dirname(resolve(binary));
  assertRealUnredirectedTree(root);
  const markerPath = join(root, STAGED_APPLICATION_MARKER);
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch (error) {
    throw new Error('OSG_E2E_BINARY has no valid staged-application authority marker', {
      cause: error,
    });
  }
  if (
    marker === null
    || typeof marker !== 'object'
    || Object.keys(marker).sort().join('|')
      !== 'applicationHash|entrypoint|schemaVersion|sourceApplicationRoot'
    || marker.schemaVersion !== STAGED_APPLICATION_SCHEMA_VERSION
    || marker.entrypoint !== 'osg-desktop.exe'
    || !APPLICATION_HASH_PATTERN.test(marker.applicationHash ?? '')
    || typeof marker.sourceApplicationRoot !== 'string'
    || !isAbsolute(marker.sourceApplicationRoot)
    || !sameResolvedPath(
      marker.sourceApplicationRoot,
      join(E2E_APPLICATIONS_CACHE_ROOT, 'applications', marker.applicationHash ?? 'invalid'),
    )
  ) {
    throw new Error('OSG_E2E_BINARY has an invalid staged-application authority marker');
  }
  const binaryStatus = lstatSync(binary);
  if (!binaryStatus.isFile() || binaryStatus.isSymbolicLink() || binaryStatus.nlink !== 1) {
    throw new Error('OSG_E2E_BINARY is not a private regular staged file');
  }
  return Object.freeze({ binary: resolve(binary), root, marker });
};

export const writeStagedApplicationMarker = ({ stagedRoot, publication }) => {
  writeFileSync(join(stagedRoot, STAGED_APPLICATION_MARKER), `${JSON.stringify({
    schemaVersion: STAGED_APPLICATION_SCHEMA_VERSION,
    applicationHash: publication.applicationHash,
    sourceApplicationRoot: publication.applicationRoot,
    entrypoint: 'osg-desktop.exe',
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
};
