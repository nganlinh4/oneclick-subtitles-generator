import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isAbsolute, join, relative, resolve, sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import test from 'node:test';

import {
  defaultJourneys, isolatedEnvironment, normalizeJourney, parseArguments,
  runContainedJourneyOperation,
} from './run-isolated.mjs';
import {
  acquireEvidenceLease, parseEvidenceLeaseContract, withEvidenceLease,
} from './support/evidenceLease.js';
import {
  AUTOMATION_AUDIO_GUARD, AUTOMATION_DIALOG_GUARD, AUTOMATION_ENVIRONMENT_GUARD,
  AUTOMATION_INTERACTION_GUARD, AUTOMATION_WEBDRIVER_GUARD, AUTOMATION_WINDOW_GUARD,
  E2E_ASSET_CACHE_ROOT, ENGINE_PACKAGES_CACHE, EVIDENCE_CACHE_ROOT,
  FOUR_WINDOW_ASR_MEDIA_CACHE,
  JOURNEY_TIMEOUT_MS, assertAutomationDialogGuard, attachRunRootCaches, canReuseRunRoot,
  createRunRoot, isolationEnvironment, NATIVE_TOOLS_CACHE, REAL_MEDIA_CACHE, removeRunRoot,
  runRootAuthorization, SOURCE_SWITCH_MEDIA_CACHE, stagedDialogPaths,
} from './support/environment.js';
import { cachedRealVideo } from './support/realMedia.js';

const TEST_STAGING_ROOT = mkdtempSync(join(tmpdir(), 'osg-e2e-test-staging-'));
test.after(() => rmSync(TEST_STAGING_ROOT, { recursive: true, force: true }));
const createTestRunRoot = (options = {}) => createRunRoot({
  ...options,
  testStagingRoot: TEST_STAGING_ROOT,
});

const RUNNER_URL = pathToFileURL(join(import.meta.dirname, 'run-isolated.mjs')).href;
const ENVIRONMENT_URL = pathToFileURL(join(import.meta.dirname, 'support', 'environment.js')).href;
const runRunnerSubprocess = ({ cacheRoot, script }) => {
  const environment = { ...process.env, OSG_DEV_CACHE_ROOT: cacheRoot };
  delete environment.OSG_E2E_BINARY;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: resolve(import.meta.dirname, '..'),
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
  });
};

const writeHistoricalReceiptFixture = (cacheRoot) => {
  const binary = Buffer.from('historical-e2e-binary');
  const binaryHash = createHash('sha256').update(binary).digest('hex');
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    hashAlgorithm: 'sha256',
    entrypoint: 'osg-desktop.exe',
    resourceDirectories: ['licenses', 'ui-fonts', 'workers'],
    directories: [],
    files: [{ path: 'osg-desktop.exe', size: binary.length, sha256: binaryHash }],
  }, null, 2)}\n`);
  const applicationHash = createHash('sha256').update(manifest).digest('hex');
  const applicationRoot = join(cacheRoot, 'apps', 'e2e', 'applications', applicationHash);
  const receiptsRoot = join(cacheRoot, 'apps', 'e2e', 'receipts');
  mkdirSync(applicationRoot, { recursive: true });
  mkdirSync(receiptsRoot, { recursive: true });
  writeFileSync(join(applicationRoot, 'osg-desktop.exe'), binary);
  writeFileSync(join(applicationRoot, '.osg-application-manifest.json'), manifest);
  // Receipt verification reaches the explicit historical-provenance refusal before comparing the
  // modern receipt schema, faithfully representing a retained schema-v2 pre-provenance build.
  writeFileSync(join(receiptsRoot, 'current.json'), `${JSON.stringify({ applicationHash })}\n`);
};

const guardedWindowsGuiFixture = (guards, subsystem = 2) => {
  const bytes = Buffer.alloc(1_024);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set(Buffer.from([0x50, 0x45, 0, 0]), 64);
  bytes.writeUInt16LE(0x20b, 64 + 24);
  bytes.writeUInt16LE(subsystem, 64 + 24 + 68);
  Buffer.concat(guards).copy(bytes, 256);
  return bytes;
};

test('discovers every product journey while excluding scenario-only diagnostics', () => {
  const names = defaultJourneys().map((path) => path.replaceAll('\\', '/').split('/').at(-1));
  assert.deepEqual(names, [
    'urlToPreview.journey.js',
    'aboutAndUpdaterLifecycle.journey.js',
    'alternateLocalAsrMatrix.journey.js',
    'alternateProviderDownload.journey.js',
    'bulkTranslationFileIO.journey.js',
    'cacheClearSafety.journey.js',
    'canvasPlaybackPerformance.journey.js',
    'defaultFont.journey.js',
    'downloadCancellationRetryIdentity.journey.js',
    'downloadQualityCancellationIdentity.journey.js',
    'downloadQualityVariants.journey.js',
    'edgeTtsNarrationGeneration.journey.js',
    'editorCueCrudAndHistory.journey.js',
    'exportAnimationParityMatrix.journey.js',
    'failedDownloadNoStale.journey.js',
    'freshInstallVisual.journey.js',
    'geminiCredentialBoundary.journey.js',
    'geminiOutputPreview.journey.js',
    'localAsrGeneration.journey.js',
    'localFileImport.journey.js',
    'mainPreviewControlsAndFullscreen.journey.js',
    'mainPreviewRenderHandoff.journey.js',
    'manualLyricsAndGeniusBoundary.journey.js',
    'narrationEngineMatrix.journey.js',
    'narrationGeneration.journey.js',
    'nativeExportDecoded.journey.js',
    'playlistWatchSelection.journey.js',
    'providerBoundaries.journey.js',
    'referenceVoiceAndPerCueNarration.journey.js',
    'renderAudioNarrationMix.journey.js',
    'renderCancelRetryExport.journey.js',
    'renderFormatTransformMatrix.journey.js',
    'settingsSurface.journey.js',
    'settingsVideoProcessingAndPrompts.journey.js',
    'srtOnlyMediaAttach.journey.js',
    'startup.journey.js',
    'subtitleCustomizationPreview.journey.js',
    'subtitleDocumentRoundTrip.journey.js',
    'subtitleMaterialAndAnimation.journey.js',
    'timelineAdvancedEditing.journey.js',
    'timelineBoundary.journey.js',
    'translatedDocumentExports.journey.js',
    'urlLocalAsrPreview.journey.js',
    'youtubeSearchAndHistory.journey.js',
  ]);
});

test('parses a bounded repeat and deduplicates exact journey paths', () => {
  const parsed = parseArguments([
    '--repeat', '8', 'journeys/startup.journey.js', 'journeys/startup.journey.js',
  ]);
  assert.equal(parsed.repeat, 8);
  assert.equal(parsed.journeys.length, 1);
  assert.match(parsed.journeys[0], /startup\.journey\.js$/);
});

test('refuses traversal, unknown options, missing files and unbounded repetition', () => {
  assert.throws(() => normalizeJourney('../package.json'), /directly under/);
  assert.throws(() => parseArguments(['--unknown']), /unknown option/);
  assert.throws(() => parseArguments(['journeys/missing.journey.js']), /does not exist/);
  assert.throws(() => parseArguments(['--repeat', '101']), /1 through 100/);
});

test('removes every inherited isolation and dialog value without mutating the caller', () => {
  const source = {
    SAFE: 'kept',
    OSG_E2E_DATA_ROOT: 'old-root',
    OSG_E2E_EVIDENCE_ATTEMPT: 'old-attempt',
    OSG_E2E_KEEP_ROOT: '1',
    OSG_E2E_MEDIA_SELECTION: 'old-input',
    OSG_E2E_MEDIA_SELECTION_SEQUENCE: '["old-input","old-input-2"]',
    OSG_E2E_MEDIA_DESTINATION: 'old-output',
    OSG_E2E_OFFSCREEN_WINDOW: '0',
    OSG_E2E_EXACT_DOWNLOAD_URLS: '["old-capability"]',
    OSG_E2E_DOWNLOAD_FIXTURE_MANIFEST: '[{"old":true}]',
    OSG_E2E_DOWNLOAD_FIXTURE_EVENTS: 'old-events',
    OSG_E2E_FIXTURE_ROOT: 'old-fixture-root',
    OSG_E2E_WORKFLOW: 'old-workflow',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--start-fullscreen',
    WEBVIEW2_USER_DATA_FOLDER: 'old-webview',
    WDIO_WORKER_ID: 'stale-worker',
    __WDIO_TAURI_EMBEDDED__: 'true',
    __WDIO_TAURI_APP_BINARY__: 'C:\\Users\\user\\live-app.exe',
    TAURI_WEBDRIVER_PORT: '4445',
    TAURI_DATA_DIR: 'C:\\Users\\user\\live-data',
    REMOTE_WEBDRIVER_URL: 'http://127.0.0.1:4444',
  };
  const clean = isolatedEnvironment(source);
  assert.deepEqual(clean, { SAFE: 'kept' });
  assert.equal(source.OSG_E2E_DATA_ROOT, 'old-root');
});

test('pure runner import tolerates absent, corrupt, and historical receipts while run fails closed', (context) => {
  for (const receiptState of ['absent', 'corrupt', 'historical']) {
    const cacheRoot = mkdtempSync(join(tmpdir(), `osg-runner-${receiptState}-`));
    context.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
    if (receiptState === 'corrupt') {
      const receiptsRoot = join(cacheRoot, 'apps', 'e2e', 'receipts');
      mkdirSync(receiptsRoot, { recursive: true });
      writeFileSync(join(receiptsRoot, 'current.json'), '{not-json\n');
    } else if (receiptState === 'historical') {
      writeHistoricalReceiptFixture(cacheRoot);
    }

    const imported = runRunnerSubprocess({
      cacheRoot,
      script: [
        `const runner = await import(${JSON.stringify(RUNNER_URL)});`,
        `const environment = await import(${JSON.stringify(ENVIRONMENT_URL)});`,
        "if (!environment.APPLICATION_BINARY.includes('.unpublished')) throw new Error('unsafe receipt selected');",
        "if (runner.parseArguments(['--repeat', '2']).repeat !== 2) throw new Error('pure import failed');",
      ].join('\n'),
    });
    assert.equal(imported.status, 0, `${receiptState}: ${imported.stderr}`);

    const launchRejected = runRunnerSubprocess({
      cacheRoot,
      script: [
        `const runner = await import(${JSON.stringify(RUNNER_URL)});`,
        'try {',
        '  await runner.run({ repeat: 1, journeys: [] });',
        "  throw new Error('runner accepted an unverified publication');",
        '} catch (error) {',
        "  if (error.message === 'runner accepted an unverified publication') throw error;",
        "  if (!/receipt|publication|application/i.test(error.message)) throw error;",
        '}',
      ].join('\n'),
    });
    assert.equal(launchRejected.status, 0, `${receiptState}: ${launchRejected.stderr}`);
  }
});

test('binds the fixture capability to the disposable root even when the shell supplies another root', () => {
  const prior = process.env.OSG_E2E_FIXTURE_ROOT;
  process.env.OSG_E2E_FIXTURE_ROOT = 'C:\\Users\\user\\live-files';
  try {
    const disposable = 'C:\\Temp\\osg-e2e-disposable';
    assert.equal(isolationEnvironment(disposable).OSG_E2E_FIXTURE_ROOT, disposable);
  } finally {
    if (prior === undefined) delete process.env.OSG_E2E_FIXTURE_ROOT;
    else process.env.OSG_E2E_FIXTURE_ROOT = prior;
  }
});

test('stages media input and output inside the disposable run, never the persistent cache', () => {
  const paths = stagedDialogPaths('C:\\Temp\\osg-e2e-run', 'C:\\repo\\target\\e2e-real-media\\source.mp4');
  assert.deepEqual(paths, {
    fixtureRoot: 'C:\\Temp\\osg-e2e-run',
    mediaSelection: 'C:\\Temp\\osg-e2e-run\\input\\source.mp4',
    mediaDestination: 'C:\\Temp\\osg-e2e-run\\output',
  });
  assert.doesNotMatch(paths.mediaSelection, /e2e-real-media/i);
  assert.doesNotMatch(paths.mediaDestination, /e2e-real-media/i);
});

test('a staging copy failure cannot leak its disposable run root', async () => {
  const { withDisposableRunRoot } = await import('./run-isolated.mjs');
  const events = [];
  assert.throws(
    () => withDisposableRunRoot({
      stagingLease: { name: 'lease' },
      createRunRoot: () => {
        events.push('create');
        return 'C:\\Temp\\osg-copy-failure';
      },
      runRootAuthorization: () => 'authorization',
      removeRunRoot: (root, authorization) => events.push(`remove:${root}:${authorization}`),
    }, () => {
      events.push('copy');
      throw new Error('simulated copyFileSync failure');
    }, ({ runRoot }) => {
      events.push(`preserve:${runRoot}`);
    }),
    /copyFileSync failure/u,
  );
  assert.deepEqual(events, [
    'create',
    'copy',
    'preserve:C:\\Temp\\osg-copy-failure',
    'remove:C:\\Temp\\osg-copy-failure:authorization',
  ]);
});

test('bootstrap and staging exceptions are recorded as failed journeys without aborting the queue', () => {
  const failures = [];
  const events = [];
  const output = [];
  for (const [label, operation] of [
    ['bootstrap', () => { throw new Error('injected bootstrap refusal'); }],
    ['copy', () => { throw new Error('injected copy refusal'); }],
    ['later-journey', () => { events.push('later-ran'); return 17; }],
  ]) {
    const result = runContainedJourneyOperation({
      failures,
      label,
      operation,
      onFailure: (error) => events.push(`evidence:${label}:${error.message}`),
      write: value => output.push(value),
    });
    if (label === 'later-journey') assert.equal(result, 17);
  }
  assert.deepEqual(events, [
    'evidence:bootstrap:injected bootstrap refusal',
    'evidence:copy:injected copy refusal',
    'later-ran',
  ]);
  assert.deepEqual(failures.map(({ label, status }) => ({ label, status })), [
    { label: 'bootstrap', status: 'harness-error' },
    { label: 'copy', status: 'harness-error' },
  ]);
  assert.match(output.join(''), /FAILED bootstrap: harness error/u);
  assert.match(output.join(''), /FAILED copy: harness error/u);
});

test('real-media discovery refuses unreceipted files and nested prior exports', () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-real-media-cache-'));
  try {
    const input = join(root, 'source.mp4');
    const nested = join(root, 'exports', 'run-old');
    mkdirSync(nested, { recursive: true });
    writeFileSync(input, 'source');
    writeFileSync(join(nested, 'newer-export.mp4'), 'export');
    assert.equal(cachedRealVideo(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isolated roots retain engine packages through a junction without deleting the cache', () => {
  const cacheScratch = mkdtempSync(join(tmpdir(), 'osg-e2e-engine-cache-test-'));
  const enginePackagesCache = join(cacheScratch, 'engine-packages');
  const root = createTestRunRoot({ keepNativeTools: false });
  const rootAuthorization = runRootAuthorization(root);
  const junction = join(root, 'data', 'engine-packages');
  try {
    assert.equal(lstatSync(junction, { throwIfNoEntry: false }), undefined);
    assert.equal(existsSync(enginePackagesCache), false);
    assert.deepEqual(attachRunRootCaches({
      root,
      nativeToolsCache: join(cacheScratch, 'native-tools'),
      enginePackagesCache,
    }), { keepNativeTools: false, keepEnginePackages: true });
    assert.equal(lstatSync(junction).isSymbolicLink(), true);
    assert.equal(existsSync(enginePackagesCache), true);
  } finally {
    removeRunRoot(root, rootAuthorization);
  }
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(enginePackagesCache), true);
  rmSync(cacheScratch, { recursive: true, force: true });
});

test('a from-empty engine/tool policy stays detached until the leased launcher applies it', () => {
  const cacheScratch = mkdtempSync(join(tmpdir(), 'osg-e2e-disabled-cache-test-'));
  const nativeToolsCache = join(cacheScratch, 'native-tools');
  const enginePackagesCache = join(cacheScratch, 'engine-packages');
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  const rootAuthorization = runRootAuthorization(root);
  try {
    assert.deepEqual(attachRunRootCaches({ root, nativeToolsCache, enginePackagesCache }), {
      keepNativeTools: false,
      keepEnginePackages: false,
    });
    assert.equal(existsSync(nativeToolsCache), false);
    assert.equal(existsSync(enginePackagesCache), false);
    assert.equal(lstatSync(join(root, 'data', 'native-tools'), { throwIfNoEntry: false }), undefined);
    assert.equal(
      lstatSync(join(root, 'data', 'engine-packages'), { throwIfNoEntry: false }),
      undefined,
    );
  } finally {
    removeRunRoot(root, rootAuthorization);
    rmSync(cacheScratch, { recursive: true, force: true });
  }
});

test('a disabled cache accepts the application-created in-root store but never a link', () => {
  const cacheScratch = mkdtempSync(join(tmpdir(), 'osg-e2e-disabled-store-test-'));
  const nativeToolsCache = join(cacheScratch, 'native-tools');
  const enginePackagesCache = join(cacheScratch, 'engine-packages');
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  const rootAuthorization = runRootAuthorization(root);
  const store = join(root, 'data', 'native-tools');
  try {
    // The launcher's service spawns the application before this config runs again in the worker,
    // and the application creates its store directory eagerly. Re-attaching must accept it.
    mkdirSync(store, { recursive: true });
    assert.deepEqual(attachRunRootCaches({ root, nativeToolsCache, enginePackagesCache }), {
      keepNativeTools: false,
      keepEnginePackages: false,
    });
    assert.equal(existsSync(nativeToolsCache), false);
    // A link at the same path could reach a shared persistent cache and must stay refused.
    rmSync(store, { recursive: true, force: true });
    mkdirSync(nativeToolsCache, { recursive: true });
    symlinkSync(nativeToolsCache, store, 'junction');
    assert.throws(
      () => attachRunRootCaches({ root, nativeToolsCache, enginePackagesCache }),
      /attached the disabled native-tools cache/u,
    );
  } finally {
    removeRunRoot(root, rootAuthorization);
    rmSync(cacheScratch, { recursive: true, force: true });
  }
});

test('every retained E2E asset is below the one external manager-owned lane', () => {
  for (const assetPath of [
    NATIVE_TOOLS_CACHE,
    ENGINE_PACKAGES_CACHE,
    REAL_MEDIA_CACHE,
    SOURCE_SWITCH_MEDIA_CACHE,
    FOUR_WINDOW_ASR_MEDIA_CACHE,
  ]) {
    const inside = relative(resolve(E2E_ASSET_CACHE_ROOT), resolve(assetPath));
    assert.ok(
      inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside),
      `${assetPath} escaped the managed E2E asset lane`,
    );
    assert.doesNotMatch(
      assetPath,
      /[\\/]target[\\/]e2e-|[\\/]target[\\/]workflow-evidence/iu,
    );
  }
});

test('workflow evidence has its own external manager lane instead of sharing application assets', () => {
  assert.equal(EVIDENCE_CACHE_ROOT, join(resolve(E2E_ASSET_CACHE_ROOT, '..', '..'), 'evidence'));
  assert.notEqual(resolve(EVIDENCE_CACHE_ROOT), resolve(E2E_ASSET_CACHE_ROOT));
  assert.doesNotMatch(EVIDENCE_CACHE_ROOT, /[\\/]target[\\/]workflow-evidence/iu);
});

const evidenceLeaseFixture = (() => {
  const cacheRoot = 'C:\\OSG-Test-Cache';
  const evidenceRoot = join(cacheRoot, 'evidence');
  const repositoryRoot = 'C:\\WORK\\oneclick-subtitles-generator';
  const leaseId = '1'.repeat(32);
  const contract = (overrides = {}) => ({
    schemaVersion: 1,
    cacheRoot,
    rootId: '2'.repeat(32),
    lane: 'evidence',
    primaryPath: evidenceRoot,
    cargoTargetDir: null,
    frontendCacheRoot: null,
    appPublicationRoot: null,
    appExecutablePath: null,
    assetCacheRoot: null,
    runtimeContentRoot: join(cacheRoot, 'runtime', 'hashes'),
    evidenceRoot,
    stagingRoot: join(cacheRoot, 'staging'),
    leasePaths: [join(evidenceRoot, '.osg-cache-lease')],
    leaseId,
    leaseProcessId: process.pid,
    leaseProcessCreatedUtc: '2026-08-26T00:00:00.0000000Z',
    ...overrides,
  });
  const managerDouble = ({ failRelease = false, calls = [] } = {}) => (
    (command, arguments_, options) => {
      calls.push({ command, arguments: arguments_, options });
      const operation = arguments_[arguments_.indexOf('-Action') + 1];
      const leaseOperation = arguments_[arguments_.indexOf('-LeaseOperation') + 1];
      if (operation === 'Lease' && leaseOperation === 'Acquire') {
        return { status: 0, stdout: `${JSON.stringify(contract())}\n`, stderr: '' };
      }
      if (operation === 'Lease' && leaseOperation === 'Release' && failRelease) {
        return { status: 17, stdout: '', stderr: 'release refused' };
      }
      return { status: 0, stdout: '{}\n', stderr: '' };
    }
  );
  return Object.freeze({ cacheRoot, contract, evidenceRoot, managerDouble, repositoryRoot });
})();

test('accepts only the manager evidence lane and its exact lease path', () => {
  const {
    cacheRoot, contract, evidenceRoot, repositoryRoot,
  } = evidenceLeaseFixture;
  assert.equal(parseEvidenceLeaseContract({
    stdout: JSON.stringify(contract()), cacheRoot, evidenceRoot, repositoryRoot,
  }).evidenceRoot, evidenceRoot);
  for (const hostile of [
    contract({ lane: 'e2e' }),
    contract({ evidenceRoot: repositoryRoot, primaryPath: repositoryRoot }),
    contract({ leasePaths: [join(cacheRoot, 'assets', 'e2e', '.osg-cache-lease')] }),
    contract({ evidenceRoot: '\\\\?\\C:\\OSG-Test-Cache\\evidence' }),
    contract({ evidenceRoot: '\\\\.\\C:\\OSG-Test-Cache\\evidence' }),
    contract({ evidenceRoot: '\\??\\C:\\OSG-Test-Cache\\evidence' }),
    contract({ evidenceRoot: '\\\\??\\C:\\OSG-Test-Cache\\evidence' }),
    contract({ evidenceRoot: '\\DeViCe\\HarddiskVolume1\\evidence' }),
    contract({ evidenceRoot: '\\\\GLOBAL??\\C:\\OSG-Test-Cache\\evidence' }),
    contract({ primaryPath: `${evidenceRoot}. ` }),
  ]) {
    assert.throws(
      () => parseEvidenceLeaseContract({
        stdout: JSON.stringify(hostile), cacheRoot, evidenceRoot, repositoryRoot,
      }),
      /invalid|unexpected|exact evidence lane/u,
    );
  }
});

test('holds the evidence lease through work, then releases before post-prune', () => {
  const {
    cacheRoot, evidenceRoot, managerDouble, repositoryRoot,
  } = evidenceLeaseFixture;
  const events = [];
  const calls = [];
  const value = withEvidenceLease(() => {
    events.push('operation');
    return 42;
  }, {
    cacheRoot,
    evidenceRoot,
    repositoryRoot,
    spawn: (command, arguments_, options) => {
      const action = arguments_[arguments_.indexOf('-Action') + 1];
      const leaseOperationIndex = arguments_.indexOf('-LeaseOperation');
      const leaseOperation = leaseOperationIndex < 0 ? undefined : arguments_[leaseOperationIndex + 1];
      events.push(leaseOperation === undefined ? action : `${action}:${leaseOperation}`);
      return managerDouble({ calls })(command, arguments_, options);
    },
  });
  assert.equal(value, 42);
  assert.deepEqual(events, ['Prune', 'Lease:Acquire', 'operation', 'Lease:Release', 'Prune']);
  assert.equal(calls.length, 4);
  assert.equal(calls.every(({ options }) => options.windowsHide === true), true);
  assert.equal(calls[3].arguments.includes('-ProtectLane'), false);
  const protectedUnit = calls[3].arguments.indexOf('-ProtectUnit');
  assert.equal(calls[3].arguments[protectedUnit + 1], 'apps-e2e');
});

test('preserves the workflow failure when evidence release also fails', () => {
  const {
    cacheRoot, evidenceRoot, managerDouble, repositoryRoot,
  } = evidenceLeaseFixture;
  const primary = new Error('journey failed');
  assert.throws(
    () => withEvidenceLease(() => { throw primary; }, {
      cacheRoot,
      evidenceRoot,
      repositoryRoot,
      spawn: managerDouble({ failRelease: true }),
    }),
    (error) => error instanceof AggregateError
      && error.errors[0] === primary
      && /release refused/u.test(error.errors[1].message),
  );
});

test('an evidence lease is idempotent but never prunes before its exact release', () => {
  const {
    cacheRoot, evidenceRoot, managerDouble, repositoryRoot,
  } = evidenceLeaseFixture;
  const calls = [];
  const lease = acquireEvidenceLease({
    cacheRoot, evidenceRoot, repositoryRoot, spawn: managerDouble({ calls }),
  });
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  assert.deepEqual(calls.map(({ arguments: arguments_ }) => (
    arguments_[arguments_.indexOf('-Action') + 1]
  )), ['Prune', 'Lease', 'Lease', 'Prune']);
});

test('external evidence maintenance preserves acquire and release with zero prune scans', () => {
  const {
    cacheRoot, evidenceRoot, managerDouble, repositoryRoot,
  } = evidenceLeaseFixture;
  const calls = [];
  const lease = acquireEvidenceLease({
    cacheMaintenance: 'external',
    cacheRoot,
    evidenceRoot,
    repositoryRoot,
    spawn: managerDouble({ calls }),
  });
  assert.equal(lease.release(), true);
  assert.deepEqual(calls.map(({ arguments: arguments_ }) => [
    arguments_[arguments_.indexOf('-Action') + 1],
    arguments_[arguments_.indexOf('-LeaseOperation') + 1],
  ]), [
    ['Lease', 'Acquire'],
    ['Lease', 'Release'],
  ]);
  assert.throws(
    () => acquireEvidenceLease({
      cacheMaintenance: 'typo',
      cacheRoot,
      evidenceRoot,
      repositoryRoot,
      spawn: managerDouble({ calls }),
    }),
    /standalone or external/u,
  );
});

test('an isolated profile can be reused only with its authority and an approved process role', () => {
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  const authorization = runRootAuthorization(root);
  const enclosing = mkdtempSync(join(tmpdir(), 'osg-e2e-container-'));
  try {
    const base = { OSG_E2E_DATA_ROOT: root };

    assert.equal(canReuseRunRoot({ environment: base, workerProcess: false }), false);
    assert.equal(canReuseRunRoot({
      environment: { ...base, OSG_E2E_REUSE_ROOT: '1' },
      workerProcess: false,
    }), false);
    assert.equal(canReuseRunRoot({
      environment: {
        ...base,
        OSG_E2E_REUSE_ROOT: '1',
        OSG_E2E_RUN_ROOT_AUTHORIZATION: '0'.repeat(64),
      },
      workerProcess: false,
    }), false);
    assert.equal(canReuseRunRoot({
      environment: {
        ...base,
        OSG_E2E_REUSE_ROOT: '1',
        OSG_E2E_RUN_ROOT_AUTHORIZATION: authorization,
      },
      workerProcess: false,
    }), true);
    assert.equal(canReuseRunRoot({
      environment: {
        ...base,
        WDIO_WORKER_ID: '0-0',
        OSG_E2E_RUN_ROOT_AUTHORIZATION: authorization,
      },
      workerProcess: true,
    }), true);
    assert.equal(canReuseRunRoot({
      environment: { ...base, OSG_E2E_RUN_ROOT_AUTHORIZATION: authorization },
      workerProcess: true,
    }), false);

    const lookalike = join(enclosing, 'osg-e2e-lookalike');
    for (const child of [
      '', 'data', 'cache', 'logs', 'webview', 'evidence', 'input', 'output',
    ]) {
      mkdirSync(join(lookalike, child), { recursive: true });
    }
    writeFileSync(join(lookalike, '.osg-e2e-authority'), authorization);
    assert.equal(canReuseRunRoot({
      environment: {
        OSG_E2E_DATA_ROOT: lookalike,
        OSG_E2E_REUSE_ROOT: '1',
        OSG_E2E_RUN_ROOT_AUTHORIZATION: authorization,
      },
      workerProcess: false,
    }), false, 'a token cannot authorize a lookalike profile outside the direct OS temp boundary');
  } finally {
    removeRunRoot(root, authorization);
    rmSync(enclosing, { recursive: true, force: true });
  }
});

test('production run roots cannot fall back to the operating-system temp directory', () => {
  assert.throws(
    () => createRunRoot({ keepNativeTools: false, keepEnginePackages: false }),
    /managed staging lease or test root/u,
  );
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  const rootAuthorization = runRootAuthorization(root);
  try {
    assert.equal(resolve(root).startsWith(`${resolve(TEST_STAGING_ROOT)}${sep}`), true);
  } finally {
    removeRunRoot(root, rootAuthorization);
  }
});

test('run-root cleanup refuses hostile paths and mismatched private authority', () => {
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  const authorization = runRootAuthorization(root);
  const hostile = mkdtempSync(join(tmpdir(), 'osg-e2e-cleanup-hostile-'));
  const sentinel = join(hostile, 'must-survive.txt');
  writeFileSync(sentinel, 'foreign bytes');
  try {
    assert.throws(
      () => removeRunRoot(hostile, authorization),
      /without its exact private authority/u,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'foreign bytes');
    assert.throws(
      () => removeRunRoot(root, '0'.repeat(64)),
      /without its exact private authority/u,
    );
    assert.equal(existsSync(root), true);
  } finally {
    removeRunRoot(root, authorization);
    rmSync(hostile, { recursive: true, force: true });
  }
});

test('the cache policy cannot be widened after an isolated root is authorized', () => {
  const root = createTestRunRoot({ keepNativeTools: false, keepEnginePackages: false });
  try {
    const policyPath = join(root, '.osg-e2e-cache-policy.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
    policy.keepNativeTools = true;
    writeFileSync(policyPath, `${JSON.stringify(policy)}\n`);
    assert.throws(() => runRootAuthorization(root), /required private temporary layout/u);
    assert.throws(
      () => attachRunRootCaches({
        root,
        nativeToolsCache: join(root, 'forbidden-native-tools'),
        enginePackagesCache: join(root, 'forbidden-engine-packages'),
      }),
      /required private temporary layout/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the outer journey timeout cannot kill a valid multi-gigabyte engine installation', () => {
  assert.ok(JOURNEY_TIMEOUT_MS >= 2 * 60 * 60 * 1_000);
});

test('refuses a production binary before it can open a native dialog', () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-e2e-binary-'));
  try {
    const production = join(root, 'production.exe');
    writeFileSync(production, 'ordinary production bytes');
    assert.throws(
      () => assertAutomationDialogGuard(production),
      /does not contain the compile-time automation dialog guard/,
    );

    const automation = join(root, 'automation.exe');
    writeFileSync(automation, guardedWindowsGuiFixture([
      Buffer.from('prefix '), AUTOMATION_DIALOG_GUARD, Buffer.from(' middle '),
      AUTOMATION_WINDOW_GUARD, Buffer.from(' middle '), AUTOMATION_ENVIRONMENT_GUARD,
      Buffer.from(' middle '), AUTOMATION_AUDIO_GUARD, Buffer.from(' middle '),
      AUTOMATION_INTERACTION_GUARD, Buffer.from(' middle '), AUTOMATION_WEBDRIVER_GUARD,
      Buffer.from(' suffix'),
    ]));
    assert.doesNotThrow(() => assertAutomationDialogGuard(automation));

    const consoleAutomation = join(root, 'console-automation.exe');
    writeFileSync(consoleAutomation, guardedWindowsGuiFixture([
      AUTOMATION_DIALOG_GUARD, AUTOMATION_WINDOW_GUARD, AUTOMATION_ENVIRONMENT_GUARD,
      AUTOMATION_AUDIO_GUARD, AUTOMATION_INTERACTION_GUARD, AUTOMATION_WEBDRIVER_GUARD,
    ], 3));
    assert.throws(
      () => assertAutomationDialogGuard(consoleAutomation),
      /not a Windows GUI-subsystem executable/,
    );

    const oldAutomation = join(root, 'old-automation.exe');
    writeFileSync(oldAutomation, AUTOMATION_DIALOG_GUARD);
    assert.throws(
      () => assertAutomationDialogGuard(oldAutomation),
      /does not contain the compile-time off-screen window guard/,
    );

    const unsafeProfileAutomation = join(root, 'unsafe-profile-automation.exe');
    writeFileSync(
      unsafeProfileAutomation,
      Buffer.concat([AUTOMATION_DIALOG_GUARD, AUTOMATION_WINDOW_GUARD]),
    );
    assert.throws(
      () => assertAutomationDialogGuard(unsafeProfileAutomation),
      /does not contain the compile-time isolated-profile preflight/,
    );

    const audibleAutomation = join(root, 'audible-automation.exe');
    writeFileSync(
      audibleAutomation,
      Buffer.concat([
        AUTOMATION_DIALOG_GUARD, AUTOMATION_WINDOW_GUARD, AUTOMATION_ENVIRONMENT_GUARD,
      ]),
    );
    assert.throws(
      () => assertAutomationDialogGuard(audibleAutomation),
      /does not contain the compile-time automation audio guard/,
    );

    const interactiveAutomation = join(root, 'interactive-automation.exe');
    writeFileSync(
      interactiveAutomation,
      Buffer.concat([
        AUTOMATION_DIALOG_GUARD, AUTOMATION_WINDOW_GUARD, AUTOMATION_ENVIRONMENT_GUARD,
        AUTOMATION_AUDIO_GUARD,
      ]),
    );
    assert.throws(
      () => assertAutomationDialogGuard(interactiveAutomation),
      /does not contain the compile-time automation interaction guard/,
    );

    const registryServerAutomation = join(root, 'registry-server-automation.exe');
    writeFileSync(
      registryServerAutomation,
      Buffer.concat([
        AUTOMATION_DIALOG_GUARD, AUTOMATION_WINDOW_GUARD, AUTOMATION_ENVIRONMENT_GUARD,
        AUTOMATION_AUDIO_GUARD, AUTOMATION_INTERACTION_GUARD,
      ]),
    );
    assert.throws(
      () => assertAutomationDialogGuard(registryServerAutomation),
      /does not contain the guarded WebDriver server/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
