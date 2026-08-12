import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertInspection,
  parseArguments,
  selectTauriTarget,
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

test('installed WebView CLI accepts only the bounded inspection contract', () => {
  assert.deepEqual(parseArguments([
    '--port', '54321',
    '--expected-version', '1.0.0-rc.1',
    '--screenshot', 'capture.png',
  ]), {
    port: 54321,
    expectedVersion: '1.0.0-rc.1',
    screenshot: 'capture.png',
  });
  assert.throws(() => parseArguments([
    '--port', '80', '--expected-version', '1.0.0', '--screenshot', 'capture.png',
  ]), /unprivileged/);
  assert.throws(() => parseArguments([
    '--port', '54321', '--expected-version', 'latest', '--screenshot', 'capture.png',
  ]), /semantic/);
  assert.throws(() => parseArguments([
    '--port', '54321', '--expected-version', '1.0.0', '--screenshot', 'capture.png', '--extra', 'x',
  ]), /Only/);
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
