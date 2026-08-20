import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultJourneys, isolatedEnvironment, normalizeJourney, parseArguments,
} from './run-isolated.mjs';

test('discovers every product journey while excluding scenario-only diagnostics', () => {
  const names = defaultJourneys().map((path) => path.replaceAll('\\', '/').split('/').at(-1));
  assert.deepEqual(names, [
    'defaultFont.journey.js',
    'editPersistRelaunch.journey.js',
    'startup.journey.js',
    'unicodeCues.journey.js',
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
