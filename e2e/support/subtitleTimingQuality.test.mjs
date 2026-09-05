import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { scoreSubtitleTiming } from './subtitleTimingQuality.js';
const reference = { words: [
  { text: 'hello', start: 1, end: 1.4 }, { text: 'world', start: 1.5, end: 2 },
  { text: 'next', start: 4, end: 5 },
] };
test('measures signed shift independently of perfect text', () => {
  const score = scoreSubtitleTiming(reference, [
    { text: 'hello world', start: 1.5, end: 2.5 }, { text: 'next', start: 4.5, end: 5.5 },
  ]);
  assert.equal(score.wordErrorRate, 0);
  assert.equal(score.start.signedMedianMs, 500);
  assert.equal(score.end.p95AbsoluteMs, 500);
});
test('aligns text across changed segmentation and reports missing speech', () => {
  const score = scoreSubtitleTiming(reference, [{ text: 'world', start: 1.5, end: 2 }]);
  assert.equal(score.matchedWords, 1);
  assert.equal(score.referenceWordCoverage, 1 / 3);
  assert.equal(score.start.medianAbsoluteMs, 0);
});
test('does not manufacture perfect timing when there are no matching words', () => {
  const score = scoreSubtitleTiming(reference, [{ text: 'invented', start: 1, end: 2 }]);
  assert.equal(score.start.medianAbsoluteMs, null);
  assert.equal(score.timedCues, 0);
});
