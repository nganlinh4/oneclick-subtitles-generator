import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(import.meta.dirname, '..', 'journeys', 'geminiDocumentSuccess.journey.js'), 'utf8');

test('the live document journey uses public controls and independently reads staged outputs', () => {
  assert.match(source, /enrollGeminiCredentials\(\{ limit: 20 \}\)/u);
  assert.match(source, /openProjectWithMedia\(\)/u);
  assert.match(source, /importSubtitles\(\)/u);
  assert.match(source, /\.process-button/u);
  assert.match(source, /readFileSync\(path, 'utf8'\)/u);
  assert.match(source, /newJobs\.every\(\(\{ state \}\) => state === 'succeeded'\)/u);
});

test('the journey contains neither credential values nor direct provider transport', () => {
  assert.doesNotMatch(source, /AIza|generativelanguage\.googleapis\.com|x-goog-api-key|GEMINI_API_KEY\s*=/u);
  assert.doesNotMatch(source, /fetch\s*\(|credential_set/u);
});
