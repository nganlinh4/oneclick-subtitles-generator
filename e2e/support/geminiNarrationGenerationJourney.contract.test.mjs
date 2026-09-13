import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const source = readFileSync(
  new URL('../journeys/geminiNarrationGeneration.journey.js', import.meta.url),
  'utf8',
);
const section = readFileSync(
  new URL('../../src/components/narration/sections/GeminiNarrationSection.js', import.meta.url),
  'utf8',
);
const resultRow = readFileSync(
  new URL('../../src/components/narration/components/GeminiResultRow.js', import.meta.url),
  'utf8',
);

test('Gemini narration uses public credential enrollment and the visible concurrency control', () => {
  assert.match(source, /enrollGeminiCredentials\(\{ limit: CONCURRENCY \}\)/u);
  assert.match(source, /selector: '#gemini-concurrent-clients'/u);
  assert.match(source, /method: 'gemini'/u);
  assert.match(source, /expectedFormat: 'wav'/u);
  assert.doesNotMatch(source, /GEMINI_API_KEY/u);
  assert.match(section, /<GenerateButton\s+\n?\s*narrationMethod="gemini"/u);
  assert.match(resultRow, /data-narration-result-state=/u);
});

test('Gemini narration proves real overlap and distinct workers without exposing their identities', () => {
  assert.match(source, /speech\.concurrency_observed/u);
  assert.match(source, /workers: CONCURRENCY/u);
  assert.match(source, /observedPeak: CONCURRENCY/u);
  assert.doesNotMatch(source, /credentialId/u);
});
