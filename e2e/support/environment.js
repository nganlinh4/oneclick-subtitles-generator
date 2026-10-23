// Where a journey runs, and what it is allowed to touch.
//
// Every run gets its own data root. That is not tidiness: the application resolves its data
// directory through SHGetKnownFolderPath, so a run without an explicit root writes into the
// developer's real projects — 17 of them on the machine this was written on. The root is passed
// through OSG_E2E_DATA_ROOT, which exists only in the `unsigned-local-build` channel.
//
// This module owns the verified application under test and its automation guards; cache roots,
// staged applications and run roots live in ./environment/ and are re-exported below.

import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import process from 'node:process';

import { E2E_APPLICATIONS_CACHE_ROOT, REPOSITORY_ROOT } from './environment/cacheRoots.js';
import { sameResolvedPath } from './environment/pathIdentity.js';
import { assertStagedApplicationBinary } from './environment/stagedApplication.js';

export { scrubAutomationEnvironment } from './automationEnvironment.js';
export {
  REPOSITORY_ROOT,
  resolveDevelopmentCacheRoot,
  DEVELOPMENT_CACHE_ROOT,
  E2E_APPLICATIONS_CACHE_ROOT,
  E2E_ASSET_CACHE_ROOT,
  EVIDENCE_CACHE_ROOT,
  E2E_STAGING_ROOT,
  FIXTURE_ROOT,
  NATIVE_TOOLS_CACHE,
  ENGINE_PACKAGES_CACHE,
  REAL_MEDIA_CACHE,
  SOURCE_SWITCH_MEDIA_CACHE,
  FOUR_WINDOW_ASR_MEDIA_CACHE,
  LONG_SYNTHETIC_MEDIA_CACHE,
} from './environment/cacheRoots.js';
export {
  writeStagedApplicationParentMarker,
  assertStagedApplicationBinary,
  writeStagedApplicationMarker,
} from './environment/stagedApplication.js';
export {
  createRunRoot,
  attachRunRootCaches,
  runRootAuthorization,
  managedStagingEnvironment,
  canReuseRunRoot,
  removeRunRoot,
} from './environment/runRoot.js';

const require = createRequire(import.meta.url);
const { readAndVerifyE2eApplicationReceipt } = require(
  '../../scripts/e2e-application-publication.js'
);
const { readCleanGitSourceProvenance } = require('../../scripts/git-source-provenance.js');

const UNPUBLISHED_APPLICATION_DIRECTORY = '.unpublished';

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
