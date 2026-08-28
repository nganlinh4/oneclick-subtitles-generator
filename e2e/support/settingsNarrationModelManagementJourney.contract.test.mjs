import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  MIN_FREE_RESERVE_BYTES,
  SPEECH_DELIVERY_CATALOG,
  speechPackageInstallRequirement,
} from './speechPackageCapacity.js';

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

test('the install claim is gated on the same disk requirement the native installer enforces', () => {
  assert.match(journeySource, /speechPackageInstallRequirement/u);
  assert.match(journeySource, /availableStoreBytes\(enginePackagesRoot\)/u);
  assert.match(journeySource, /capacity\.sufficient/u);
  assert.match(
    journeySource,
    /assert\.deepEqual\(\s*afterRefusalDigest,\s*emptyBaseline/u,
    'the refusal branch needs the same independent filesystem oracle as the cancellation branch',
  );
});

test('the mirrored requirement matches the reviewed Windows F5-TTS delivery release', () => {
  const requirement = speechPackageInstallRequirement('f5-tts', { platform: 'windows-x86_64' });
  const catalog = JSON.parse(readFileSync(SPEECH_DELIVERY_CATALOG, 'utf8'));
  const release = catalog.platforms['windows-x86_64'].backends
    .find(({ id }) => id === 'f5-tts').releases[0];
  assert.equal(requirement.deliveryAvailable, true);
  assert.equal(requirement.version, release.version);
  assert.equal(
    requirement.requiredBytes,
    release.sizeBytes + release.unpackedSizeBytes + MIN_FREE_RESERVE_BYTES,
  );
});

test('a target the catalog does not serve is reported unavailable, never as an installable offer', () => {
  const requirement = speechPackageInstallRequirement('f5-tts', { platform: 'linux-x86_64' });
  assert.equal(requirement.deliveryAvailable, false);
  assert.equal(requirement.requiredBytes, 0);
  assert.equal(speechPackageInstallRequirement('not-a-backend').deliveryAvailable, false);
});
