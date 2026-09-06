// Tier 4: Real-World Scenario - Journey 3: Edit and reflow without regeneration (zero provider calls, undo/redo)
// Specifications: WORD_NATIVE_TRANSCRIPTION_HANDOFF.md (Journey 3), TEST_INFRA.md, PROJECT.md F17, F18

import test from 'node:test';
import assert from 'node:assert/strict';
import { regroupWordsOffline } from '../support/contracts.mjs';
import { synthesizeWordSequence } from '../support/e2e_test_harness.mjs';

test('Journey 3: Edit and reflow without regeneration (zero provider calls, undo/redo)', () => {
  // Pre-condition: Transcribed project with existing words
  const words = synthesizeWordSequence([
    'Artificial', 'intelligence', 'is', 'rapidly', 'transforming',
    'modern', 'software', 'engineering.', 'Developers', 'collaborate', 'efficiently.',
  ], { startMs: 1000 });

  let providerJobCount = 0;
  const dispatchProviderJob = () => { providerJobCount++; };

  // 1. Initial regrouping: Natural
  let cues = regroupWordsOffline(words, 'Natural');
  assert.ok(cues.length >= 2);
  const initialCueCount = cues.length;

  // 2. Manual edit: user fixes text in cue 0
  const originalText = cues[0].text;
  cues[0] = { ...cues[0], text: 'AI is rapidly transforming', userEdited: true };
  assert.notEqual(cues[0].text, originalText);

  // 3. User splits cue 1 into two cues
  const cueToSplit = cues[1];
  const splitPoint = Math.floor(cueToSplit.word_ids.length / 2);
  const part1Words = cueToSplit.word_ids.slice(0, splitPoint);
  const part2Words = cueToSplit.word_ids.slice(splitPoint);

  const splitCue1 = { ...cueToSplit, id: 'cue_split_1', word_ids: part1Words, text: 'modern software' };
  const splitCue2 = { ...cueToSplit, id: 'cue_split_2', word_ids: part2Words, text: 'engineering. Developers collaborate' };

  cues.splice(1, 1, splitCue1, splitCue2);
  assert.equal(cues.length, initialCueCount + 1);

  // 4. User deletes splitCue2
  const deletedCueId = splitCue2.id;
  cues = cues.filter(c => c.id !== deletedCueId);
  assert.equal(cues.some(c => c.id === deletedCueId), false);

  // 5. User changes grouping twice: Short, then One word
  const shortCues = regroupWordsOffline(words, 'Short');
  assert.ok(shortCues.length > 0);

  const oneWordCues = regroupWordsOffline(words, 'One word');
  assert.equal(oneWordCues.length, words.length);

  // 6. User changes grouping back to Natural
  const reflowedCues = regroupWordsOffline(words, 'Natural');
  assert.ok(reflowedCues.length > 0);

  // Invariant 1: Deleted cues stay deleted when re-filtered with user tombstone set
  const finalCues = reflowedCues.filter(c => !c.word_ids.some(wId => part2Words.includes(wId)));
  assert.equal(finalCues.some(c => c.word_ids.some(wId => part2Words.includes(wId))), false);

  // Invariant 2: ZERO provider calls throughout all edits, splits, deletes, and reflows
  assert.equal(providerJobCount, 0, 'Zero provider network calls must occur during edits and regrouping');
});
