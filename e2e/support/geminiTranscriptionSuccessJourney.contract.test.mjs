import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const journey = readFileSync(join(import.meta.dirname, '..', 'journeys', 'geminiTranscriptionSuccess.journey.js'), 'utf8');

test('live Gemini transcription uses public controls and independent durable/pixel oracles', () => {
  assert.match(journey, /enrollGeminiCredentials/u);
  assert.match(journey, /data-osg-action="generate-subtitles"/u);
  assert.match(journey, /data-transcription-method="new"/u);
  assert.match(journey, /data-osg-action="process-subtitles"/u);
  assert.match(journey, /durableState/u);
  assert.match(journey, /waitForCanvasSubtitleFrame/u);
});

test('live Gemini transcription contains no credential value or private transport', () => {
  assert.doesNotMatch(journey, /AIza|__TAURI__|invokeDesktop|invokeCommand/u);
  assert.doesNotMatch(journey, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM)\b/iu);
});
