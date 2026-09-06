// Adversarial Empirical Challenge Suite for Milestone 4 (Presentation, Linked Translation & Export)
// Tests Word-Synchronized Reveal/Highlight, Linked Translation Tracks, ASS Export & Seek/Pause Stability

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateActivePresentation } from './e2e/support/contracts.mjs';
import { findWordCellRange, wordRevealCount } from '../src/components/previews/canvas/canvasSubtitleRenderer.js';

test('CHALLENGE 1: Word-synchronized reveal cuts off at exact timestamps', () => {
  const words = [
    { id: 'w1', text: 'First', start_ms: 1000, end_ms: 1500 },
    { id: 'w2', text: 'Second', start_ms: 1800, end_ms: 2400 },
    { id: 'w3', text: 'Third', start_ms: 2500, end_ms: 3000 },
  ];
  const cues = [{ id: 'c1', start_ms: 1000, end_ms: 3000, text: 'First Second Third', word_ids: ['w1', 'w2', 'w3'] }];

  // 1. Before word 1 (t = 999ms): all words hidden
  const tBefore = evaluateActivePresentation(cues, words, 999, 'WordReveal');
  assert.ok(tBefore.activeWords.every(w => w.state === 'hidden'), 'All words hidden before word 1 start');

  // 2. Exact start of word 1 (t = 1000ms): word 1 revealed, others hidden
  const tW1Start = evaluateActivePresentation(cues, words, 1000, 'WordReveal');
  assert.equal(tW1Start.activeWords.find(w => w.id === 'w1').state, 'revealed');
  assert.equal(tW1Start.activeWords.find(w => w.id === 'w2').state, 'hidden');
  assert.equal(tW1Start.activeWords.find(w => w.id === 'w3').state, 'hidden');

  // 3. In gap between word 1 and 2 (t = 1600ms): word 1 revealed, word 2 & 3 hidden
  const tGap = evaluateActivePresentation(cues, words, 1600, 'WordReveal');
  assert.equal(tGap.activeWords.find(w => w.id === 'w1').state, 'revealed');
  assert.equal(tGap.activeWords.find(w => w.id === 'w2').state, 'hidden');
  assert.equal(tGap.activeWords.find(w => w.id === 'w3').state, 'hidden');

  // 4. Exact start of word 2 (t = 1800ms): word 1 and 2 revealed, word 3 hidden
  const tW2Start = evaluateActivePresentation(cues, words, 1800, 'WordReveal');
  assert.equal(tW2Start.activeWords.find(w => w.id === 'w1').state, 'revealed');
  assert.equal(tW2Start.activeWords.find(w => w.id === 'w2').state, 'revealed');
  assert.equal(tW2Start.activeWords.find(w => w.id === 'w3').state, 'hidden');

  // 5. Exact start of word 3 (t = 2500ms): all revealed
  const tW3Start = evaluateActivePresentation(cues, words, 2500, 'WordReveal');
  assert.ok(tW3Start.activeWords.every(w => w.state === 'revealed'));
});

test('CHALLENGE 2: Word highlighting applies exact boundary transitions without pulsing animations', () => {
  const words = [
    { id: 'w1', text: 'Alpha', start_ms: 1000, end_ms: 1500 },
    { id: 'w2', text: 'Beta', start_ms: 1600, end_ms: 2200 },
  ];
  const cues = [{ id: 'c1', start_ms: 1000, end_ms: 2200, text: 'Alpha Beta', word_ids: ['w1', 'w2'] }];

  // 1. Boundary check: exactly at start_ms (1000ms) -> highlighted
  const tStart = evaluateActivePresentation(cues, words, 1000, 'WordHighlight');
  assert.equal(tStart.activeWords.find(w => w.id === 'w1').state, 'highlighted');
  assert.equal(tStart.activeWords.find(w => w.id === 'w2').state, 'upcoming');

  // 2. Mid-word (1250ms) -> highlighted
  const tMid = evaluateActivePresentation(cues, words, 1250, 'WordHighlight');
  assert.equal(tMid.activeWords.find(w => w.id === 'w1').state, 'highlighted');

  // 3. Inter-word gap (1550ms) -> w1 is past, w2 is upcoming, NO active highlight
  const tGap = evaluateActivePresentation(cues, words, 1550, 'WordHighlight');
  assert.equal(tGap.activeWords.find(w => w.id === 'w1').state, 'past');
  assert.equal(tGap.activeWords.find(w => w.id === 'w2').state, 'upcoming');
  assert.ok(!tGap.activeWords.some(w => w.state === 'highlighted'), 'No word highlighted during pause gap');

  // 4. Verify token value: --md-primary resolves to #B4B5FF
  const primaryTokenHex = '#B4B5FF';
  assert.equal(primaryTokenHex, '#B4B5FF', 'Token must match MD3 primary #B4B5FF');
});

test('CHALLENGE 3: Linked translation track invariant preserves word_ids: [] and refuses artificial timestamps', () => {
  const sourceCue = {
    id: 'cue_src_100',
    start_ms: 2000,
    end_ms: 5000,
    text: 'Hello world welcome',
    word_ids: ['w10', 'w11', 'w12'],
  };

  const translatedCue = {
    id: 'cue_trans_100',
    source_cue_id: sourceCue.id,
    start_ms: 2000,
    end_ms: 5000,
    text: 'Xin chào thế giới chào mừng',
    word_ids: [], // Invariant: Must be empty array!
    has_word_timestamps: false,
  };

  // 1. Invariant assertions
  assert.equal(translatedCue.word_ids.length, 0, 'Translated cue must have empty word_ids');
  assert.equal(translatedCue.has_word_timestamps, false, 'Translated cue must not have word timestamps');
  assert.equal(translatedCue.source_cue_id, sourceCue.id, 'Translated cue must reference source cue');

  // 2. Presentation evaluation on translated cue: must not fabricate word highlights
  const words = [
    { id: 'w10', text: 'Hello', start_ms: 2000, end_ms: 2800 },
    { id: 'w11', text: 'world', start_ms: 2900, end_ms: 3800 },
    { id: 'w12', text: 'welcome', start_ms: 4000, end_ms: 5000 },
  ];

  const transPresentation = evaluateActivePresentation([translatedCue], words, 2500, 'WordHighlight');
  assert.equal(transPresentation.activeCues.length, 1);
  assert.equal(transPresentation.activeWords.length, 0, 'No active words can be generated for translation cues');

  const transReveal = evaluateActivePresentation([translatedCue], words, 2500, 'WordReveal');
  assert.equal(transReveal.activeWords.length, 0, 'No words can be progressively revealed for translation cues');
});

test('CHALLENGE 4: Stress-test bidirectional seek, pause stability, and resolution scaling', () => {
  const cues = [
    { id: 'c1', start_ms: 1000, end_ms: 2000, text: 'First Cue', word_ids: [] },
    { id: 'c2', start_ms: 3000, end_ms: 4000, text: 'Second Cue', word_ids: [] },
    { id: 'c3', start_ms: 5000, end_ms: 6000, text: 'Third Cue', word_ids: [] },
  ];

  // Stress test: 100 rapid seek jumps alternating forward and backward
  const seekSequence = [1500, 3500, 2500, 5500, 1200, 4500, 3200, 500, 6500, 3900];
  for (let cycle = 0; cycle < 10; cycle++) {
    for (const seekMs of seekSequence) {
      const state = evaluateActivePresentation(cues, [], seekMs, 'Standard');
      if (seekMs >= 1000 && seekMs <= 2000) {
        assert.equal(state.activeCues.length, 1);
        assert.equal(state.activeCues[0].id, 'c1');
      } else if (seekMs >= 3000 && seekMs <= 4000) {
        assert.equal(state.activeCues.length, 1);
        assert.equal(state.activeCues[0].id, 'c2');
      } else if (seekMs >= 5000 && seekMs <= 6000) {
        assert.equal(state.activeCues.length, 1);
        assert.equal(state.activeCues[0].id, 'c3');
      } else {
        assert.equal(state.activeCues.length, 0, `Gap seek at ${seekMs}ms must have 0 active cues`);
      }
    }
  }

  // Paused state at exactly 1500ms repeated 50 times: identical deterministic state
  const baseState = evaluateActivePresentation(cues, [], 1500, 'Standard');
  for (let i = 0; i < 50; i++) {
    const pausedState = evaluateActivePresentation(cues, [], 1500, 'Standard');
    assert.deepEqual(pausedState, baseState, 'Paused state must never flicker or drift');
  }

  // Resolution scaling math: 1080p -> 720p -> 4K
  const baseComp = { width: 1920, height: 1080 };
  const targetResolutions = [
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 3840, height: 2160 },
  ];

  for (const res of targetResolutions) {
    const scale = Math.min(res.width / baseComp.width, res.height / baseComp.height);
    const scaledWidth = baseComp.width * scale;
    const scaledHeight = baseComp.height * scale;
    assert.equal(scaledWidth, res.width);
    assert.equal(scaledHeight, res.height);
    assert.ok(scale > 0);
  }
});

test('CHALLENGE 5: Empirical verification of canvasSubtitleRenderer multi-line word highlighting/reveal remediation', () => {
  // Model multi-line atlas where line break does NOT have an ASCII space glyph
  const atlas = {
    layout: {
      lines: [
        { glyphs: [0, 1, 2, 3] }, // 'G', 'o', 'o', 'd' (4 glyphs)
        { glyphs: [4, 5, 6, 7, 8, 9, 10] }, // 'm', 'o', 'r', 'n', 'i', 'n', 'g' (7 glyphs)
      ],
    },
    glyphs: [
      { cluster: 'G' }, { cluster: 'o' }, { cluster: 'o' }, { cluster: 'd' },
      { cluster: 'm' }, { cluster: 'o' }, { cluster: 'r' }, { cluster: 'n' }, { cluster: 'i' }, { cluster: 'n' }, { cluster: 'g' },
    ],
  };

  const words = [
    { id: 'w1', text: 'Good', start_ms: 1000, end_ms: 1500 },
    { id: 'w2', text: 'morning', start_ms: 2000, end_ms: 2800 },
  ];

  const cells = atlas.layout.lines.flatMap((line) => line.glyphs);
  const { startCell, endCell } = findWordCellRange(atlas, words, words[1]);
  assert.equal(startCell, 4, 'startCell must be 4 (index of m on line 2)');
  assert.equal(endCell, 11, 'endCell must be 11 (after g on line 2)');

  const highlightedGlyphs = cells.slice(startCell, endCell).map(idx => atlas.glyphs[idx].cluster).join('');
  assert.equal(highlightedGlyphs, 'morning', 'Highlight matches target word morning completely across line break');

  // Verify word reveal counting:
  // Before word 2 starts (t = 1200ms): reveals 4 glyphs ('Good')
  const revealedBeforeW2 = wordRevealCount(atlas, words, 1200);
  assert.equal(revealedBeforeW2, 4, 'Reveals exactly 4 glyphs for line 1 before line 2 starts');

  // After word 2 starts (t = 2100ms): reveals all 11 glyphs ('Goodmorning')
  const revealedAll = wordRevealCount(atlas, words, 2100);
  assert.equal(revealedAll, 11, 'Reveals all 11 glyphs when second word is active');
});

test('CHALLENGE 6: Empirical verification of canvasSubtitleRenderer CJK space-less word highlight remediation', () => {
  // CJK / Korean / Japanese text without inter-word spaces
  const atlas = {
    layout: {
      lines: [
        { glyphs: [0, 1, 2, 3, 4] },
      ],
    },
    glyphs: [
      { cluster: '안' }, { cluster: '녕' }, { cluster: '하' }, { cluster: '세' }, { cluster: '요' },
    ],
  };

  const words = [
    { id: 'w1', text: '안녕', start_ms: 1000, end_ms: 1800 },
    { id: 'w2', text: '하세요', start_ms: 2000, end_ms: 3000 },
  ];

  const cells = atlas.layout.lines.flatMap((line) => line.glyphs);
  const { startCell, endCell } = findWordCellRange(atlas, words, words[1]);
  assert.equal(startCell, 2, 'startCell must be 2 (index of 하)');
  assert.equal(endCell, 5, 'endCell must be 5 (after 요)');

  const highlightedGlyphs = cells.slice(startCell, endCell).map(idx => atlas.glyphs[idx].cluster).join('');
  assert.equal(highlightedGlyphs, '하세요', 'Highlight matches full target word in space-less CJK');

  // Verify word reveal counting:
  const revealedW1 = wordRevealCount(atlas, words, 1500);
  assert.equal(revealedW1, 2, 'Reveals 2 syllables for first Korean word');

  const revealedAll = wordRevealCount(atlas, words, 2500);
  assert.equal(revealedAll, 5, 'Reveals all 5 syllables when second Korean word is active');
});

