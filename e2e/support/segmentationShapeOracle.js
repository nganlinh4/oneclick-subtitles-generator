import { strict as assert } from 'node:assert';

/**
 * Pure oracles for transcriptionRulesAndAnalysis.journey.js: proving the public local-ASR
 * segmentation settings (osg-asr's SegmentationOptions -- strategy/max_characters/max_words/
 * pause_threshold_ms) change the SHAPE of durably transcribed cues in the documented direction, and
 * that no provider-owned job appears without a credential.
 */

/**
 * Word count using the same whitespace-splitting definition the product's own request builds for
 * English/Latin text: crates/osg-asr/src/segment.rs joins words with a single ASCII space for
 * non-CJK output, so counting whitespace-delimited tokens matches what the engine itself counted.
 */
export const wordCount = (text) => {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/u).length;
};

/**
 * Prove the public "Split by word count" setting caps every produced cue at the requested word
 * count -- the exact contract `limited_segments` in crates/osg-asr/src/segment.rs enforces (a
 * segment ends once it holds `max_words` words, a pause boundary is reached, or input ends), not
 * merely "shorter on average". Also protects against an engine that silently ignored the setting
 * and produced one giant cue.
 */
export const verifyWordCappedSegmentationShape = ({ cues, maxWords }) => {
  assert.ok(Number.isSafeInteger(maxWords) && maxWords > 0, 'maxWords must be a positive integer');
  assert.ok(Array.isArray(cues) && cues.length > 0, 'the word-capped run produced no durable cues');
  const counts = cues.map((cue) => wordCount(cue.text));
  const offenders = cues.filter((cue, index) => counts[index] > maxWords);
  assert.deepEqual(
    offenders,
    [],
    `word-capped segmentation produced a cue over its ${maxWords}-word limit: ${JSON.stringify(offenders)}`,
  );
  const totalWords = counts.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    cueCount: cues.length,
    totalWords,
    averageWords: totalWords / cues.length,
    maxObservedWords: Math.max(...counts),
  });
};

/** Reduce a durable cue array into the same shape verifyWordCappedSegmentationShape returns, for
 * the unconstrained (full-sentence) run this journey compares against. */
export const summarizeSegmentationShape = (cues) => {
  assert.ok(Array.isArray(cues) && cues.length > 0, 'the run produced no durable cues');
  const counts = cues.map((cue) => wordCount(cue.text));
  const totalWords = counts.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    cueCount: cues.length,
    totalWords,
    averageWords: totalWords / cues.length,
    maxObservedWords: Math.max(...counts),
  });
};

/**
 * Prove the documented direction: a small word-count cap produces MORE, SHORTER cues than full
 * sentences (no word limit) transcribed from the exact same audio. This is the customer-visible
 * SHAPE change the public segmentation controls promise -- not a claim about transcript accuracy,
 * wording, or timing.
 */
export const verifySegmentationShapeDirection = ({ wordCapped, sentence }) => {
  assert.ok(
    wordCapped.cueCount > sentence.cueCount,
    'word-capped segmentation did not produce more cues than full-sentence segmentation: '
    + JSON.stringify({ wordCapped, sentence }),
  );
  assert.ok(
    wordCapped.averageWords < sentence.averageWords,
    'word-capped cues were not shorter on average than full-sentence cues: '
    + JSON.stringify({ wordCapped, sentence }),
  );
  return Object.freeze({ wordCapped, sentence });
};

/**
 * Prove no provider-owned job of any watched kind was created between two durable snapshots --
 * the same "before/after job diff" shape geminiCredentialBoundary.journey.js already uses, kept as
 * a pure, independently testable function rather than duplicated inline per journey.
 */
export const assertNoNewProviderJob = ({ before, after, providerKinds }) => {
  const kinds = new Set(providerKinds);
  const beforeJobs = before.jobs.filter((job) => kinds.has(job.kind));
  const afterJobs = after.jobs.filter((job) => kinds.has(job.kind));
  assert.deepEqual(
    afterJobs,
    beforeJobs,
    `a provider-owned job appeared without a credential: ${JSON.stringify({ beforeJobs, afterJobs })}`,
  );
  return Object.freeze({ providerJobCount: afterJobs.length });
};
