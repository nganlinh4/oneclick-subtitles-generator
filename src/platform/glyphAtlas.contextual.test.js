import { describe, expect, it } from 'vitest';

import { GLYPH_ATLAS_LIMITS, bakeGlyphAtlas } from './glyphAtlas';
import { measureGlyphAtlasPayload } from './glyphAtlasStaging';
import {
  ARABIC,
  bake,
  ARABIC_REPEATED,
  SHAPED_SIZE_PX,
  cellAlphaOf,
  cellFormsOf,
  createLigatureSurface,
  cursive,
  dualJoining,
  lineFormsOf,
} from './glyphAtlasTestFont';

/**
 * Contextual cells. A cursive face gives one cluster four glyphs, so a cell is baked from the
 * canonical spelling of the form the run gives it rather than from the bare cluster. `-ب-` below is
 * that spelling made readable: a joiner on a side is a request for the form that joins on that side.
 */
describe('bakeGlyphAtlas contextual cells', () => {
  const handled = { shapingCrossesClusters: false, directionNeedsBidi: false };

  it('bakes each position from the form the run gives it, and reproduces the run', () => {
    const descriptor = cursive({ text: ARABIC });

    // Initial م, final ر, initial ح (ر cannot join onwards, so the letter after it starts a stroke),
    // medial ب, final ا — five letters in four different forms, none of them the isolated one.
    expect(cellFormsOf(descriptor)).toEqual(['ح-', 'م-', '-ا', '-ب-', '-ر']);
    expect(descriptor.glyphs.map((glyph) => glyph.advanceWidthPx)).toEqual([25, 25, 27.5, 20, 27.5]);
    // Every cell is still right-to-left: a joiner is neutral and does not decide a direction.
    expect(descriptor.glyphs.every((glyph) => glyph.direction === 'rtl')).toBe(true);

    // Drawn right to left, and the advances are the run's own, so the run is reproduced exactly.
    expect(lineFormsOf(descriptor)).toEqual(['-ا|-ب-|ح-|-ر|م-']);
    expect(descriptor.layout.lines[0].penXPx).toEqual([0, 27.5, 47.5, 72.5, 100]);
    expect(descriptor.metrics.runAdvanceWidthPx).toBe(125);
    expect(descriptor.metrics.shapingResidualPx).toBe(0);
    expect(descriptor.layout.lines[0].shapingResidualPx).toBe(0);
    expect(descriptor.layout.cellAdvanceLayout).toBe('reproduces');
    expect(descriptor.layout.refusal).toEqual(handled);
  });

  it('gives one cluster three cells and three rasters when the run gives it three forms', () => {
    const descriptor = cursive({ text: ARABIC_REPEATED });

    expect(cellFormsOf(descriptor)).toEqual(['ب-', '-ب', '-ب-']);
    expect(new Set(descriptor.glyphs.map((glyph) => glyph.cluster)).size).toBe(3);
    // The point of the whole exercise: the same cluster in initial, medial and final position is
    // three different pieces of ink, not one cell drawn three times.
    const alphas = descriptor.glyphs.map((_glyph, cell) => cellAlphaOf(descriptor, cell));
    expect(new Set(alphas).size).toBe(3);
    expect(alphas.every((alpha) => alpha > 0)).toBe(true);

    expect(lineFormsOf(descriptor)).toEqual(['-ب|-ب-|ب-']);
    expect(descriptor.layout.cellAdvanceLayout).toBe('reproduces');
  });

  it('keeps the contextual forms inside a paragraph of the other direction', () => {
    const mixed = cursive({ text: `ok ${ARABIC}` });

    // A left-to-right paragraph: the Latin reads first, then the Arabic block right to left, and the
    // Arabic is still spelled with the forms its own word gives it.
    expect(lineFormsOf(mixed)).toEqual(['o|k| |-ا|-ب-|ح-|-ر|م-']);
    expect(mixed.metrics.baseDirection).toBe('ltr');
    expect(mixed.layout.textAlign).toBe('left');
    expect(mixed.layout.cellAdvanceLayout).toBe('reproduces');
  });

  it('separates the two refusals, so bidi refuses alone once shaping no longer does', () => {
    // A bracket beside right-to-left text needs a mirrored glyph the atlas never baked. The cells
    // are contextual and reproduce the run — the residual says so — and the run is still refused,
    // now for the one reason that is actually true of it.
    const bracketed = cursive({ text: `(${ARABIC})` });

    expect(bracketed.metrics.shapingResidualPx).toBe(0);
    expect(bracketed.layout.cellAdvanceLayout).toBe('refused');
    expect(bracketed.layout.refusal)
      .toEqual({ shapingCrossesClusters: false, directionNeedsBidi: true });
  });

  it('keeps a run whose clusters do not join on the isolated cells it always baked', () => {
    const latin = cursive({ text: 'aa bb' });

    expect(cellFormsOf(latin)).toEqual([' ', 'a', 'b']);
    expect(latin.metrics.shapingResidualPx).toBe(0);
    expect(latin.layout.cellAdvanceLayout).toBe('reproduces');
    // A joiner next to a non-joining cluster asks for a form the face does not have, so the bare
    // spelling wins on advance and the cell is the one the isolated path bakes.
    expect(latin.glyphs.every((glyph) => glyph.cluster.length === 1)).toBe(true);
  });

  it('wraps a cursive run at a space and still reproduces every line', () => {
    const wrapped = cursive({ text: `${ARABIC} ${ARABIC_REPEATED}`, maxWidthPx: 140 });

    expect(wrapped.layout.lineCount).toBe(2);
    expect(lineFormsOf(wrapped)).toEqual([' |-ا|-ب-|ح-|-ر|م-', '-ب|-ب-|ب-']);
    expect(wrapped.layout.lines.map((line) => line.shapingResidualPx)).toEqual([0, 0]);
    expect(wrapped.metrics.shapingResidualPx).toBe(0);
    expect(wrapped.layout.cellAdvanceLayout).toBe('reproduces');
    // Joining does not cross the space the line broke at, so the two words are spelled exactly as
    // they were unwrapped and the second line's cells are shared with the first where they repeat.
    expect(wrapped.atlas.glyphCount).toBe(8);
  });

  it('still refuses a line the engine would have reshaped, which is a break inside a word', () => {
    const split = cursive({ text: ARABIC_REPEATED, maxWidthPx: 40 });

    expect(lineFormsOf(split)).toEqual(['ب-', '-ب-', '-ب']);
    // Each line carries one letter of a word, and a letter alone is drawn isolated rather than
    // joined — so what the engine would measure for that line is not what these cells reproduce.
    expect(split.layout.lines.map((line) => line.shapingResidualPx)).toEqual([5, 10, 2.5]);
    expect(split.layout.cellAdvanceLayout).toBe('refused');
    expect(split.layout.refusal).toEqual({ shapingCrossesClusters: true, directionNeedsBidi: false });
  });

  it('refuses a ligature rather than spelling one glyph as several cells', () => {
    const ligated = bakeGlyphAtlas(
      { text: 'ffi', face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX },
      { surface: createLigatureSurface() }
    );

    // No spelling of `f` measures 19px — the second position's share of a 60px ligature — so the run
    // comes back unresolved and keeps the isolated cells and the residual that refuses them.
    expect(cellFormsOf(ligated)).toEqual(['f', 'i']);
    expect(ligated.metrics.runAdvanceWidthPx).toBe(60);
    expect(ligated.metrics.shapingResidualPx).toBe(-18);
    expect(ligated.layout.cellAdvanceLayout).toBe('refused');
    expect(ligated.layout.refusal).toEqual({ shapingCrossesClusters: true, directionNeedsBidi: false });
  });
});

describe('bakeGlyphAtlas contextual bounds', () => {
  /** `count` distinct letters, each in all four forms: alone, then a three-letter word. */
  const everyForm = (count) => dualJoining(count).map((letter) => `${letter} ${letter.repeat(3)} `).join('');

  it('holds the glyph bound by declining to resolve rather than by overflowing it', () => {
    // The worst case is four cells per distinct cluster, and it is reached exactly: 255 letters in
    // four forms plus the one space cell is 1021 cells, four short of the bound.
    const atCap = cursive({ text: everyForm(255) });
    expect(atCap.atlas.glyphCount).toBe(255 * 4 + 1);
    expect(atCap.atlas.glyphCount).toBeLessThanOrEqual(GLYPH_ATLAS_LIMITS.maxGlyphCount);
    expect(atCap.layout.cellAdvanceLayout).toBe('reproduces');

    // One letter more needs 1025 cells, so the run keeps its 257 isolated ones and its refusal
    // instead of failing the bake or silently dropping a form.
    const overCap = cursive({ text: everyForm(256) });
    expect(overCap.atlas.glyphCount).toBe(257);
    expect(overCap.layout.cellAdvanceLayout).toBe('refused');
  });

  it('falls back when four times the cells no longer fit the atlas', () => {
    // 60 letters at the largest bakeable size: 241 contextual cells do not fit 4096px, 61 isolated
    // ones do. The bake succeeds either way, which is the difference between a worse picture and no
    // picture at all.
    const text = dualJoining(60).map((letter) => `${letter.repeat(4)} `).join('');
    const large = cursive({ text, fontSizePx: GLYPH_ATLAS_LIMITS.maxFontSizePx });

    expect(large.atlas.glyphCount).toBe(61);
    expect(large.atlas.widthPx).toBe(GLYPH_ATLAS_LIMITS.maxAtlasDimensionPx);
    expect(large.layout.cellAdvanceLayout).toBe('refused');
  });

  it('passes the native boundary validation a contextual descriptor has to survive', () => {
    // The joiners a contextual cell is spelled with are code points like any other, so the staging
    // validator bounds them the same way — and this is what proves it, rather than a claim that it
    // would.
    const measurement = measureGlyphAtlasPayload(cursive({ text: ARABIC }));

    expect(measurement.withinBudget).toBe(true);
    expect(measurement.metadataBytes).toBeGreaterThan(0);
  });
});


describe('the persisted right-to-left setting', () => {
  it('forces the paragraph level instead of leaving it to the text', () => {
    // Left null the baker resolves the level from the first strong character (UAX #9 P2/P3), which
    // is right for mixed content and wrong for a caller who has told us the subtitle is RTL. The
    // discriminating case is text with no strong character at all: nothing in it can imply a level,
    // so the only way the two runs can differ is if the setting was actually consulted.
    const neutral = '123 456';

    const resolved = bake({ text: neutral, baseDirection: null });
    const forced = bake({ text: neutral, baseDirection: 'rtl' });

    expect(resolved.layout.textAlign).toBe('left');
    expect(forced.layout.textAlign).toBe('right');
    // The metrics keep reporting the coarse classification, which is provenance and deliberately
    // not the answer — a caller must read the layout, not this.
    expect(forced.metrics.baseDirection).toBe(resolved.metrics.baseDirection);
  });

  it('is refused when it is neither a direction nor absent', () => {
    for (const value of ['auto', 'RTL', '', 0, true, {}]) {
      expect(() => bake({ text: 'abc', baseDirection: value })).toThrow(/baseDirection/);
    }
  });
});
