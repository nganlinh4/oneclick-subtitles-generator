import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  CLICK_PICKER_EXPRESSION,
  LOCAL_MEDIA_RESULT_EXPRESSION,
  OPEN_PICKER_EXPRESSION,
  PICKER_CONTROL_READY_EXPRESSION,
  assertLocalMediaResult,
  assertPriorMediaState,
  parseArguments,
  waitForValue,
  writePickerPhase,
} from './inspect-installed-local-media-flow.mjs';
import { sanitizeInspectorError } from './inspect-installed-media-flow.mjs';

const assetId = '019ff572-2132-7ba1-9e9c-5a29894963bf';
const priorAssetId = '019ff572-2132-7ba1-9e9c-5a29894963be';
const playbackUrl = 'http://127.0.0.1:43123/asset/01111111-2222-4333-8444-555555555555?token='
  + 'a'.repeat(64);
const playbackId = '01111111-2222-4333-8444-555555555555';
const fileName = 'osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4';
const repositoryRoot = path.resolve(import.meta.dirname, '..');

const pickerExpressionHarness = ({
  activeIndices = [1],
  includeControl = true,
  includeInput = true,
  duplicateContainer = false,
  duplicateControl = false,
} = {}) => {
  class FakeElement {}
  class FakeButton extends FakeElement {
    constructor(index) {
      super();
      this.active = activeIndices.includes(index);
      this.clicks = 0;
      this.classList = {
        contains: (name) => name === 'tab-btn' || (name === 'active' && this.active),
      };
    }

    click() {
      this.clicks += 1;
      buttons.forEach((button) => { button.active = false; });
      this.active = true;
    }
  }
  class FakeInput extends FakeElement {}
  class FakeDiv extends FakeElement {
    constructor() {
      super();
      this.clicks = 0;
    }

    querySelector(selector) {
      if (selector !== ':scope > input.hidden-file-input[type="file"]') return null;
      return includeInput ? input : null;
    }

    click() {
      this.clicks += 1;
    }
  }
  const buttons = [new FakeButton(0), new FakeButton(1)];
  const tabList = new FakeElement();
  tabList.children = buttons;
  buttons.forEach((button) => { button.parentElement = tabList; });
  const input = new FakeInput();
  const picker = new FakeDiv();
  const secondPicker = new FakeDiv();
  const container = new FakeElement();
  container.querySelectorAll = (selector) => {
    if (selector === ':scope > .input-header > .input-tabs > button[data-input-tab="file-upload"]') {
      return [buttons[1]];
    }
    if (selector === ':scope > .tab-content-wrapper div.file-upload-input:not(.loading)') {
      if (!includeControl) return [];
      return duplicateControl ? [picker, secondPicker] : [picker];
    }
    return [];
  };
  const document = {
    querySelectorAll: (selector) => selector === '.input-methods-container'
      ? duplicateContainer ? [container, new FakeElement()] : [container]
      : [],
  };
  const context = {
    document,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeButton,
    HTMLDivElement: FakeDiv,
    HTMLInputElement: FakeInput,
  };
  return {
    buttons,
    picker,
    click: () => vm.runInNewContext(CLICK_PICKER_EXPRESSION, context),
    open: () => vm.runInNewContext(OPEN_PICKER_EXPRESSION, context),
    ready: () => vm.runInNewContext(PICKER_CONTROL_READY_EXPRESSION, context),
  };
};

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
      '--phase-directory', root, '--prior-asset-id', priorAssetId,
    ], { RUNNER_TEMP: root }), {
      port: 43123, expectedFileName: fileName, screenshot, phaseDirectory: root,
      priorAssetId,
    });
    assert.throws(() => parseArguments([
      '--port', '43123', '--expected-file-name', '../escape.mp4', '--screenshot', screenshot,
      '--phase-directory', root, '--prior-asset-id', priorAssetId,
    ], { RUNNER_TEMP: root }), /filename is invalid/);
    assert.throws(() => parseArguments([
      '--port', '43123', '--expected-file-name', fileName,
      '--screenshot', path.join(root, '..', 'escape.png'),
      '--phase-directory', root, '--prior-asset-id', priorAssetId,
    ], { RUNNER_TEMP: root }), /Screenshot must stay/);
    assert.throws(() => parseArguments([
      '--port', '43123', '--expected-file-name', fileName, '--screenshot', screenshot,
      '--phase-directory', root, '--prior-asset-id', priorAssetId.toUpperCase(),
    ], { RUNNER_TEMP: root }), /prior.*identity is invalid/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writes each bounded picker handshake phase exactly once inside RUNNER_TEMP', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-local-media-phases-'));
  try {
    for (const stage of ['starting', 'connected', 'control-ready', 'click-issued']) {
      writePickerPhase(root, stage);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(
          root, `osg-installed-native-picker-${stage}.json`,
        ), 'utf8')),
        { schemaVersion: 1, stage },
      );
      assert.equal(fs.existsSync(path.join(
        root, `osg-installed-native-picker-${stage}.json.tmp`,
      )), false);
      const original = fs.readFileSync(path.join(
        root, `osg-installed-native-picker-${stage}.json`,
      ));
      assert.throws(() => writePickerPhase(root, stage), /EEXIST/);
      assert.deepEqual(fs.readFileSync(path.join(
        root, `osg-installed-native-picker-${stage}.json`,
      )), original);
    }
    assert.throws(() => writePickerPhase(root, '../escape'), /phase is invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserves the primary picker-phase publication failure when cleanup also fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-local-media-phase-failure-'));
  const originalLink = fs.linkSync;
  const originalUnlink = fs.unlinkSync;
  try {
    fs.linkSync = () => {
      const error = new Error('primary picker-phase publication failure');
      error.code = 'EPERM';
      throw error;
    };
    fs.unlinkSync = () => {
      const error = new Error('secondary picker-phase cleanup failure');
      error.code = 'EACCES';
      throw error;
    };
    assert.throws(
      () => writePickerPhase(root, 'starting'),
      (error) => error?.message === 'primary picker-phase publication failure',
    );
  } finally {
    fs.linkSync = originalLink;
    fs.unlinkSync = originalUnlink;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts the exact opaque local-media session and decoded fixture', () => {
  assert.equal(assertLocalMediaResult(validResult(), fileName, priorAssetId).video.width, 640);
  assert.deepEqual(
    assertPriorMediaState(
      { assetId: priorAssetId, sessionMediaId: priorAssetId },
      priorAssetId,
      'already-active',
    ),
    { assetId: priorAssetId, sessionMediaId: priorAssetId },
  );
  assert.deepEqual(
    assertPriorMediaState(
      { assetId: null, sessionMediaId: priorAssetId },
      priorAssetId,
      'activated',
    ),
    { assetId: null, sessionMediaId: priorAssetId },
  );
});

test('does not re-click an active Upload File tab and activates it only when necessary', () => {
  const inputMethodsSource = fs.readFileSync(
    path.join(repositoryRoot, 'src/components/InputMethods.js'), 'utf8',
  );
  assert.equal((inputMethodsSource.match(/data-input-tab="file-upload"/g) || []).length, 1);
  assert.match(
    inputMethodsSource,
    /<button\s+className=\{`tab-btn \$\{activeTab === 'file-upload' \? 'active' : ''\}`\}\s+data-input-tab="file-upload"\s+onClick=\{\(\) => setActiveTab\('file-upload'\)\}\s*>/,
  );
  const alreadyActive = pickerExpressionHarness();
  assert.equal(alreadyActive.open(), 'already-active');
  assert.equal(alreadyActive.buttons[1].clicks, 0);
  assert.equal(alreadyActive.ready(), true);
  assert.equal(alreadyActive.click(), true);
  assert.equal(alreadyActive.buttons[1].clicks, 0);
  assert.equal(alreadyActive.picker.clicks, 1);

  const inactive = pickerExpressionHarness({ activeIndices: [0] });
  assert.equal(inactive.open(), 'activated');
  assert.equal(inactive.buttons[1].clicks, 1);
  assert.equal(inactive.ready(), true);
  assert.equal(inactive.click(), true);
  assert.equal(inactive.buttons[1].clicks, 1);
  assert.equal(inactive.picker.clicks, 1);
});

test('fails closed on ambiguous tab state, incomplete controls, and prior-asset drift', () => {
  for (const activeIndices of [[], [0, 1]]) {
    const ambiguous = pickerExpressionHarness({ activeIndices });
    assert.equal(ambiguous.open(), null);
    assert.equal(ambiguous.buttons[1].clicks, 0);
    assert.equal(ambiguous.ready(), false);
  }
  assert.equal(pickerExpressionHarness({ includeControl: false }).ready(), false);
  assert.equal(pickerExpressionHarness({ includeInput: false }).ready(), false);
  assert.equal(pickerExpressionHarness({ duplicateContainer: true }).click(), false);
  assert.equal(pickerExpressionHarness({ duplicateControl: true }).click(), false);

  for (const [state, activation] of [
    [{ assetId: null, sessionMediaId: priorAssetId }, 'already-active'],
    [{ assetId: priorAssetId, sessionMediaId: priorAssetId }, 'activated'],
    [{ assetId, sessionMediaId: priorAssetId }, 'already-active'],
    [{ assetId: null, sessionMediaId: assetId }, 'activated'],
    [{ assetId: priorAssetId, sessionMediaId: priorAssetId }, 'unknown'],
  ]) {
    assert.throws(
      () => assertPriorMediaState(state, priorAssetId, activation),
      /(?:tab activation is invalid|reviewed prior native asset)/,
    );
  }
});

test('rejects WebView path injection, missing audio, and a stale visible capability', () => {
  const pathLeak = validResult();
  pathLeak.htmlFileInput = { fileCount: 1, value: 'C:\\fakepath\\fixture.mp4' };
  assert.throws(() => assertLocalMediaResult(pathLeak, fileName, priorAssetId), /injected a path/);

  const missingAudio = validResult();
  missingAudio.inspection.hasAudio = false;
  assert.throws(() => assertLocalMediaResult(missingAudio, fileName, priorAssetId), /native inspection/);

  const stale = validResult();
  stale.video.currentSrc = `${playbackUrl}b`;
  assert.throws(() => assertLocalMediaResult(stale, fileName, priorAssetId), /media element/);

  const stalePrior = validResult();
  stalePrior.assetId = priorAssetId;
  stalePrior.session.media.id = priorAssetId;
  stalePrior.inspection.assetId = priorAssetId;
  assert.throws(
    () => assertLocalMediaResult(stalePrior, fileName, priorAssetId),
    /retained the prior URL asset/,
  );
  assert.throws(
    () => assertPriorMediaState(
      { assetId, sessionMediaId: priorAssetId }, priorAssetId, 'already-active',
    ),
    /reviewed prior native asset/,
  );
});

test('rejects fixture-byte drift and non-v4 playback identities', () => {
  const changedBytes = validResult();
  changedBytes.playbackBytes.sha256 = 'b'.repeat(64);
  assert.throws(() => assertLocalMediaResult(changedBytes, fileName, priorAssetId), /playback bytes/);

  const changedSessionBytes = validResult();
  changedSessionBytes.session.media.sizeBytes -= 1;
  changedSessionBytes.session.playback.byteLength -= 1;
  assert.throws(() => assertLocalMediaResult(changedSessionBytes, fileName, priorAssetId), /session and visible/);

  const invalidPlaybackId = '01111111-2222-7333-8444-555555555555';
  const invalidUrl = playbackUrl.replace(playbackId, invalidPlaybackId);
  const invalidPlayback = validResult();
  invalidPlayback.currentFileUrl = invalidUrl;
  invalidPlayback.session.playback.id = invalidPlaybackId;
  invalidPlayback.session.playback.playbackUrl = invalidUrl;
  invalidPlayback.video.currentSrc = invalidUrl;
  assert.throws(() => assertLocalMediaResult(invalidPlayback, fileName, priorAssetId), /playback identity/);
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
