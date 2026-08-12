import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LOCAL_MEDIA_RESULT_EXPRESSION,
  assertLocalMediaResult,
  parseArguments,
  waitForValue,
} from './inspect-installed-local-media-flow.mjs';
import { sanitizeInspectorError } from './inspect-installed-media-flow.mjs';

const assetId = '019ff572-2132-7ba1-9e9c-5a29894963bf';
const playbackUrl = 'http://127.0.0.1:43123/asset/01111111-2222-4333-8444-555555555555?token='
  + 'a'.repeat(64);
const playbackId = '01111111-2222-4333-8444-555555555555';
const fileName = 'osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4';

const validResult = () => ({
  assetId,
  currentFileUrl: playbackUrl,
  displayedFileName: fileName,
  errorToastMessages: [],
  htmlFileInput: { fileCount: 0, value: '' },
  inspection: {
    assetId,
    audioCodec: 'aac',
    compatibilityAction: 'direct',
    durationUs: 4_000_000,
    frameRate: 24,
    hasAudio: true,
    hasVideo: true,
    height: 360,
    issues: [],
    videoCodec: 'h264',
    width: 640,
  },
  playbackBytes: {
    byteLength: 366_888,
    sha256: 'aecf6c8ef3977cd4525261ccadb4086581bd911cb17cc97128cfd8640c6055db',
  },
  session: {
    media: {
      displayName: fileName,
      extension: 'mp4',
      id: assetId,
      kind: 'video',
      sizeBytes: 366_888,
    },
    playback: {
      byteLength: 366_888,
      id: playbackId,
      mimeType: 'video/mp4',
      playbackUrl,
    },
    subtitleTrack: null,
  },
  video: {
    currentSrc: playbackUrl,
    duration: 4,
    height: 360,
    paused: true,
    readyState: 4,
    width: 640,
  },
});

test('parses only a bounded name and CI-owned screenshot path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-local-media-flow-'));
  try {
    const screenshot = path.join(root, 'capture.png');
    assert.deepEqual(parseArguments([
      '--port', '43123', '--expected-file-name', fileName, '--screenshot', screenshot,
    ], { RUNNER_TEMP: root }), { port: 43123, expectedFileName: fileName, screenshot });
    assert.throws(() => parseArguments([
      '--port', '43123', '--expected-file-name', '../escape.mp4', '--screenshot', screenshot,
    ], { RUNNER_TEMP: root }), /filename is invalid/);
    assert.throws(() => parseArguments([
      '--port', '43123', '--expected-file-name', fileName,
      '--screenshot', path.join(root, '..', 'escape.png'),
    ], { RUNNER_TEMP: root }), /Screenshot must stay/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts the exact opaque local-media session and decoded fixture', () => {
  assert.equal(assertLocalMediaResult(validResult(), fileName).video.width, 640);
});

test('rejects WebView path injection, missing audio, and a stale visible capability', () => {
  const pathLeak = validResult();
  pathLeak.htmlFileInput = { fileCount: 1, value: 'C:\\fakepath\\fixture.mp4' };
  assert.throws(() => assertLocalMediaResult(pathLeak, fileName), /injected a path/);

  const missingAudio = validResult();
  missingAudio.inspection.hasAudio = false;
  assert.throws(() => assertLocalMediaResult(missingAudio, fileName), /native inspection/);

  const stale = validResult();
  stale.video.currentSrc = `${playbackUrl}b`;
  assert.throws(() => assertLocalMediaResult(stale, fileName), /media element/);
});

test('rejects fixture-byte drift and non-v4 playback identities', () => {
  const changedBytes = validResult();
  changedBytes.playbackBytes.sha256 = 'b'.repeat(64);
  assert.throws(() => assertLocalMediaResult(changedBytes, fileName), /playback bytes/);

  const changedSessionBytes = validResult();
  changedSessionBytes.session.media.sizeBytes -= 1;
  changedSessionBytes.session.playback.byteLength -= 1;
  assert.throws(() => assertLocalMediaResult(changedSessionBytes, fileName), /session and visible/);

  const invalidPlaybackId = '01111111-2222-7333-8444-555555555555';
  const invalidUrl = playbackUrl.replace(playbackId, invalidPlaybackId);
  const invalidPlayback = validResult();
  invalidPlayback.currentFileUrl = invalidUrl;
  invalidPlayback.session.playback.id = invalidPlaybackId;
  invalidPlayback.session.playback.playbackUrl = invalidUrl;
  invalidPlayback.video.currentSrc = invalidUrl;
  assert.throws(() => assertLocalMediaResult(invalidPlayback, fileName), /playback identity/);
});

test('waits for an accepted local-media state and bounds a stalled dialog', async () => {
  let reads = 0;
  const accepted = await waitForValue(
    async () => ({ ready: ++reads >= 2 }),
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

test('keeps local capability reads outside WebView and redacts hostile stalled state', async () => {
  assert.doesNotMatch(LOCAL_MEDIA_RESULT_EXPRESSION, /\bfetch\s*\(/);
  assert.doesNotMatch(LOCAL_MEDIA_RESULT_EXPRESSION, /crypto\.subtle/);
  const hostile = validResult();
  hostile.errorToastMessages = [
    `failure currentFileUrl playbackUrl localhost 127.0.0.1 token ${playbackUrl}`,
  ];
  let ticks = 0;
  const timeout = await waitForValue(
    async () => hostile,
    () => false,
    { now: () => ++ticks * 10, timeoutMs: 15, delay: async () => {} },
  ).catch((error) => error);
  const serialized = `${timeout.message}\n${sanitizeInspectorError(
    new Error(hostile.errorToastMessages[0]),
  )}`;
  for (const forbidden of [
    'a'.repeat(64), 'playbackUrl', 'currentFileUrl', 'localhost', '127.0.0.1', 'token',
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});
