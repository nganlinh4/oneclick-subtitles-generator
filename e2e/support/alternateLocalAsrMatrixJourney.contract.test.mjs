import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const journeySource = readFileSync(
  resolve(import.meta.dirname, '..', 'journeys', 'alternateLocalAsrMatrix.journey.js'),
  'utf8',
);

test('the journey is discoverable in the default sweep and wired into e2e/package.json', () => {
  const runIsolatedSource = readFileSync(
    resolve(import.meta.dirname, '..', 'run-isolated.mjs'),
    'utf8',
  );
  assert.doesNotMatch(
    runIsolatedSource,
    /'alternateLocalAsrMatrix\.journey\.js'/u,
    'this journey needs no isolated cache policy, so it must stay OUT of NON_DEFAULT_JOURNEYS',
  );
  const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.match(packageJson.scripts['test:alternate-local-asr'], /alternateLocalAsrMatrix\.journey\.js/u);
});

test('every catalog engine is checked against an independent filesystem oracle, not the DOM alone', () => {
  assert.match(journeySource, /ASR_CATALOG_ENGINES/u);
  assert.match(journeySource, /directoryShapeDigest\(packageDirectory\(root, engine\.packageId\)\)/u);
  assert.match(journeySource, /isTruthfulCardState\(settled\.state, digest\.exists\)/u);
});

test('the install-offer proof is bounded (cancel, never a completed multi-gigabyte download)', () => {
  assert.match(journeySource, /installThenCancelBounded/u);
  assert.doesNotMatch(journeySource, /waitForEngineState\([^)]*state\?\.state === 'ready'/u);
});

test('cancellation is independently verified to leave no orphaned bytes on disk', () => {
  assert.match(journeySource, /assert\.deepEqual\(after, before/u);
});

test('the journey records the no-hardware-gate finding rather than fabricating a refusal to assert', () => {
  assert.match(journeySource, /no CUDA\/DirectML\/CoreML capability check/u);
});
