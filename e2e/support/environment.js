// Where a journey runs, and what it is allowed to touch.
//
// Every run gets its own data root. That is not tidiness: the application resolves its data
// directory through SHGetKnownFolderPath, so a run without an explicit root writes into the
// developer's real projects — 17 of them on the machine this was written on. The root is passed
// through OSG_E2E_DATA_ROOT, which exists only in the `unsigned-local-build` channel.

import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path';
import process from 'node:process';

import { resolveDevelopmentCacheRoot as resolveDevelopmentCacheRootPure } from './developmentCacheRoot.js';

export { scrubAutomationEnvironment } from './automationEnvironment.js';

const require = createRequire(import.meta.url);
const { readAndVerifyE2eApplicationReceipt } = require(
  '../../scripts/e2e-application-publication.js'
);
const { readCleanGitSourceProvenance } = require('../../scripts/git-source-provenance.js');
const { assertWindowsProcessIdentity } = require('../../scripts/windows-process-identity.js');

export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');

const UNPUBLISHED_APPLICATION_DIRECTORY = '.unpublished';
const STAGED_APPLICATION_MARKER = '.osg-e2e-staged-application.json';
const STAGED_APPLICATION_PARENT_MARKER = '.osg-e2e-staging-parent';
const STAGED_APPLICATION_SCHEMA_VERSION = 1;
const APPLICATION_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const STAGED_APPLICATION_ROOT_PATTERN = /^osg-e2e-app-/u;
const sameCanonicalPath = (left, right) => (
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
);

const hasTraversalSegment = (input) => String(input)
  .split(/[\\/]+/u)
  .some((segment) => segment === '.' || segment === '..');

const sameResolvedPath = (left, right) => sameCanonicalPath(resolve(left), resolve(right));

const sameOrChildPath = (candidate, parent) => {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return pathFromParent === '' || (
    pathFromParent !== '..'
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent)
  );
};

export const resolveDevelopmentCacheRoot = (options = {}) => resolveDevelopmentCacheRootPure({
  ...options,
  repositoryRoot: options.repositoryRoot ?? REPOSITORY_ROOT,
});
export const DEVELOPMENT_CACHE_ROOT = resolveDevelopmentCacheRoot();
export const E2E_APPLICATIONS_CACHE_ROOT = join(DEVELOPMENT_CACHE_ROOT, 'apps', 'e2e');
export const E2E_ASSET_CACHE_ROOT = join(DEVELOPMENT_CACHE_ROOT, 'assets', 'e2e');
export const EVIDENCE_CACHE_ROOT = join(DEVELOPMENT_CACHE_ROOT, 'evidence');
export const E2E_STAGING_ROOT = join(DEVELOPMENT_CACHE_ROOT, 'staging');

/** Re-hash the receipt, manifest, exact inventory, and every application file. */
export const readVerifiedPublishedApplication = () => readAndVerifyE2eApplicationReceipt({
  applicationsCacheRoot: E2E_APPLICATIONS_CACHE_ROOT,
});

export const assertPublicationMatchesCurrentSource = (publication, currentSource) => {
  const source = publication?.sourceProvenance;
  if (
    source?.dirty !== false
    || currentSource?.dirty !== false
    || source.commit !== currentSource.commit
    || source.tree !== currentSource.tree
  ) {
    throw new Error(
      'The verified E2E application publication does not match the current clean source commit/tree',
    );
  }
  return publication;
};

/** Verify the immutable publication and prove it was built from this exact clean checkout. */
export const readVerifiedCurrentPublishedApplication = () => assertPublicationMatchesCurrentSource(
  readVerifiedPublishedApplication(),
  readCleanGitSourceProvenance({ repositoryRoot: REPOSITORY_ROOT }),
);

const currentReceiptPath = join(E2E_APPLICATIONS_CACHE_ROOT, 'receipts', 'current.json');
// Module import is not launch authority. Source-contract tests and discovery commands must remain
// usable while a build has not been published yet, and while an old or interrupted publication is
// waiting to be replaced. Preserve the verified path convenience for a valid receipt, but soften
// every absent/corrupt/historical receipt to a deliberately nonexistent sentinel. The actual launch
// path calls readVerifiedPublishedApplication() again and still fails closed before WebDriver starts.
let publicationAtModuleLoad = null;
if (existsSync(currentReceiptPath)) {
  try {
    publicationAtModuleLoad = readVerifiedPublishedApplication();
  } catch {
    publicationAtModuleLoad = null;
  }
}

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
 * Reviewed SUBTITLE fixtures a journey may hand to the application.
 *
 * Subtitle files only. There are no media fixtures any more: a journey that wants video downloads a
 * real one from a real URL, because a synthetic colour-bars clip proved the decoder could open a
 * synthetic colour-bars clip and nothing about what a customer actually plays. See `realMedia.js`.
 */
export const FIXTURE_ROOT = join(REPOSITORY_ROOT, 'e2e', 'fixtures', 'subtitles');

/**
 * Where the optional native tools live BETWEEN runs.
 *
 * FFmpeg, yt-dlp and Deno are downloaded from the reviewed delivery catalog on first use, and FFmpeg
 * alone is 110 MB. A customer installs them once and keeps them; re-downloading them for every
 * journey would be testing the installer over and over instead of testing the workflow, and would
 * put a third of a gigabyte of network traffic between a code change and its answer.
 *
 * So the directory is real, persistent, and OUTSIDE the disposable run root — junctioned in, rather
 * than provided by a new environment variable, because the application must keep resolving its tools
 * exactly where it resolves them for a customer. `nativeToolsInstall.journey.js` is the one that
 * starts from empty and proves the install itself.
 */
export const NATIVE_TOOLS_CACHE = join(E2E_ASSET_CACHE_ROOT, 'native-tools');

/**
 * Heavy local AI packages retained between isolated journeys.
 *
 * Faster-Whisper Turbo is a 4.56 GiB download and 6.73 GiB installed. Re-downloading it for every
 * clean database would test bandwidth rather than the customer workflow. The package store is
 * junctioned into an otherwise disposable root, exactly like a customer keeps an installed engine
 * while opening and closing projects. `nativeEngineInstall` owns the from-empty proof.
 */
export const ENGINE_PACKAGES_CACHE = join(E2E_ASSET_CACHE_ROOT, 'engine-packages');

/**
 * Where a real downloaded video is kept between runs. This cache is input-only; every journey
 * copies its selected media into its disposable run root and writes exports elsewhere in that root.
 *
 * The managed cache lease creates the owned asset lane before this child is used. The application
 * canonicalizes staged paths, so workflow setup creates this exact child before handing any path to
 * the application; a missing directory must remain a typed automation refusal, never a dialog.
 */
export const REAL_MEDIA_CACHE = join(E2E_ASSET_CACHE_ROOT, 'real-media');

/**
 * A second, visibly different real video used only by the main-preview source-switch journey.
 * Kept out of `REAL_MEDIA_CACHE` so newest-file discovery can never make unrelated journeys select
 * it instead of their reviewed YouTube source.
 */
export const SOURCE_SWITCH_MEDIA_CACHE = join(
  E2E_ASSET_CACHE_ROOT,
  'source-switch-media',
);

/** Offline-generated long-form speech/video used by the four-window ASR journey. */
export const FOUR_WINDOW_ASR_MEDIA_CACHE = join(E2E_ASSET_CACHE_ROOT, 'four-window-asr-media');

/**
 * Offline-generated, tiny-bitrate, hours-long synthetic media used by the long-media
 * resource-bound journey and its relaunch-recovery scenario. Long in TIME, not on disk: see
 * longSyntheticMediaFixture.js for the exact recipe and why duration (not bitrate) is what has
 * to be real here.
 */
export const LONG_SYNTHETIC_MEDIA_CACHE = join(E2E_ASSET_CACHE_ROOT, 'long-synthetic-media');

/**
 * The verified immutable application selected by the current external-cache receipt.
 *
 * A missing, corrupt, or historical receipt gets a deliberately nonexistent EXTERNAL sentinel so
 * source-only tests can still import this module. assertAutomationDialogGuard() resolves the
 * receipt again and refuses before WebDriver starts.
 */
export const BUILT_APPLICATION_DIRECTORY = publicationAtModuleLoad?.applicationRoot
  ?? join(E2E_APPLICATIONS_CACHE_ROOT, UNPUBLISHED_APPLICATION_DIRECTORY);

// A from-empty managed ASR install downloads and verifies 4.56 GiB before inference begins. The
// journey owns tighter per-step timeouts; this outer Mocha cap must not kill that valid operation.
export const JOURNEY_TIMEOUT_MS = 3 * 60 * 60 * 1_000;

/**
 * The binary under test. The E2E channel, never a production build.
 *
 * `OSG_E2E_BINARY` points the harness at a STAGED copy instead. That exists so a journey can damage
 * what the application ships -- a corrupt font resource, a missing one -- without touching the build
 * output every other journey depends on. The staged copy is a real installation layout, so the
 * application resolves its resources exactly as it does in the built one.
 */
const stagedApplicationOverride = process.env.OSG_E2E_BINARY;
if (stagedApplicationOverride !== undefined) assertStagedApplicationBinary(stagedApplicationOverride);
export const APPLICATION_BINARY = stagedApplicationOverride
  ?? publicationAtModuleLoad?.binaryPath
  ?? join(BUILT_APPLICATION_DIRECTORY, 'osg-desktop.exe');

const assertApplicationLaunchSource = (binary) => {
  if (!sameResolvedPath(binary, APPLICATION_BINARY)) return;
  if (stagedApplicationOverride !== undefined) {
    assertStagedApplicationBinary(binary);
    return;
  }
  const current = readVerifiedCurrentPublishedApplication();
  if (
    !sameResolvedPath(current.binaryPath, binary)
    || publicationAtModuleLoad?.applicationHash !== current.applicationHash
  ) {
    throw new Error(
      'The immutable E2E application receipt changed after the harness selected its binary',
    );
  }
};

// Compiled into dialog_paths.rs only when `e2e-automation` is enabled. Checking this before WDIO
// launches the executable prevents a production build at the same Cargo output path from silently
// restoring native picker/save dialogs. That mix-up is especially hazardous because an unattended
// dialog can sit behind the application indefinitely and make the machine appear stuck.
export const AUTOMATION_DIALOG_GUARD = Buffer.from(
  'The automation build refused an unstaged native file dialog.',
  'utf8',
);
export const AUTOMATION_WINDOW_GUARD = Buffer.from(
  'The automation build requires a non-focusable off-screen native window.',
  'utf8',
);
export const AUTOMATION_ENVIRONMENT_GUARD = Buffer.from(
  'the automation build refused an unsafe harness environment:',
  'utf8',
);
export const AUTOMATION_AUDIO_GUARD = Buffer.from('--mute-audio', 'utf8');
export const AUTOMATION_INTERACTION_GUARD = Buffer.from(
  'The automation build refused an interactive desktop surface.',
  'utf8',
);
export const AUTOMATION_WEBDRIVER_GUARD = Buffer.from(
  'The OSG automation WebDriver refuses native-window mutation and unidentified sessions.',
  'utf8',
);

export const assertAutomationDialogGuard = (binary) => {
  // The WebDriver configuration is contract-tested to pass APPLICATION_BINARY here before its
  // service can spawn anything. Re-read and re-hash the current immutable publication at that last
  // responsible moment; importing a path from a once-valid receipt is not launch authority.
  assertApplicationLaunchSource(binary);
  let bytes;
  try {
    bytes = readFileSync(binary);
  } catch (error) {
    throw new Error(`The E2E binary is unavailable: ${binary}`, { cause: error });
  }
  if (!bytes.includes(AUTOMATION_DIALOG_GUARD)) {
    throw new Error(
      `Refusing to launch ${binary}: it does not contain the compile-time automation dialog guard. `
      + 'Rebuild with --features e2e-automation; a production binary may open File Explorer.',
    );
  }
  if (!bytes.includes(AUTOMATION_WINDOW_GUARD)) {
    throw new Error(
      `Refusing to launch ${binary}: it does not contain the compile-time off-screen window guard. `
      + 'Rebuild the current source with --features e2e-automation; an older automation binary may enter the interactive desktop.',
    );
  }
  if (!bytes.includes(AUTOMATION_ENVIRONMENT_GUARD)) {
    throw new Error(
      `Refusing to launch ${binary}: it does not contain the compile-time isolated-profile preflight. `
      + 'Rebuild the current source with --features e2e-automation; a test binary must fail closed before resolving application data.',
    );
  }
  if (!bytes.includes(AUTOMATION_AUDIO_GUARD)) {
    throw new Error(
      `Refusing to launch ${binary}: it does not contain the compile-time automation audio guard. `
      + 'Rebuild the current source with --features e2e-automation; an older test binary may emit sound.',
    );
  }
  if (!bytes.includes(AUTOMATION_INTERACTION_GUARD)) {
    throw new Error(
      `Refusing to launch ${binary}: it does not contain the compile-time automation interaction guard. `
      + 'Rebuild the current source with --features e2e-automation; an older test binary may open an OS surface.',
    );
  }
  if (!bytes.includes(AUTOMATION_WEBDRIVER_GUARD)) {
    throw new Error(
      `Refusing to launch ${binary}: it does not contain the guarded WebDriver server. `
      + 'Rebuild the current source with --features e2e-automation; the registry server can move or fullscreen the native window.',
    );
  }
  const peOffset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
  const optionalHeader = peOffset + 24;
  const subsystemOffset = optionalHeader + 68;
  const isWindowsGui = bytes.subarray(0, 2).equals(Buffer.from('MZ'))
    && peOffset >= 64
    && bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))
    && subsystemOffset + 2 <= bytes.length
    && [0x10b, 0x20b].includes(bytes.readUInt16LE(optionalHeader))
    && bytes.readUInt16LE(subsystemOffset) === 2;
  if (!isWindowsGui) {
    throw new Error(
      `Refusing to launch ${binary}: it is not a Windows GUI-subsystem executable. `
      + 'The GUI subsystem is required independently of the patched launcher\'s windowsHide guard.',
    );
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

export const stagedDialogPaths = (root, cachedVideo) => Object.freeze({
  fixtureRoot: root,
  mediaSelection: cachedVideo === null ? null : join(root, 'input', basename(cachedVideo)),
  mediaDestination: join(root, 'output'),
});

/** Everything a run must set so it cannot reach live user state. */
export const isolationEnvironment = (root) => ({
  OSG_E2E_DATA_ROOT: root,
  // A full-size real WebView positioned entirely off-screen and excluded from the taskbar. The
  // embedded driver may make its HWND compositor-visible so GPU/video work keeps advancing; the
  // enforceable boundary is that it never enters the interactive desktop or receives real input.
  // This is consumed only by the binary's `e2e-automation` graph;
  // production does not compile the reader. Playback/render journeys prove their own progress
  // instead of assuming visibility implies the compositor ran.
  OSG_E2E_OFFSCREEN_WINDOW: '1',
  // The only files a staged file-dialog selection may name. The application resolves and re-checks
  // this itself; declaring it here is what keeps a journey to reviewed files.
  // Never inherit this boundary from the shell. `run-isolated.mjs` strips the parent value and
  // this factory binds the application to the disposable root it just created. Letting an ambient
  // value win would make the staged dialog guard authorise files outside the isolated run.
  OSG_E2E_FIXTURE_ROOT: root,
  // What the next OPEN dialog returns, and where the next SAVE dialog writes. Both are read from
  // the process environment, so they are fixed for a launch; a journey needing different ones runs
  // its own launch. Both are bounded by the application to the reviewed root above.
  ...(process.env.OSG_E2E_MEDIA_SELECTION === undefined
    ? {}
    : { OSG_E2E_MEDIA_SELECTION: process.env.OSG_E2E_MEDIA_SELECTION }),
  ...(process.env.OSG_E2E_MEDIA_SELECTION_SEQUENCE === undefined
    ? {}
    : { OSG_E2E_MEDIA_SELECTION_SEQUENCE: process.env.OSG_E2E_MEDIA_SELECTION_SEQUENCE }),
  ...(process.env.OSG_E2E_MEDIA_DESTINATION === undefined
    ? {}
    : { OSG_E2E_MEDIA_DESTINATION: process.env.OSG_E2E_MEDIA_DESTINATION }),
  WEBVIEW2_USER_DATA_FOLDER: join(root, 'webview'),
});

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
