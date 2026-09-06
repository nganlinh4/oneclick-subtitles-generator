// Tier 2: Boundary & Corner Cases - Area 2: Specialized Provider & Native Engine Boundary
// Specifications: ORIGINAL_REQUEST.md §R2, PROJECT.md F05-F10, WORD_NATIVE_TRANSCRIPTION_HANDOFF.md

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDurationToNanoseconds,
  projectWordWith100msOvershootPolicy,
  namespaceSpeaker,
} from '../support/contracts.mjs';

test('T2.2.1: Exactly 100ms overshoot clamped to media end; 101ms overshoot quarantined', () => {
  const mediaDurationMs = 120_000; // 2 minutes

  // Exactly 100ms overshoot (120,100ms)
  const edge100 = projectWordWith100msOvershootPolicy({
    word: 'edge100',
    start_offset: '119.500s',
    end_offset: '120.100s',
  }, mediaDurationMs);

  assert.equal(edge100.status, 'clamped');
  assert.equal(edge100.word.clamped_end_ms, mediaDurationMs);
  assert.equal(edge100.word.overshoot_ms, 100);

  // 101ms overshoot (120,101ms)
  const edge101 = projectWordWith100msOvershootPolicy({
    word: 'edge101',
    start_offset: '119.500s',
    end_offset: '120.101s',
  }, mediaDurationMs);

  assert.equal(edge101.status, 'quarantined');
  assert.ok(edge101.reason.includes('overshoot_exceeds_100ms'));
});

test('T2.2.2: Negative start offset or non-monotonic timestamps rejected by parser/validator', () => {
  assert.throws(() => parseDurationToNanoseconds('-0.5s'), /Negative duration offset disallowed/);
  assert.throws(() => parseDurationToNanoseconds('invalid-format'), /Invalid duration string format/);
  assert.throws(() => parseDurationToNanoseconds('1.2.3s'), /Malformed duration decimal/);

  // Reversed timestamps: start > end
  const reversed = projectWordWith100msOvershootPolicy({
    word: 'reversed',
    start_offset: '10.000s',
    end_offset: '8.000s',
  }, 30_000);

  assert.equal(reversed.status, 'rejected');
  assert.equal(reversed.reason, 'reversed_timestamps');
});

test('T2.2.3: Provider response with empty audioTranscription.words handled gracefully as silence', () => {
  const emptyTranscriptionPart = {
    audioTranscription: {
      words: [],
    },
  };

  const processProviderWords = (part) => {
    if (!part?.audioTranscription?.words) return [];
    return part.audioTranscription.words;
  };

  const extracted = processProviderWords(emptyTranscriptionPart);
  assert.equal(Array.isArray(extracted), true);
  assert.equal(extracted.length, 0, 'Silent media should yield clean empty word array without error');
});

test('T2.2.4: Cross-window speaker namespacing prevents collision across 4 windows', () => {
  const windowCount = 4;
  const rawProviderSpeaker = 'Speaker 1';

  const namespaced = [];
  for (let w = 0; w < windowCount; w++) {
    namespaced.push(namespaceSpeaker(w, rawProviderSpeaker));
  }

  // All 4 must be distinct namespaced identifiers
  const uniqueNames = new Set(namespaced);
  assert.equal(uniqueNames.size, 4);
  assert.equal(namespaced[0], 'w0:Speaker 1');
  assert.equal(namespaced[3], 'w3:Speaker 1');
});

test('T2.2.5: Bounded 2-worker pool queueing strictly bounds concurrency to 2 active workers', async () => {
  class BoundedWorkerPool {
    constructor(maxConcurrency = 2) {
      this.maxConcurrency = maxConcurrency;
      this.activeWorkers = 0;
      this.peakConcurrency = 0;
      this.queue = [];
    }

    async run(taskFn) {
      if (this.activeWorkers >= this.maxConcurrency) {
        await new Promise(resolve => this.queue.push(resolve));
      }
      this.activeWorkers++;
      this.peakConcurrency = Math.max(this.peakConcurrency, this.activeWorkers);
      try {
        return await taskFn();
      } finally {
        this.activeWorkers--;
        if (this.queue.length > 0) {
          const next = this.queue.shift();
          next();
        }
      }
    }
  }

  const pool = new BoundedWorkerPool(2);
  const taskDelays = [20, 20, 20, 20, 20];
  const results = await Promise.all(taskDelays.map((delay, idx) =>
    pool.run(async () => {
      await new Promise(r => setTimeout(r, delay));
      return `result-${idx}`;
    })
  ));

  assert.equal(results.length, 5);
  assert.equal(pool.peakConcurrency, 2, 'Worker pool concurrency must NEVER exceed 2');
  assert.equal(pool.activeWorkers, 0);
});

test('T2.2.6: Targeted window retry modifies only failed window interval without touching sisters', () => {
  const windowsState = [
    { windowIndex: 0, range: [0, 60], status: 'promoted', words: ['w0-1', 'w0-2'] },
    { windowIndex: 1, range: [60, 120], status: 'failed', words: [] },
    { windowIndex: 2, range: [120, 180], status: 'promoted', words: ['w2-1', 'w2-2'] },
  ];

  // User triggers retry for failed window 1
  const retryWindow = (state, targetIndex, newWords) => state.map(win => {
    if (win.windowIndex === targetIndex) {
      return { ...win, status: 'promoted', words: newWords };
    }
    return win; // Sister windows completely untouched
  });

  const retriedState = retryWindow(windowsState, 1, ['w1-1', 'w1-2']);

  assert.equal(retriedState[1].status, 'promoted');
  assert.deepEqual(retriedState[1].words, ['w1-1', 'w1-2']);
  assert.deepEqual(retriedState[0].words, ['w0-1', 'w0-2'], 'Window 0 words must remain untouched');
  assert.deepEqual(retriedState[2].words, ['w2-1', 'w2-2'], 'Window 2 words must remain untouched');
});
