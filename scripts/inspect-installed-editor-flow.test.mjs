import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { URL } from 'node:url';

import {
  NATIVE_HISTORY_EXPRESSION,
  assertEditorSnapshot,
  assertNativeHistorySnapshot,
  parseArguments,
  sanitizeEditorError,
  waitForValue,
} from './inspect-installed-editor-flow.mjs';

test('executed history probe resolves the native workspace rather than a removed browser mirror', async () => {
  const id = '019ff572-2132-7ba1-9e9c-5a29894963bf';
  const context = {
    localStorage: { getItem() { throw new Error('legacy media storage is not authority'); } },
    window: { __TAURI_INTERNALS__: { invoke: async (command) => {
      if (command === 'active_workspace_get') return {
        initialized: true, workspace: { cacheId: 'site_fixture_project_alias', projectId: id },
      };
      if (command === 'setting_get') return {
        entries: [{ cacheId: 'site_fixture_project_alias', projectId: id }],
      };
      if (command === 'project_load') return {
        stateVersion: 9,
        tracks: [{ label: 'Cached subtitles', origin: 'legacyJson', cues: [{ text: 'saved' }] }],
      };
      assert.equal(command, 'project_track_history_status');
      return {};
    } } },
  };
  const result = await vm.runInNewContext(NATIVE_HISTORY_EXPRESSION, context);
  assert.equal(result.cacheIdValid, true);
  assert.equal(result.matchingEntryCount, 1);
  assert.equal(result.projectIdValid, true);
  assert.equal(result.text, 'saved');
});

const snapshot = () => ({
  canRedo: false,
  canUndo: true,
  editButtonCount: 1,
  errorToastMessages: [],
  itemCount: 1,
  redoButtonCount: 1,
  text: 'OSG durable editor smoke',
  textInputCount: 0,
  undoButtonCount: 1,
});

test('a stalled editor reports the failed invariant and bounded state without cue contents', async () => {
  let tick = 0;
  const wrong = { ...snapshot(), text: 'private customer subtitle', canUndo: false };
  await assert.rejects(waitForValue(async () => wrong, value => {
    assertEditorSnapshot(value, { text: 'OSG durable editor smoke', canUndo: true, canRedo: false });
    return true;
  }, { stage: 'visible-edited', timeoutMs: 10, now: () => ++tick * 5, delay: async () => {} }), error => {
    assert.match(error.message, /visible-edited/);
    assert.match(error.message, /wrong subtitle rows/);
    assert.match(error.message, /"textKind":"other"/);
    assert.match(error.message, /"canUndo":false/);
    assert.equal(error.message.includes('private customer subtitle'), false);
    return true;
  });
});

const nativeHistory = () => ({
  cacheIdValid: true,
  cueCount: 1,
  matchingEntryCount: 1,
  matchingTrackCount: 1,
  projectIdValid: true,
  projectStateVersion: 9,
  status: {
    canRedo: false,
    canUndo: true,
    diverged: false,
    historyVersion: 7,
    redoReason: null,
    stateVersion: 9,
    undoReason: 'OSG lyrics editor v1: text',
  },
  text: 'OSG durable editor smoke',
});

test('parses only a CI-owned editor screenshot path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-editor-flow-'));
  try {
    const screenshot = path.join(root, 'capture.png');
    assert.deepEqual(parseArguments([
      '--port', '43123', '--screenshot', screenshot,
    ], { RUNNER_TEMP: root }), { port: 43123, screenshot });
    assert.throws(() => parseArguments([
      '--port', '43123', '--screenshot', path.join(root, '..', 'escape.png'),
    ], { RUNNER_TEMP: root }), /Screenshot must stay/);
    assert.throws(() => parseArguments([
      '--port', '80', '--screenshot', screenshot,
    ], { RUNNER_TEMP: root }), /unprivileged/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts an exact edited row and durable navigation controls', () => {
  assert.equal(assertEditorSnapshot(snapshot(), {
    text: 'OSG durable editor smoke', canUndo: true, canRedo: false,
  }).itemCount, 1);
});

test('accepts only the authoritative native project cursor and subtitle track', () => {
  assert.equal(assertNativeHistorySnapshot(nativeHistory(), {
    text: 'OSG durable editor smoke',
    canUndo: true,
    canRedo: false,
    minimumHistoryVersion: 7,
  }).status.historyVersion, 7);

  const optimisticOnly = nativeHistory();
  optimisticOnly.status.historyVersion = 6;
  assert.throws(() => assertNativeHistorySnapshot(optimisticOnly, {
    text: optimisticOnly.text,
    canUndo: true,
    canRedo: false,
    minimumHistoryVersion: 7,
  }), /stale native history cursor/);

  const tornRead = nativeHistory();
  tornRead.projectStateVersion = 8;
  assert.throws(() => assertNativeHistorySnapshot(tornRead, {
    text: tornRead.text,
    canUndo: true,
    canRedo: false,
  }), /stale native history cursor/);

  const wrongTrack = nativeHistory();
  wrongTrack.text = 'stale native row';
  assert.throws(() => assertNativeHistorySnapshot(wrongTrack, {
    text: 'OSG durable editor smoke',
    canUndo: true,
    canRedo: false,
  }), /authoritative subtitle row/);
});

test('allows React to commit the controlled input before submitting the edit', async () => {
  const source = await fs.promises.readFile(
    new URL('./inspect-installed-editor-flow.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /dispatchEvent\(new Event\('input'/);
  assert.match(source, /await new Promise\(\(resolve\) => setTimeout\(resolve, 100\)\)/);
  assert.ok(source.indexOf("dispatchEvent(new Event('input'")
    < source.indexOf("dispatchEvent(new KeyboardEvent('keydown'"));
});

test('rejects path fields, wrong rows, stale controls, and error toasts', () => {
  const leaked = snapshot();
  leaked.path = 'C:\\fixture.srt';
  assert.throws(() => assertEditorSnapshot(leaked, {
    text: leaked.text, canUndo: true, canRedo: false,
  }), /invalid snapshot/);

  const wrongText = snapshot();
  assert.throws(() => assertEditorSnapshot(wrongText, {
    text: 'different', canUndo: true, canRedo: false,
  }), /wrong subtitle rows/);

  const stale = snapshot();
  stale.canRedo = true;
  assert.throws(() => assertEditorSnapshot(stale, {
    text: stale.text, canUndo: true, canRedo: false,
  }), /wrong undo\/redo/);

  const missingButtons = snapshot();
  missingButtons.canUndo = null;
  assert.throws(() => assertEditorSnapshot(missingButtons, {
    text: missingButtons.text, canUndo: true, canRedo: false,
  }), /wrong undo\/redo/);

  const ambiguousButtons = snapshot();
  ambiguousButtons.editButtonCount = 2;
  assert.throws(() => assertEditorSnapshot(ambiguousButtons, {
    text: ambiguousButtons.text, canUndo: true, canRedo: false,
  }), /ambiguous editor controls/);

  const failed = snapshot();
  failed.errorToastMessages = ['Sanitized editor failure'];
  assert.throws(() => assertEditorSnapshot(failed, {
    text: failed.text, canUndo: true, canRedo: false,
  }), /error toast/);
});

test('waits for an accepted editor state and bounds a stalled revision', async () => {
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

test('wait failures and evaluation diagnostics cannot serialize inspected state', async () => {
  const source = await fs.promises.readFile(
    new URL('./inspect-installed-editor-flow.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /JSON\.stringify\(lastValue\)/);
  assert.doesNotMatch(source, /exceptionDetails\?\.text/);
  assert.match(source, /project\.subtitleCacheIndex\.v1/);
  assert.match(source, /project_track_history_status/);
});

test('redacts bounded editor failures before writing stderr', () => {
  const secret = 'a'.repeat(64);
  const sanitized = sanitizeEditorError(new Error(
    `ENOENT C:\\runner\\private\\capture.png http://127.0.0.1:43123/asset/id?token=${secret}`,
  ));
  assert.doesNotMatch(sanitized, /C:\\runner|127\.0\.0\.1|token|a{64}/i);
  assert.match(sanitized, /<redacted-path>/);
  assert.ok(sanitized.length <= 2_048);
});
