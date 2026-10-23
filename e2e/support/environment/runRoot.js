// Disposable run roots: managed-staging authority, private layout, cache junctions and removal.

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';

import {
  DEVELOPMENT_CACHE_ROOT, E2E_STAGING_ROOT, ENGINE_PACKAGES_CACHE, NATIVE_TOOLS_CACHE,
} from './cacheRoots.js';
import { sameCanonicalPath, sameOrChildPath, sameResolvedPath } from './pathIdentity.js';

const require = createRequire(import.meta.url);
const { assertWindowsProcessIdentity } = require('../../../scripts/windows-process-identity.js');

const RUN_ROOT_AUTHORITY_FILE = '.osg-e2e-authority';
const RUN_ROOT_PARENT_FILE = '.osg-e2e-staging-parent';
const RUN_ROOT_STAGING_AUTHORITY_FILE = '.osg-e2e-staging-authority.json';
const RUN_ROOT_STAGING_AUTHORITY_SCHEMA_VERSION = 1;
const RUN_ROOT_AUTHORITY_PATTERN = /^[0-9a-f]{64}$/u;
const CACHE_LEASE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const RUN_ROOT_CACHE_POLICY_FILE = '.osg-e2e-cache-policy.json';
const RUN_ROOT_CACHE_POLICY_SCHEMA_VERSION = 1;
const RUN_ROOT_CHILDREN = Object.freeze([
  'data', 'cache', 'logs', 'webview', 'evidence', 'input', 'output',
]);

const readPrivateJson = (path, label) => {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error(`${label} is not one private regular file`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
};

const managedStagingAuthority = ({ root, requireLiveOwner }) => {
  const authority = readPrivateJson(
    join(root, RUN_ROOT_STAGING_AUTHORITY_FILE),
    'the isolated run staging authority',
  );
  const expectedKeys = authority?.managed
    ? 'cacheRoot|leaseId|leaseOwnerProcessCreatedUtc|leaseOwnerProcessId|managed|owner|rootId|schemaVersion|stagingRoot'
    : 'managed|schemaVersion|stagingRoot';
  if (
    authority === null
    || typeof authority !== 'object'
    || typeof authority.managed !== 'boolean'
    || Object.keys(authority).sort().join('|') !== expectedKeys
    || authority.schemaVersion !== RUN_ROOT_STAGING_AUTHORITY_SCHEMA_VERSION
  ) {
    throw new Error('the isolated run staging authority has an invalid schema');
  }
  const canonicalRoot = realpathSync.native(root);
  const canonicalParent = realpathSync.native(dirname(canonicalRoot));
  if (!sameCanonicalPath(authority.stagingRoot ?? '', canonicalParent)) {
    throw new Error('the isolated run staging authority changed its parent');
  }
  if (!authority.managed) {
    if (!process.env.NODE_TEST_CONTEXT || !sameOrChildPath(canonicalParent, tmpdir())) {
      throw new Error('a test-only staging authority escaped node:test');
    }
    return Object.freeze(authority);
  }
  if (
    authority.owner !== 'oneclick-subtitles-generator'
    || !CACHE_LEASE_ID_PATTERN.test(authority.rootId ?? '')
    || !CACHE_LEASE_ID_PATTERN.test(authority.leaseId ?? '')
    || !Number.isSafeInteger(authority.leaseOwnerProcessId)
    || authority.leaseOwnerProcessId < 1
    || typeof authority.leaseOwnerProcessCreatedUtc !== 'string'
    || Number.isNaN(Date.parse(authority.leaseOwnerProcessCreatedUtc))
    || !sameCanonicalPath(realpathSync.native(authority.cacheRoot), realpathSync.native(DEVELOPMENT_CACHE_ROOT))
    || !sameCanonicalPath(realpathSync.native(authority.stagingRoot), realpathSync.native(E2E_STAGING_ROOT))
  ) {
    throw new Error('the isolated run staging authority changed its managed cache identity');
  }
  const rootMarker = readPrivateJson(
    join(authority.cacheRoot, '.osg-development-cache.json'),
    'the managed development-cache root marker',
  );
  const entryMarker = readPrivateJson(
    join(authority.stagingRoot, '.osg-cache-entry.json'),
    'the managed staging entry marker',
  );
  const leaseMarker = readPrivateJson(
    join(authority.stagingRoot, '.osg-cache-lease'),
    'the managed staging lease marker',
  );
  if (
    rootMarker.schemaVersion !== 1
    || rootMarker.cacheKind !== 'development-cache'
    || rootMarker.owner !== authority.owner
    || rootMarker.rootId !== authority.rootId
    || entryMarker.schemaVersion !== 1
    || entryMarker.owner !== authority.owner
    || entryMarker.rootId !== authority.rootId
    || entryMarker.lane !== 'staging'
    || leaseMarker.schemaVersion !== 1
    || leaseMarker.owner !== authority.owner
    || leaseMarker.rootId !== authority.rootId
    || leaseMarker.laneGroup !== 'staging'
    || leaseMarker.leaseId !== authority.leaseId
    || leaseMarker.processId !== authority.leaseOwnerProcessId
    || leaseMarker.processCreatedUtc !== authority.leaseOwnerProcessCreatedUtc
  ) {
    throw new Error('the isolated run staging authority does not match the active managed lease');
  }
  if (requireLiveOwner) {
    try {
      assertWindowsProcessIdentity({
        processId: authority.leaseOwnerProcessId,
        processCreatedUtc: authority.leaseOwnerProcessCreatedUtc,
      });
    } catch (error) {
      throw new Error('the isolated run staging lease owner identity is stale or was reused', {
        cause: error,
      });
    }
  }
  return Object.freeze(authority);
};

const cachePolicyDigest = ({ authorization, keepNativeTools, keepEnginePackages }) => createHash(
  'sha256',
).update([
  authorization,
  keepNativeTools ? 'native-tools:1' : 'native-tools:0',
  keepEnginePackages ? 'engine-packages:1' : 'engine-packages:0',
].join('\n')).digest('hex');

const readRunRootCachePolicy = (root, authorization) => {
  const path = join(root, RUN_ROOT_CACHE_POLICY_FILE);
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error('the isolated run root cache policy is not one private regular file');
  }
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  if (
    policy === null
    || typeof policy !== 'object'
    || Object.keys(policy).sort().join('|')
      !== 'digest|keepEnginePackages|keepNativeTools|schemaVersion'
    || policy.schemaVersion !== RUN_ROOT_CACHE_POLICY_SCHEMA_VERSION
    || typeof policy.keepNativeTools !== 'boolean'
    || typeof policy.keepEnginePackages !== 'boolean'
    || policy.digest !== cachePolicyDigest({ authorization, ...policy })
  ) {
    throw new Error('the isolated run root cache policy is invalid or was changed after creation');
  }
  return Object.freeze({
    keepNativeTools: policy.keepNativeTools,
    keepEnginePackages: policy.keepEnginePackages,
  });
};

const hasSafeRunRootLayout = (root) => {
  try {
    if (typeof root !== 'string' || root.length === 0) return false;
    const rootStatus = lstatSync(root);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) return false;
    const canonicalRoot = realpathSync.native(root);
    const parentAuthorityPath = join(canonicalRoot, RUN_ROOT_PARENT_FILE);
    const parentAuthorityStatus = lstatSync(parentAuthorityPath);
    if (
      !parentAuthorityStatus.isFile()
      || parentAuthorityStatus.isSymbolicLink()
      || parentAuthorityStatus.nlink !== 1
    ) return false;
    const authorizedParent = readFileSync(parentAuthorityPath, 'utf8').trim();
    const canonicalParent = realpathSync.native(dirname(canonicalRoot));
    const managedStagingRoot = existsSync(E2E_STAGING_ROOT)
      ? realpathSync.native(E2E_STAGING_ROOT)
      : null;
    if (
      !sameCanonicalPath(authorizedParent, canonicalParent)
      || !basename(canonicalRoot).startsWith('osg-e2e-run-')
      || (
        !(managedStagingRoot !== null && sameCanonicalPath(canonicalParent, managedStagingRoot))
        && !(process.env.NODE_TEST_CONTEXT && sameOrChildPath(canonicalParent, tmpdir()))
      )
    ) {
      return false;
    }
    for (const child of RUN_ROOT_CHILDREN) {
      const path = join(canonicalRoot, child);
      const status = lstatSync(path);
      if (
        !status.isDirectory()
        || status.isSymbolicLink()
        || !sameCanonicalPath(realpathSync.native(path), path)
      ) {
        return false;
      }
    }
    const authorityPath = join(canonicalRoot, RUN_ROOT_AUTHORITY_FILE);
    const authorityStatus = lstatSync(authorityPath);
    if (
      !authorityStatus.isFile()
      || authorityStatus.isSymbolicLink()
      || authorityStatus.nlink !== 1
    ) {
      return false;
    }
    const authorization = readFileSync(authorityPath, 'utf8').trim();
    if (!RUN_ROOT_AUTHORITY_PATTERN.test(authorization)) return false;
    managedStagingAuthority({ root: canonicalRoot, requireLiveOwner: false });
    readRunRootCachePolicy(canonicalRoot, authorization);
    return true;
  } catch {
    return false;
  }
};

/**
 * A fresh, isolated root for one run, including the WebView2 profile.
 *
 * `OSG_E2E_DATA_ROOT` moves the database, cache and logs. It does NOT move WebView2's own profile,
 * which holds `localStorage` — and that is where this application keeps its recent-videos list and
 * its subtitle settings. Measured: eight "isolated" runs left no `EBWebView` directory in their
 * roots, and a run in a supposedly clean root displayed the developer's real recent YouTube videos.
 * Those runs were reading, and could have written, live user state.
 *
 * `WEBVIEW2_USER_DATA_FOLDER` is honoured here: setting it produced a `webview` directory inside the
 * isolated root while the live profile's modification time did not change.
 *
 * `keepNativeTools` junctions the persistent tool directory in. Everything else about the root stays
 * disposable: the database, the projects, the caches and the logs are all new every run.
 */
export const createRunRoot = ({
  keepNativeTools = true,
  keepEnginePackages = true,
  stagingLease = null,
  testStagingRoot = null,
} = {}) => {
  if (typeof keepNativeTools !== 'boolean' || typeof keepEnginePackages !== 'boolean') {
    throw new Error('the isolated run root cache policy accepts booleans only');
  }
  if ((stagingLease === null) === (testStagingRoot === null)) {
    throw new Error('an isolated run root requires exactly one managed staging lease or test root');
  }
  let parent;
  let stagingAuthority;
  if (stagingLease !== null) {
    if (
      typeof stagingLease !== 'object'
      || !CACHE_LEASE_ID_PATTERN.test(stagingLease.leaseId ?? '')
      || !sameResolvedPath(stagingLease.stagingRoot ?? '', E2E_STAGING_ROOT)
    ) {
      throw new Error('the isolated run root requires the exact active managed staging lease');
    }
    const rootMarker = readPrivateJson(
      join(DEVELOPMENT_CACHE_ROOT, '.osg-development-cache.json'),
      'the managed development-cache root marker',
    );
    const entryMarker = readPrivateJson(
      join(E2E_STAGING_ROOT, '.osg-cache-entry.json'),
      'the managed staging entry marker',
    );
    const marker = readPrivateJson(
      join(E2E_STAGING_ROOT, '.osg-cache-lease'),
      'the managed staging lease marker',
    );
    if (
      rootMarker.schemaVersion !== 1
      || rootMarker.cacheKind !== 'development-cache'
      || rootMarker.owner !== 'oneclick-subtitles-generator'
      || !CACHE_LEASE_ID_PATTERN.test(rootMarker.rootId ?? '')
      || entryMarker.schemaVersion !== 1
      || entryMarker.owner !== rootMarker.owner
      || entryMarker.rootId !== rootMarker.rootId
      || entryMarker.lane !== 'staging'
      || marker.schemaVersion !== 1
      || marker.leaseId !== stagingLease.leaseId
      || marker.owner !== rootMarker.owner
      || marker.rootId !== rootMarker.rootId
      || marker.laneGroup !== 'staging'
      || marker.processId !== process.pid
      || marker.processCreatedUtc !== stagingLease.leaseOwnerProcessCreatedUtc
    ) {
      throw new Error('the isolated run root staging lease is not active for this process');
    }
    try {
      assertWindowsProcessIdentity({
        processId: marker.processId,
        processCreatedUtc: marker.processCreatedUtc,
      });
    } catch (error) {
      throw new Error('the isolated run root staging owner identity is stale or was reused', {
        cause: error,
      });
    }
    parent = E2E_STAGING_ROOT;
    stagingAuthority = {
      schemaVersion: RUN_ROOT_STAGING_AUTHORITY_SCHEMA_VERSION,
      managed: true,
      owner: rootMarker.owner,
      rootId: rootMarker.rootId,
      cacheRoot: realpathSync.native(DEVELOPMENT_CACHE_ROOT),
      stagingRoot: realpathSync.native(E2E_STAGING_ROOT),
      leaseId: marker.leaseId,
      leaseOwnerProcessId: marker.processId,
      leaseOwnerProcessCreatedUtc: marker.processCreatedUtc,
    };
  } else {
    if (
      !process.env.NODE_TEST_CONTEXT
      || typeof testStagingRoot !== 'string'
      || !isAbsolute(testStagingRoot)
      || !sameOrChildPath(testStagingRoot, tmpdir())
    ) {
      throw new Error('the private run-root test boundary is unavailable outside node:test');
    }
    mkdirSync(testStagingRoot, { recursive: true });
    parent = testStagingRoot;
    stagingAuthority = {
      schemaVersion: RUN_ROOT_STAGING_AUTHORITY_SCHEMA_VERSION,
      managed: false,
      stagingRoot: realpathSync.native(testStagingRoot),
    };
  }
  const canonicalParent = realpathSync.native(parent);
  const root = mkdtempSync(join(canonicalParent, 'osg-e2e-run-'));
  for (const child of RUN_ROOT_CHILDREN) {
    mkdirSync(join(root, child), { recursive: true });
  }
  // A path is not authority to reuse a profile. The launcher that created this root also owns a
  // fresh secret, which must be passed explicitly to a worker or a reviewed multi-process scenario.
  // This prevents a stale OSG_E2E_DATA_ROOT in an ambient shell from selecting an earlier run.
  const authorization = randomBytes(32).toString('hex');
  writeFileSync(
    join(root, RUN_ROOT_AUTHORITY_FILE),
    authorization,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  writeFileSync(
    join(root, RUN_ROOT_PARENT_FILE),
    `${canonicalParent}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  writeFileSync(
    join(root, RUN_ROOT_STAGING_AUTHORITY_FILE),
    `${JSON.stringify(stagingAuthority, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  const policy = {
    schemaVersion: RUN_ROOT_CACHE_POLICY_SCHEMA_VERSION,
    keepNativeTools,
    keepEnginePackages,
    digest: cachePolicyDigest({ authorization, keepNativeTools, keepEnginePackages }),
  };
  writeFileSync(
    join(root, RUN_ROOT_CACHE_POLICY_FILE),
    `${JSON.stringify(policy, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  return root;
};

const attachPersistentCache = ({ root, name, cache, enabled }) => {
  const junction = join(root, 'data', name);
  let junctionStatus = lstatSync(junction, { throwIfNoEntry: false });
  if (!enabled) {
    // The application creates its store directory eagerly at boot, and this config runs again in
    // the WDIO worker after the launcher's service has already spawned the binary. An ordinary
    // directory is that disposable in-root store; only a link that could reach a shared persistent
    // cache violates the from-empty policy.
    if (junctionStatus !== undefined
      && (junctionStatus.isSymbolicLink() || !junctionStatus.isDirectory())) {
      throw new Error(`the isolated run root attached the disabled ${name} cache`);
    }
    return;
  }
  mkdirSync(cache, { recursive: true });
  if (junctionStatus === undefined) {
    // A junction rather than a copy: install receipts and multi-gigabyte engines must survive the
    // disposable database/profile that exercised them.
    symlinkSync(cache, junction, 'junction');
    junctionStatus = lstatSync(junction);
  }
  if (
    !junctionStatus.isSymbolicLink()
    || !sameCanonicalPath(realpathSync.native(junction), realpathSync.native(cache))
  ) {
    throw new Error(`the isolated run root ${name} cache junction has the wrong target`);
  }
};

/** Attach persistent assets only after the WDIO launcher holds the managed E2E cache lease. */
export const attachRunRootCaches = ({
  root,
  nativeToolsCache = NATIVE_TOOLS_CACHE,
  enginePackagesCache = ENGINE_PACKAGES_CACHE,
}) => {
  const authorization = runRootAuthorization(root);
  const policy = readRunRootCachePolicy(root, authorization);
  attachPersistentCache({
    root,
    name: 'native-tools',
    cache: nativeToolsCache,
    enabled: policy.keepNativeTools,
  });
  attachPersistentCache({
    root,
    name: 'engine-packages',
    cache: enginePackagesCache,
    enabled: policy.keepEnginePackages,
  });
  return policy;
};

export const runRootAuthorization = (root) => {
  if (!hasSafeRunRootLayout(root)) {
    throw new Error('the isolated run root does not have the required private temporary layout');
  }
  const value = readFileSync(join(root, RUN_ROOT_AUTHORITY_FILE), 'utf8').trim();
  if (!RUN_ROOT_AUTHORITY_PATTERN.test(value)) {
    throw new Error('the isolated run root has no valid reuse authority');
  }
  return value;
};

/**
 * Reify the managed staging lease that authorized this run root into the child environment.
 *
 * The native guard validates the same files again immediately before Tauri starts. Passing the
 * exact identities here is intentional: a path beneath the cache is not lease authority, and a
 * stale run-root marker must not become one after its owner dies or its staging lease is replaced.
 */
export const managedStagingEnvironment = (root) => {
  if (!hasSafeRunRootLayout(root)) {
    throw new Error('the isolated run root cannot supply managed staging authority');
  }
  const authority = managedStagingAuthority({ root, requireLiveOwner: true });
  if (!authority.managed) {
    throw new Error('a test-only staging root cannot launch the real automation binary');
  }
  return Object.freeze({
    OSG_E2E_CACHE_ROOT: authority.cacheRoot,
    OSG_E2E_CACHE_ROOT_ID: authority.rootId,
    OSG_E2E_STAGING_ROOT: authority.stagingRoot,
    OSG_E2E_STAGING_LEASE_ID: authority.leaseId,
    OSG_E2E_STAGING_LEASE_OWNER_PID: String(authority.leaseOwnerProcessId),
    OSG_E2E_STAGING_LEASE_OWNER_CREATED_UTC: authority.leaseOwnerProcessCreatedUtc,
  });
};

/**
 * Decide whether this process may reuse an already-created isolated profile.
 *
 * Ordinary launchers always create a new root. Reuse is limited to either a real WDIO IPC worker,
 * or a scenario runner that explicitly opts into cross-process persistence, and both must prove
 * possession of the root's independently-created 256-bit authority.
 */
export const canReuseRunRoot = ({ environment, workerProcess }) => {
  const root = environment.OSG_E2E_DATA_ROOT;
  const suppliedAuthority = environment.OSG_E2E_RUN_ROOT_AUTHORIZATION;
  const isAuthorizedRole = workerProcess
    ? typeof environment.WDIO_WORKER_ID === 'string' && environment.WDIO_WORKER_ID.length > 0
    : environment.OSG_E2E_REUSE_ROOT === '1';
  if (
    !isAuthorizedRole
    || typeof root !== 'string'
    || root.length === 0
    || !hasSafeRunRootLayout(root)
    || !RUN_ROOT_AUTHORITY_PATTERN.test(suppliedAuthority ?? '')
  ) {
    return false;
  }
  try {
    return runRootAuthorization(root) === suppliedAuthority;
  } catch {
    return false;
  }
};

export const removeRunRoot = (root, authorization) => {
  if (
    !RUN_ROOT_AUTHORITY_PATTERN.test(authorization ?? '')
    || !hasSafeRunRootLayout(root)
    || runRootAuthorization(root) !== authorization
  ) {
    throw new Error('refusing to remove an isolated run root without its exact private authority');
  }
  try {
    // The junction is removed, never followed: `rm -r` through a junction would delete the tools
    // every run and quietly reinstate the 110 MB download this cache exists to avoid.
    rmSync(join(root, 'data', 'native-tools'), { recursive: false, force: true });
  } catch {
    // Absent when the run did not junction it in.
  }
  try {
    rmSync(join(root, 'data', 'engine-packages'), { recursive: false, force: true });
  } catch {
    // Absent for the one from-empty engine-package scenario.
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // A locked log file is not a test failure; the temporary directory is disposable either way.
  }
};
