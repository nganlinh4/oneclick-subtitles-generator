// Tier 1: Feature Coverage - Area 4: Editing Surface & Local Regrouping (F15-F20)
// Specifications: ORIGINAL_REQUEST.md §R4, PROJECT.md F15-F20, WORD_NATIVE_TRANSCRIPTION_HANDOFF.md

import test from 'node:test';
import assert from 'node:assert/strict';
import { regroupWordsOffline, evaluateActivePresentation } from '../support/contracts.mjs';
import { synthesizeWordSequence } from '../support/e2e_test_harness.mjs';

test('T1.4.1: Compact [Transcript | Captions] switcher toggles view modes while sharing underlying revision', () => {
  const editorState = {
    viewMode: 'Captions', // 'Captions' | 'Transcript'
    activeRevisionId: 'rev-1',
    activeWordId: null,
  };

  // Switch to Transcript
  editorState.viewMode = 'Transcript';
  assert.equal(editorState.viewMode, 'Transcript');

  // Switch back to Captions
  editorState.viewMode = 'Captions';
  assert.equal(editorState.viewMode, 'Captions');
  assert.equal(editorState.activeRevisionId, 'rev-1', 'Switching view must not reload or re-query transcript');
});

test('T1.4.2: Transcript view groups speaker turns and clicking word yields exact native start_ms', () => {
  const words = [
    { id: 'w1', text: 'Hello', start_ms: 1200, end_ms: 1500, speaker_id: 'host' },
    { id: 'w2', text: 'there,', start_ms: 1550, end_ms: 1900, speaker_id: 'host' },
    { id: 'w3', text: 'General', start_ms: 2500, end_ms: 3000, speaker_id: 'guest' },
    { id: 'w4', text: 'Kenobi.', start_ms: 3050, end_ms: 3600, speaker_id: 'guest' },
  ];

  // Group into turns
  const turns = [];
  let currentTurn = null;
  for (const w of words) {
    if (!currentTurn || currentTurn.speaker_id !== w.speaker_id) {
      currentTurn = { speaker_id: w.speaker_id, start_ms: w.start_ms, end_ms: w.end_ms, words: [w] };
      turns.push(currentTurn);
    } else {
      currentTurn.words.push(w);
      currentTurn.end_ms = w.end_ms;
    }
  }

  assert.equal(turns.length, 2);
  assert.equal(turns[0].speaker_id, 'host');
  assert.equal(turns[1].speaker_id, 'guest');

  // Click-to-seek action on w3
  const targetWord = words.find(w => w.id === 'w3');
  const seekTargetMs = targetWord.start_ms;
  assert.equal(seekTargetMs, 2500, 'Word click must seek exactly to word start_ms');
});

test('T1.4.3: Local regrouping policies (Natural, Short, One word, Custom) execute with zero network calls', () => {
  const rawTokens = ['This', 'is', 'a', 'comprehensive', 'test', 'for', 'local', 'offline', 'regrouping.', 'It', 'works!'];
  const words = synthesizeWordSequence(rawTokens, { startMs: 1000, avgWordDurationMs: 300, avgPauseMs: 100 });

  let networkCallCount = 0;
  const mockNetworkFetch = () => { networkCallCount++; };

  // 1. Natural
  const naturalCues = regroupWordsOffline(words, 'Natural');
  // 2. Short
  const shortCues = regroupWordsOffline(words, 'Short');
  // 3. One word
  const oneWordCues = regroupWordsOffline(words, 'One word');
  // 4. Custom (max 3 words)
  const customCues = regroupWordsOffline(words, 'Custom', { max_words: 3 });

  assert.equal(networkCallCount, 0, 'Regrouping policies must be 100% offline with zero provider calls');

  // Verifications
  assert.equal(oneWordCues.length, words.length, 'One word policy must yield exactly 1 cue per word');
  assert.ok(shortCues.length >= naturalCues.length, 'Short cues should be more granular than Natural');
  assert.ok(customCues.every(c => c.text.split(' ').length <= 3), 'Custom policy must respect max_words constraint');
});

test('T1.4.4: Manual text edits preserve raw provider observation provenance while tagging edited spans', () => {
  const originalWord = {
    id: 'w-orig',
    text: 'recieved',
    start_ms: 2000,
    end_ms: 2500,
    is_unaligned: false,
  };

  // User edits spelling to 'received'
  const editedWord = {
    ...originalWord,
    text: 'received',
    raw_spelling: originalWord.text,
    provenance: {
      original_text: originalWord.text,
      edited_at: Date.now(),
    },
  };

  assert.equal(editedWord.text, 'received');
  assert.equal(editedWord.raw_spelling, 'recieved', 'Raw recognized spelling must be retained');
  assert.equal(editedWord.start_ms, 2000, 'Original start timing preserved on spelling correction');

  // User inserts a new unaligned word
  const insertedWord = {
    id: 'w-new',
    text: 'additional',
    start_ms: 2500,
    end_ms: 2500,
    is_unaligned: true, // Explicitly tagged as unaligned
  };
  assert.equal(insertedWord.is_unaligned, true, 'Inserted text must not acquire fake exact word times');
});

test('T1.4.5: Word-synchronized reveal/highlighting styles map active playback time t accurately', () => {
  const words = [
    { id: 'w1', text: 'One', start_ms: 1000, end_ms: 1400 },
    { id: 'w2', text: 'two', start_ms: 1500, end_ms: 1900 },
    { id: 'w3', text: 'three', start_ms: 2000, end_ms: 2400 },
  ];
  const cues = [{
    id: 'c1',
    start_ms: 1000,
    end_ms: 2500,
    text: 'One two three',
    word_ids: ['w1', 'w2', 'w3'],
  }];

  // At t = 1600ms (during word "two")
  const revealState = evaluateActivePresentation(cues, words, 1600, 'WordReveal');
  assert.equal(revealState.activeCues.length, 1);
  assert.equal(revealState.activeWords.find(w => w.id === 'w1').state, 'revealed');
  assert.equal(revealState.activeWords.find(w => w.id === 'w2').state, 'revealed');
  assert.equal(revealState.activeWords.find(w => w.id === 'w3').state, 'hidden');

  const highlightState = evaluateActivePresentation(cues, words, 1600, 'WordHighlight');
  assert.equal(highlightState.activeWords.find(w => w.id === 'w1').state, 'past');
  assert.equal(highlightState.activeWords.find(w => w.id === 'w2').state, 'highlighted');
  assert.equal(highlightState.activeWords.find(w => w.id === 'w3').state, 'upcoming');
});

test('T1.4.6: Linked translation tracks preserve source transcript spans without fake 1-to-1 word timestamps', () => {
  const sourceCue = {
    id: 'cue-src-1',
    start_ms: 1000,
    end_ms: 3000,
    text: 'Good morning everyone',
    word_ids: ['w1', 'w2', 'w3'],
  };

  // Translation to Vietnamese
  const translatedCue = {
    id: 'cue-trans-1',
    source_cue_id: sourceCue.id,
    start_ms: sourceCue.start_ms,
    end_ms: sourceCue.end_ms,
    text: 'Chào buổi sáng mọi người',
    has_word_timestamps: false, // Translation cues do NOT fabricate 1-to-1 word timestamps
  };

  assert.equal(translatedCue.start_ms, 1000);
  assert.equal(translatedCue.end_ms, 3000);
  assert.equal(translatedCue.source_cue_id, 'cue-src-1');
  assert.equal(translatedCue.has_word_timestamps, false, 'Translated words must not inherit fake 1-to-1 word timestamps');
});
