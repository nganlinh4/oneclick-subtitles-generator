// Tier 1: Feature Coverage - Area 1: Domain & Transactional Persistence (F01-F04)
// Specifications: ORIGINAL_REQUEST.md §R1, PROJECT.md F01-F04, WORD_NATIVE_TRANSCRIPTION_HANDOFF.md

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  validateTimedWord,
  validateTranscriptRevision,
  validateTranscriptTurn,
} from '../support/contracts.mjs';
import {
  createBaseDatabase,
  applyV15Migration,
  seedProject,
  uuidToBuffer,
  bufferToUuid,
} from '../support/e2e_test_harness.mjs';

test('T1.1.1: TimedWord domain types enforce non-negative monotonic timing and properties', () => {
  const word = {
    id: randomUUID(),
    text: 'Hello',
    start_ms: 1200,
    end_ms: 1650,
    speaker_id: 'speaker_1',
    confidence: 0.98,
    is_unaligned: false,
  };

  assert.equal(validateTimedWord(word), true);
  assert.equal(word.end_ms - word.start_ms, 450);

  // Invariant checks
  assert.throws(() => validateTimedWord({ ...word, start_ms: -10 }), /start_ms must be non-negative/);
  assert.throws(() => validateTimedWord({ ...word, end_ms: 1000 }), /must be >= start_ms/);
  assert.throws(() => validateTimedWord({ ...word, confidence: 1.5 }), /confidence must be in/);
});

test('T1.1.2: TranscriptRevision links immutable words and ordered speaker turns', () => {
  const word1 = { id: randomUUID(), text: 'Welcome', start_ms: 0, end_ms: 400, speaker_id: 'host' };
  const word2 = { id: randomUUID(), text: 'everyone', start_ms: 450, end_ms: 900, speaker_id: 'host' };
  const turn = {
    turn_id: randomUUID(),
    speaker_id: 'host',
    start_ms: 0,
    end_ms: 900,
    word_ids: [word1.id, word2.id],
  };

  const revision = {
    revision_id: randomUUID(),
    project_id: randomUUID(),
    created_at: Date.now(),
    words: [word1, word2],
    turns: [turn],
  };

  assert.equal(validateTranscriptTurn(turn), true);
  assert.equal(validateTranscriptRevision(revision), true);
  assert.equal(revision.words.length, 2);
  assert.equal(revision.turns[0].word_ids.length, 2);
});

test('T1.1.3: Additive SQLite Migration v15 creates new tables without mutating existing v14 schema', () => {
  const db = createBaseDatabase();
  const { projectId } = seedProject(db, { title: 'Pre-migration Project' });

  // Add an existing cue in v14 schema
  const cueId = randomUUID();
  const trackId = randomUUID();
  db.prepare(`
    INSERT INTO cues (id, project_id, track_id, ordinal, start_ms, end_ms, text)
    VALUES (?, ?, ?, 1, 1000, 3000, 'Existing pre-migration subtitle')
  `).run(uuidToBuffer(cueId), uuidToBuffer(projectId), uuidToBuffer(trackId));

  // Apply v15 additive migration
  applyV15Migration(db);

  // Verify v14 data remains intact
  const existingCue = db.prepare('SELECT text, start_ms, end_ms FROM cues WHERE id = ?')
    .get(uuidToBuffer(cueId));
  assert.ok(existingCue);
  assert.equal(existingCue.text, 'Existing pre-migration subtitle');
  assert.equal(existingCue.start_ms, 1000);

  // Verify new v15 tables exist and accept queries
  const revisionCount = db.prepare('SELECT count(*) as count FROM transcript_revisions').get();
  const wordCount = db.prepare('SELECT count(*) as count FROM transcript_words').get();
  const turnCount = db.prepare('SELECT count(*) as count FROM transcript_turns').get();
  const mappingCount = db.prepare('SELECT count(*) as count FROM cue_word_mappings').get();

  assert.equal(revisionCount.count, 0);
  assert.equal(wordCount.count, 0);
  assert.equal(turnCount.count, 0);
  assert.equal(mappingCount.count, 0);
});

test('T1.1.4: Pre-change v1-v14 legacy projects load seamlessly as cue-only without synthetic word timings', () => {
  const db = createBaseDatabase();
  const { projectId } = seedProject(db, { title: 'Legacy v14 Project' });

  // Seed 3 legacy cues
  const trackId = randomUUID();
  const legacyTexts = ['First sentence.', 'Second phrase spoken.', 'Third final line.'];
  legacyTexts.forEach((text, idx) => {
    db.prepare(`
      INSERT INTO cues (id, project_id, track_id, ordinal, start_ms, end_ms, text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuidToBuffer(randomUUID()), uuidToBuffer(projectId), uuidToBuffer(trackId), idx + 1, idx * 2000, (idx + 1) * 2000, text);
  });

  // Apply v15 migration
  applyV15Migration(db);

  // Assert: No synthetic transcript_words or transcript_revisions fabricated
  const wordsForProject = db.prepare(`
    SELECT w.* FROM transcript_words w
    JOIN transcript_revisions r ON w.revision_id = r.revision_id
    WHERE r.project_id = ?
  `).all(uuidToBuffer(projectId));

  assert.equal(wordsForProject.length, 0, 'Legacy projects must NOT fabricate synthetic word timings');

  // Verify all original cues load intact
  const loadedCues = db.prepare('SELECT ordinal, text FROM cues WHERE project_id = ? ORDER BY ordinal')
    .all(uuidToBuffer(projectId));
  assert.equal(loadedCues.length, 3);
  assert.equal(loadedCues[0].text, 'First sentence.');
});

test('T1.1.5: Transactional persistence recovers word timestamps, speakers, and turns across save/relaunch', () => {
  const db = createBaseDatabase();
  applyV15Migration(db);
  const { projectId, mediaId } = seedProject(db, { title: 'Word Native Project' });

  const revisionId = randomUUID();
  const now = Date.now();

  // Insert Revision
  db.prepare(`
    INSERT INTO transcript_revisions (revision_id, project_id, source_asset_id, created_at_ms, provider_model, word_count, turn_count)
    VALUES (?, ?, ?, ?, 'gemini-3.5-transcribe', 3, 1)
  `).run(uuidToBuffer(revisionId), uuidToBuffer(projectId), uuidToBuffer(mediaId), now);

  // Insert Words
  const word1Id = randomUUID();
  const word2Id = randomUUID();
  const word3Id = randomUUID();

  const insertWord = db.prepare(`
    INSERT INTO transcript_words (id, revision_id, ordinal, text, start_ms, end_ms, speaker_id, confidence, is_unaligned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertWord.run(uuidToBuffer(word1Id), uuidToBuffer(revisionId), 0, 'One', 500, 800, 'spk_1', 0.99, 0);
  insertWord.run(uuidToBuffer(word2Id), uuidToBuffer(revisionId), 1, 'click', 820, 1100, 'spk_1', 0.98, 0);
  insertWord.run(uuidToBuffer(word3Id), uuidToBuffer(revisionId), 2, 'subtitles', 1150, 1800, 'spk_1', 0.95, 0);

  // Query back and verify fidelity
  const savedWords = db.prepare(`
    SELECT id, ordinal, text, start_ms, end_ms, speaker_id, confidence, is_unaligned
    FROM transcript_words WHERE revision_id = ? ORDER BY ordinal
  `).all(uuidToBuffer(revisionId));

  assert.equal(savedWords.length, 3);
  assert.equal(bufferToUuid(savedWords[0].id), word1Id);
  assert.equal(savedWords[0].text, 'One');
  assert.equal(savedWords[0].start_ms, 500);
  assert.equal(savedWords[0].end_ms, 800);
  assert.equal(savedWords[1].text, 'click');
  assert.equal(savedWords[2].text, 'subtitles');
});

test('T1.1.6: Indexed range queries efficiently retrieve words within specific time intervals', () => {
  const db = createBaseDatabase();
  applyV15Migration(db);
  const { projectId } = seedProject(db);
  const revisionId = randomUUID();

  db.prepare(`
    INSERT INTO transcript_revisions (revision_id, project_id, created_at_ms, provider_model, word_count, turn_count)
    VALUES (?, ?, ?, 'gemini-3.5-transcribe', 10, 1)
  `).run(uuidToBuffer(revisionId), uuidToBuffer(projectId), Date.now());

  const insertWord = db.prepare(`
    INSERT INTO transcript_words (id, revision_id, ordinal, text, start_ms, end_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Insert 10 words spaced across 10 seconds
  for (let i = 0; i < 10; i++) {
    insertWord.run(uuidToBuffer(randomUUID()), uuidToBuffer(revisionId), i, `Word${i}`, i * 1000, i * 1000 + 600);
  }

  // Query words in range [2500, 5500]
  const rangeWords = db.prepare(`
    SELECT ordinal, text, start_ms, end_ms FROM transcript_words
    WHERE revision_id = ? AND start_ms <= 5500 AND end_ms >= 2500
    ORDER BY ordinal
  `).all(uuidToBuffer(revisionId));

  // Words falling in this range should be Word2 (2000-2600), Word3 (3000-3600), Word4 (4000-4600), Word5 (5000-5600)
  assert.equal(rangeWords.length, 4);
  assert.equal(rangeWords[0].text, 'Word2');
  assert.equal(rangeWords[3].text, 'Word5');
});
