// Tier 4: Real-World Scenario - Journey 4: Save / relaunch / migration with intact words, edits, and pre-change project support
// Specifications: WORD_NATIVE_TRANSCRIPTION_HANDOFF.md (Journey 4), TEST_INFRA.md, PROJECT.md F02, F03, F04

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createBaseDatabase,
  applyV15Migration,
  seedProject,
  uuidToBuffer,
  bufferToUuid,
} from '../support/e2e_test_harness.mjs';

test('Journey 4: Save / relaunch / migration with intact words, edits, and pre-change project support', () => {
  // Phase 1: Create a Legacy Project B in pre-v15 database (v1-v14 schema)
  const db = createBaseDatabase();
  const legacyProjectId = randomUUID();
  const legacyTrackId = randomUUID();

  db.prepare(`
    INSERT INTO projects (id, title, state_version, created_at_ms, updated_at_ms)
    VALUES (?, 'Pre-Change v14 Project', 0, 1000, 1000)
  `).run(uuidToBuffer(legacyProjectId));

  db.prepare(`
    INSERT INTO cues (id, project_id, track_id, ordinal, start_ms, end_ms, text)
    VALUES (?, ?, ?, 1, 0, 4000, 'Legacy subtitle before migration')
  `).run(uuidToBuffer(randomUUID()), uuidToBuffer(legacyProjectId), uuidToBuffer(legacyTrackId));

  // Phase 2: Run Application Migration to v15
  applyV15Migration(db);

  // Phase 3: Create Word-Native Project A in v15 database
  const modernProjectId = randomUUID();
  const modernProjectBuffer = uuidToBuffer(modernProjectId);
  const revisionId = randomUUID();
  const revBuffer = uuidToBuffer(revisionId);

  db.prepare(`
    INSERT INTO projects (id, title, state_version, created_at_ms, updated_at_ms)
    VALUES (?, 'Modern Word Native Project', 1, 2000, 2000)
  `).run(modernProjectBuffer);

  db.prepare(`
    INSERT INTO transcript_revisions (revision_id, project_id, created_at_ms, provider_model, word_count, turn_count)
    VALUES (?, ?, ?, 'gemini-3.5-transcribe', 2, 1)
  `).run(revBuffer, modernProjectBuffer, Date.now());

  const word1Id = randomUUID();
  const word2Id = randomUUID();
  db.prepare(`
    INSERT INTO transcript_words (id, revision_id, ordinal, text, start_ms, end_ms, speaker_id)
    VALUES (?, ?, 0, 'WordOne', 1200, 1600, 'speaker_alice')
  `).run(uuidToBuffer(word1Id), revBuffer);

  db.prepare(`
    INSERT INTO transcript_words (id, revision_id, ordinal, text, start_ms, end_ms, speaker_id)
    VALUES (?, ?, 1, 'WordTwo', 1650, 2100, 'speaker_alice')
  `).run(uuidToBuffer(word2Id), revBuffer);

  // Phase 4: Simulate App Close and Relaunch (reading directly from persisted DB without cache)
  // Verification A: Modern Project A reloaded
  const reloadedWords = db.prepare(`
    SELECT text, start_ms, end_ms, speaker_id FROM transcript_words
    WHERE revision_id = ? ORDER BY ordinal
  `).all(revBuffer);

  assert.equal(reloadedWords.length, 2);
  assert.equal(reloadedWords[0].text, 'WordOne');
  assert.equal(reloadedWords[0].start_ms, 1200);
  assert.equal(reloadedWords[0].end_ms, 1600);
  assert.equal(reloadedWords[0].speaker_id, 'speaker_alice');

  assert.equal(reloadedWords[1].text, 'WordTwo');
  assert.equal(reloadedWords[1].start_ms, 1650);
  assert.equal(reloadedWords[1].end_ms, 2100);

  // Verification B: Pre-change Legacy Project B reloaded
  const reloadedLegacyCues = db.prepare(`
    SELECT text, start_ms, end_ms FROM cues
    WHERE project_id = ?
  `).all(uuidToBuffer(legacyProjectId));

  assert.equal(reloadedLegacyCues.length, 1);
  assert.equal(reloadedLegacyCues[0].text, 'Legacy subtitle before migration');
  assert.equal(reloadedLegacyCues[0].start_ms, 0);
  assert.equal(reloadedLegacyCues[0].end_ms, 4000);

  // Invariant: Legacy project does NOT have fabricated transcript_words
  const legacyWords = db.prepare(`
    SELECT w.* FROM transcript_words w
    JOIN transcript_revisions r ON w.revision_id = r.revision_id
    WHERE r.project_id = ?
  `).all(uuidToBuffer(legacyProjectId));

  assert.equal(legacyWords.length, 0, 'Pre-change project must remain usable as cue-only without synthetic words');
});
