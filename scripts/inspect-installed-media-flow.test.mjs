import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  mediaPreferencesForPhase,
  parseArguments,
  waitForValue,
} from './inspect-installed-media-flow.mjs';
import { PRIOR_ASSET_ID } from './installed-media-flow/test-fixtures.mjs';

test('parses only bounded CI-owned media-flow files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-media-flow-'));
  try {
    const srt = path.join(root, 'fixture.srt');
    const screenshot = path.join(root, 'capture.png');
    fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\nfixture\n');
    assert.deepEqual(parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot,
      '--media-phase', 'initial',
    ], { RUNNER_TEMP: root }), {
      port: 43123, srt, screenshot, priorAssetId: null, mediaPhase: 'initial',
    });
    assert.deepEqual(parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot,
      '--media-phase', 'reactivation',
      '--prior-asset-id', PRIOR_ASSET_ID,
    ], { RUNNER_TEMP: root }), {
      port: 43123, srt, screenshot, priorAssetId: PRIOR_ASSET_ID,
      mediaPhase: 'reactivation',
    });
    assert.throws(() => parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot,
      '--media-phase', 'reactivation',
      '--prior-asset-id', 'not-a-uuid',
    ], { RUNNER_TEMP: root }), /asset identity is invalid/);
    assert.throws(() => parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', path.join(root, '..', 'escape.png'),
      '--media-phase', 'initial',
    ], { RUNNER_TEMP: root }), /Screenshot must stay/);
    assert.throws(() => parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot,
      '--media-phase', 'initial', '--extra', 'value',
    ], { RUNNER_TEMP: root }), /Only reviewed/);
    assert.throws(() => parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot,
      '--media-phase', 'https://example.com/arbitrary.mp4',
    ], { RUNNER_TEMP: root }), /phase is invalid/);
    assert.throws(() => parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot,
      '--media-phase', 'reactivation',
    ], { RUNNER_TEMP: root }), /phase and prior asset are inconsistent/);
    assert.throws(() => parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot,
      '--media-phase', 'initial', '--prior-asset-id', PRIOR_ASSET_ID,
    ], { RUNNER_TEMP: root }), /phase and prior asset are inconsistent/);
    assert.throws(() => parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot,
      '--media-url', 'https://example.com/arbitrary.mp4',
    ], { RUNNER_TEMP: root }), /Only reviewed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('routes each exact media phase to a distinct reviewed adapter key', () => {
  assert.deepEqual(mediaPreferencesForPhase('initial'), {
    autoImport: 'true', preferredLanguages: '["en"]',
  });
  assert.deepEqual(mediaPreferencesForPhase('reactivation'), {
    autoImport: 'false', preferredLanguages: '["en"]',
  });
  assert.notEqual(
    mediaPreferencesForPhase('initial').autoImport,
    mediaPreferencesForPhase('reactivation').autoImport,
  );
  assert.throws(() => mediaPreferencesForPhase('final'), /phase is invalid/);
  assert.throws(() => mediaPreferencesForPhase('https://example.com/arbitrary.mp4'),
    /phase is invalid/);
});

test('waits for a terminal accepted state and rejects a bounded timeout', async () => {
  let reads = 0;
  const accepted = await waitForValue(
    async () => ({ ready: ++reads >= 3 }),
    (value) => value.ready,
    { now: () => reads * 10, timeoutMs: 100, delay: async () => {} },
  );
  assert.deepEqual(accepted, { ready: true });
  let ticks = 0;
  await assert.rejects(() => waitForValue(
    async () => ({ ready: false }),
    (value) => value.ready,
    { now: () => ++ticks * 10, timeoutMs: 15, delay: async () => {} },
  ), /timed out: terminal-state-timeout/);
  for (const failureCode of [
    'url-tab-timeout',
    'url-stage-timeout',
    'srt-readiness-timeout',
    'download-start-timeout',
    'terminal-state-timeout',
  ]) {
    let categoryTicks = 0;
    await assert.rejects(() => waitForValue(
      async () => false,
      (value) => value === true,
      {
        failureCode,
        now: () => ++categoryTicks * 10,
        timeoutMs: 15,
        delay: async () => {},
      },
    ), new RegExp(`timed out: ${failureCode}$`));
  }
  await assert.rejects(() => waitForValue(
    async () => false,
    (value) => value === true,
    { failureCode: 'private-state-timeout' },
  ), /timeout category is invalid/);
});
