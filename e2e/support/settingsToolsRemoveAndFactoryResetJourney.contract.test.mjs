import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const journeySource = readFileSync(
  resolve(import.meta.dirname, '..', 'journeys', 'settingsToolsRemoveAndFactoryReset.journey.js'),
  'utf8',
);
const scenarioSource = readFileSync(
  resolve(import.meta.dirname, '..', 'scenarios', 'settingsToolsRemoveAndFactoryReset.mjs'),
  'utf8',
);

test('the scenario requests a private, non-shared native-tools cache', () => {
  assert.match(scenarioSource, /keepNativeTools:\s*false/u);
  assert.match(scenarioSource, /createRunRoot/u);
  assert.match(scenarioSource, /journeys\/settingsToolsRemoveAndFactoryReset\.journey\.js/u);
});

test('the journey refuses to run outside its dedicated scenario', () => {
  assert.match(journeySource, /OSG_E2E_TOOLS_RESET_PHASE/u);
  assert.match(journeySource, /assert\.equal\(\s*PHASE,\s*'run'/u);
});

test('the journey is excluded from the default discovery sweep', () => {
  const runIsolatedSource = readFileSync(
    resolve(import.meta.dirname, '..', 'run-isolated.mjs'),
    'utf8',
  );
  assert.match(runIsolatedSource, /'settingsToolsRemoveAndFactoryReset\.journey\.js'/u);
});

test('removal is proven real, unlike settingsSurface\'s cancel-only guard', () => {
  assert.doesNotMatch(journeySource, /__TAURI__|invokeDesktop|invokeCommand/u);
  assert.match(journeySource, /data-tool-action="remove-request"/u);
  // clickSettingsControl wraps clickControl to tolerate the sticky settings footer (see
  // e2e/support/settingsControls.js); either is the same real click on the same real control.
  assert.match(
    journeySource,
    /click(?:Control|SettingsControl)\(`\$\{TOOL_ROW\} \[data-tool-action="remove-confirm"\]`\)/u,
  );
  assert.match(journeySource, /directoryShapeDigest\(toolsRoot\)/u);
  assert.match(journeySource, /assert\.deepEqual\(\s*afterRemovalDigest,\s*emptyBaseline/u);
});

test('factory reset is proven to clear a real credential, not merely refused on an empty one', () => {
  assert.match(journeySource, /genius-key-input/u);
  assert.match(journeySource, /credential_refs/u);
  assert.match(journeySource, /credentialsBeforeReset, 1/u);
  assert.match(journeySource, /credentialsAfterReset, 0/u);
  assert.match(journeySource, /\.factory-reset-btn/u);
  assert.match(journeySource, /\.toast\.toast-warning \.toast-button/u);
});
