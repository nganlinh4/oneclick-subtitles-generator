import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const source = readFileSync(
  new URL('../journeys/localAsrGeneration.journey.js', import.meta.url),
  'utf8',
);

test('local ASR cannot pass on partial cues before its owned native job succeeds', () => {
  assert.match(source, /existingTranscribeJobIds/u);
  assert.match(source, /newTranscribeJobs\.length <= 1/u);
  assert.match(source, /lastJob\?\.state === 'succeeded'/u);
  assert.match(source, /generationActive === false/u);
  assert.match(source, /ASR cues appeared before their native job succeeded/u);
});
