import { describe, expect, it } from 'vitest';

import { GLYPH_ATLAS_ERROR_CODES, GLYPH_ATLAS_LIMITS, bakeGlyphAtlas, bakeGlyphAtlasForCues } from './glyphAtlas';
import {
  CURSIVE_FAMILY,
  DEFAULT_FACES,
  HEBREW,
  SHAPED_SIZE_PX,
  cellTextsOf,
  codeOf,
  createFakeSurface,
  createLigatureSurface,
  defineFace,
} from './glyphAtlasTestFont';

/**
 * A whole cue list, baked into as many atlas pages as its alphabet needs.
 *
 * The metrics below come from the fake font model `glyphAtlasTestFont.js` owns; what that model
 * reproduces faithfully, and what it cannot, is documented there. What this suite is about is not
 * the metrics but the TABLE: that cues sharing a page share one cell list, that the list keeps the
 * strictly-increasing order `crates/osg-scene` re-derives, that a cue drawn from page 2 indexes
 * page 2, and that a one-cue call is byte-for-byte the bake the preview already gets.
 *
 * A CELL IS ONE SHAPED LINE, so a page's table is the distinct LINES its cues are made of — not an
 * alphabet. That is the cost of the line mask and it is measured here rather than asserted: a track
 * that repeats itself still costs one cell, and a track of many distinct lines is paged.
 *
 * The paging BOUNDARIES — what closes a page, what refuses one — are exercised at reduced limits in
 * `glyphAtlasPaging.test.js`, because reaching them at the shipped limits costs tens of thousands of
 * measurements to prove arithmetic.
 */

const cues = (request, surfaceOptions) => bakeGlyphAtlasForCues(
  { face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX, ...request },
  { surface: createFakeSurface(surfaceOptions) }
);

const cursiveCues = (request, surfaceOptions) => bakeGlyphAtlasForCues(
  { face: { family: CURSIVE_FAMILY }, fontSizePx: SHAPED_SIZE_PX, ...request },
  { surface: createFakeSurface(surfaceOptions) }
);

/** The page a cue was laid out against. */
const pageOf = (baked, cue) => baked.pages[baked.pageOfCue[cue]];

/** The only page, asserted to be the only one — most of this suite is about single-page content. */
const onlyPage = (baked) => {
  expect(baked.pages).toHaveLength(1);
  return baked.pages[0];
};

/** The text each of a cue's lines was rasterized from, read back through its own page's table. */
const linesOf = (baked, cue) => {
  const page = pageOf(baked, cue);
  return baked.runs[cue].lines.map(
    (line) => line.glyphs.map((cell) => page.glyphs[cell].cluster).join('')
  );
};

const cellsOf = (run) => run.lines.flatMap((line) => line.glyphs);

/** A face that covers every plane, so an astral cluster can be baked without substitution. */
const EVERY_PLANE = new Map([
  ...DEFAULT_FACES,
  ['editor sans', defineFace('editor-sans', 0.52, () => true, 0.81, 0.19)],
]);

const bytesOf = (descriptor) => [...descriptor.pixels];

describe('bakeGlyphAtlasForCues table', () => {
  it('gives cues that share a page one cell table with no duplicates, each indexing its own lines', () => {
    const baked = cues({ texts: ['abc', 'bcd', 'abc'] });
    const page = onlyPage(baked);

    // Three cues, two distinct lines: the repeated cue indexes the cell the first one baked rather
    // than baking a second copy of the same picture.
    expect(cellTextsOf(page)).toEqual(['abc', 'bcd']);
    expect(page.atlas.glyphCount).toBe(2);
    expect(cellsOf(baked.runs[0])).toEqual([0]);
    expect(cellsOf(baked.runs[1])).toEqual([1]);
    expect(cellsOf(baked.runs[2])).toEqual([0]);
    // One run per cue, in cue order, and the first cue a page serves is that page's own layout.
    expect(baked.runs).toHaveLength(3);
    expect(baked.pageOfCue).toEqual([0, 0, 0]);
    expect(baked.runs[0]).toBe(page.layout);
    expect(Object.isFrozen(baked.runs)).toBe(true);
    expect(Object.isFrozen(baked.pages)).toBe(true);
  });

  it('rasterizes a cue that joins as one line, joined forms and all', () => {
    // A face that joins gives one letter four different glyphs depending on its neighbours, so the
    // width of a word is not the sum of its letters. That used to need a per-position spelling
    // probed against progressive prefixes, and an exact-equality check that failed on ordinary
    // text. The line is measured and drawn as one object now, so the joining is simply in the mask.
    const baked = cursiveCues({ texts: ['بب', 'ببب'] });
    const page = onlyPage(baked);

    expect(cellTextsOf(page)).toEqual(['بب', 'ببب']);
    expect(linesOf(baked, 0)).toEqual(['بب']);
    expect(linesOf(baked, 1)).toEqual(['ببب']);
    // The three-letter word is not one and a half times the two-letter one, because its middle
    // letter takes a medial form. That is what makes this a joining fixture rather than three
    // copies of one glyph, and it is exactly the disagreement that used to refuse the cue.
    const [shorter, longer] = page.glyphs.map((glyph) => glyph.advanceWidthPx);
    expect(longer).not.toBeCloseTo(shorter * 1.5, 5);
    expect(baked.runs.every((run) => run.cellAdvanceLayout === 'reproduces')).toBe(true);
    expect(baked.runs.every((run) => run.lines.every((line) => line.shapingResidualPx === 0)))
      .toBe(true);
  });

  it('keeps a Latin cue and a joining one in the same table', () => {
    const baked = cursiveCues({ texts: ['ok', 'ok بب'] });

    expect(cellTextsOf(onlyPage(baked))).toEqual(['ok', 'ok بب']);
    expect(linesOf(baked, 0)).toEqual(['ok']);
    expect(linesOf(baked, 1)).toEqual(['ok بب']);
    expect(cellsOf(baked.runs[0])).toEqual([0]);
  });

  it('orders each page by UTF-16 code unit, which is not code point order', () => {
    // U+FF21 sorts after an astral character by code unit and before it by code point, so a table
    // built any other way would be one `crates/osg-scene` re-derives differently and refuses.
    const astral = String.fromCodePoint(0x20000);
    const baked = cues({ texts: ['Ａ', astral] }, { faces: EVERY_PLANE });
    const page = onlyPage(baked);

    expect(cellTextsOf(page)).toEqual([astral, 'Ａ']);
    const codeUnits = cellTextsOf(page).map((text) => text.charCodeAt(0));
    expect(codeUnits).toEqual([...codeUnits].sort((left, right) => left - right));
    expect(cellsOf(baked.runs[0])).toEqual([1]);
    expect(cellsOf(baked.runs[1])).toEqual([0]);
  });

  it('is strictly increasing across a cue list large enough to need many cells', () => {
    const baked = cues({ texts: Array.from({ length: 200 }, (_unused, index) => `line ${index}`) });

    const texts = cellTextsOf(onlyPage(baked));
    expect(texts.length).toBe(200);
    for (const [index, text] of texts.entries()) {
      if (index === 0) continue;
      expect(texts[index - 1] < text, text).toBe(true);
    }
  });
});

describe('bakeGlyphAtlasForCues paging', () => {
  /** A cue list of distinct one-line cues, so the cells needed are exactly `count`. */
  const lineCues = (count, prefix = 'c') => Array.from(
    { length: count },
    (_unused, index) => `${prefix}${index}`,
  );

  it('fills a page to the cell bound and starts another rather than refusing the document', () => {
    const perPage = GLYPH_ATLAS_LIMITS.maxGlyphCount;

    const full = cues({ texts: lineCues(perPage) });
    expect(full.pages).toHaveLength(1);
    expect(full.pages[0].glyphs.length).toBe(perPage);

    // One cue more opens a second page rather than refusing the document, which is what paging is
    // for — and what a cell being a LINE makes an ordinary track reach rather than a rare one.
    const spilled = cues({ texts: lineCues(perPage + 1) });
    expect(spilled.pages).toHaveLength(2);
    expect(spilled.pages[0].glyphs.length).toBe(perPage);
    expect(spilled.pages[1].glyphs.length).toBe(1);
    expect(spilled.pageOfCue).toEqual([...Array(perPage).fill(0), 1]);
  });

  it('lays the spilled cue out against its OWN page, not against page 0', () => {
    const perPage = GLYPH_ATLAS_LIMITS.maxGlyphCount;
    const texts = lineCues(perPage + 1);
    const baked = cues({ texts });

    // The last cue's line is page 1's whole table, so its cell is index 0 — the same index page 0
    // uses for an entirely different line. Reading it against page 0 would draw the wrong line,
    // which is exactly what a page index exists to prevent.
    expect(cellsOf(baked.runs[perPage])).toEqual([0]);
    expect(cellTextsOf(baked.pages[1])).toEqual([texts[perPage]]);
    expect(cellTextsOf(baked.pages[0])).not.toContain(texts[perPage]);
    // Every cue's cells are inside its own page's table, and every page index is a real page.
    for (const [cue, run] of baked.runs.entries()) {
      const cellCount = pageOf(baked, cue).glyphs.length;
      expect(cellsOf(run).every((cell) => cell >= 0 && cell < cellCount)).toBe(true);
    }
    expect(baked.pageOfCue).toHaveLength(baked.runs.length);
    expect(baked.pageOfCue.every((page) => page >= 0 && page < baked.pages.length)).toBe(true);
  });

  it('pages a cue list that mixes directions instead of refusing it', () => {
    // CSS `start` is the right edge of a right-to-left paragraph, and only the shaper can resolve
    // it. The compositor aligns every cue by its ATLAS's one answer — so cues that resolve to
    // different alignments simply land on different pages. This document used to be refused whole.
    const baked = cues({ texts: ['ok', HEBREW] });

    expect(baked.pages).toHaveLength(2);
    expect(baked.pageOfCue).toEqual([0, 1]);
    expect(baked.runs.map((run) => run.textAlign)).toEqual(['left', 'right']);
    expect(baked.pages.map((page) => page.layout.textAlign)).toEqual(['left', 'right']);

    // Forcing the paragraph level — which is what the persisted rtlSupport does — makes them agree,
    // and agreeing cues share a page.
    const forced = cues({ texts: ['ok', HEBREW], baseDirection: 'rtl' });
    expect(forced.pages).toHaveLength(1);
    expect(forced.runs.map((run) => run.textAlign)).toEqual(['right', 'right']);
    // So does asking for an alignment that is not the direction-dependent default.
    const centred = cues({ texts: ['ok', HEBREW], textAlign: 'center' });
    expect(centred.pages).toHaveLength(1);
    expect(centred.runs.map((run) => run.textAlign)).toEqual(['center', 'center']);
  });

  /**
   * What a page holds, measured rather than asserted, because a cell being a line changed it.
   *
   * A page used to hold a whole track: its bound was on the ALPHABET, so 500 cues of English cost
   * 27 cells and ten times the cues cost the same. A page now holds `maxGlyphCount` distinct LINES,
   * so a long track needs pages — which is the price of the mask and its advance coming from one
   * operation. Repetition is still free, and only one page is ever bound per frame.
   */
  it('measures how much ordinary text fits: the bound is on the distinct lines', () => {
    const many = cues({ texts: lineCues(500) });
    expect(many.runs).toHaveLength(500);
    expect(onlyPage(many).glyphs.length).toBe(500);

    // A track that repeats itself costs one cell however long it is, because a page's table is the
    // set of distinct lines rather than a list of them.
    const repeated = cues({ texts: Array.from({ length: 500 }, () => 'the same line') });
    expect(repeated.runs).toHaveLength(500);
    expect(onlyPage(repeated).glyphs.length).toBe(1);

    // And a track with more distinct lines than one page holds is paged, not refused.
    expect(cues({ texts: lineCues(GLYPH_ATLAS_LIMITS.maxGlyphCount + 1) }).pages).toHaveLength(2);
  });

  it('rejects a cue list that is not one', () => {
    expect(codeOf(() => cues({ texts: [] }))).toBe('glyphAtlasInvalidRequest');
    expect(codeOf(() => cues({ texts: 'abc' }))).toBe('glyphAtlasInvalidRequest');
    expect(codeOf(() => cues({ texts: ['ok', 42] }))).toBe('glyphAtlasInvalidRequest');
    expect(codeOf(() => bakeGlyphAtlasForCues(null))).toBe('glyphAtlasInvalidRequest');
  });
});

describe('bakeGlyphAtlasForCues staging contract', () => {
  it('refuses a cue that would place no cell, which the compositor refuses too', () => {
    // `osg_compositor::CueRun::validate` rejects a run with no lines and a run with no cells, so
    // both of these would take the whole export down with a refusal nobody could act on.
    expect(codeOf(() => cues({ texts: ['ok', ''] }))).toBe('glyphAtlasInvalidRequest');
    expect(codeOf(() => cues({ texts: ['ok', '\n'] }))).toBe('glyphAtlasInvalidRequest');
    // Whitespace does place cells — inkless ones — so it is a cue like any other.
    expect(() => cues({ texts: ['ok', '  '] })).not.toThrow();
  });

  it('exports a ligature that no per-cluster spelling could ever have reproduced', () => {
    // The case that used to take the whole export down. `ffi` is drawn as ONE glyph narrower than
    // the three letters it is spelled with, so no per-cluster cell table could reproduce the run's
    // width, and the baker refused rather than draw it wrongly. The line is one cell now, so the
    // ligature is in the mask and the width reported is the width of that mask.
    const baked = bakeGlyphAtlasForCues(
      { texts: ['ok', 'ffi'], face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX },
      { surface: createLigatureSurface() }
    );

    expect(baked.runs.every((run) => run.cellAdvanceLayout === 'reproduces')).toBe(true);
    expect(baked.runs[1].lines[0].shapingResidualPx).toBe(0);
    // The LIGATED width, not the sum of three letters, which is 1.2 face sizes against 3 * 0.52.
    expect(baked.runs[1].lines[0].advanceWidthPx).toBe(SHAPED_SIZE_PX * 1.2);

    // The preview bakes the same thing, which is what makes the export a proof of it.
    const single = bakeGlyphAtlas(
      { text: 'ffi', face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX },
      { surface: createLigatureSurface() }
    );
    expect(single.layout.cellAdvanceLayout).toBe('reproduces');
    expect(single.layout.lines[0].advanceWidthPx).toBe(SHAPED_SIZE_PX * 1.2);
  });

  it('declares the cue-set codes', () => {
    expect(GLYPH_ATLAS_ERROR_CODES).toContain('glyphAtlasCueLayoutRefused');
    expect(GLYPH_ATLAS_ERROR_CODES).toContain('glyphAtlasTooManyPages');
    expect(GLYPH_ATLAS_ERROR_CODES).toContain('glyphAtlasPixelBudget');
    // The alignment conflict is gone because paging removed the condition, not because it was
    // downgraded: mixed-direction cues now land on different pages and both are drawn.
    expect(GLYPH_ATLAS_ERROR_CODES).not.toContain('glyphAtlasCueAlignmentConflict');
    expect(new Set(GLYPH_ATLAS_ERROR_CODES).size).toBe(GLYPH_ATLAS_ERROR_CODES.length);
  });
});

describe('bakeGlyphAtlasForCues determinism', () => {
  const TEXTS = ['the quick brown fox', 'jumps over', 'the lazy dog'];

  it('bakes the same bytes and the same identity from the same cue list', () => {
    const first = cues({ texts: TEXTS });
    const second = cues({ texts: TEXTS });

    expect(second.pages[0].contentHash).toBe(first.pages[0].contentHash);
    expect(bytesOf(second.pages[0])).toEqual(bytesOf(first.pages[0]));
    expect(second.pages[0].glyphs).toEqual(first.pages[0].glyphs);
    expect(second.runs).toEqual(first.runs);
    expect(second.pageOfCue).toEqual(first.pageOfCue);
  });

  it('builds the same table whatever order the cues arrive in', () => {
    const forward = cues({ texts: TEXTS });
    const reversed = cues({ texts: [...TEXTS].reverse() });

    // These cues share a page either way, and a page's table and raster are a function of the SET of
    // cells, so the atlas itself is identical.
    expect(cellTextsOf(reversed.pages[0])).toEqual(cellTextsOf(forward.pages[0]));
    expect(bytesOf(reversed.pages[0])).toEqual(bytesOf(forward.pages[0]));
    // Each cue's layout travels with its cue rather than with its position.
    expect(reversed.runs[2]).toEqual(forward.runs[0]);
    expect(reversed.runs[0]).toEqual(forward.runs[2]);
    // The identity is not, and must not be: a page carries its first cue's layout, so a reordered
    // list is a different page even though it is the same table.
    expect(reversed.pages[0].contentHash).not.toBe(forward.pages[0].contentHash);
  });

  it('changes identity when any cue changes, including one that shares every cell', () => {
    const base = cues({ texts: ['ab', 'ba'] });

    // Same cells, same first cue, different second cue: the hash covers every run the page carries,
    // not just the one it exposes as `layout`.
    expect(cues({ texts: ['ab', 'ab'] }).pages[0].contentHash).not.toBe(base.pages[0].contentHash);
    expect(cues({ texts: ['ab', 'ba', 'ab'] }).pages[0].contentHash).not.toBe(base.pages[0].contentHash);
  });
});

describe('bakeGlyphAtlasForCues single-cue agreement', () => {
  /** The one guard that the two entry points are one pipeline rather than two that resemble each other. */
  const agrees = (request) => {
    const options = { surface: createFakeSurface() };
    const shared = { face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX, ...request };
    const single = bakeGlyphAtlas({ ...shared, text: request.text }, options);
    const baked = bakeGlyphAtlasForCues({ ...shared, texts: [request.text] }, options);
    const page = onlyPage(baked);

    expect(page.contentHash).toBe(single.contentHash);
    expect(page.glyphs).toEqual(single.glyphs);
    expect(page.metrics).toEqual(single.metrics);
    expect(page.atlas).toEqual(single.atlas);
    expect(page.face).toEqual(single.face);
    expect(page.layout).toEqual(single.layout);
    expect(bytesOf(page)).toEqual(bytesOf(single));
    expect(baked.runs).toHaveLength(1);
    expect(baked.runs[0]).toBe(page.layout);
    expect(baked.pageOfCue).toEqual([0]);
  };

  it('reproduces the preview bake exactly for one cue', () => {
    agrees({ text: 'Hello world' });
    agrees({ text: 'wrap me here now', maxWidthPx: SHAPED_SIZE_PX * 4 });
    agrees({ text: 'two\nlines', letterSpacingPx: 2, textAlign: 'center' });
    agrees({ text: 'Case Folded', textTransform: 'uppercase', lineHeightPx: 72, paddingPx: 3 });
  });

  it('reproduces it for a right-to-left cue and for one whose letters join', () => {
    const options = { surface: createFakeSurface() };
    const shared = { face: { family: CURSIVE_FAMILY }, fontSizePx: SHAPED_SIZE_PX };
    const single = bakeGlyphAtlas({ ...shared, text: 'ببب' }, options);
    const baked = bakeGlyphAtlasForCues({ ...shared, texts: ['ببب'] }, options);
    const page = onlyPage(baked);

    expect(page.contentHash).toBe(single.contentHash);
    expect(cellTextsOf(page)).toEqual(cellTextsOf(single));
    expect(page.layout).toEqual(single.layout);
    expect(bytesOf(page)).toEqual(bytesOf(single));
  });

  it('gives a cue the same cells whichever cues it is baked beside', () => {
    // The property paging exists to preserve: a cue whose cells depended on its neighbours would
    // mean the preview (one cue) and the export (all of them) could bake different pictures for the
    // same text, and the export would stop being a proof of the preview.
    const options = { surface: createFakeSurface() };
    const shared = { face: { family: CURSIVE_FAMILY }, fontSizePx: SHAPED_SIZE_PX };
    const alone = bakeGlyphAtlasForCues({ ...shared, texts: ['ببب'] }, options);
    const crowded = bakeGlyphAtlasForCues({ ...shared, texts: ['ok', 'ببب', 'more text here'] }, options);

    expect(linesOf(crowded, 1)).toEqual(linesOf(alone, 0));
    expect(crowded.runs[1].widthPx).toBe(alone.runs[0].widthPx);
    expect(crowded.runs[1].lines.map((line) => line.advanceWidthPx))
      .toEqual(alone.runs[0].lines.map((line) => line.advanceWidthPx));
  });
});
