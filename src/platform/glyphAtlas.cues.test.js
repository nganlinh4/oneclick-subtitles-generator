import { describe, expect, it } from 'vitest';

import { GLYPH_ATLAS_ERROR_CODES, GLYPH_ATLAS_LIMITS, bakeGlyphAtlas, bakeGlyphAtlasForCues } from './glyphAtlas';
import {
  ACUTE,
  CURSIVE_FAMILY,
  DEFAULT_FACES,
  HEBREW,
  SHAPED_SIZE_PX,
  cellFormsOf,
  clustersOf,
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
 * the metrics but the TABLE: that cues sharing a page share one cell list, that the list is the
 * union over contextual FORMS rather than over characters, that it keeps the strictly-increasing
 * UTF-16 order `crates/osg-scene` re-derives, that a cue drawn from page 2 indexes page 2, that
 * ordinary content still produces exactly one page, and that a one-cue call is byte-for-byte the
 * bake the preview already gets.
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

/** Every cell a cue draws, per line, with context joiners shown as `-` so a form can be read. */
const formsOf = (baked, cue) => {
  const forms = cellFormsOf(pageOf(baked, cue));
  return baked.runs[cue].lines.map((line) => line.glyphs.map((cell) => forms[cell]).join('|'));
};

const cellsOf = (run) => run.lines.flatMap((line) => line.glyphs);

/** A face that covers every plane, so an astral cluster can be baked without substitution. */
const EVERY_PLANE = new Map([
  ...DEFAULT_FACES,
  ['editor sans', defineFace('editor-sans', 0.52, () => true, 0.81, 0.19)],
]);

const bytesOf = (descriptor) => [...descriptor.pixels];

describe('bakeGlyphAtlasForCues table', () => {
  it('gives cues that share a page one cell table with no duplicates, each indexing its own clusters', () => {
    const baked = cues({ texts: ['abc', 'bcd'] });
    const page = onlyPage(baked);

    expect(clustersOf(page)).toEqual(['a', 'b', 'c', 'd']);
    expect(page.atlas.glyphCount).toBe(4);
    expect(cellsOf(baked.runs[0])).toEqual([0, 1, 2]);
    expect(cellsOf(baked.runs[1])).toEqual([1, 2, 3]);
    // One run per cue, in cue order, and the first cue a page serves is that page's own layout.
    expect(baked.runs).toHaveLength(2);
    expect(baked.pageOfCue).toEqual([0, 0]);
    expect(baked.runs[0]).toBe(page.layout);
    expect(Object.isFrozen(baked.runs)).toBe(true);
    expect(Object.isFrozen(baked.pages)).toBe(true);
  });

  it('unions over contextual forms, not over characters, and each cue indexes the form it has', () => {
    // The same letter in two cues: a two-letter word gives it initial and final forms, a
    // three-letter word adds the medial one. Three forms, three cells, one table.
    const baked = cursiveCues({ texts: ['بب', 'ببب'] });

    expect(cellFormsOf(onlyPage(baked))).toEqual(['ب-', '-ب', '-ب-']);
    // Right-to-left, so each line reads left to right as drawn: final form first.
    expect(formsOf(baked, 0)).toEqual(['-ب|ب-']);
    expect(formsOf(baked, 1)).toEqual(['-ب|-ب-|ب-']);
    // The cell cue 1 indexes for its middle position is the medial one — the cell resolved FOR that
    // position, not the initial cell cue 0 happens to have for the same cluster.
    expect(cellsOf(baked.runs[1])[1]).toBe(2);
    expect(baked.runs.every((run) => run.cellAdvanceLayout === 'reproduces')).toBe(true);
  });

  it('keeps a cue that needs no contextual form on the cells it always had', () => {
    // A Latin cue beside one that joins: the Latin cells are the bare clusters, the cursive ones are
    // joined forms, and both sit in one table. Sorted by code unit, a joiner-first spelling lands
    // after the letter-first one.
    const baked = cursiveCues({ texts: ['ok', 'ok بب'] });

    expect(cellFormsOf(onlyPage(baked))).toEqual([' ', 'k', 'o', 'ب-', '-ب']);
    expect(formsOf(baked, 0)).toEqual(['o|k']);
    expect(formsOf(baked, 1)).toEqual(['o|k| |-ب|ب-']);
    // The Latin cue's cells are exactly the ones it would have had alone.
    expect(cellsOf(baked.runs[0])).toEqual([2, 1]);
  });

  it('orders each page by UTF-16 code unit, which is not code point order', () => {
    // U+FF21 sorts after an astral cluster by code unit and before it by code point, so a table
    // built any other way would be one `crates/osg-scene` re-derives differently and refuses.
    const astral = String.fromCodePoint(0x20000);
    const baked = cues({ texts: [`aＡ`, `a${astral}`] }, { faces: EVERY_PLANE });
    const page = onlyPage(baked);

    expect(clustersOf(page)).toEqual(['a', astral, 'Ａ']);
    const codeUnits = clustersOf(page).map((cluster) => cluster.charCodeAt(0));
    expect(codeUnits).toEqual([...codeUnits].sort((left, right) => left - right));
    expect(new Set(clustersOf(page)).size).toBe(page.glyphs.length);
    expect(cellsOf(baked.runs[0])).toEqual([0, 2]);
    expect(cellsOf(baked.runs[1])).toEqual([0, 1]);
  });

  it('is strictly increasing across a cue list large enough to need many cells', () => {
    const alphabet = (start, count) => Array.from(
      { length: count },
      (_unused, index) => String.fromCodePoint(start + index)
    ).join('');
    const baked = cues({ texts: [alphabet(0x4e00, 64), alphabet(0x4e20, 64), alphabet(0x0100, 64)] });

    const clusters = clustersOf(onlyPage(baked));
    expect(clusters.length).toBe(64 + 32 + 64);
    for (const [index, cluster] of clusters.entries()) {
      if (index === 0) continue;
      expect(clusters[index - 1] < cluster).toBe(true);
    }
  });
});

describe('bakeGlyphAtlasForCues paging', () => {
  const distinct = (start, count) => Array.from(
    { length: count },
    (_unused, index) => String.fromCodePoint(start + index)
  ).join('');

  /** Cue lists whose alphabets do not overlap, so the cells needed are exactly `perCue * count`. */
  const alphabetCues = (count, perCue) => Array.from(
    { length: count },
    (_unused, index) => distinct(0x4e00 + index * perCue, perCue)
  );

  it('fills a page to the glyph bound and starts another rather than refusing the document', () => {
    const perCue = 64;
    const perPage = GLYPH_ATLAS_LIMITS.maxGlyphCount / perCue;

    const full = cues({ texts: alphabetCues(perPage, perCue) });
    expect(full.pages).toHaveLength(1);
    expect(full.pages[0].glyphs.length).toBe(GLYPH_ATLAS_LIMITS.maxGlyphCount);

    // One cue more used to be refused outright. It now opens a second page, and the document that a
    // Chinese or Korean track actually is exports.
    const spilled = cues({ texts: alphabetCues(perPage + 1, perCue) });
    expect(spilled.pages).toHaveLength(2);
    expect(spilled.pages[0].glyphs.length).toBe(GLYPH_ATLAS_LIMITS.maxGlyphCount);
    expect(spilled.pages[1].glyphs.length).toBe(perCue);
    expect(spilled.pageOfCue).toEqual([...Array(perPage).fill(0), 1]);
  });

  it('lays the spilled cue out against its OWN page, not against page 0', () => {
    const perCue = 64;
    const perPage = GLYPH_ATLAS_LIMITS.maxGlyphCount / perCue;
    const texts = alphabetCues(perPage + 1, perCue);
    const baked = cues({ texts });

    // The last cue's clusters are page 1's whole table, so its cells are 0..63 — the same indices
    // page 0 uses for entirely different characters. Reading them against page 0 would draw 64 wrong
    // glyphs, which is exactly what a page index exists to prevent.
    const last = baked.runs[perPage];
    expect(cellsOf(last)).toEqual([...Array(perCue).keys()]);
    expect(clustersOf(baked.pages[1])).toEqual([...texts[perPage]]);
    expect(clustersOf(baked.pages[0])).not.toEqual(clustersOf(baked.pages[1]));
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

  it('measures how much ordinary text fits: the bound is on the alphabet, not on the cue count', () => {
    const words = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'a', 'lazy', 'dog'];
    const sentence = (index) => Array.from(
      { length: 8 },
      (_unused, word) => words[(index * 7 + word * 3) % words.length]
    ).join(' ');
    const ordinary = (count) => Array.from({ length: count }, (_unused, index) => sentence(index));

    // Five hundred cues of English saturate at the alphabet they are written in — 26 letters and a
    // space — nowhere near the 1024 a page allows, so they are ONE page. Ten times the cues would
    // measure the same. Paging must never fragment ordinary content: a second page here would be a
    // second texture upload per frame for nothing.
    const many = cues({ texts: ordinary(500) });
    expect(many.runs).toHaveLength(500);
    expect(onlyPage(many).glyphs.length).toBe(27);
    expect(onlyPage(cues({ texts: ordinary(50) })).glyphs.length).toBe(27);

    // A large-alphabet track is the case that fills pages, and it fills them in proportion to the
    // distinct characters the track uses rather than to how many cues it has.
    expect(onlyPage(cues({ texts: alphabetCues(8, 128) })).glyphs.length).toBe(1_024);
    expect(cues({ texts: alphabetCues(9, 128) }).pages).toHaveLength(2);
  });

  it('bounds a page by cluster code points too, which no single cue could exceed', () => {
    // 514 distinct clusters of eight code points each: 4112 code points of cells, above what one
    // page carries, while each cue's own text stays under it. Only the page total can see this.
    const heavy = (start, count) => Array.from(
      { length: count },
      (_unused, index) => `${String.fromCodePoint(start + index)}${ACUTE.repeat(7)}`
    ).join('');
    const half = GLYPH_ATLAS_LIMITS.maxTextCodePoints / 8 / 2;

    expect(cues({ texts: [heavy(0x4e00, half), heavy(0x4e00 + half, half)] }).pages).toHaveLength(1);
    expect(cues({ texts: [heavy(0x4e00, half + 1), heavy(0x5000, half)] }).pages).toHaveLength(2);
  });

  it('refuses a document with more distinct characters than every page together could carry', () => {
    // The one whole-document bound. It is a work bound as much as a capacity one: every distinct
    // cluster is measured, and a document past this was never going to bake whatever the pages did.
    const capacity = GLYPH_ATLAS_LIMITS.maxGlyphCount * GLYPH_ATLAS_LIMITS.maxAtlasPages;
    const perCue = 1_024;
    const over = alphabetCues(capacity / perCue + 1, perCue);

    expect(codeOf(() => cues({ texts: over }))).toBe('glyphAtlasTooManyPages');
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

  it('refuses the export when one cue cannot be laid out from cells', () => {
    // A ligature is the case no per-cluster spelling reproduces. `SubtitleScene::new` gates on the
    // atlas's verdict, so a cue that cannot be drawn from cells is refused rather than drawn in the
    // wrong order — and paging cannot rescue it, because the refusal is about that cue alone.
    const ligated = () => bakeGlyphAtlasForCues(
      { texts: ['ok', 'ffi'], face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX },
      { surface: createLigatureSurface() }
    );

    expect(codeOf(ligated)).toBe('glyphAtlasCueLayoutRefused');
    // The same text alone still bakes, refusal and all, because the preview reads that refusal.
    const single = bakeGlyphAtlas(
      { text: 'ffi', face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX },
      { surface: createLigatureSurface() }
    );
    expect(single.layout.cellAdvanceLayout).toBe('refused');
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
    expect(clustersOf(reversed.pages[0])).toEqual(clustersOf(forward.pages[0]));
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

  it('reproduces it for a right-to-left cue and for one that needs contextual cells', () => {
    const options = { surface: createFakeSurface() };
    const shared = { face: { family: CURSIVE_FAMILY }, fontSizePx: SHAPED_SIZE_PX };
    const single = bakeGlyphAtlas({ ...shared, text: 'ببب' }, options);
    const baked = bakeGlyphAtlasForCues({ ...shared, texts: ['ببب'] }, options);
    const page = onlyPage(baked);

    expect(page.contentHash).toBe(single.contentHash);
    expect(cellFormsOf(page)).toEqual(cellFormsOf(single));
    expect(page.layout).toEqual(single.layout);
    expect(bytesOf(page)).toEqual(bytesOf(single));
  });

  it('gives a cue the same cells whichever cues it is baked beside', () => {
    // The property paging exists to preserve, and the one the old global contextual fallback broke:
    // a cue whose cells depended on its neighbours meant the preview (one cue) and the export (all
    // of them) could bake different glyphs for the same text.
    const options = { surface: createFakeSurface() };
    const shared = { face: { family: CURSIVE_FAMILY }, fontSizePx: SHAPED_SIZE_PX };
    const alone = bakeGlyphAtlasForCues({ ...shared, texts: ['ببب'] }, options);
    const crowded = bakeGlyphAtlasForCues({ ...shared, texts: ['ok', 'ببب', 'more text here'] }, options);

    expect(formsOf(crowded, 1)).toEqual(formsOf(alone, 0));
    expect(crowded.runs[1].widthPx).toBe(alone.runs[0].widthPx);
    expect(crowded.runs[1].lines.map((line) => line.penXPx))
      .toEqual(alone.runs[0].lines.map((line) => line.penXPx));
  });
});
