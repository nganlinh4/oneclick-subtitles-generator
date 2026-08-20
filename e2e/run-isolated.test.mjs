import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  defaultJourneys, isolatedEnvironment, normalizeJourney, parseArguments,
} from './run-isolated.mjs';
import {
  ENGINE_PACKAGES_CACHE, JOURNEY_TIMEOUT_MS, createRunRoot, removeRunRoot, stagedDialogPaths,
} from './support/environment.js';
import { cachedRealVideo } from './support/realMedia.js';

test('discovers every product journey while excluding scenario-only diagnostics', () => {
  const names = defaultJourneys().map((path) => path.replaceAll('\\', '/').split('/').at(-1));
  assert.deepEqual(names, [
    'defaultFont.journey.js',
    'localAsrGeneration.journey.js',
    'narrationGeneration.journey.js',
    'nativeExportDecoded.journey.js',
    'startup.journey.js',
    'urlToPreview.journey.js',
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
    OSG_E2E_KEEP_ROOT: '1',
    OSG_E2E_MEDIA_SELECTION: 'old-input',
    OSG_E2E_MEDIA_DESTINATION: 'old-output',
    WEBVIEW2_USER_DATA_FOLDER: 'old-webview',
  };
  const clean = isolatedEnvironment(source);
  assert.deepEqual(clean, { SAFE: 'kept' });
  assert.equal(source.OSG_E2E_DATA_ROOT, 'old-root');
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

test('real-media discovery cannot select a prior export nested under the input cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'osg-real-media-cache-'));
  try {
    const input = join(root, 'source.mp4');
    const nested = join(root, 'exports', 'run-old');
    mkdirSync(nested, { recursive: true });
    writeFileSync(input, 'source');
    writeFileSync(join(nested, 'newer-export.mp4'), 'export');
    assert.equal(cachedRealVideo(root), input);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isolated roots retain engine packages through a junction without deleting the cache', () => {
  const root = createRunRoot({ keepNativeTools: false });
  const junction = join(root, 'data', 'engine-packages');
  try {
    assert.equal(lstatSync(junction).isSymbolicLink(), true);
    assert.equal(existsSync(ENGINE_PACKAGES_CACHE), true);
  } finally {
    removeRunRoot(root);
  }
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(ENGINE_PACKAGES_CACHE), true);
});

test('the outer journey timeout cannot kill a valid multi-gigabyte engine installation', () => {
  assert.ok(JOURNEY_TIMEOUT_MS >= 2 * 60 * 60 * 1_000);
});
