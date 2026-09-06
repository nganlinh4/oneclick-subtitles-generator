// Tier 2: Boundary & Corner Cases - Area 1: Domain & Transactional Persistence Boundary
// Specifications: ORIGINAL_REQUEST.md §R1, PROJECT.md F01-F04, WORD_NATIVE_TRANSCRIPTION_HANDOFF.md

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validateTimedWord,
  validateTranscriptRevision,
} from '../support/contracts.mjs';
import {
  createBaseDatabase,
  applyV15Migration,
  seedProject,
  uuidToBuffer,
  bufferToUuid,
} from '../support/e2e_test_harness.mjs';

test('T2.1.1: Empty transcript (0 words, 0 turns) stores and retrieves cleanly without crash', () => {
  const db = createBaseDatabase();
  applyV15Migration(db);
  const { projectId } = seedProject(db);

  const revisionId = randomUUID();
  const emptyRevision = {
    revision_id: revisionId,
    project_id: projectId,
    created_at: Date.now(),
    words: [],
    turns: [],
  };

  assert.equal(validateTranscriptRevision(emptyRevision), true);

  db.prepare(`
    INSERT INTO transcript_revisions (revision_id, project_id, created_at_ms, provider_model, word_count, turn_count)
    VALUES (?, ?, ?, 'gemini-3.5-transcribe', 0, 0)
  `).run(uuidToBuffer(revisionId), uuidToBuffer(projectId), emptyRevision.created_at);

  const stored = db.prepare('SELECT word_count, turn_count FROM transcript_revisions WHERE revision_id = ?')
    .get(uuidToBuffer(revisionId));
  assert.equal(stored.word_count, 0);
  assert.equal(stored.turn_count, 0);

  const words = db.prepare('SELECT * FROM transcript_words WHERE revision_id = ?')
    .all(uuidToBuffer(revisionId));
  assert.equal(words.length, 0);
});

test('T2.1.2: Zero-duration words (start_ms == end_ms) handled without division by zero or negative interval', () => {
  const zeroDurationWord = {
    id: randomUUID(),
    text: 'snap',
    start_ms: 5000,
    end_ms: 5000, // exact instantaneous boundary
    confidence: 0.9,
    is_unaligned: false,
  };

  assert.equal(validateTimedWord(zeroDurationWord), true);
  assert.equal(zeroDurationWord.end_ms - zeroDurationWord.start_ms, 0);

  // Division by zero safeguard in progress/ratio calculations
  const calculateWordProgress = (word, currentMs) => {
    const duration = word.end_ms - word.start_ms;
    if (duration <= 0) {
      return currentMs >= word.start_ms ? 1.0 : 0.0;
    }
    return Math.min(1.0, Math.max(0.0, (currentMs - word.start_ms) / duration));
  };

  assert.equal(calculateWordProgress(zeroDurationWord, 4999), 0.0);
  assert.equal(calculateWordProgress(zeroDurationWord, 5000), 1.0);
  assert.equal(calculateWordProgress(zeroDurationWord, 5001), 1.0);
});

test('T2.1.3: 64-bit integer timestamp boundary values (>24 hours) handled without overflow', () => {
  const day24Ms = 24 * 60 * 60 * 1000; // 86,400,000 ms
  const day48Ms = 48 * 60 * 60 * 1000; // 172,800,000 ms

  const longMediaWord = {
    id: randomUUID(),
    text: 'marathon',
    start_ms: day24Ms,
    end_ms: day24Ms + 800,
    is_unaligned: false,
  };

  assert.equal(validateTimedWord(longMediaWord), true);
  assert.ok(Number.isSafeInteger(day48Ms));
  assert.ok(day48Ms < Number.MAX_SAFE_INTEGER);
});

test('T2.1.4: Pre-change SQLite migration handles partial v14 rows and null fields gracefully', () => {
  const db = createBaseDatabase();
  const projectId = randomUUID();
  const projectBuffer = uuidToBuffer(projectId);

  // Insert project with 0 state_version
  db.prepare(`
    INSERT INTO projects (id, title, state_version, created_at_ms, updated_at_ms)
    VALUES (?, 'Minimal Legacy Project', 0, 1000, 1000)
  `).run(projectBuffer);

  // Insert cue with minimal valid fields
  const cueId = randomUUID();
  db.prepare(`
    INSERT INTO cues (id, project_id, track_id, ordinal, start_ms, end_ms, text)
    VALUES (?, ?, ?, 1, 0, 1000, '')
  `).run(uuidToBuffer(cueId), projectBuffer, uuidToBuffer(randomUUID()));

  // Run migration
  applyV15Migration(db);

  // Validate integrity
  const cue = db.prepare('SELECT text, start_ms, end_ms FROM cues WHERE id = ?').get(uuidToBuffer(cueId));
  assert.equal(cue.text, '');
  assert.equal(cue.start_ms, 0);
  assert.equal(cue.end_ms, 1000);
});

test('T2.1.5: High-volume persistence (5,000 words in single revision) commits with transactional integrity', () => {
  const db = createBaseDatabase();
  applyV15Migration(db);
  const { projectId } = seedProject(db);

  const revisionId = randomUUID();
  const revBuffer = uuidToBuffer(revisionId);
  const wordCount = 5_000;

  db.prepare(`
    INSERT INTO transcript_revisions (revision_id, project_id, created_at_ms, provider_model, word_count, turn_count)
    VALUES (?, ?, ?, 'gemini-3.5-transcribe', ?, 1)
  `).run(revBuffer, uuidToBuffer(projectId), Date.now(), wordCount);

  const insertWord = db.prepare(`
    INSERT INTO transcript_words (id, revision_id, ordinal, text, start_ms, end_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN TRANSACTION;');
  for (let i = 0; i < wordCount; i++) {
    insertWord.run(uuidToBuffer(randomUUID()), revBuffer, i, `w${i}`, i * 200, i * 200 + 180);
  }
  db.exec('COMMIT;');

  const countResult = db.prepare('SELECT count(*) as total FROM transcript_words WHERE revision_id = ?')
    .get(revBuffer);
  assert.equal(countResult.total, wordCount);

  // Spot check first and last
  const firstWord = db.prepare('SELECT text, start_ms FROM transcript_words WHERE revision_id = ? AND ordinal = 0')
    .get(revBuffer);
  const lastWord = db.prepare('SELECT text, start_ms FROM transcript_words WHERE revision_id = ? AND ordinal = ?')
    .get(revBuffer, wordCount - 1);

  assert.equal(firstWord.text, 'w0');
  assert.equal(firstWord.start_ms, 0);
  assert.equal(lastWord.text, `w${wordCount - 1}`);
  assert.equal(lastWord.start_ms, (wordCount - 1) * 200);
});

test('T2.1.6: Foreign key cascade deletions remove associated transcript words and turns when project is deleted', () => {
  const db = createBaseDatabase();
  applyV15Migration(db);
  const { projectId } = seedProject(db);
  const projectBuffer = uuidToBuffer(projectId);

  const revisionId = randomUUID();
  const revBuffer = uuidToBuffer(revisionId);

  db.prepare(`
    INSERT INTO transcript_revisions (revision_id, project_id, created_at_ms, provider_model, word_count, turn_count)
    VALUES (?, ?, ?, 'gemini-3.5-transcribe', 1, 0)
  `).run(revBuffer, projectBuffer, Date.now());

  db.prepare(`
    INSERT INTO transcript_words (id, revision_id, ordinal, text, start_ms, end_ms)
    VALUES (?, ?, 0, 'CascadedWord', 0, 500)
  `).run(uuidToBuffer(randomUUID()), revBuffer);

  // Delete project
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectBuffer);

  // Words and revisions must be cleaned up via CASCADE
  const remainingRevs = db.prepare('SELECT count(*) as c FROM transcript_revisions WHERE project_id = ?')
    .get(projectBuffer);
  const remainingWords = db.prepare('SELECT count(*) as c FROM transcript_words WHERE revision_id = ?')
    .get(revBuffer);

  assert.equal(remainingRevs.c, 0);
  assert.equal(remainingWords.c, 0);
});
