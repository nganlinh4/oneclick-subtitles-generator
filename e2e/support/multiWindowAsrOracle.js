import { strict as assert } from 'node:assert';

const MAX_ITEMS = 2_000;
const TIME_TOLERANCE_SECONDS = 0.002;

const finiteTime = (value, label) => {
  assert.equal(typeof value, 'number', `${label} must be a number`);
  assert.ok(Number.isFinite(value) && value >= 0, `${label} must be finite and non-negative`);
  return value;
};

const cueSignature = ({ start, end, start_ms: startMs, end_ms: endMs, text }, label) => {
  const startSeconds = start === undefined ? Number(startMs) / 1_000 : Number(start);
  const endSeconds = end === undefined ? Number(endMs) / 1_000 : Number(end);
  finiteTime(startSeconds, `${label}.start`);
  finiteTime(endSeconds, `${label}.end`);
  assert.ok(endSeconds > startSeconds, `${label} must have positive duration`);
  assert.equal(typeof text, 'string', `${label}.text must be a string`);
  const normalizedText = text.trim();
  assert.ok(normalizedText.length > 0 && normalizedText.length <= 10_000, `${label}.text is invalid`);
  return Object.freeze({
    startMs: Math.round(startSeconds * 1_000),
    endMs: Math.round(endSeconds * 1_000),
    text: normalizedText,
  });
};

const normalizeRange = (range, index) => {
  assert.ok(range && typeof range === 'object', `range ${index} is missing`);
  const start = finiteTime(Number(range.start), `range ${index}.start`);
  const end = finiteTime(Number(range.end), `range ${index}.end`);
  assert.ok(end > start, `range ${index} is empty`);
  return Object.freeze({ start, end });
};

export const assertFourContiguousRanges = ({
  ranges,
  durationSeconds,
  maxRequestSeconds,
  expectedCount = 4,
}) => {
  assert.ok(Array.isArray(ranges), 'processing ranges are missing');
  assert.equal(ranges.length, expectedCount, `expected ${expectedCount} processing ranges`);
  const normalized = ranges.map(normalizeRange);
  assert.ok(Math.abs(normalized[0].start) <= TIME_TOLERANCE_SECONDS, 'ranges do not start at zero');
  for (let index = 0; index < normalized.length; index += 1) {
    const range = normalized[index];
    assert.ok(
      range.end - range.start <= maxRequestSeconds + TIME_TOLERANCE_SECONDS,
      `range ${index} exceeds the public maximum duration`,
    );
    if (index > 0) {
      assert.ok(
        Math.abs(normalized[index - 1].end - range.start) <= TIME_TOLERANCE_SECONDS,
        `ranges ${index - 1} and ${index} overlap or leave a gap`,
      );
    }
  }
  assert.ok(
    Math.abs(normalized.at(-1).end - durationSeconds) <= TIME_TOLERANCE_SECONDS,
    'processing ranges do not cover the media duration',
  );
  return Object.freeze(normalized);
};

const assertNoForbiddenText = (texts, forbiddenTexts, label) => {
  const forbidden = new Set(forbiddenTexts.map((text) => text.trim()));
  const resurrected = texts.find((text) => forbidden.has(text.trim()));
  assert.equal(resurrected, undefined, `${label} resurrected deleted cue ${JSON.stringify(resurrected)}`);
};

/** Validate the complete seed-process witness plus the read-only durable result. */
export const assertMultiWindowAsrResult = ({
  durationSeconds,
  maxRequestSeconds,
  expectedCount = 4,
  forbiddenTexts,
  jobs,
  rangePublications,
  streamPublications,
  visibleMilestones,
  durableCues,
  inlineErrors,
}) => {
  for (const [label, value] of Object.entries({
    forbiddenTexts, jobs, rangePublications, streamPublications, visibleMilestones, durableCues,
    inlineErrors,
  })) {
    assert.ok(Array.isArray(value), `${label} must be an array`);
    assert.ok(value.length <= MAX_ITEMS, `${label} exceeded its bounded witness capacity`);
  }
  assert.ok(forbiddenTexts.length > 0, 'the journey supplied no deleted-cue sentinels');
  assert.deepEqual(inlineErrors, [], 'the successful ASR flow rendered or raised an error surface');

  assert.equal(jobs.length, expectedCount, `one Process click did not create ${expectedCount} jobs`);
  assert.equal(new Set(jobs.map(({ id }) => id)).size, expectedCount, 'native ASR job ids are not distinct');
  assert.ok(jobs.every(({ kind, state }) => kind === 'transcribe' && state === 'succeeded'),
    'every owned native ASR job must terminate successfully');

  assert.ok(rangePublications.length > 0, 'the UI never published its processing ranges');
  const canonicalRanges = assertFourContiguousRanges({
    ranges: rangePublications[0], durationSeconds, maxRequestSeconds, expectedCount,
  });
  for (const ranges of rangePublications.slice(1)) {
    assert.deepEqual(
      assertFourContiguousRanges({ ranges, durationSeconds, maxRequestSeconds, expectedCount }),
      canonicalRanges,
      'the UI and ASR adapter disagreed about the four ranges',
    );
  }

  assert.equal(streamPublications.length, expectedCount,
    'each native window must publish exactly one streaming result');
  const streamed = [];
  streamPublications.forEach((publication, index) => {
    assert.equal(publication.generationActive, true,
      `window ${index} published after aggregate processing became inactive`);
    const segment = normalizeRange(publication.segment, index);
    assert.ok(Math.abs(segment.start - canonicalRanges[index].start) <= TIME_TOLERANCE_SECONDS
      && Math.abs(segment.end - canonicalRanges[index].end) <= TIME_TOLERANCE_SECONDS,
    `stream publication ${index} belongs to the wrong range`);
    assert.ok(Array.isArray(publication.subtitles) && publication.subtitles.length > 0,
      `window ${index} produced no cues`);
    assertNoForbiddenText(
      publication.subtitles.map(({ text }) => String(text ?? '')),
      forbiddenTexts,
      `stream publication ${index}`,
    );
    publication.subtitles.forEach((cue, cueIndex) => {
      const signature = cueSignature(cue, `stream ${index} cue ${cueIndex}`);
      assert.ok(signature.startMs >= Math.round(segment.start * 1_000) - 1
        && signature.endMs <= Math.round(segment.end * 1_000) + 1,
      `stream ${index} emitted a cue outside its native range`);
      streamed.push(signature);
    });
  });

  // React legitimately coalesces paints when the engine finishes several windows within one
  // frame, so a distinct paint per window count cannot be demanded. Live streaming is proven by
  // the earliest window reaching the screen while the aggregate was still active plus monotonic
  // growth; per-window publication liveness is pinned by the exact stream ledger above.
  assert.ok(visibleMilestones.length >= 1,
    'no window ever reached the visible timeline while processing remained active');
  let previousCount = 0;
  let previousStreamCount = 0;
  for (const [index, milestone] of visibleMilestones.entries()) {
    assert.equal(milestone.generationActive, true, `visible milestone ${index} occurred after completion`);
    assert.ok(Number.isSafeInteger(milestone.streamCount)
      && milestone.streamCount >= 1 && milestone.streamCount <= expectedCount,
    `visible milestone ${index} has an invalid stream count`);
    assert.ok(milestone.streamCount >= previousStreamCount,
      `the stream count went backwards at visible milestone ${index}`);
    previousStreamCount = milestone.streamCount;
    assert.ok(Array.isArray(milestone.rows) && milestone.rows.length > previousCount,
      `visible cue count did not grow monotonically at milestone ${index}`);
    previousCount = milestone.rows.length;
    assertNoForbiddenText(milestone.rows, forbiddenTexts, `visible milestone ${index}`);
  }

  const durable = durableCues.map((cue, index) => cueSignature(cue, `durable cue ${index}`));
  assert.ok(durable.length > 0, 'the merged track was not persisted');
  assertNoForbiddenText(durable.map(({ text }) => text), forbiddenTexts, 'durable track');
  const ordered = [...durable].sort((left, right) => (
    left.startMs - right.startMs || left.endMs - right.endMs || left.text.localeCompare(right.text)
  ));
  assert.deepEqual(durable, ordered, 'the durable merge is not in timeline order');
  const streamedOrdered = [...streamed].sort((left, right) => (
    left.startMs - right.startMs || left.endMs - right.endMs || left.text.localeCompare(right.text)
  ));
  assert.deepEqual(durable, streamedOrdered,
    'the durable merged track differs from the four streamed native results');

  for (let index = 1; index < canonicalRanges.length; index += 1) {
    const boundaryMs = Math.round(canonicalRanges[index].start * 1_000);
    assert.ok(durable.some(({ startMs }) => startMs < boundaryMs),
      `no durable cue precedes boundary ${index}`);
    assert.ok(durable.some(({ endMs }) => endMs > boundaryMs),
      `no durable cue follows boundary ${index}`);
  }
  return Object.freeze({
    ranges: canonicalRanges,
    cueCount: durable.length,
    jobIds: Object.freeze(jobs.map(({ id }) => id)),
  });
};
