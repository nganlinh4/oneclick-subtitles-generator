import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  assertNoNewProviderJob,
  summarizeSegmentationShape,
  verifySegmentationShapeDirection,
  verifyWordCappedSegmentationShape,
  wordCount,
} from './segmentationShapeOracle.js';

test('wordCount splits on whitespace and ignores leading/trailing/blank input', () => {
  assert.equal(wordCount('Alright so here we are'), 5);
  assert.equal(wordCount('  spaced   out   words  '), 3);
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   '), 0);
  assert.equal(wordCount('one'), 1);
});

test('a word-capped run within its limit passes and reports accurate aggregate stats', () => {
  const cues = [
    { text: 'in front of' },
    { text: 'the elephants' },
    { text: 'right here' },
  ];
  const outcome = verifyWordCappedSegmentationShape({ cues, maxWords: 3 });
  assert.equal(outcome.cueCount, 3);
  assert.equal(outcome.totalWords, 3 + 2 + 2);
  assert.equal(outcome.maxObservedWords, 3);
  assert.ok(Math.abs(outcome.averageWords - (7 / 3)) < 1e-9);
});

test('a cue over the requested word cap is a hard failure naming the offender', () => {
  const cues = [
    { text: 'one two' },
    { text: 'one two three four' }, // 4 words, over a cap of 2
  ];
  assert.throws(
    () => verifyWordCappedSegmentationShape({ cues, maxWords: 2 }),
    /over its 2-word limit/u,
  );
});

test('an empty word-capped run is refused rather than silently proving nothing', () => {
  assert.throws(
    () => verifyWordCappedSegmentationShape({ cues: [], maxWords: 2 }),
    /no durable cues/u,
  );
});

test('summarizeSegmentationShape mirrors the same stats for the unconstrained comparison run', () => {
  const outcome = summarizeSegmentationShape([
    { text: 'Alright so here we are in front of the elephants.' },
  ]);
  assert.equal(outcome.cueCount, 1);
  assert.equal(outcome.totalWords, 10);
  assert.equal(outcome.averageWords, 10);
});

test('the documented direction holds: more, shorter cues from a small word cap', () => {
  const wordCapped = summarizeSegmentationShape([
    { text: 'Alright so' }, { text: 'here we' }, { text: 'are in' }, { text: 'front of' }, { text: 'the elephants' },
  ]);
  const sentence = summarizeSegmentationShape([
    { text: 'Alright so here we are in front of the elephants.' },
  ]);
  const outcome = verifySegmentationShapeDirection({ wordCapped, sentence });
  assert.equal(outcome.wordCapped.cueCount, 5);
  assert.equal(outcome.sentence.cueCount, 1);
});

test('the reverse direction (fewer or longer word-capped cues) is a hard failure', () => {
  const wordCapped = summarizeSegmentationShape([{ text: 'one whole sentence right here' }]);
  const sentence = summarizeSegmentationShape([
    { text: 'one' }, { text: 'whole' }, { text: 'sentence' }, { text: 'right' }, { text: 'here' },
  ]);
  assert.throws(
    () => verifySegmentationShapeDirection({ wordCapped, sentence }),
    /did not produce more cues/u,
  );
});

test('equal-count runs fail the direction check even if word counts differ', () => {
  const wordCapped = summarizeSegmentationShape([{ text: 'a b' }, { text: 'c d' }]);
  const sentence = summarizeSegmentationShape([{ text: 'a' }, { text: 'b c d' }]);
  assert.throws(
    () => verifySegmentationShapeDirection({ wordCapped, sentence }),
    /did not produce more cues/u,
  );
});

test('assertNoNewProviderJob passes when no watched job kind appears', () => {
  const before = { jobs: [{ id: 1, kind: 'transcribe' }] };
  const after = { jobs: [{ id: 1, kind: 'transcribe' }, { id: 2, kind: 'unrelatedKind' }] };
  const outcome = assertNoNewProviderJob({
    before, after, providerKinds: ['analyzeSubtitles', 'transcribe', 'translate'],
  });
  assert.equal(outcome.providerJobCount, 1);
});

test('a new watched-kind job is a hard failure', () => {
  const before = { jobs: [] };
  const after = { jobs: [{ id: 1, kind: 'analyzeSubtitles' }] };
  assert.throws(
    () => assertNoNewProviderJob({ before, after, providerKinds: ['analyzeSubtitles'] }),
    /a provider-owned job appeared without a credential/u,
  );
});
