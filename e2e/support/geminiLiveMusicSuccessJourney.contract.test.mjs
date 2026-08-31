import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(import.meta.dirname, '..', 'journeys', 'geminiLiveMusicSuccess.journey.js'), 'utf8');

test('the live music journey uses real nested controls, PCM, recording and an independent file signature', () => {
  for (const witness of [
    'enrollGeminiCredentials({ limit: 20 })',
    'clickPromptDjTransport()',
    "live.playbackState === 'playing'",
    'peakLevel > 0.0001',
    'browser.pause(5_000)',
    "signature, '52494646'",
  ]) assert.ok(source.includes(witness), `missing live-music witness: ${witness}`);
  assert.doesNotMatch(source, /dispatchEvent|postMessage|live_music_start|executeAsync/u);
});
