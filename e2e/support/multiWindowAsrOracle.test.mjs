import { strict as assert } from 'node:assert';
import test from 'node:test';

import { assertMultiWindowAsrResult } from './multiWindowAsrOracle.js';

const ranges = Object.freeze([
  { start: 0, end: 51 },
  { start: 51, end: 102 },
  { start: 102, end: 153 },
  { start: 153, end: 204 },
]);

const valid = () => {
  const streamPublications = ranges.map((segment, index) => ({
    segment,
    generationActive: true,
    subtitles: [{
      start: segment.start + 10,
      end: segment.start + 12,
      text: `fresh window ${index + 1}`,
    }],
  }));
  return {
    durationSeconds: 204,
    maxRequestSeconds: 60,
    expectedCount: 4,
    forbiddenTexts: ['deleted old A', 'deleted old B'],
    jobs: ranges.map((_, index) => ({ id: `job-${index}`, kind: 'transcribe', state: 'succeeded' })),
    rangePublications: [ranges, ranges.map((range) => ({ ...range }))],
    streamPublications,
    visibleMilestones: streamPublications.map((_, index) => ({
      generationActive: true,
      streamCount: index + 1,
      rows: streamPublications.slice(0, index + 1).flatMap(({ subtitles }) => (
        subtitles.map(({ text }) => text)
      )),
    })),
    durableCues: streamPublications.flatMap(({ subtitles }) => subtitles.map((cue, index) => ({
      id: `cue-${index}`,
      start_ms: Math.round(cue.start * 1_000),
      end_ms: Math.round(cue.end * 1_000),
      text: cue.text,
    }))),
    inlineErrors: [],
  };
};

test('accepts four distinct successful jobs, live monotonic publication, and an exact durable merge', () => {
  const result = assertMultiWindowAsrResult(valid());
  assert.equal(result.cueCount, 4);
  assert.equal(result.jobIds.length, 4);
});

test('refuses a duplicate or non-successful native job', () => {
  const duplicate = valid();
  duplicate.jobs[3].id = duplicate.jobs[0].id;
  assert.throws(() => assertMultiWindowAsrResult(duplicate), /job ids are not distinct/u);

  const failed = valid();
  failed.jobs[2].state = 'failed';
  assert.throws(() => assertMultiWindowAsrResult(failed), /must terminate successfully/u);
});

test('refuses range gaps, oversized windows, and UI/adapter disagreement', () => {
  const gap = valid();
  gap.rangePublications[0] = gap.rangePublications[0].map((range) => ({ ...range }));
  gap.rangePublications[0][1].start += 1;
  assert.throws(() => assertMultiWindowAsrResult(gap), /overlap or leave a gap/u);

  const oversized = valid();
  oversized.rangePublications[0] = [
    { start: 0, end: 61 }, { start: 61, end: 102 },
    { start: 102, end: 153 }, { start: 153, end: 204 },
  ];
  assert.throws(() => assertMultiWindowAsrResult(oversized), /exceeds the public maximum/u);

  const disagreement = valid();
  disagreement.rangePublications[1] = [
    { start: 0, end: 50 }, { start: 50, end: 102 },
    { start: 102, end: 153 }, { start: 153, end: 204 },
  ];
  assert.throws(() => assertMultiWindowAsrResult(disagreement), /disagreed/u);
});

test('refuses publications after aggregate completion or without visible monotonic growth', () => {
  const late = valid();
  late.streamPublications[2].generationActive = false;
  assert.throws(() => assertMultiWindowAsrResult(late), /aggregate processing became inactive/u);

  const flat = valid();
  flat.visibleMilestones[2].rows = [...flat.visibleMilestones[1].rows];
  assert.throws(() => assertMultiWindowAsrResult(flat), /did not grow monotonically/u);

  // A repeated stream count is legitimate paint coalescing; only a REGRESSION in the count is a
  // witness-integrity failure.
  const backwards = valid();
  backwards.visibleMilestones[2].streamCount = 1;
  assert.throws(() => assertMultiWindowAsrResult(backwards), /went backwards/u);
});

test('refuses resurrected deleted cues and durable output unlike the streamed results', () => {
  const resurrected = valid();
  resurrected.visibleMilestones[1].rows.push('deleted old A');
  assert.throws(() => assertMultiWindowAsrResult(resurrected), /resurrected deleted cue/u);

  const mismatch = valid();
  mismatch.durableCues[1].text = 'a different durable cue';
  assert.throws(() => assertMultiWindowAsrResult(mismatch), /differs from the four streamed/u);
});

test('refuses missing boundary coverage, out-of-range cues, and inline errors', () => {
  const missingCue = valid();
  missingCue.streamPublications[3].subtitles = [];
  assert.throws(() => assertMultiWindowAsrResult(missingCue), /window 3 produced no cues/u);

  const outside = valid();
  outside.streamPublications[1].subtitles[0].start = 49;
  assert.throws(() => assertMultiWindowAsrResult(outside), /outside its native range/u);

  const errored = valid();
  errored.inlineErrors.push('The native subtitle project returned an invalid track');
  assert.throws(() => assertMultiWindowAsrResult(errored), /error surface/u);
});

