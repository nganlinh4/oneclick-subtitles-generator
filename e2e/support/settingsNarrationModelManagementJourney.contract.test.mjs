import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const journeySource = readFileSync(
  resolve(import.meta.dirname, '..', 'journeys', 'settingsNarrationModelManagement.journey.js'),
  'utf8',
);
const scenarioSource = readFileSync(
  resolve(import.meta.dirname, '..', 'scenarios', 'settingsNarrationModelManagement.mjs'),
  'utf8',
);

test('the scenario requests a genuinely empty, non-shared engine-packages cache', () => {
  assert.match(scenarioSource, /keepEnginePackages:\s*false/u);
  assert.match(scenarioSource, /createRunRoot/u);
  assert.match(scenarioSource, /journeys\/settingsNarrationModelManagement\.journey\.js/u);
});

test('the journey refuses to run outside its dedicated scenario', () => {
  assert.match(journeySource, /OSG_E2E_MODEL_MANAGEMENT_PHASE/u);
  assert.match(journeySource, /assert\.equal\(PHASE, 'manage'/u);
});

test('the journey is excluded from the default discovery sweep', () => {
  const runIsolatedSource = readFileSync(
    resolve(import.meta.dirname, '..', 'run-isolated.mjs'),
    'utf8',
  );
  assert.match(runIsolatedSource, /'settingsNarrationModelManagement\.journey\.js'/u);
});

test('status and cancellation are proven from public controls, never a private queue probe', () => {
  assert.doesNotMatch(journeySource, /__TAURI__|invokeDesktop|invokeCommand/u);
  assert.match(journeySource, /data-model-package-id/u);
  assert.match(journeySource, /data-model-package-state/u);
  assert.match(journeySource, /data-model-action="install"/u);
  assert.match(journeySource, /data-model-action="cancel"/u);
  assert.doesNotMatch(
    journeySource,
    /clickControl\([^\n]*data-model-action="remove"/u,
    'the 4.59 GiB package is never fully installed, so Remove is only ever asserted absent, not clicked',
  );
});

test('the not-installed claim and the cancellation claim each have an independent filesystem oracle', () => {
  assert.match(journeySource, /directoryShapeDigest\(enginePackagesRoot\)/u);
  assert.match(journeySource, /emptyBaseline/u);
  assert.match(journeySource, /afterCancelDigest/u);
  assert.match(journeySource, /assert\.deepEqual\(\s*afterCancelDigest,\s*emptyBaseline/u);
});
