import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const journey = readFileSync(join(import.meta.dirname, '..', 'journeys', 'geminiBackgroundImageSuccess.journey.js'), 'utf8');
const scenario = readFileSync(join(import.meta.dirname, '..', 'scenarios', 'geminiBackgroundImageSuccess.mjs'), 'utf8');

test('the live image journey owns prompt, image artifact and relaunch proof', () => {
  assert.match(journey, /enrollGeminiCredentials\(\{ limit: 20 \}\)/u);
  assert.match(journey, /\.prompt-header \.generate-button/u);
  assert.match(journey, /\.album-art-preview \.floating-upload-button/u);
  assert.match(journey, /kind\.startsWith\('generatedBackgroundImage:'\)/u);
  assert.match(journey, /PHASE === 'verify'/u);
  assert.match(scenario, /stagedMediaSelectionSequence: \[video, reference\]/u);
});

test('the image journey contains neither credential values nor direct provider transport', () => {
  assert.doesNotMatch(journey, /AIza|generativelanguage\.googleapis\.com|x-goog-api-key|GEMINI_API_KEY\s*=/u);
  assert.doesNotMatch(journey, /fetch\s*\(|credential_set/u);
});
