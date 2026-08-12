import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertMediaFlowResult,
  parseArguments,
  waitForValue,
} from './inspect-installed-media-flow.mjs';

const TOOL = (id, version) => ({
  id,
  state: 'installed',
  installed: true,
  activeRuntime: true,
  pendingRemoval: false,
  restartRequired: false,
  operation: null,
  version,
});

const validResult = () => ({
  assetId: '019ff572-2132-7ba1-9e9c-5a29894963bf',
  currentFileName: 'trailer.mp4',
  currentFileUrl: 'http://127.0.0.1:43123/asset/01111111-2222-4333-8444-555555555555?token=' + 'a'.repeat(64),
  errorToastCount: 0,
  jobs: [
    {
      kind: 'downloadMedia',
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
    },
  ],
  session: {
    media: {
      id: '019ff572-2132-7ba1-9e9c-5a29894963bf',
      kind: 'video',
    },
    playback: {
      playbackUrl: 'http://127.0.0.1:43123/asset/01111111-2222-4333-8444-555555555555?token=' + 'a'.repeat(64),
    },
  },
  subtitleMarkerVisible: true,
  tools: {
    tools: [
      TOOL('media-tools', '8.1.2'),
      TOOL('yt-dlp', '2026.07.04'),
      TOOL('deno', '2.9.5'),
    ],
  },
  uploadedSrtInfo: {
    hasUploaded: true,
    fileName: 'osg-installed-media-smoke.srt',
    source: 'srt',
  },
  video: {
    currentSrc: 'http://127.0.0.1:43123/asset/01111111-2222-4333-8444-555555555555?token=' + 'a'.repeat(64),
    duration: 52.2,
    height: 480,
    paused: true,
    readyState: 4,
    width: 854,
  },
});

test('parses only bounded CI-owned media-flow files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-media-flow-'));
  try {
    const srt = path.join(root, 'fixture.srt');
    const screenshot = path.join(root, 'capture.png');
    fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\nfixture\n');
    assert.deepEqual(parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot,
    ], { RUNNER_TEMP: root }), { port: 43123, srt, screenshot });
    assert.throws(() => parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', path.join(root, '..', 'escape.png'),
    ], { RUNNER_TEMP: root }), /Screenshot must stay/);
    assert.throws(() => parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot, '--extra', 'value',
    ], { RUNNER_TEMP: root }), /Only reviewed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts the complete native media, subtitle, tool, and job result', () => {
  assert.equal(assertMediaFlowResult(validResult()).video.width, 854);
});

test('rejects subtitle-only, inactive-tool, and accidental render false positives', () => {
  const missingVideo = validResult();
  missingVideo.video = null;
  assert.throws(() => assertMediaFlowResult(missingVideo), /media element/);

  const inactive = validResult();
  inactive.tools.tools[1].activeRuntime = false;
  assert.throws(() => assertMediaFlowResult(inactive), /immediately active/);

  const render = validResult();
  render.jobs.push({ kind: 'renderVideo', state: 'succeeded', progress: { basisPoints: 10_000 } });
  assert.throws(() => assertMediaFlowResult(render), /download-only job/);
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
  ), /timed out/);
});
