// The isolated runner: journey discovery, arguments, environment scrubbing, staging, and the
// production-binary refusal.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import test from 'node:test';

import {
  defaultJourneys, isolatedEnvironment, normalizeJourney, parseArguments,
  runContainedJourneyOperation,
} from './run-isolated.mjs';
import {
  AUTOMATION_AUDIO_GUARD, AUTOMATION_DIALOG_GUARD, AUTOMATION_ENVIRONMENT_GUARD,
  AUTOMATION_INTERACTION_GUARD, AUTOMATION_WEBDRIVER_GUARD, AUTOMATION_WINDOW_GUARD,
  JOURNEY_TIMEOUT_MS, assertAutomationDialogGuard, isolationEnvironment, stagedDialogPaths,
} from './support/environment.js';
import { cachedRealVideo } from './support/realMedia.js';

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
test('discovers every default journey, fixture owners first', () => {
  const names = defaultJourneys().map((path) => path.replaceAll('\\', '/').split('/').at(-1));
  assert.deepEqual(names, [
    'urlToPreview.journey.js',
    'localAsrGeneration.journey.js',
    'aboutAndUpdaterLifecycle.journey.js',
    'alternateProviderDownload.journey.js',
    'authenticatedCookieDownload.journey.js',
    'browserProfileCookieDownload.journey.js',
    'bulkTranslationFileIO.journey.js',
    'cacheClearSafety.journey.js',
    'canvasPlaybackPerformance.journey.js',
    'downloadCancellationRetryIdentity.journey.js',
    'downloadQualityCancellationIdentity.journey.js',
    'downloadQualityVariants.journey.js',
    'edgeTtsNarrationGeneration.journey.js',
    'editorCueCrudAndHistory.journey.js',
    'engineCatalogMatrix.journey.js',
    'exportAnimationParityMatrix.journey.js',
    'failedDownloadNoStale.journey.js',
    'frontendResponsiveness.journey.js',
    'geminiNarrationGeneration.journey.js',
    'geminiOutputPreview.journey.js',
    'largeSubtitleResponsiveness.journey.js',
    'localFileImport.journey.js',
    'mainPreviewControlsAndFullscreen.journey.js',
    'mainPreviewRenderHandoff.journey.js',
    'manualLyricsAndGeniusBoundary.journey.js',
    'narrationGeneration.journey.js',
    'nativeExportDecoded.journey.js',
    'playlistWatchSelection.journey.js',
    'presentationAudit.journey.js',
    'promptDjMidiInput.journey.js',
    'providerBoundaries.journey.js',
    'referenceVoiceAndPerCueNarration.journey.js',
    'renderAudioNarrationMix.journey.js',
    'renderCancelRetryExport.journey.js',
    'renderFormatTransformMatrix.journey.js',
    'settingsDraftIsolation.journey.js',
    'settingsSurface.journey.js',
    'settingsVideoProcessingAndPrompts.journey.js',
    'srtOnlyMediaAttach.journey.js',
    'startup.journey.js',
    'subtitleCustomizationPreview.journey.js',
    'subtitleDocumentRoundTrip.journey.js',
    'subtitleMaterialAndAnimation.journey.js',
    'timelineAdvancedEditing.journey.js',
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
