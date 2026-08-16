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
 * One atlas for a whole cue list.
 *
 * The metrics below come from the fake font model `glyphAtlasTestFont.js` owns; what that model
 * reproduces faithfully, and what it cannot, is documented there. What this suite is about is not
 * the metrics but the TABLE: that n cues share one cell list, that the list is the union over
 * contextual FORMS rather than over characters, that it keeps the strictly-increasing UTF-16 order
 * `crates/osg-scene` re-derives, that its bounds refuse rather than truncate, and that a one-cue
 * call is byte-for-byte the bake the preview already gets.
 */

const cues = (request, surfaceOptions) => bakeGlyphAtlasForCues(
  { face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX, ...request },
  { surface: createFakeSurface(surfaceOptions) }
);

const cursiveCues = (request, surfaceOptions) => bakeGlyphAtlasForCues(
  { face: { family: CURSIVE_FAMILY }, fontSizePx: SHAPED_SIZE_PX, ...request },
  { surface: createFakeSurface(surfaceOptions) }
);

/** Every cell a run draws, per line, with context joiners shown as `-` so a form can be read. */
const formsOf = ({ descriptor }, run) => {
  const forms = cellFormsOf(descriptor);
  return run.lines.map((line) => line.glyphs.map((cell) => forms[cell]).join('|'));
};

const cellsOf = (run) => run.lines.flatMap((line) => line.glyphs);

/** A face that covers every plane, so an astral cluster can be baked without substitution. */
const EVERY_PLANE = new Map([
  ...DEFAULT_FACES,
  ['editor sans', defineFace('editor-sans', 0.52, () => true, 0.81, 0.19)],
]);

const bytesOf = (descriptor) => [...descriptor.pixels];

describe('bakeGlyphAtlasForCues table', () => {
  it('gives every cue one cell table with no duplicates, each indexing its own clusters', () => {
    const baked = cues({ texts: ['abc', 'bcd'] });

    expect(clustersOf(baked.descriptor)).toEqual(['a', 'b', 'c', 'd']);
    expect(baked.descriptor.atlas.glyphCount).toBe(4);
    expect(cellsOf(baked.runs[0])).toEqual([0, 1, 2]);
    expect(cellsOf(baked.runs[1])).toEqual([1, 2, 3]);
    // One run per cue, in cue order, and the first is the descriptor's own layout.
    expect(baked.runs).toHaveLength(2);
    expect(baked.runs[0]).toBe(baked.descriptor.layout);
    expect(Object.isFrozen(baked.runs)).toBe(true);
  });

  it('unions over contextual forms, not over characters, and each cue indexes the form it has', () => {
    // The same letter in two cues: a two-letter word gives it initial and final forms, a
    // three-letter word adds the medial one. Three forms, three cells, one table.
    const baked = cursiveCues({ texts: ['بب', 'ببب'] });

    expect(cellFormsOf(baked.descriptor)).toEqual(['ب-', '-ب', '-ب-']);
    // Right-to-left, so each line reads left to right as drawn: final form first.
    expect(formsOf(baked, baked.runs[0])).toEqual(['-ب|ب-']);
    expect(formsOf(baked, baked.runs[1])).toEqual(['-ب|-ب-|ب-']);
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

    expect(cellFormsOf(baked.descriptor)).toEqual([' ', 'k', 'o', 'ب-', '-ب']);
    expect(formsOf(baked, baked.runs[0])).toEqual(['o|k']);
    expect(formsOf(baked, baked.runs[1])).toEqual(['o|k| |-ب|ب-']);
    // The Latin cue's cells are exactly the ones it would have had alone.
    expect(cellsOf(baked.runs[0])).toEqual([2, 1]);
  });

  it('orders the union by UTF-16 code unit, which is not code point order', () => {
    // U+FF21 sorts after an astral cluster by code unit and before it by code point, so a table
    // built any other way would be one `crates/osg-scene` re-derives differently and refuses.
    const astral = String.fromCodePoint(0x20000);
    const baked = cues({ texts: [`aＡ`, `a${astral}`] }, { faces: EVERY_PLANE });

    expect(clustersOf(baked.descriptor)).toEqual(['a', astral, 'Ａ']);
    const codeUnits = clustersOf(baked.descriptor).map((cluster) => cluster.charCodeAt(0));
    expect(codeUnits).toEqual([...codeUnits].sort((left, right) => left - right));
    expect(new Set(clustersOf(baked.descriptor)).size).toBe(baked.descriptor.glyphs.length);
    expect(cellsOf(baked.runs[0])).toEqual([0, 2]);
    expect(cellsOf(baked.runs[1])).toEqual([0, 1]);
  });

  it('is strictly increasing across a cue list large enough to need many cells', () => {
    const alphabet = (start, count) => Array.from(
      { length: count },
      (_unused, index) => String.fromCodePoint(start + index)
    ).join('');
    const baked = cues({ texts: [alphabet(0x4e00, 64), alphabet(0x4e20, 64), alphabet(0x0100, 64)] });

    const clusters = clustersOf(baked.descriptor);
    expect(clusters.length).toBe(64 + 32 + 64);
    for (const [index, cluster] of clusters.entries()) {
      if (index === 0) continue;
      expect(clusters[index - 1] < cluster).toBe(true);
    }
  });
});

describe('bakeGlyphAtlasForCues bounds', () => {
  const distinct = (start, count) => Array.from(
    { length: count },
    (_unused, index) => String.fromCodePoint(start + index)
  ).join('');

  /** Cue lists whose alphabets do not overlap, so the union is exactly `perCue * count` cells. */
  const alphabetCues = (count, perCue) => Array.from(
    { length: count },
    (_unused, index) => distinct(0x4e00 + index * perCue, perCue)
  );

  it('applies the glyph bound to the union and refuses rather than truncating', () => {
    const perCue = 64;
    const capacity = GLYPH_ATLAS_LIMITS.maxGlyphCount / perCue;

    const full = cues({ texts: alphabetCues(capacity, perCue) });
    expect(full.descriptor.glyphs.length).toBe(GLYPH_ATLAS_LIMITS.maxGlyphCount);
    expect(full.runs).toHaveLength(capacity);

    // One cue more is refused whole. Nothing is dropped: there is no descriptor at all.
    expect(codeOf(() => cues({ texts: alphabetCues(capacity + 1, perCue) })))
      .toBe('glyphAtlasTooManyGlyphs');
  });

  it('bounds the union by cluster code points too, which no single cue could exceed', () => {
    // 514 distinct clusters of eight code points each: 4112 code points of cells, above the bound,
    // while each cue's own text stays under it. Only the union can see this.
    const heavy = (start, count) => Array.from(
      { length: count },
      (_unused, index) => `${String.fromCodePoint(start + index)}${ACUTE.repeat(7)}`
    ).join('');
    const half = GLYPH_ATLAS_LIMITS.maxTextCodePoints / 8 / 2;

    expect(() => cues({ texts: [heavy(0x4e00, half), heavy(0x4e00 + half, half)] })).not.toThrow();
    expect(codeOf(() => cues({ texts: [heavy(0x4e00, half + 1), heavy(0x5000, half)] })))
      .toBe('glyphAtlasTextTooLong');
  });

  it('measures how much ordinary text fits: the bound is on the alphabet, not on the cue count', () => {
    const words = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'a', 'lazy', 'dog'];
    const sentence = (index) => Array.from(
      { length: 8 },
      (_unused, word) => words[(index * 7 + word * 3) % words.length]
    ).join(' ');
    const ordinary = (count) => Array.from({ length: count }, (_unused, index) => sentence(index));

    // Five hundred cues of English saturate at the alphabet they are written in — 26 letters and a
    // space — nowhere near the 1024 the bound allows. Ten times the cues would measure the same.
    const many = cues({ texts: ordinary(500) });
    expect(many.runs).toHaveLength(500);
    expect(many.descriptor.glyphs.length).toBe(27);
    expect(cues({ texts: ordinary(50) }).descriptor.glyphs.length).toBe(27);

    // A large-alphabet track is the case that can reach the bound, and it reaches it in proportion
    // to the distinct characters the track uses rather than to how many cues it has.
    expect(cues({ texts: alphabetCues(8, 128) }).descriptor.glyphs.length).toBe(1_024);
    expect(codeOf(() => cues({ texts: alphabetCues(9, 128) }))).toBe('glyphAtlasTooManyGlyphs');
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

  it('refuses the whole atlas when one cue cannot be laid out from cells', () => {
    // A ligature is the case no per-cluster spelling reproduces. `SubtitleScene::new` gates on the
    // ATLAS's verdict, one for every cue, so a refused cue cannot be carried beside sound ones.
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

  it('refuses cues that resolve to different alignments, which one atlas cannot carry', () => {
    // CSS `start` is the right edge of a right-to-left paragraph, and only the shaper can resolve
    // it. The compositor aligns every cue by the atlas's one answer, so a mixed-direction list with
    // the direction left to the text would align half of it against the wrong edge.
    expect(codeOf(() => cues({ texts: ['ok', HEBREW] }))).toBe('glyphAtlasCueAlignmentConflict');

    // Forcing the paragraph level — which is what the persisted rtlSupport does — makes them agree.
    const forced = cues({ texts: ['ok', HEBREW], baseDirection: 'rtl' });
    expect(forced.runs.map((run) => run.textAlign)).toEqual(['right', 'right']);
    // So does asking for an alignment that is not the direction-dependent default.
    expect(cues({ texts: ['ok', HEBREW], textAlign: 'center' }).runs.map((run) => run.textAlign))
      .toEqual(['center', 'center']);
  });

  it('declares both cue-set codes', () => {
    expect(GLYPH_ATLAS_ERROR_CODES).toContain('glyphAtlasCueLayoutRefused');
    expect(GLYPH_ATLAS_ERROR_CODES).toContain('glyphAtlasCueAlignmentConflict');
    expect(new Set(GLYPH_ATLAS_ERROR_CODES).size).toBe(GLYPH_ATLAS_ERROR_CODES.length);
  });
});

describe('bakeGlyphAtlasForCues determinism', () => {
  const TEXTS = ['the quick brown fox', 'jumps over', 'the lazy dog'];

  it('bakes the same bytes and the same identity from the same cue list', () => {
    const first = cues({ texts: TEXTS });
    const second = cues({ texts: TEXTS });

    expect(second.descriptor.contentHash).toBe(first.descriptor.contentHash);
    expect(bytesOf(second.descriptor)).toEqual(bytesOf(first.descriptor));
    expect(second.descriptor.glyphs).toEqual(first.descriptor.glyphs);
    expect(second.runs).toEqual(first.runs);
  });

  it('builds the same atlas whatever order the cues arrive in', () => {
    const forward = cues({ texts: TEXTS });
    const reversed = cues({ texts: [...TEXTS].reverse() });

    // The table and its raster are a function of the SET of cells, so the atlas itself is identical.
    expect(clustersOf(reversed.descriptor)).toEqual(clustersOf(forward.descriptor));
    expect(bytesOf(reversed.descriptor)).toEqual(bytesOf(forward.descriptor));
    // Each cue's layout travels with its cue rather than with its position.
    expect(reversed.runs[2]).toEqual(forward.runs[0]);
    expect(reversed.runs[0]).toEqual(forward.runs[2]);
    // The identity is not, and must not be: the descriptor carries the first cue's layout, so a
    // reordered list is a different descriptor even though it is the same table.
    expect(reversed.descriptor.contentHash).not.toBe(forward.descriptor.contentHash);
  });

  it('changes identity when any cue changes, including one that shares every cell', () => {
    const base = cues({ texts: ['ab', 'ba'] });

    // Same cells, same first cue, different second cue: the hash covers every run, not just the one
    // the descriptor carries.
    expect(cues({ texts: ['ab', 'ab'] }).descriptor.contentHash).not.toBe(base.descriptor.contentHash);
    expect(cues({ texts: ['ab', 'ba', 'ab'] }).descriptor.contentHash).not.toBe(base.descriptor.contentHash);
  });
});

describe('bakeGlyphAtlasForCues single-cue agreement', () => {
  /** The one guard that the two entry points are one pipeline rather than two that resemble each other. */
  const agrees = (request) => {
    const options = { surface: createFakeSurface() };
    const shared = { face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX, ...request };
    const single = bakeGlyphAtlas({ ...shared, text: request.text }, options);
    const baked = bakeGlyphAtlasForCues({ ...shared, texts: [request.text] }, options);

    expect(baked.descriptor.contentHash).toBe(single.contentHash);
    expect(baked.descriptor.glyphs).toEqual(single.glyphs);
    expect(baked.descriptor.metrics).toEqual(single.metrics);
    expect(baked.descriptor.atlas).toEqual(single.atlas);
    expect(baked.descriptor.face).toEqual(single.face);
    expect(baked.descriptor.layout).toEqual(single.layout);
    expect(bytesOf(baked.descriptor)).toEqual(bytesOf(single));
    expect(baked.runs).toHaveLength(1);
    expect(baked.runs[0]).toBe(baked.descriptor.layout);
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

    expect(baked.descriptor.contentHash).toBe(single.contentHash);
    expect(cellFormsOf(baked.descriptor)).toEqual(cellFormsOf(single));
    expect(baked.descriptor.layout).toEqual(single.layout);
    expect(bytesOf(baked.descriptor)).toEqual(bytesOf(single));
  });
});
