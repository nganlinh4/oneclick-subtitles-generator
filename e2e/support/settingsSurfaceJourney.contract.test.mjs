import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const source = readFileSync(
  resolve(import.meta.dirname, '..', 'journeys', 'settingsSurface.journey.js'),
  'utf8',
);

test('settings journey reaches every public tab and records behavioural checkpoints', () => {
  for (const tab of [
    'api-keys', 'video-processing', 'prompts', 'cache', 'model-management', 'tools', 'about',
  ]) {
    assert.match(source, new RegExp(`tab: '${tab}'`));
  }
  for (const checkpoint of [
    '08-appearance-changed',
    '09-processing-edits',
    '10-prompt-edited',
    '11-persisted-preferences',
    '12-persisted-prompt',
    '14-factory-reset-confirmation',
    '15-factory-reset-safe',
  ]) {
    assert.match(source, new RegExp(checkpoint));
  }
  assert.match(source, /assertSettingsChromeInViewport/u);
  assert.match(source, /horizontalScroll/u);
  assert.match(source, /settingsChromeBaseline/u);
  assert.match(source, /ambientHistory/u);
  assert.match(source, /buttonDisabled: true/u);
  assert.match(source, /display: 'none'/u);
  assert.match(source, /overlayPointerEvents/u);
  assert.match(source, /allowed pointer input through the Settings backdrop/u);
  assert.match(source, /assertSettingsArrowIsolation/u);
  assert.match(source, /Settings ArrowRight sought the background video/u);
  assert.match(
    source,
    /step: '09-processing-edits'[\s\S]*?focusSelector: '\.video-processing-section \.compact-setting:has\(label\[for="time-format"\]\)'/u,
    'processing evidence must target a visible changed control, not the taller-than-viewport section',
  );
});

test('settings journey uses public controls and refuses private or native-dialog shortcuts', () => {
  assert.doesNotMatch(source, /__TAURI__|invokeDesktop|invokeCommand|browser\.executeAsync/u);
  assert.doesNotMatch(source, /select_media|open_document|save_document|dialog_paths/u);
  assert.match(source, /data-app-action=\\?"open-settings/);
  assert.match(source, /data-tool-action=\\?"remove-request/);
  assert.match(source, /data-tool-action=\\?"remove-cancel/);
  assert.match(source, /\.factory-reset-btn/);
  assert.match(source, /\.toast\.toast-warning \.toast-button/);
});

test('package removal is confirmation-only while factory reset has independent preservation oracles', () => {
  assert.doesNotMatch(source, /clickControl\([^\n]*remove-confirm/u);
  assert.match(source, /directoryShapeDigest\(NATIVE_TOOLS_CACHE\)/u);
  assert.match(source, /directoryShapeDigest\(ENGINE_PACKAGES_CACHE\)/u);
  assert.match(source, /durableCustomerIdentity\(root\)/u);
  assert.match(source, /durableWorkspaceIdentity\(root\)/u);
  assert.match(source, /durableSettings\(root, SETTING_KEYS\)/u);
  assert.equal(
    [...source.matchAll(/await openProjectWithMedia\(\);/gu)].length,
    1,
    'factory reset must restore the exact workspace without selecting the file again',
  );
  assert.match(source, /mediaPickerRequestCount\(root\)/u);
  assert.match(source, /reset duplicated the preserved project/u);
  assert.match(source, /reset duplicated the preserved media asset/u);
  assert.match(source, /waitForRestoredMedia\(\)/u);
  assert.match(source, /toolDeletionProven: false/u);
});
