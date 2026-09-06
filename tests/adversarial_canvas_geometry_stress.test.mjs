// Adversarial Stress Suite for Canvas Subtitle Renderer Geometry
// Stress tests multi-line line breaks, space-less CJK scripts, repeated words, and timeline progressions

import test from 'node:test';
import assert from 'node:assert/strict';
import { findWordCellRange, wordRevealCount } from '../src/components/previews/canvas/canvasSubtitleRenderer.js';

// Helper to construct mock atlas from lines of strings
function makeAtlas(linesArray) {
  const glyphs = [];
  const lines = [];
  let glyphIndex = 0;

  for (const lineStr of linesArray) {
    const lineGlyphs = [];
    for (const char of lineStr) {
      glyphs.push({ cluster: char });
      lineGlyphs.push(glyphIndex++);
    }
    lines.push({ glyphs: lineGlyphs });
  }

  return {
    layout: { lines },
    glyphs,
  };
}

function getHighlightedText(atlas, range) {
  if (range.startCell === null || range.endCell === null) return null;
  const cells = atlas.layout.lines.flatMap(l => l.glyphs);
  return cells.slice(range.startCell, range.endCell).map(idx => atlas.glyphs[idx].cluster).join('');
}

test('CANVAS-STRESS-1: Multi-line 3-line layout without space glyphs on line wraps', () => {
  // Line wraps in canvas renderer do not insert space characters into the glyph stream
  const lines = [
    'OneTwo',     // Line 1: 'One', 'Two'
    'ThreeFour',   // Line 2: 'Three', 'Four'
    'FiveSix',     // Line 3: 'Five', 'Six'
  ];
  const atlas = makeAtlas(lines);

  const words = [
    { id: 'w1', text: 'One', start_ms: 1000, end_ms: 1500 },
    { id: 'w2', text: 'Two', start_ms: 1500, end_ms: 2000 },
    { id: 'w3', text: 'Three', start_ms: 2000, end_ms: 2500 },
    { id: 'w4', text: 'Four', start_ms: 2500, end_ms: 3000 },
    { id: 'w5', text: 'Five', start_ms: 3000, end_ms: 3500 },
    { id: 'w6', text: 'Six', start_ms: 3500, end_ms: 4000 },
  ];

  for (const word of words) {
    const range = findWordCellRange(atlas, words, word);
    assert.ok(range.startCell !== null && range.endCell !== null, `Range must be found for ${word.text}`);
    const highlighted = getHighlightedText(atlas, range);
    assert.equal(highlighted, word.text, `Highlighted text for ${word.text} must match exactly without truncation!`);
  }
});

test('CANVAS-STRESS-2: Space-less Japanese script with Kanji, Hiragana, Katakana', () => {
  // Japanese text without spaces
  const text = '吾輩は猫である名前はまだ無い';
  const atlas = makeAtlas([text]);

  const words = [
    { id: 'w1', text: '吾輩は', start_ms: 1000, end_ms: 1800 },
    { id: 'w2', text: '猫である', start_ms: 1900, end_ms: 2700 },
    { id: 'w3', text: '名前は', start_ms: 2800, end_ms: 3500 },
    { id: 'w4', text: 'まだ無い', start_ms: 3600, end_ms: 4500 },
  ];

  for (const word of words) {
    const range = findWordCellRange(atlas, words, word);
    const highlighted = getHighlightedText(atlas, range);
    assert.equal(highlighted, word.text, `Japanese phrase '${word.text}' must highlight with 0 truncation`);
  }
});

test('CANVAS-STRESS-3: Space-less Chinese script with repeated identical characters', () => {
  // '天天向上天天快乐' -> identical words '天天' occurring twice!
  const text = '天天向上天天快乐';
  const atlas = makeAtlas([text]);

  const words = [
    { id: 'w1', text: '天天', start_ms: 1000, end_ms: 1500 },
    { id: 'w2', text: '向上', start_ms: 1600, end_ms: 2000 },
    { id: 'w3', text: '天天', start_ms: 2100, end_ms: 2500 },
    { id: 'w4', text: '快乐', start_ms: 2600, end_ms: 3000 },
  ];

  const range1 = findWordCellRange(atlas, words, words[0]);
  const range3 = findWordCellRange(atlas, words, words[2]);

  assert.equal(range1.startCell, 0);
  assert.equal(range1.endCell, 2);
  assert.equal(getHighlightedText(atlas, range1), '天天');

  // Second '天天' must match at index 4, NOT index 0!
  assert.equal(range3.startCell, 4);
  assert.equal(range3.endCell, 6);
  assert.equal(getHighlightedText(atlas, range3), '天天');
});

test('CANVAS-STRESS-4: Multi-line Korean script across line breaks', () => {
  const lines = [
    '대한민국은',
    '민주공화국이다',
  ];
  const atlas = makeAtlas(lines);

  const words = [
    { id: 'w1', text: '대한민국은', start_ms: 1000, end_ms: 2000 },
    { id: 'w2', text: '민주공화국이다', start_ms: 2100, end_ms: 3500 },
  ];

  const range2 = findWordCellRange(atlas, words, words[1]);
  assert.equal(range2.startCell, 5, 'Start cell must be 5 (first char of line 2)');
  assert.equal(range2.endCell, 12, 'End cell must be 12 (end of line 2)');
  assert.equal(getHighlightedText(atlas, range2), '민주공화국이다');
});

test('CANVAS-STRESS-5: Word reveal timeline progression through gaps and boundaries', () => {
  const lines = ['Hello', 'World'];
  const atlas = makeAtlas(lines);

  const words = [
    { id: 'w1', text: 'Hello', start_ms: 1000, end_ms: 2000 },
    { id: 'w2', text: 'World', start_ms: 3000, end_ms: 4000 },
  ];

  // 1. Before word 1 (t = 500ms): 0 cells revealed
  assert.equal(wordRevealCount(atlas, words, 500), 0);

  // 2. Exactly at start of word 1 (t = 1000ms): reveals 5 cells ('Hello')
  assert.equal(wordRevealCount(atlas, words, 1000), 5);

  // 3. During word 1 (t = 1500ms): reveals 5 cells
  assert.equal(wordRevealCount(atlas, words, 1500), 5);

  // 4. In pause gap between word 1 and 2 (t = 2500ms): remains 5 cells
  assert.equal(wordRevealCount(atlas, words, 2500), 5);

  // 5. Exactly at start of word 2 (t = 3000ms): reveals 10 cells ('HelloWorld')
  assert.equal(wordRevealCount(atlas, words, 3000), 10);

  // 6. After word 2 (t = 5000ms): reveals all 10 cells
  assert.equal(wordRevealCount(atlas, words, 5000), 10);
});

test('CANVAS-STRESS-6: Robustness on degenerate inputs', () => {
  assert.equal(wordRevealCount(null, [], 1000), null);
  assert.equal(wordRevealCount({}, [], 1000), null);
  assert.equal(wordRevealCount({ layout: { lines: [] } }, [{ text: 'a' }], 1000), 0);

  const emptyAtlas = { layout: { lines: [] }, glyphs: [] };
  const rangeEmpty = findWordCellRange(emptyAtlas, [{ id: 'w1', text: 'a' }], { id: 'w1' });
  assert.deepEqual(rangeEmpty, { startCell: null, endCell: null });

  const atlas = makeAtlas(['Test']);
  const rangeMissing = findWordCellRange(atlas, [{ id: 'w1', text: 'Test' }], { id: 'w999', text: 'Other' });
  assert.deepEqual(rangeMissing, { startCell: null, endCell: null });
});
