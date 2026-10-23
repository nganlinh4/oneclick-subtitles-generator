/**
 * Maps reveal progress and word timings onto glyph-cell counts and ranges of a shaped atlas, for the
 * typewriter, word-by-word and active-word highlight effects.
 */

const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);

export const revealCount = (atlas, progress) => {
  const cells = atlas.layout.lines.flatMap((line) => line.glyphs);
  const lengths = cells.map((index) => atlas.glyphs[index]?.cluster?.length ?? 0);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const revealedUnits = Math.floor(total * clamp(progress, 0, 1));
  let used = 0;
  let count = 0;
  for (const length of lengths) {
    if (used + length > revealedUnits) break;
    used += length;
    count += 1;
  }
  return count;
};

export const wordRevealCount = (atlas, words, instantMs) => {
  if (!atlas?.layout?.lines || !Array.isArray(words) || words.length === 0) return null;
  const cells = atlas.layout.lines.flatMap((line) => line.glyphs);
  if (cells.length === 0) return 0;

  const fullGlyphText = cells.map((cellIndex) => atlas.glyphs[cellIndex]?.cluster ?? '').join('');

  let cursor = 0;
  let maxRevealedChar = 0;
  let anyStarted = false;

  for (const word of words) {
    const wordStart = word.startMs ?? word.start_ms ?? Math.round((word.start || 0) * 1000);
    const text = word.text || '';
    if (text.length === 0) continue;
    const foundIdx = fullGlyphText.indexOf(text, cursor);
    const startChar = foundIdx !== -1 ? foundIdx : cursor;
    const endChar = startChar + text.length;
    cursor = endChar;

    if (wordStart <= instantMs) {
      anyStarted = true;
      maxRevealedChar = Math.max(maxRevealedChar, endChar);
    }
  }

  if (!anyStarted || maxRevealedChar === 0) return 0;

  let currentChars = 0;
  let cellCount = 0;
  for (const cellIndex of cells) {
    if (currentChars >= maxRevealedChar) break;
    const glyph = atlas.glyphs[cellIndex];
    const clusterLen = (glyph?.cluster ?? '').length || 1;
    currentChars += clusterLen;
    cellCount += 1;
  }
  return cellCount;
};

export const findWordCellRange = (atlas, words, targetWord) => {
  if (!atlas?.layout?.lines || !Array.isArray(words) || !targetWord) {
    return { startCell: null, endCell: null };
  }
  const cells = atlas.layout.lines.flatMap((line) => line.glyphs);
  if (cells.length === 0) return { startCell: null, endCell: null };

  const fullGlyphText = cells.map((cellIndex) => atlas.glyphs[cellIndex]?.cluster ?? '').join('');

  let cursor = 0;
  let targetStartChar = null;
  let targetEndChar = null;

  for (const w of words) {
    const text = w.text || '';
    if (text.length === 0) continue;
    const foundIdx = fullGlyphText.indexOf(text, cursor);
    const startChar = foundIdx !== -1 ? foundIdx : cursor;
    const endChar = startChar + text.length;
    cursor = endChar;

    if (w === targetWord || w.id === targetWord.id) {
      targetStartChar = startChar;
      targetEndChar = endChar;
      break;
    }
  }

  if (targetStartChar === null || targetEndChar === null) {
    return { startCell: null, endCell: null };
  }

  let currentChars = 0;
  let startCell = null;
  let endCell = null;

  for (let i = 0; i < cells.length; i++) {
    const glyph = atlas.glyphs[cells[i]];
    const clusterLen = (glyph?.cluster ?? '').length || 1;
    if (startCell === null && currentChars + clusterLen > targetStartChar) {
      startCell = i;
    }
    if (currentChars < targetEndChar) {
      endCell = i + 1;
    }
    currentChars += clusterLen;
  }
  return { startCell, endCell };
};
