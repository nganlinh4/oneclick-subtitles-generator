import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const source = readFileSync(
  new URL('../journeys/edgeTtsNarrationGeneration.journey.js', import.meta.url),
  'utf8',
);
const shared = readFileSync(
  new URL('./providerNarrationJourney.js', import.meta.url),
  'utf8',
);

test('the journey targets edge-tts throughout, never silently falling back to gTTS', () => {
  assert.match(source, /const ENGINE = 'edge-tts'/u);
  assert.match(source, /ensureEngineReady\(ENGINE/u);
  assert.match(source, /runProviderNarrationGeneration/u);
  assert.match(source, /method: ENGINE/u);
  assert.match(shared, /label\[for="method-\$\{method\}"\]/u);
  assert.match(shared, /data-narration-method="\$\{method\}"/u);
  assert.match(shared, /method,/u);
});

test('generation cannot pass on partial cues before its owned native batch succeeds', () => {
  assert.match(shared, /jobs\.length === 1/u);
  assert.match(shared, /jobs\[0\]\.state === 'succeeded'/u);
  assert.match(shared, /readyArtifacts\.length === after\.cues\.length/u);
  assert.match(shared, /records\.length === 1/u);
});

test('every cue artifact is independently re-decoded, not merely trusted from SQLite', () => {
  assert.match(shared, /looksLikeMp3\(readFileSync\(path\)\.subarray\(0, 3\)\)/u);
  assert.match(shared, /probeMedia\(path\)/u);
  assert.match(shared, /measureAudioSignal\(path\)/u);
  assert.match(shared, /peakVolumeDb > -50/u);
});

test('the journey stops at generation and never re-runs the engine-agnostic align/render pipeline', () => {
  assert.doesNotMatch(shared, /download-aligned-narration/u);
  assert.doesNotMatch(shared, /render-video/u);
  assert.doesNotMatch(shared, /actuateNativeRange/u);
});

test('no visible or transient narration refusal survives the run', () => {
  assert.match(shared, /assert\.deepEqual\(await visibleFailures\(\), \[\]/u);
  assert.match(shared, /assert\.deepEqual\(await recordedFailures\(\), \[\]/u);
});
