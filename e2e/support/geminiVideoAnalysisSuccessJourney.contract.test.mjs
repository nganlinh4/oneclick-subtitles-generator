import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const journey = readFileSync(join(import.meta.dirname, '..', 'journeys', 'geminiVideoAnalysisSuccess.journey.js'), 'utf8');

test('the live analysis journey proves provider, ownership, rules control, transcription and pixels', () => {
  for (const witness of [
    'enrollGeminiCredentials({ limit: 20 })',
    "kind === 'analyzeSubtitles'",
    'durableTranscriptionRules(root)',
    "rows[0].analysis?.providerJobId",
    "$('#use-transcription-rules')",
    "kind === 'transcribe'",
    'waitForCanvasSubtitleFrame(180_000)',
  ]) assert.match(journey, new RegExp(witness.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('the live analysis journey fails on provider refusal and never substitutes application state', () => {
  assert.match(journey, /TERMINAL\.has\(analysisJob\?\.state\)/u);
  assert.match(journey, /errorToasts\.length > 0/u);
  assert.doesNotMatch(journey, /localStorage\.setItem|executeAsync|mock|fixture.*analysis/iu);
});
