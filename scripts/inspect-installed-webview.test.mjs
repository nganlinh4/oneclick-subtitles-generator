import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertInspection,
  assertPersistence,
  parseArguments,
  selectTauriTarget,
  waitForInspection,
} from './inspect-installed-webview.mjs';

const validInspection = Object.freeze({
  readyState: 'complete',
  rootChildren: 1,
  rootWidth: 1400,
  rootHeight: 900,
  managedFont: true,
  managedFontStyle: true,
  fontReadyClass: true,
  fontLoaded: true,
  bodyFontFamily: '"Google Sans", "Open Sans", sans-serif',
  health: {
    appVersion: '1.0.0-rc.1',
    architecture: 'x86_64',
    platform: 'windows',
  },
});

const projectId = '018f0e4a-7b3c-7def-8abc-0123456789ab';
const project = Object.freeze({
  metadata: { id: projectId, name: 'OSG installed lifecycle probe committed' },
  stateVersion: 3,
  media: [],
  tracks: [],
});
const history = Object.freeze({
  stateVersion: 3,
  canUndo: true,
  canRedo: false,
  undoReason: 'OSG installed lifecycle revision',
  redoReason: null,
});
const persistence = Object.freeze({
  setting: JSON.stringify({
    schemaVersion: 1,
    version: '1.0.0-rc.1',
    purpose: 'installed-lifecycle',
    projectId,
  }),
  project,
  loaded: project,
  history,
  lifecycle: null,
});

test('installed WebView CLI accepts only the bounded inspection contract', () => {
  assert.deepEqual(parseArguments([
    '--port', '54321',
    '--expected-version', '1.0.0-rc.1',
    '--screenshot', 'capture.png',
    '--phase', 'first-launch',
  ]), {
    port: 54321,
    expectedVersion: '1.0.0-rc.1',
    screenshot: 'capture.png',
    phase: 'first-launch',
    expectedProjectId: undefined,
  });
  assert.throws(() => parseArguments([
    '--port', '80', '--expected-version', '1.0.0', '--screenshot', 'capture.png',
    '--phase', 'first-launch',
  ]), /unprivileged/);
  assert.throws(() => parseArguments([
    '--port', '54321', '--expected-version', 'latest', '--screenshot', 'capture.png',
    '--phase', 'first-launch',
  ]), /semantic/);
  assert.throws(() => parseArguments([
    '--port', '54321', '--expected-version', '1.0.0', '--screenshot', 'capture.png',
    '--phase', 'first-launch', '--extra', 'x',
  ]), /Only/);
  assert.equal(parseArguments([
    '--port', '54321', '--expected-version', '1.0.0', '--screenshot', 'capture.png',
    '--phase', 'relaunch', '--expected-project-id', projectId,
  ]).expectedProjectId, projectId);
  assert.throws(() => parseArguments([
    '--port', '54321', '--expected-version', '1.0.0', '--screenshot', 'capture.png',
    '--phase', 'relaunch', '--expected-project-id', 'not-an-id',
  ]), /UUIDv7/);
});

test('persistence requires exact settings and project snapshots across every phase', () => {
  const initialProject = {
    ...project,
    metadata: { ...project.metadata, name: 'OSG installed lifecycle probe' },
    stateVersion: 2,
  };
  const firstLaunch = {
    ...persistence,
    lifecycle: {
      commit: { revisionId: '018f0e4a-7b3c-7def-8abc-0123456789ac', stateVersion: 1 },
      afterCommit: { ...project, stateVersion: 1 },
      statusAfterCommit: { ...history, stateVersion: 1 },
      undo: initialProject,
      statusAfterUndo: {
        stateVersion: 2,
        canUndo: false,
        canRedo: true,
        undoReason: null,
        redoReason: 'OSG installed lifecycle revision',
      },
      redo: project,
    },
  };
  assert.deepEqual(assertPersistence(firstLaunch, {
    phase: 'first-launch', expectedVersion: '1.0.0-rc.1', expectedProjectId: undefined,
  }), { projectId });
  for (const lifecycle of [
    { ...firstLaunch.lifecycle, extra: true },
    {
      ...firstLaunch.lifecycle,
      statusAfterUndo: { ...firstLaunch.lifecycle.statusAfterUndo, canUndo: true },
    },
    {
      ...firstLaunch.lifecycle,
      redo: { ...project, metadata: { ...project.metadata, name: 'Drifted' } },
    },
  ]) {
    assert.throws(() => assertPersistence({ ...firstLaunch, lifecycle }, {
      phase: 'first-launch', expectedVersion: '1.0.0-rc.1', expectedProjectId: undefined,
    }));
  }
  assert.deepEqual(assertPersistence(persistence, {
    phase: 'relaunch', expectedVersion: '1.0.0-rc.1', expectedProjectId: projectId,
  }), { projectId });
  for (const mutation of [
    { setting: `${persistence.setting}forbidden` },
    { setting: persistence.setting.replace('1.0.0-rc.1', '1.0.0') },
    { project: { ...project, stateVersion: 1 } },
    { loaded: null },
  ]) {
    assert.throws(() => assertPersistence({ ...persistence, ...mutation }, {
      phase: 'relaunch', expectedVersion: '1.0.0-rc.1', expectedProjectId: projectId,
    }));
  }
});

test('target selection accepts one exact Tauri page on the requested loopback port', () => {
  const target = {
    type: 'page',
    url: 'https://tauri.localhost/',
    webSocketDebuggerUrl: 'ws://127.0.0.1:54321/devtools/page/opaque',
  };
  assert.equal(selectTauriTarget([target], 54321), target);
  assert.throws(() => selectTauriTarget([{ ...target, url: 'https://example.com/' }], 54321),
    /exactly one/);
  assert.throws(() => selectTauriTarget([{ ...target, webSocketDebuggerUrl: 'ws://example.com:54321/x' }], 54321),
    /loopback-only/);
  assert.throws(() => selectTauriTarget([{ ...target, webSocketDebuggerUrl: 'ws://127.0.0.1:54322/x' }], 54321),
    /requested loopback port/);
});

test('inspection requires rendered UI, managed fonts, and real Windows IPC', () => {
  assert.equal(assertInspection(validInspection, '1.0.0-rc.1'), validInspection);
  for (const mutation of [
    { rootChildren: 0 },
    { rootWidth: 999 },
    { managedFont: false },
    { managedFontStyle: false },
    { fontReadyClass: false },
    { fontLoaded: false },
    { bodyFontFamily: 'Arial' },
    { health: { ...validInspection.health, appVersion: '1.0.0' } },
    { health: { ...validInspection.health, architecture: 'aarch64' } },
  ]) {
    assert.throws(() => assertInspection({ ...validInspection, ...mutation }, '1.0.0-rc.1'));
  }
});

test('inspection waits for the real page instead of trusting native setup timing', async () => {
  const responses = [
    { result: { value: { ...validInspection, readyState: 'loading', rootChildren: 0 } } },
    { result: { value: validInspection } },
  ];
  let attempts = 0;
  await expectReady();
  assert.equal(attempts, 2);

  async function expectReady() {
    const result = await waitForInspection(
      async () => {
        attempts += 1;
        return responses.shift();
      },
      '1.0.0-rc.1',
      { now: () => 0, delay: async () => {}, timeoutMs: 1 },
    );
    assert.equal(result, validInspection);
  }
});

test('inspection keeps a hard deadline for a permanently blank installed page', async () => {
  let clock = 0;
  await assert.rejects(
    waitForInspection(
      async () => ({ result: { value: { ...validInspection, rootChildren: 0 } } }),
      '1.0.0-rc.1',
      {
        now: () => {
          clock += 10;
          return clock;
        },
        delay: async () => {},
        timeoutMs: 5,
      },
    ),
    /did not become ready within 60 seconds/,
  );
});
