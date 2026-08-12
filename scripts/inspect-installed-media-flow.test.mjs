import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MEDIA_RESULT_EXPRESSION,
  assertMediaFlowResult,
  collectDownloadJobIds,
  hasMediaFlowStarted,
  parseArguments,
  readPlaybackCapability,
  sanitizeInspectorError,
  summarizeMediaFlowFailure,
  waitForValue,
} from './inspect-installed-media-flow.mjs';

const DOWNLOAD_JOB_A = '019ff572-2140-7ba1-8e9c-5a29894963bf';
const DOWNLOAD_JOB_B = '019ff572-2141-7ba1-8e9c-5a29894963bf';
const PRIOR_ASSET_ID = '019ff572-2131-7ba1-9e9c-5a29894963bf';

const TOOL = (id, version) => ({
  activeRuntime: true,
  availableInstalledBytes: 2_048,
  availableVersion: version,
  deliveryAvailable: true,
  downloadBytes: 1_024,
  id,
  installed: true,
  installedBytes: 2_048,
  label: ({
    deno: 'Deno',
    'media-tools': 'FFmpeg and FFprobe',
    'yt-dlp': 'yt-dlp',
  })[id] ?? 'Unreviewed tool',
  operation: null,
  pendingRemoval: false,
  restartRequired: false,
  state: 'installed',
  version,
});

const validResult = () => ({
  assetId: '019ff572-2132-7ba1-9e9c-5a29894963bf',
  currentFileName: 'trailer.mp4',
  currentFileUrl: 'http://127.0.0.1:43123/asset/01111111-2222-4333-8444-555555555555?token=' + 'a'.repeat(64),
  errorToastMessages: [],
  jobs: [
    {
      id: DOWNLOAD_JOB_A,
      kind: 'downloadMedia',
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
    },
  ],
  playbackBytes: {
    byteLength: 366_888,
    sha256: 'aecf6c8ef3977cd4525261ccadb4086581bd911cb17cc97128cfd8640c6055db',
  },
  session: {
    media: {
      displayName: 'trailer.mp4',
      extension: 'mp4',
      id: '019ff572-2132-7ba1-9e9c-5a29894963bf',
      kind: 'video',
      sizeBytes: 366_888,
    },
    playback: {
      byteLength: 366_888,
      id: '01111111-2222-4333-8444-555555555555',
      mimeType: 'video/mp4',
      playbackUrl: 'http://127.0.0.1:43123/asset/01111111-2222-4333-8444-555555555555?token=' + 'a'.repeat(64),
    },
    subtitleTrack: null,
  },
  subtitleMarkerVisible: true,
  tools: {
    schemaVersion: 1,
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
    duration: 4,
    height: 360,
    paused: true,
    readyState: 4,
    width: 640,
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
    ], { RUNNER_TEMP: root }), {
      port: 43123, srt, screenshot, priorAssetId: null,
    });
    assert.deepEqual(parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot,
      '--prior-asset-id', PRIOR_ASSET_ID,
    ], { RUNNER_TEMP: root }), {
      port: 43123, srt, screenshot, priorAssetId: PRIOR_ASSET_ID,
    });
    assert.throws(() => parseArguments([
      '--port', '43123', '--srt', srt, '--screenshot', screenshot,
      '--prior-asset-id', 'not-a-uuid',
    ], { RUNNER_TEMP: root }), /asset identity is invalid/);
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
  assert.equal(assertMediaFlowResult(validResult()).video.width, 640);
  assert.deepEqual(collectDownloadJobIds(validResult()), [DOWNLOAD_JOB_A]);
});

test('requires a replaced asset and exactly one successful download created after baseline', () => {
  const staleAsset = validResult();
  assert.throws(() => assertMediaFlowResult(staleAsset, {
    priorAssetId: staleAsset.assetId,
    baselineDownloadJobIds: [],
  }), /retained the prior native asset/);

  const historicalOnly = validResult();
  assert.throws(() => assertMediaFlowResult(historicalOnly, {
    priorAssetId: PRIOR_ASSET_ID,
    baselineDownloadJobIds: [DOWNLOAD_JOB_A],
  }), /newly attributable/);

  const newlyDownloaded = validResult();
  newlyDownloaded.jobs.unshift({
    id: DOWNLOAD_JOB_B,
    kind: 'downloadMedia',
    state: 'succeeded',
    progress: { basisPoints: 10_000 },
  });
  assert.equal(assertMediaFlowResult(newlyDownloaded, {
    priorAssetId: PRIOR_ASSET_ID,
    baselineDownloadJobIds: [DOWNLOAD_JOB_A],
  }), newlyDownloaded);

  const failedNewDownload = validResult();
  failedNewDownload.jobs.push({
    id: DOWNLOAD_JOB_B,
    kind: 'downloadMedia',
    state: 'failed',
    progress: { basisPoints: 10_000 },
  });
  assert.throws(() => assertMediaFlowResult(failedNewDownload, {
    priorAssetId: PRIOR_ASSET_ID,
    baselineDownloadJobIds: [DOWNLOAD_JOB_A],
  }), /newly attributable/);
});

test('rejects subtitle-only, inactive-tool, and accidental render false positives', () => {
  const missingVideo = validResult();
  missingVideo.video = null;
  assert.throws(() => assertMediaFlowResult(missingVideo), /media element/);

  const inactive = validResult();
  inactive.tools.tools[1].activeRuntime = false;
  assert.throws(() => assertMediaFlowResult(inactive), /immediately active/);

  const duplicatedTool = validResult();
  duplicatedTool.tools.tools = [
    TOOL('deno', '2.9.5'),
    TOOL('deno', '2.9.5'),
    TOOL('deno', '2.9.5'),
  ];
  assert.throws(() => assertMediaFlowResult(duplicatedTool), /immediately active/);

  const missingTool = validResult();
  missingTool.tools.tools.pop();
  assert.throws(() => assertMediaFlowResult(missingTool), /immediately active/);

  const extraTool = validResult();
  extraTool.tools.tools.push(TOOL('unreviewed-tool', '1.0.0'));
  assert.throws(() => assertMediaFlowResult(extraTool), /immediately active/);

  for (const mutation of [
    (result) => { result.tools.schemaVersion = 2; },
    (result) => { result.tools.extra = true; },
    (result) => { result.tools.tools[0].extra = true; },
    (result) => { delete result.tools.tools[0].downloadBytes; },
    (result) => { result.tools.tools[0].label = 'Wrong label'; },
    (result) => { result.tools.tools[0].availableVersion = 'different'; },
    (result) => { result.tools.tools[0].installedBytes = 0; },
    (result) => { result.tools.tools[0].installedBytes = 1; },
    (result) => { result.tools.tools[0].downloadBytes = 0; },
    (result) => { result.tools.tools[0].availableInstalledBytes = 0; },
  ]) {
    const malformedTools = validResult();
    mutation(malformedTools);
    assert.throws(() => assertMediaFlowResult(malformedTools), /immediately active/);
  }

  const stalePlayback = validResult();
  stalePlayback.session.playback.id = '11111111-2222-4333-8444-555555555556';
  assert.throws(() => assertMediaFlowResult(stalePlayback), /native session/);

  const wrongPlaybackVersion = validResult();
  wrongPlaybackVersion.session.playback.id = '01111111-2222-7333-8444-555555555555';
  wrongPlaybackVersion.currentFileUrl = wrongPlaybackVersion.currentFileUrl.replace(
    '01111111-2222-4333-8444-555555555555',
    wrongPlaybackVersion.session.playback.id,
  );
  wrongPlaybackVersion.video.currentSrc = wrongPlaybackVersion.currentFileUrl;
  wrongPlaybackVersion.session.playback.playbackUrl = wrongPlaybackVersion.currentFileUrl;
  assert.throws(() => assertMediaFlowResult(wrongPlaybackVersion), /native session/);

  for (const mutation of [
    (result) => { result.session.playback.mimeType = 'video/webm'; },
    (result) => { result.session.playback.byteLength = 1; },
    (result) => { result.session.media.sizeBytes = 1; },
    (result) => { result.session.media.extra = true; },
    (result) => { result.session.subtitleTrack = {}; },
  ]) {
    const malformedSession = validResult();
    mutation(malformedSession);
    assert.throws(() => assertMediaFlowResult(malformedSession), /native session/);
  }

  const render = validResult();
  render.jobs.push({ kind: 'renderVideo', state: 'succeeded', progress: { basisPoints: 10_000 } });
  assert.throws(() => assertMediaFlowResult(render), /download-only job/);

  const applicationFailure = validResult();
  applicationFailure.errorToastMessages = ['Sanitized download failure'];
  assert.throws(() => assertMediaFlowResult(applicationFailure), /error toast/);

  const substitutedMedia = validResult();
  substitutedMedia.playbackBytes.sha256 = 'b'.repeat(64);
  assert.throws(() => assertMediaFlowResult(substitutedMedia), /reviewed fixture bytes/);
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

test('requires immediate native activity after the real media action', () => {
  assert.equal(hasMediaFlowStarted(validResult()), true);
  const inactive = validResult();
  inactive.jobs = [];
  inactive.tools.tools = inactive.tools.tools.map((tool) => ({
    ...tool,
    installed: false,
    operation: null,
    state: 'missing',
  }));
  assert.equal(hasMediaFlowStarted(inactive), false);
  inactive.errorToastMessages = ['Sanitized failure'];
  assert.throws(() => hasMediaFlowStarted(inactive), /failed in the application/);

  const historical = validResult();
  assert.equal(hasMediaFlowStarted(historical, {
    priorAssetId: PRIOR_ASSET_ID,
    baselineDownloadJobIds: [DOWNLOAD_JOB_A],
  }), false);
  historical.jobs.push({
    id: DOWNLOAD_JOB_B,
    kind: 'downloadMedia',
    state: 'running',
    progress: { basisPoints: 0 },
  });
  assert.equal(hasMediaFlowStarted(historical, {
    priorAssetId: PRIOR_ASSET_ID,
    baselineDownloadJobIds: [DOWNLOAD_JOB_A],
  }), true);
});

test('keeps byte verification outside the production WebView CSP boundary', async () => {
  assert.doesNotMatch(MEDIA_RESULT_EXPRESSION, /\bfetch\s*\(/);
  assert.doesNotMatch(MEDIA_RESULT_EXPRESSION, /crypto\.subtle/);
  const bytes = Buffer.alloc(366_888, 0x2a);
  let requestedUrl = null;
  const result = await readPlaybackCapability(validResult().currentFileUrl, {
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'GET');
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-length': String(bytes.length),
          'content-type': 'video/mp4',
        },
      });
    },
    timeoutMs: 1_000,
  });
  assert.equal(requestedUrl, validResult().currentFileUrl);
  assert.deepEqual(result, {
    byteLength: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
});

test('never serializes an opaque playback capability in failures or timeouts', async () => {
  const hostile = validResult();
  hostile.errorToastMessages = [
    `failure currentFileUrl playbackUrl localhost 127.0.0.1 token ${hostile.currentFileUrl}`,
  ];
  let applicationError;
  try {
    hasMediaFlowStarted(hostile);
  } catch (error) {
    applicationError = error;
  }
  const timeoutError = await waitForValue(
    async () => hostile,
    () => false,
    { now: (() => { let tick = 0; return () => ++tick * 10; })(), timeoutMs: 15, delay: async () => {} },
  ).catch((error) => error);
  const sanitized = sanitizeInspectorError(new Error(
    `${hostile.errorToastMessages[0]} at "C:\\Users\\runner admin\\private fixture.mp4" `
      + 'and /home/runner/private-fixture.mp4',
  ));
  const serialized = [
    applicationError?.message,
    timeoutError?.message,
    sanitized,
    JSON.stringify(summarizeMediaFlowFailure(hostile)),
  ].join('\n');
  for (const forbidden of [
    'a'.repeat(64), 'playbackUrl', 'currentFileUrl', 'localhost', '127.0.0.1', 'token',
    'runner admin', 'private fixture.mp4', '/home/runner',
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test('capability read failures are bounded and capability-free', async () => {
  const error = await readPlaybackCapability(validResult().currentFileUrl, {
    fetchImpl: async () => new Response(Buffer.alloc(366_889), {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    }),
    timeoutMs: 1_000,
  }).catch((failure) => failure);
  assert.equal(error.message, 'Installed playback capability could not be verified');
  assert.equal(error.message.includes('127.0.0.1'), false);
  assert.equal(error.message.includes('a'.repeat(64)), false);
});
