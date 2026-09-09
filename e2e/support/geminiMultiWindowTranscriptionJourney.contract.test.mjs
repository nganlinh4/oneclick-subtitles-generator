import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (...parts) => readFileSync(join(import.meta.dirname, ...parts), 'utf8');
const journey = read('..', 'journeys', 'geminiMultiWindowTranscription.journey.js');
const scenario = read('..', 'scenarios', 'geminiMultiWindowTranscription.mjs');

test('the live four-window journey uses the reviewed real-speech fixture and public Gemini controls', () => {
  assert.match(scenario, /stagedFourWindowAsrVideo/u);
  assert.match(journey, /FOUR_WINDOW_ASR_FIXTURE/u);
  assert.match(journey, /#transcribe-window/u);
  assert.match(journey, /data-transcription-method="gemini-transcribe-live"/u);
  assert.doesNotMatch(journey, /data-transcription-method="new"/u);
  assert.match(journey, /EXPECTED_WINDOWS/u);
  assert.match(journey, /processing-ranges/u);
  assert.match(journey, /streaming-update/u);
});

test('the live four-window journey contains no credential value or private transport', () => {
  assert.doesNotMatch(journey + scenario, /AIza|__TAURI__|invokeDesktop|invokeCommand/u);
});
