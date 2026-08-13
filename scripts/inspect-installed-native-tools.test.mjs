import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertActiveCapabilities,
  assertNativeToolsStatus,
  assertRemovedCapabilities,
  assertToolDomState,
  parseArguments,
  waitForValue,
} from './inspect-installed-native-tools.mjs';

const toolIds = ['deno', 'media-tools', 'yt-dlp'];
const labels = { deno: 'Deno', 'media-tools': 'FFmpeg and FFprobe', 'yt-dlp': 'yt-dlp' };
const assetId = '019ff572-2132-7ba1-9e9c-5a29894963bf';
const jobIds = [
  '019ff572-2132-7ba1-9e9c-5a29894963ba',
  '019ff572-2132-7ba1-9e9c-5a29894963bb',
  '019ff572-2132-7ba1-9e9c-5a29894963bc',
];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const statusEntry = (id, expected, index) => ({
  id,
  label: labels[id],
  deliveryAvailable: true,
  installed: expected === 'installed',
  state: expected === 'installed' ? 'installed' : 'missing',
  version: expected === 'installed' ? `v-${id}` : null,
  availableVersion: `v-${id}`,
  installedBytes: expected === 'installed' ? 2_000 + index : 0,
  downloadBytes: 1_000 + index,
  availableInstalledBytes: 2_000 + index,
  activeRuntime: expected === 'installed',
  pendingRemoval: false,
  restartRequired: false,
  operation: expected === 'installing' ? {
    job: {
      id: jobIds[index],
      kind: 'installEngine',
      state: 'running',
      progress: { basisPoints: 2_500 },
      sequence: 2,
    },
    tool: id,
    action: 'install',
    phase: 'downloading',
    basisPoints: 2_500,
    bytesDone: 250,
    totalBytes: 1_000,
  } : null,
});

const status = (expected) => ({
  schemaVersion: 1,
  tools: toolIds.map((id, index) => statusEntry(id, expected, index)),
});

const domState = (expected) => ({
  settingsOpen: true,
  panelActive: true,
  errorCount: 0,
  rows: toolIds.map((id) => ({
    id,
    state: expected,
    actions: [expected === 'missing' ? 'install' : expected === 'installing'
      ? 'cancel' : 'remove-request'],
  })),
});

const download = (overrides = {}) => ({
  available: true,
  inspectAvailable: true,
  version: '2026.07.04',
  reason: null,
  maxConcurrentDownloads: 4,
  inventoryTtlSeconds: 900,
  ...overrides,
});

const pipeline = (overrides = {}) => ({
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
  ...overrides,
});

test('parses only one asset and two CI-owned screenshot paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-native-tools-'));
  try {
    const installingScreenshot = path.join(root, 'installing.png');
    const installedScreenshot = path.join(root, 'installed.png');
    assert.deepEqual(parseArguments([
      '--port', '43123', '--asset-id', assetId,
      '--installing-screenshot', installingScreenshot,
      '--installed-screenshot', installedScreenshot,
    ], { RUNNER_TEMP: root }), {
      port: 43123, assetId, installingScreenshot, installedScreenshot,
    });
    assert.throws(() => parseArguments([
      '--port', '43123', '--asset-id', assetId.toUpperCase(),
      '--installing-screenshot', installingScreenshot,
      '--installed-screenshot', installedScreenshot,
    ], { RUNNER_TEMP: root }), /asset identity/);
    assert.throws(() => parseArguments([
      '--port', '43123', '--asset-id', assetId,
      '--installing-screenshot', path.join(root, '..', 'escape.png'),
      '--installed-screenshot', installedScreenshot,
    ], { RUNNER_TEMP: root }), /RUNNER_TEMP/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frontend exposes the reviewed nonvisual settings and native-tool actions', () => {
  const header = fs.readFileSync(path.join(repositoryRoot, 'src/components/Header.js'), 'utf8');
  const settings = fs.readFileSync(
    path.join(repositoryRoot, 'src/components/settings/SettingsModal.js'), 'utf8',
  );
  const tools = fs.readFileSync(
    path.join(repositoryRoot, 'src/components/engines/NativeToolsList.js'), 'utf8',
  );
  assert.match(header, /data-app-action="open-settings"/);
  assert.match(settings, /data-settings-tab="tools"/);
  assert.match(settings, /data-settings-panel="tools"/);
  assert.match(settings, /data-settings-action="close"/);
  assert.match(tools, /data-native-tool-id=\{catalog\.id\}/);
  for (const action of ['remove-request', 'remove-confirm', 'remove-cancel', 'install', 'cancel']) {
    assert.match(tools, new RegExp(`data-tool-action="${action}"`));
  }
});

test('accepts exact missing, simultaneous installing, and hot installed status', () => {
  assert.deepEqual(assertNativeToolsStatus(status('missing'), 'missing').tools.map(({ id }) => id), toolIds);
  assert.deepEqual(
    assertNativeToolsStatus(status('installing'), 'installing').tools.map(({ jobId }) => jobId),
    jobIds,
  );
  assert.deepEqual(
    assertNativeToolsStatus(status('installed'), 'installed').tools.map(({ version }) => version),
    toolIds.map((id) => `v-${id}`),
  );
});

test('rejects stale runtime, duplicate jobs, deferred removal, and schema drift', () => {
  const stale = status('missing');
  stale.tools[0].activeRuntime = true;
  assert.throws(() => assertNativeToolsStatus(stale, 'missing'), /complete removal/);
  const duplicate = status('installing');
  duplicate.tools[1].operation.job.id = duplicate.tools[0].operation.job.id;
  assert.throws(() => assertNativeToolsStatus(duplicate, 'installing'), /distinct jobs/);
  for (const invalidJob of [{ state: 'queued' }, { state: 'cancelling' }, { sequence: 0 }]) {
    const invalidStatus = status('installing');
    Object.assign(invalidStatus.tools[0].operation.job, invalidJob);
    assert.throws(() => assertNativeToolsStatus(invalidStatus, 'installing'), /invalid job/);
  }
  const deferredRemoval = status('installed');
  deferredRemoval.tools[0].pendingRemoval = true;
  deferredRemoval.tools[0].restartRequired = true;
  assert.throws(() => assertNativeToolsStatus(deferredRemoval, 'installed'), /catalog entry/);
  const extra = status('installed');
  extra.tools[0].path = 'private';
  assert.throws(() => assertNativeToolsStatus(extra, 'installed'), /catalog entry/);
});

test('requires exact semantic UI rows without errors', () => {
  for (const expected of ['missing', 'installing', 'installed']) {
    assert.equal(assertToolDomState(domState(expected), expected).rows.length, 3);
  }
  const wrongAction = domState('missing');
  wrongAction.rows[0].actions = ['remove-request'];
  assert.throws(() => assertToolDomState(wrongAction, 'missing'), /row state/);
  const error = domState('installed');
  error.errorCount = 1;
  assert.throws(() => assertToolDomState(error, 'installed'), /Tools panel/);
});

test('proves removed capabilities and real hot consumer reactivation', () => {
  assert.equal(assertRemovedCapabilities({
    download: download({
      available: false, inspectAvailable: false, version: null, reason: 'downloaderUnavailable',
    }),
    pipelineErrorCode: 'mediaToolsUnavailable',
  }).pipelineErrorCode, 'mediaToolsUnavailable');
  assert.equal(assertActiveCapabilities({ download: download(), pipeline: pipeline() }, assetId)
    .pipeline.width, 640);
  assert.throws(() => assertRemovedCapabilities({
    download: download({
      available: false, inspectAvailable: true, version: null, reason: 'downloaderUnavailable',
    }),
    pipelineErrorCode: 'mediaToolsUnavailable',
  }), /deactivate/);
  assert.throws(() => assertActiveCapabilities({
    download: download(), pipeline: pipeline({ assetId: jobIds[0] }),
  }, assetId), /reactivate/);
  assert.throws(() => assertActiveCapabilities({
    download: download(), pipeline: pipeline({ frameRate: 'garbage' }),
  }, assetId), /reactivate/);
  assert.throws(() => assertActiveCapabilities({
    download: download(), pipeline: pipeline({ durationUs: '4000000' }),
  }, assetId), /reactivate/);
});

test('bounds a stalled UI state', async () => {
  let time = 0;
  await assert.rejects(() => waitForValue(
    async () => ({ state: 'missing' }),
    (value) => value.state === 'installed',
    { timeoutMs: 2, now: () => time++, delay: async () => {} },
  ), /timed out/);
});
