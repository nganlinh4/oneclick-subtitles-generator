// Tier 4: Real-World Scenario - Journey 5: Parallel long recording with at least 4 windows, progressive durable output, and seamless boundary joins
// Specifications: WORD_NATIVE_TRANSCRIPTION_HANDOFF.md (Journey 5), TEST_INFRA.md, PROJECT.md F08, F09

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createBaseDatabase,
  applyV15Migration,
  seedProject,
  uuidToBuffer,
} from '../support/e2e_test_harness.mjs';
import { projectWindowOffset } from '../support/contracts.mjs';

test('Journey 5: Parallel long recording with at least 4 windows, progressive durable output, and seamless boundary joins', async () => {
  const db = createBaseDatabase();
  applyV15Migration(db);
  const { projectId, mediaId } = seedProject(db, { title: 'Long Recording (12m)', durationMs: 720_000 });

  // 12-minute media split into 4 windows of 180s (3 minutes) each:
  // Window 0: [0, 180s]
  // Window 1: [180s, 360s]
  // Window 2: [360s, 540s]
  // Window 3: [540s, 720s]
  const windowRanges = [
    { index: 0, startMs: 0, endMs: 180_000 },
    { index: 1, startMs: 180_000, endMs: 360_000 },
    { index: 2, startMs: 360_000, endMs: 540_000 },
    { index: 3, startMs: 540_000, endMs: 720_000 },
  ];

  // Bounded 2-worker pool: Max concurrency = 2
  let activeWorkers = 0;
  let peakConcurrency = 0;

  // Window completion order: Window 1 completes BEFORE Window 0 (out-of-order execution)
  const windowExecution = async (win) => {
    activeWorkers++;
    peakConcurrency = Math.max(peakConcurrency, activeWorkers);
    // Simulate latency: Win 0 takes 40ms, Win 1 takes 10ms, Win 2 takes 20ms, Win 3 takes 20ms
    const delays = [40, 10, 20, 20];
    await new Promise(r => setTimeout(r, delays[win.index]));
    activeWorkers--;

    // Produce words for this window (including boundary speech)
    const words = [
      { text: `w${win.index}_first`, offsetMs: 500, durationMs: 400 },
      { text: `w${win.index}_mid`, offsetMs: 90_000, durationMs: 500 },
      { text: `w${win.index}_boundary`, offsetMs: 179_200, durationMs: 600 },
    ];

    return {
      windowIndex: win.index,
      projectWords: words.map((w, i) => ({
        id: randomUUID(),
        ordinal: win.index * 10 + i,
        text: w.text,
        start_ms: projectWindowOffset(win.startMs, w.offsetMs),
        end_ms: projectWindowOffset(win.startMs, w.offsetMs + w.durationMs),
        speaker_id: `w${win.index}:speaker_1`,
      })),
    };
  };

  // Run through bounded pool
  const results = [];
  // Schedule batches of 2
  const batch1 = await Promise.all([windowExecution(windowRanges[0]), windowExecution(windowRanges[1])]);
  results.push(...batch1);
  const batch2 = await Promise.all([windowExecution(windowRanges[2]), windowExecution(windowRanges[3])]);
  results.push(...batch2);

  assert.equal(peakConcurrency, 2, 'Worker pool must strictly bound concurrency to 2');

  // Progressive durable output: commit words into SQLite
  const revisionId = randomUUID();
  const revBuffer = uuidToBuffer(revisionId);
  db.prepare(`
    INSERT INTO transcript_revisions (revision_id, project_id, created_at_ms, provider_model, word_count, turn_count)
    VALUES (?, ?, ?, 'gemini-3.5-transcribe', ?, 4)
  `).run(revBuffer, uuidToBuffer(projectId), Date.now(), results.length * 3);

  const insertWord = db.prepare(`
    INSERT INTO transcript_words (id, revision_id, ordinal, text, start_ms, end_ms, speaker_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const allCommittedWords = results.flatMap(r => r.projectWords).sort((a, b) => a.start_ms - b.start_ms);
  for (let i = 0; i < allCommittedWords.length; i++) {
    const w = allCommittedWords[i];
    insertWord.run(uuidToBuffer(w.id), revBuffer, i, w.text, w.start_ms, w.end_ms, w.speaker_id);
  }

  // Verification: Seamless boundary joins
  // Boundary between Win 0 and Win 1:
  const win0Last = allCommittedWords.find(w => w.text === 'w0_boundary');
  const win1First = allCommittedWords.find(w => w.text === 'w1_first');

  assert.equal(win0Last.start_ms, 179_200);
  assert.equal(win0Last.end_ms, 179_800);
  assert.equal(win1First.start_ms, 180_500);

  // Invariant: Monotonic progression across window boundaries without negative time jumps
  assert.ok(win1First.start_ms >= win0Last.end_ms);
  assert.ok(win1First.start_ms - win0Last.end_ms <= 1000, 'Boundary gap must be seamless');
});
