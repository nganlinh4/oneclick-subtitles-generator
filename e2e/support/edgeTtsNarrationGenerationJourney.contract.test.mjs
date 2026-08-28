import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const source = readFileSync(
  new URL('../journeys/edgeTtsNarrationGeneration.journey.js', import.meta.url),
  'utf8',
);

test('the journey targets edge-tts throughout, never silently falling back to gTTS', () => {
  assert.match(source, /const ENGINE = 'edge-tts'/u);
  assert.match(source, /ensureEngineReady\(ENGINE/u);
  assert.match(source, /label\[for="method-edge-tts"\]/u);
  assert.match(source, /data-narration-method="edge-tts"/u);
  assert.match(source, /method: ENGINE/u, (
    'verifyNarrationGenerationOwnership defaults method to gtts; the edge-tts journey must override it'
  ));
});

test('generation cannot pass on partial cues before its owned native batch succeeds', () => {
  assert.match(source, /narrationJobs\.length === 1/u);
  assert.match(source, /narrationJobs\[0\]\.state === 'succeeded'/u);
  assert.match(source, /readyArtifacts\.length === afterGeneration\.cues\.length/u);
  assert.match(source, /records\.length === 1/u);
});

test('every cue artifact is independently re-decoded, not merely trusted from SQLite', () => {
  assert.match(source, /looksLikeMp3\(readFileSync\(path\)\.subarray\(0, 3\)\)/u);
  assert.match(source, /probeMedia\(path\)/u);
  assert.match(source, /measureAudioSignal\(path\)/u);
  assert.match(source, /peakVolumeDb > -50/u);
});

test('the journey stops at generation and never re-runs the engine-agnostic align/render pipeline', () => {
  assert.doesNotMatch(source, /download-aligned-narration/u);
  assert.doesNotMatch(source, /render-video/u);
  assert.doesNotMatch(source, /actuateNativeRange/u);
});

test('no visible or transient narration refusal survives the run', () => {
  assert.match(source, /assert\.deepEqual\(await visibleFailures\(\), \[\]/u);
  assert.match(source, /assert\.deepEqual\(await recordedFailures\(\), \[\]/u);
});
