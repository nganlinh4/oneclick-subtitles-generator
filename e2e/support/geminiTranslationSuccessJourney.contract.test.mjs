import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(import.meta.dirname, '..', 'journeys', 'geminiTranslationSuccess.journey.js'), 'utf8');

test('the Gemini translation success journey uses public credential and translation controls', () => {
  assert.match(source, /enrollGeminiCredentials\(\{ limit: 20 \}\)/u);
  assert.match(source, /openProjectWithMedia\(\)/u);
  assert.match(source, /importSubtitles\(SOURCE_FIXTURE\)/u);
  assert.match(source, /split-duration-slider/u);
  assert.match(source, /visibleCounts\.some\(\(count\) => count > 0 && count < 12\)/u);
  assert.match(source, /three requested translation windows did not overlap/u);
  assert.match(source, /\.translate-button/u);
  assert.match(source, /durableTranslations\(root\)/u);
  assert.match(source, /kind \}\) => kind === 'translate'/u);
});

test('the success journey contains no credential value or direct provider transport', () => {
  assert.doesNotMatch(source, /AIza|generativelanguage\.googleapis\.com|x-goog-api-key|GEMINI_API_KEY\s*=/u);
  assert.doesNotMatch(source, /fetch\s*\(|credential_set|browser\.execute\([^)]*credential/u);
});
