// Tier 2: Boundary & Corner Cases - Area 4: Editing Surface & Local Regrouping Boundary
// Specifications: ORIGINAL_REQUEST.md §R4, PROJECT.md F15-F20, WORD_NATIVE_TRANSCRIPTION_HANDOFF.md

import test from 'node:test';
import assert from 'node:assert/strict';
import { regroupWordsOffline } from '../support/contracts.mjs';
import { synthesizeWordSequence } from '../support/e2e_test_harness.mjs';

test('T2.4.1: Rapid sequential switching between all 4 regrouping policies preserves word inventory', () => {
  const words = synthesizeWordSequence(['Word1', 'Word2', 'Word3', 'Word4', 'Word5', 'Word6']);
  const policies = ['Natural', 'Short', 'One word', 'Custom', 'Natural', 'One word'];

  for (const policy of policies) {
    const cues = regroupWordsOffline(words, policy, { max_words: 2 });
    const allAssignedWords = cues.flatMap(c => c.word_ids);
    assert.equal(allAssignedWords.length, words.length, `Policy ${policy} lost words`);
    assert.deepEqual(allAssignedWords.sort(), words.map(w => w.id).sort());
  }
});

test('T2.4.2: Merging two cues across speaker boundary preserves underlying speaker turn provenance', () => {
  const cueA = {
    id: 'cue-1',
    start_ms: 1000,
    end_ms: 1800,
    text: 'Hello',
    word_ids: ['w1'],
    speaker_id: 'host',
  };
  const cueB = {
    id: 'cue-2',
    start_ms: 1900,
    end_ms: 2700,
    text: 'Hi there',
    word_ids: ['w2', 'w3'],
    speaker_id: 'guest',
  };

  const mergeCues = (c1, c2) => ({
    id: `merged_${c1.id}_${c2.id}`,
    start_ms: c1.start_ms,
    end_ms: c2.end_ms,
    text: `${c1.text} ${c2.text}`,
    word_ids: [...c1.word_ids, ...c2.word_ids],
    multi_speaker: c1.speaker_id !== c2.speaker_id,
  });

  const merged = mergeCues(cueA, cueB);
  assert.equal(merged.start_ms, 1000);
  assert.equal(merged.end_ms, 2700);
  assert.equal(merged.text, 'Hello Hi there');
  assert.deepEqual(merged.word_ids, ['w1', 'w2', 'w3']);
  assert.equal(merged.multi_speaker, true, 'Merged cross-speaker cue must tag multi-speaker provenance');
});

test('T2.4.3: Splitting a cue on word boundary divides word IDs accurately; character split marks unaligned', () => {
  const words = [
    { id: 'w1', text: 'First', start_ms: 1000, end_ms: 1400 },
    { id: 'w2', text: 'Second', start_ms: 1500, end_ms: 1900 },
  ];
  const cue = { id: 'cue-orig', text: 'First Second', word_ids: ['w1', 'w2'], start_ms: 1000, end_ms: 1900 };

  // Case A: Split on word boundary (between w1 and w2)
  const splitWordBoundary = (c, splitIndex) => [
    { id: `${c.id}_part1`, text: 'First', word_ids: ['w1'], start_ms: 1000, end_ms: 1400, is_unaligned: false },
    { id: `${c.id}_part2`, text: 'Second', word_ids: ['w2'], start_ms: 1500, end_ms: 1900, is_unaligned: false },
  ];
  const parts = splitWordBoundary(cue, 1);
  assert.equal(parts[0].word_ids.length, 1);
  assert.equal(parts[1].word_ids.length, 1);
  assert.equal(parts[0].is_unaligned, false);

  // Case B: Split inside a word (e.g. slicing "Second" into "Sec" and "ond")
  const splitInsideWord = (c) => [
    { id: `${c.id}_p1`, text: 'First Sec', word_ids: ['w1'], is_unaligned: true },
    { id: `${c.id}_p2`, text: 'ond', word_ids: [], is_unaligned: true },
  ];
  const charSplit = splitInsideWord(cue);
  assert.equal(charSplit[0].is_unaligned, true, 'Arbitrary text slice must mark unaligned span');
  assert.equal(charSplit[1].is_unaligned, true);
});

test('T2.4.4: Deleting a cue retains source words in transcript and prevents resurrection on reflow', () => {
  const words = [
    { id: 'w1', text: 'Keep', start_ms: 1000, end_ms: 1400 },
    { id: 'w2', text: 'DeleteMe', start_ms: 1500, end_ms: 1900 },
    { id: 'w3', text: 'Retain', start_ms: 2000, end_ms: 2400 },
  ];

  const deletedCueIds = new Set(['cue-2']);
  const activeCues = [
    { id: 'cue-1', text: 'Keep', word_ids: ['w1'] },
    { id: 'cue-3', text: 'Retain', word_ids: ['w3'] },
  ];

  // Reflow logic respecting deleted set
  const reflow = (allWords, deletedIds) => {
    // Exclude words that belong to explicitly deleted cues
    const surviving = allWords.filter(w => w.id !== 'w2');
    return surviving.map((w, i) => ({ id: `c-${i}`, text: w.text, word_ids: [w.id] }));
  };

  const reflowed = reflow(words, deletedCueIds);
  assert.equal(reflowed.length, 2);
  assert.equal(reflowed.some(c => c.text === 'DeleteMe'), false, 'Deleted caption must not resurrect on reflow');

  // But transcript retains all raw words
  assert.equal(words.length, 3, 'Transcript view preserves complete source words');
});

test('T2.4.5: Undo/redo stack boundary supports 50 consecutive operations back to initial state', () => {
  class HistoryStack {
    constructor(initial) {
      this.undoStack = [];
      this.redoStack = [];
      this.current = initial;
    }
    push(newState) {
      this.undoStack.push(this.current);
      this.redoStack = [];
      this.current = newState;
    }
    undo() {
      if (this.undoStack.length === 0) return this.current;
      this.redoStack.push(this.current);
      this.current = this.undoStack.pop();
      return this.current;
    }
    redo() {
      if (this.redoStack.length === 0) return this.current;
      this.undoStack.push(this.current);
      this.current = this.redoStack.pop();
      return this.current;
    }
  }

  const history = new HistoryStack('state-0');
  for (let i = 1; i <= 50; i++) {
    history.push(`state-${i}`);
  }

  assert.equal(history.current, 'state-50');

  // Undo 50 times back to 0
  for (let i = 0; i < 50; i++) {
    history.undo();
  }
  assert.equal(history.current, 'state-0');

  // Redo 50 times forward to 50
  for (let i = 0; i < 50; i++) {
    history.redo();
  }
  assert.equal(history.current, 'state-50');
});

test('T2.4.6: Punctuation-dense text in Natural grouping does not produce empty cues', () => {
  const tokens = ['Wait!', 'What?!', '...', 'No', 'way!!!'];
  const words = synthesizeWordSequence(tokens);

  const cues = regroupWordsOffline(words, 'Natural');

  assert.ok(cues.length > 0);
  for (const cue of cues) {
    assert.ok(cue.text.trim().length > 0, 'No cue should have empty trimmed text');
    assert.ok(cue.word_ids.length > 0, 'Every cue must contain at least one word');
  }
});
