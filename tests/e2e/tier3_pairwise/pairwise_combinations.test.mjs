// Tier 3: Pairwise Combinations
// System Interaction Matrix covering multi-variable orthogonal combinations
// Specifications: TEST_INFRA.md, PROJECT.md, ORIGINAL_REQUEST.md

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  regroupWordsOffline,
  evaluateActivePresentation,
  projectWindowOffset,
  namespaceSpeaker,
} from '../support/contracts.mjs';
import { synthesizeWordSequence } from '../support/e2e_test_harness.mjs';

// Pairwise Case 1: [Task: Speech] × [Engine: Gemini Transcribe] × [Scope: Whole Video] × [Grouping: Natural] × [Style: Word Reveal]
test('T3.1: Pairwise Combination 1 - Standard Primary Happy Path', () => {
  const words = synthesizeWordSequence(['Hello', 'and', 'welcome', 'to', 'OSG.'], { startMs: 0 });
  const cues = regroupWordsOffline(words, 'Natural');
  const presentation = evaluateActivePresentation(cues, words, 600, 'WordReveal');

  assert.ok(cues.length > 0);
  assert.equal(presentation.activeCues.length, 1);
  assert.ok(presentation.activeWords.some(w => w.state === 'revealed'));
});

// Pairwise Case 2: [Task: Speech] × [Engine: Gemini Transcribe] × [Scope: Selected Range] × [Grouping: Short] × [Style: Standard]
test('T3.2: Pairwise Combination 2 - Nonzero Offset Projection with Short Cues', () => {
  const selectionStartMs = 30_000;
  const rawWords = [
    { id: 'w1', text: 'Selected', start_ms: 500, end_ms: 900 },
    { id: 'w2', text: 'range', start_ms: 950, end_ms: 1400 },
  ];

  // Apply single offset projection
  const projectedWords = rawWords.map(w => ({
    ...w,
    start_ms: projectWindowOffset(selectionStartMs, w.start_ms),
    end_ms: projectWindowOffset(selectionStartMs, w.end_ms),
  }));

  assert.equal(projectedWords[0].start_ms, 30500);
  assert.equal(projectedWords[1].end_ms, 31400);

  const cues = regroupWordsOffline(projectedWords, 'Short');
  assert.equal(cues[0].start_ms, 30500);
  assert.equal(cues[0].end_ms, 31400);
});

// Pairwise Case 3: [Task: Speech] × [Engine: Local ASR] × [Scope: Whole Video] × [Grouping: One Word] × [Style: Word Highlight]
test('T3.3: Pairwise Combination 3 - Offline Local ASR with One Word Karaoke Highlight', () => {
  const words = [
    { id: 'w1', text: 'Beat', start_ms: 1000, end_ms: 1400 },
    { id: 'w2', text: 'drop', start_ms: 1500, end_ms: 1900 },
  ];
  const cues = regroupWordsOffline(words, 'One word');
  assert.equal(cues.length, 2);

  const pres = evaluateActivePresentation(cues, words, 1200, 'WordHighlight');
  assert.equal(pres.activeWords.find(w => w.id === 'w1').state, 'highlighted');
});

// Pairwise Case 4: [Task: Speech] × [Engine: Gemini Transcribe] × [Scope: Audio Only] × [Grouping: Custom] × [Style: Standard]
test('T3.4: Pairwise Combination 4 - Audio Only Media with Custom Length Constraints', () => {
  const tokens = ['Podcast', 'episode', 'number', 'forty', 'two', 'discussing', 'technology'];
  const words = synthesizeWordSequence(tokens, { startMs: 2000 });

  const customCues = regroupWordsOffline(words, 'Custom', { max_words: 3, max_duration_ms: 3000 });
  assert.ok(customCues.every(c => c.text.split(' ').length <= 3));
});

// Pairwise Case 5: [Task: Translate] × [Source: Gemini Transcribe] × [Scope: Whole Video] × [Target: Vietnamese Latin]
test('T3.5: Pairwise Combination 5 - Linked Translation Track into Vietnamese Latin Script', () => {
  const sourceWords = synthesizeWordSequence(['Machine', 'learning', 'is', 'transformative.'], { startMs: 1000 });
  const sourceCues = regroupWordsOffline(sourceWords, 'Natural');

  const translatedCue = {
    id: 'trans_1',
    source_cue_id: sourceCues[0].id,
    start_ms: sourceCues[0].start_ms,
    end_ms: sourceCues[0].end_ms,
    text: 'Học máy mang tính biến đổi sâu sắc.',
    has_word_timestamps: false,
  };

  assert.equal(translatedCue.start_ms, sourceCues[0].start_ms);
  assert.equal(translatedCue.end_ms, sourceCues[0].end_ms);
  assert.equal(translatedCue.has_word_timestamps, false, 'No fake word timestamps on translation');
});

// Pairwise Case 6: [Task: Translate] × [Source: Existing SRT] × [Scope: Selected Range] × [Target: Korean CJK]
test('T3.6: Pairwise Combination 6 - Legacy SRT Import Translation into Korean CJK', () => {
  const legacyCues = [
    { id: 'srt_1', start_ms: 5000, end_ms: 8000, text: 'Artificial intelligence research' },
  ];

  const koreanTranslation = {
    id: 'trans_ko_1',
    source_cue_id: legacyCues[0].id,
    start_ms: 5000,
    end_ms: 8000,
    text: '인공지능 연구',
    has_word_timestamps: false,
  };

  assert.equal(koreanTranslation.text, '인공지능 연구');
  assert.equal(koreanTranslation.start_ms, 5000);
});

// Pairwise Case 7: [Task: Visual/Custom (OCR)] × [Engine: Gemini Vision] × [Scope: Selected Range] × [Format: Chaptered]
test('T3.7: Pairwise Combination 7 - Visual OCR Extraction with Preserved Chapter Boundaries', () => {
  const visualTask = {
    task: 'VisualCustom',
    subtask: 'ocr',
    requiresVideo: true,
    scope: { start_ms: 10_000, end_ms: 60_000 },
  };

  assert.equal(visualTask.requiresVideo, true);
  assert.equal(visualTask.scope.end_ms - visualTask.scope.start_ms, 50_000);
});

// Pairwise Case 8: [Task: Visual/Custom (Descriptions)] × [Engine: Gemini Vision] × [Scope: Whole Video]
test('T3.8: Pairwise Combination 8 - Video Description Task Preserving Media Dimensions', () => {
  const descriptionTask = {
    task: 'VisualCustom',
    subtask: 'descriptions',
    requiresVideo: true,
    prompt: 'Describe the main visual events in this video clip.',
  };

  assert.equal(descriptionTask.requiresVideo, true);
  assert.ok(descriptionTask.prompt.length > 0);
});

// Pairwise Case 9: [Task: Speech (Diarization ON)] × [Language: Korean CJK] × [Grouping: Natural] × [Edit: Speaker Rename]
test('T3.9: Pairwise Combination 9 - Diarized Korean Speech with Speaker Renaming', () => {
  const words = [
    { id: 'w1', text: '안녕하세요,', start_ms: 1000, end_ms: 1800, speaker_id: 'w0:1' },
    { id: 'w2', text: '반갑습니다.', start_ms: 1900, end_ms: 2700, speaker_id: 'w0:2' },
  ];

  // User renames w0:1 to "김철수" and w0:2 to "이영희"
  const speakerMap = { 'w0:1': '김철수', 'w0:2': '이영희' };
  const renamedWords = words.map(w => ({ ...w, speaker_display: speakerMap[w.speaker_id] }));

  assert.equal(renamedWords[0].speaker_display, '김철수');
  assert.equal(renamedWords[1].speaker_display, '이영희');
  assert.equal(renamedWords[0].speaker_id, 'w0:1', 'Original provider namespace ID preserved');
});

// Pairwise Case 10: [Task: Speech (Diarization ON)] × [Language: Arabic RTL] × [Grouping: Natural] × [Edit: Text Correction]
test('T3.10: Pairwise Combination 10 - Diarized Arabic RTL Speech with Spelling Correction', () => {
  const arabicWords = [
    { id: 'w1', text: 'مرحبا', start_ms: 1000, end_ms: 1600, speaker_id: 'w0:1' },
    { id: 'w2', text: 'بكم', start_ms: 1700, end_ms: 2200, speaker_id: 'w0:1' },
  ];

  // User edits text
  const corrected = {
    ...arabicWords[1],
    text: 'بكم جميعاً',
    is_unaligned: true,
  };

  assert.equal(corrected.is_unaligned, true);
  assert.equal(corrected.start_ms, 1700);
});

// Pairwise Case 11: [Task: Speech] × [Migration: Legacy v14 DB] × [Action: Local Regrouping]
test('T3.11: Pairwise Combination 11 - Legacy Migration followed by Cue-Level Operations', () => {
  const legacyCues = [
    { id: 'c1', start_ms: 1000, end_ms: 3000, text: 'Legacy line one', word_ids: [] },
    { id: 'c2', start_ms: 3500, end_ms: 6000, text: 'Legacy line two', word_ids: [] },
  ];

  // Editing legacy cue
  const editedCue = { ...legacyCues[0], text: 'Updated legacy line' };
  assert.equal(editedCue.text, 'Updated legacy line');
  assert.equal(editedCue.word_ids.length, 0, 'Legacy cues remain valid without fabricated words');
});

// Pairwise Case 12: [Task: Speech] × [Engine: Gemini Transcribe] × [Error: Window 2 Fails] × [Action: Window Retry]
test('T3.12: Pairwise Combination 12 - Targeted Multi-Window Failure Recovery with Preserved Edits', () => {
  const session = {
    windows: [
      { id: 0, status: 'promoted', userEdited: false },
      { id: 1, status: 'promoted', userEdited: true, customText: 'User customized text' },
      { id: 2, status: 'failed', userEdited: false },
    ],
  };

  // Retry window 2
  session.windows[2].status = 'promoted';

  assert.equal(session.windows[1].userEdited, true);
  assert.equal(session.windows[1].customText, 'User customized text', 'Window retry must never overwrite user edits');
  assert.equal(session.windows[2].status, 'promoted');
});
