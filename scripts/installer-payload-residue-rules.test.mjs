import assert from 'node:assert/strict';
import test from 'node:test';

import { RESIDUE_RULE_COUNT, scanForbiddenResidue } from './installer-payload-residue-rules.mjs';

const entries = (...relativePaths) => relativePaths.map((relativePath) => ({ relativePath }));

test('a clean, reviewed payload has no residue matches', () => {
  const violations = scanForbiddenResidue(entries(
    'osg-desktop.exe',
    'workers/osg_asr_worker.py',
    'workers/osg_speech_worker.py',
    'licenses/LICENSE',
    'licenses/THIRD_PARTY_NOTICES.md',
    'ui-fonts/0f63b3ae4c60341fc1348749796505e9ab621a3ab690b80f9cdf66dafc1eca19',
  ));
  assert.deepEqual(violations, []);
});

test('flags a bundled Electron shell by exact name', () => {
  const violations = scanForbiddenResidue(entries('resources/electron.exe'));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, 'resources/electron.exe');
  assert.match(violations[0].reason, /Electron/);
});

test('flags an electron-builder packed app archive', () => {
  const violations = scanForbiddenResidue(entries('resources/app.asar'));
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /packed application archive/);
});

test('flags the removed Express/Flask server tree by directory name, at any depth', () => {
  const violations = scanForbiddenResidue(entries('nested/deep/server/narrationService.py'));
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /server\/ Express\+Flask tree/);
});

test('flags a bundled Chromium/CEF payload fingerprint', () => {
  const violations = scanForbiddenResidue(entries(
    'resources/chrome_100_percent.pak',
    'resources/icudtl.dat',
    'resources/libcef.dll',
  ));
  assert.equal(violations.length, 3);
});

test('flags a bundled Node runtime and native addon', () => {
  const violations = scanForbiddenResidue(entries('bin/node.exe', 'bin/addon.node'));
  assert.equal(violations.length, 2);
});

test('flags a bundled CPython interpreter and its shared library', () => {
  const violations = scanForbiddenResidue(entries('runtime/python.exe', 'runtime/python311.dll'));
  assert.equal(violations.length, 2);
});

test('does not flag the worker python SOURCE files themselves', () => {
  const violations = scanForbiddenResidue(entries(
    'workers/osg_asr_worker.py',
    'workers/osg_speech_worker.py',
  ));
  assert.deepEqual(violations, []);
});

test('does not flag Tauri NSIS-authoring machinery such as its plugin DLL', () => {
  const violations = scanForbiddenResidue(entries(
    'Plugins/x86-unicode/additional/nsis_tauri_utils.dll',
    'Bin/makensis.exe',
  ));
  assert.deepEqual(violations, []);
});

test('matching is case-insensitive on basenames and directory names', () => {
  const violations = scanForbiddenResidue(entries('Resources/Electron.EXE', 'SERVER/narrationService.js'));
  assert.equal(violations.length, 2);
});

test('is normalized against a non-empty rule catalog', () => {
  assert.ok(RESIDUE_RULE_COUNT > 20, 'the catalog should cover a meaningful number of fingerprints');
});
