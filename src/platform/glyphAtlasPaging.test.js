import { describe, expect, it } from 'vitest';

import { GLYPH_ATLAS_LIMITS, GLYPH_ATLAS_VERSION } from './glyphAtlas';
import { bakeAtlas } from './glyphAtlasBake';
import { HEBREW, SHAPED_SIZE_PX, clustersOf, codeOf, createFakeSurface } from './glyphAtlasTestFont';

/**
 * Where a page closes, and where the document is refused instead.
 *
 * These boundaries are arithmetic, and reaching them at the shipped limits costs tens of thousands
 * of canvas measurements to prove — so this suite reduces the limits instead and drives `bakeAtlas`
 * directly. That is sound because the limits are a parameter of the engine rather than a constant it
 * reads: `glyphAtlas.js` is the only module that supplies the shipped ones, and
 * `glyphAtlas.cues.test.js` exercises the same paths at those values.
 *
 * `maxTextCodePoints` is deliberately left at its shipped value: it bounds a cue's own text as well
 * as a page's cell table, and shrinking it would refuse the fixtures before paging saw them.
 */

const baked = (texts, limits = {}, request = {}) => bakeAtlas(
  {
    texts,
    request: { face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX, ...request },
    limits: { ...GLYPH_ATLAS_LIMITS, ...limits },
    version: GLYPH_ATLAS_VERSION,
  },
  { surface: createFakeSurface() },
);

/** Four cells to a page, two pages to a document: small enough to read, large enough to fragment. */
const SMALL = Object.freeze({ maxGlyphCount: 4, maxAtlasPages: 2 });

describe('atlas paging boundaries', () => {
  it('fills a page exactly to the cell bound before opening another', () => {
    expect(baked(['ab', 'cd'], SMALL).pages).toHaveLength(1);
    expect(clustersOf(baked(['ab', 'cd'], SMALL).pages[0])).toEqual(['a', 'b', 'c', 'd']);

    const spilled = baked(['ab', 'cd', 'ef'], SMALL);
    expect(spilled.pages).toHaveLength(2);
    expect(clustersOf(spilled.pages[0])).toEqual(['a', 'b', 'c', 'd']);
    expect(clustersOf(spilled.pages[1])).toEqual(['e', 'f']);
    expect(spilled.pageOfCue).toEqual([0, 0, 1]);
  });

  it('keeps a cue whole: a page never holds part of one', () => {
    // Cue 1 needs three cells and only two are left, so it moves entirely rather than splitting —
    // a run indexes ONE table, so half a cue on each page could not be drawn at all.
    const split = baked(['ab', 'cde'], SMALL);

    expect(split.pages).toHaveLength(2);
    expect(clustersOf(split.pages[0])).toEqual(['a', 'b']);
    expect(clustersOf(split.pages[1])).toEqual(['c', 'd', 'e']);
    expect(split.pageOfCue).toEqual([0, 1]);
  });

  it("makes a page's content a pure function of the cues on it", () => {
    // The property that lets the paged bake be checked cue by cue: a page is byte-identical to what
    // baking exactly its own cues would produce, so nothing about a page depends on the pages around
    // it. The incremental fill carries a width hint forward, and this is what proves the hint cannot
    // change an answer.
    const paged = baked(['ab', 'cd', 'ef', 'gh'], SMALL);
    expect(paged.pages).toHaveLength(2);

    const first = baked(['ab', 'cd'], SMALL);
    const second = baked(['ef', 'gh'], SMALL);
    expect(paged.pages[0].contentHash).toBe(first.pages[0].contentHash);
    expect(paged.pages[1].contentHash).toBe(second.pages[0].contentHash);
    expect([...paged.pages[1].pixels]).toEqual([...second.pages[0].pixels]);
    expect(paged.runs[2]).toEqual(second.runs[0]);
    expect(paged.runs[3]).toEqual(second.runs[1]);
  });

  it('opens a page when the alignment changes, however much room is left', () => {
    // Capacity is untouched here — two cells in a four-cell page — so this split can only be the
    // alignment. One atlas carries one alignment because `run_align` reads it from the atlas.
    const mixed = baked(['ok', HEBREW, 'ok'], SMALL);

    expect(mixed.pages).toHaveLength(2);
    expect(mixed.pageOfCue).toEqual([0, 1, 0]);
    expect(mixed.pages.map((page) => page.layout.textAlign)).toEqual(['left', 'right']);
  });

  it('keeps one open page per alignment, so alternating directions do not open a page per cue', () => {
    // The reason a page is keyed by alignment rather than being a contiguous stretch of cues. A
    // bilingual track alternating between directions would otherwise open a page for every cue and
    // exhaust the budget on a document with a two-letter alphabet. A page's cues need not be
    // adjacent: the compositor uploads the active cue's page each frame either way.
    const alternating = Array.from(
      { length: 40 },
      (_unused, index) => (index % 2 === 0 ? 'ok' : HEBREW),
    );
    const track = baked(alternating, SMALL);

    expect(track.pages).toHaveLength(2);
    expect(track.pageOfCue.filter((page) => page === 0)).toHaveLength(20);
    expect(track.pageOfCue.filter((page) => page === 1)).toHaveLength(20);
  });

  it('refuses a document that needs more pages than the budget allows', () => {
    // Three cues that each leave a page part-full: two cells, then three that do not fit beside
    // them, then two that do not fit beside those. The refusal is the whole document, because a page
    // silently dropped would be a stretch of subtitles missing from the exported file.
    expect(codeOf(() => baked(['ab', 'cde', 'fg'], { ...SMALL, maxAtlasPages: 2 })))
      .toBe('glyphAtlasTooManyPages');
    expect(baked(['ab', 'cde', 'fg'], { ...SMALL, maxAtlasPages: 3 }).pages).toHaveLength(3);
  });

  it('refuses a document whose pages would need more glyph memory than the budget holds', () => {
    expect(codeOf(() => baked(['ab', 'cd'], { ...SMALL, maxTotalAtlasBytes: 1 })))
      .toBe('glyphAtlasPixelBudget');
    // The budget is on the TOTAL, so a document that fits one page can pass where two would not.
    const onePageBytes = baked(['ab', 'cd'], SMALL).pages[0];
    const bytes = onePageBytes.atlas.widthPx * onePageBytes.atlas.heightPx * 4;
    expect(baked(['ab', 'cd'], { ...SMALL, maxTotalAtlasBytes: bytes }).pages).toHaveLength(1);
    expect(codeOf(() => baked(['ab', 'cd', 'ef'], { ...SMALL, maxTotalAtlasBytes: bytes })))
      .toBe('glyphAtlasPixelBudget');
  });

  it('refuses a single cue that no page could hold, naming the bound it broke', () => {
    // Paging has nothing left to try: there is no unit smaller than a cue to split into. This is a
    // genuine over-budget refusal rather than an incidental ceiling, and it says so by code.
    expect(codeOf(() => baked(['abcde'], SMALL))).toBe('glyphAtlasTooManyGlyphs');
    expect(codeOf(() => baked(['ok', 'abcde'], SMALL))).toBe('glyphAtlasTooManyGlyphs');
  });

  it('refuses a document with more distinct characters than every page together could carry', () => {
    // Checked before any measuring, because measuring is the expensive part and this document was
    // never going to bake. `maxGlyphCount * maxAtlasPages` is the whole capacity there is.
    expect(codeOf(() => baked(['abcdefghi'], SMALL))).toBe('glyphAtlasTooManyPages');
  });

  it('does not fragment a track whose alphabet stops growing', () => {
    const many = Array.from({ length: 200 }, (_unused, index) => (index % 2 === 0 ? 'ab' : 'ba'));
    const track = baked(many, SMALL);

    expect(track.pages).toHaveLength(1);
    expect(track.runs).toHaveLength(200);
    expect(new Set(track.pageOfCue).size).toBe(1);
  });

  it('lays every cue out against the page it was assigned', () => {
    const paged = baked(['ab', 'cd', 'ef'], SMALL);

    for (const [cue, run] of paged.runs.entries()) {
      const page = paged.pages[paged.pageOfCue[cue]];
      const cells = run.lines.flatMap((line) => line.glyphs);
      expect(cells.every((cell) => Number.isInteger(cell) && cell >= 0 && cell < page.glyphs.length))
        .toBe(true);
      // The cells a cue indexes spell that cue's own clusters on its own page.
      expect(cells.map((cell) => page.glyphs[cell].cluster).join('')).toBe(paged.runs === null ? '' : ['ab', 'cd', 'ef'][cue]);
    }
  });
});
