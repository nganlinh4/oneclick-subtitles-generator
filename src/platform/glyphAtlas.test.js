import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GLYPH_ATLAS_ERROR_CODES,
  GLYPH_ATLAS_LIMITS,
  GLYPH_ATLAS_VERSION,
  bakeGlyphAtlas,
  createCanvas2dMeasurementSurface,
} from './glyphAtlas';
import {
  ACUTE,
  ARABIC,
  ARABIC_REPEATED,
  DEFAULT_FACES,
  FAMILY_EMOJI,
  HEBREW,
  KOREAN,
  NON_EMOJI,
  VIETNAMESE,
  bake,
  bakeCues,
  cellTextsOf,
  codeOf,
  createFakeSurface,
  createKerningSurface,
  cursive,
  defineFace,
  lineTextsOf,
} from './glyphAtlasTestFont';

/**
 * What this suite proves and what it cannot: see the doc comment on `glyphAtlasTestFont.js`,
 * which owns the fake font model every metric below comes from. Line breaking, text transform,
 * letter spacing and justification are covered separately in `glyphAtlas.shaping.test.js`.
 */

describe('bakeGlyphAtlas descriptor', () => {
  it('returns a versioned, frozen descriptor whose codes are all declared', () => {
    const descriptor = bake({ text: 'Hi' });

    expect(descriptor.version).toBe(GLYPH_ATLAS_VERSION);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.glyphs)).toBe(true);
    expect(Object.isFrozen(descriptor.glyphs[0])).toBe(true);
    expect(Object.isFrozen(descriptor.atlas)).toBe(true);
    expect(() => { descriptor.version = 2; }).toThrow(TypeError);
    expect(() => { descriptor.glyphs.push({}); }).toThrow(TypeError);
    expect(new Set(GLYPH_ATLAS_ERROR_CODES).size).toBe(GLYPH_ATLAS_ERROR_CODES.length);
  });

  it('exposes the atlas bytes as plain RGBA without choosing a transport', () => {
    const descriptor = bake({ text: 'Hi' });

    expect(descriptor.atlas.pixelFormat).toBe('rgba8');
    expect(descriptor.pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(descriptor.pixels.length).toBe(descriptor.atlas.widthPx * descriptor.atlas.heightPx * 4);
    expect(descriptor.atlas.bytesPerRow).toBe(descriptor.atlas.widthPx * 4);
    expect(descriptor.pixels.buffer).toBeInstanceOf(ArrayBuffer);
    expect(descriptor.pixels.some((byte) => byte !== 0)).toBe(true);
  });

  it('records the face it baked with and the probes that proved it', () => {
    const descriptor = bake({ text: 'Hi', face: { family: 'Editor Sans', weight: 700, style: 'italic' } });

    expect(descriptor.face).toMatchObject({
      requestedFamily: 'Editor Sans', weight: 700, style: 'italic', fontSizePx: 48, substituted: false,
    });
    expect(descriptor.face.cssFont).toBe('italic 700 48px "Editor Sans"');
    expect(descriptor.face.probes.map((probe) => probe.probeFamily)).toEqual(['monospace', 'serif', 'sans-serif']);
    expect(descriptor.face.probes.every((probe) => probe.participated)).toBe(true);
  });

  it('derives line metrics from the face and honours an explicit line height', () => {
    const base = bake({ text: 'Hi' });
    expect(base.metrics.ascentPx).toBe(38.88);
    expect(base.metrics.descentPx).toBe(9.12);
    expect(base.metrics.baselinePx).toBe(base.metrics.ascentPx);
    expect(base.metrics.lineHeightPx).toBe(48);

    expect(bake({ text: 'Hi', lineHeightPx: 72 }).metrics.lineHeightPx).toBe(72);
  });

  it('places every glyph inside the atlas with a pen-relative origin', () => {
    const descriptor = bake({ text: 'Hello world', paddingPx: 2 });

    expect(descriptor.atlas.paddingPx).toBe(2);
    for (const glyph of descriptor.glyphs) {
      expect(glyph.xPx + glyph.widthPx).toBeLessThanOrEqual(descriptor.atlas.widthPx);
      expect(glyph.yPx + glyph.heightPx).toBeLessThanOrEqual(descriptor.atlas.heightPx);
      if (glyph.widthPx > 0) {
        expect(glyph.originXPx).toBeGreaterThanOrEqual(0);
        expect(glyph.originYPx).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The invariant the whole line-mask design exists to establish, asserted where it is cheapest to
   * read. A line's advance is the width the engine returned for the very text the engine then drew,
   * so there is no second measurement for it to differ from — under kerning, under a face that
   * joins, under any shaping at all.
   */
  it('reports a zero shaping residual because one measurement produced both', () => {
    for (const descriptor of [
      bake({ text: 'abc' }),
      bakeGlyphAtlas(
        { text: 'AV Wa To', face: { family: 'Editor Sans' }, fontSizePx: 48 },
        { surface: createKerningSurface() },
      ),
      cursive({ text: ARABIC_REPEATED }),
    ]) {
      expect(descriptor.metrics.shapingResidualPx).toBe(0);
      expect(descriptor.layout.cellAdvanceLayout).toBe('reproduces');
      expect(descriptor.layout.refusal).toEqual({
        shapingCrossesClusters: false, directionNeedsBidi: false,
      });
      for (const line of descriptor.layout.lines) {
        expect(line.shapingResidualPx).toBe(0);
        expect(line.measuredWidthPx).toBe(line.advanceWidthPx);
      }
    }
    expect(bake({ text: 'abc' }).metrics.runAdvanceWidthPx).toBe(74.88);
  });

  /**
   * One cell per line, and the cell IS the line. A line draws it at its own left edge, because the
   * mask already contains every position inside the line: visual order, letter spacing and
   * justification were applied by the engine that rasterized it.
   */
  it('draws each line as exactly one cell placed at the line origin', () => {
    const descriptor = bake({ text: 'first line\nsecond line' });

    expect(cellTextsOf(descriptor)).toEqual(['first line', 'second line']);
    expect(lineTextsOf(descriptor)).toEqual(['first line', 'second line']);
    for (const line of descriptor.layout.lines) {
      expect(line.glyphs.length).toBe(1);
      expect(line.penXPx).toEqual([0]);
    }
  });

  /**
   * The cell list is what `crates/osg-scene/src/glyph/validate.rs` re-derives its ordering rule
   * against: strictly increasing by text, then direction, then advance.
   *
   * It is a TRIPLE and not the text alone because one line's text can legitimately appear twice in
   * a document with a different picture each time — justified to fill the wrap width in the middle
   * of a block, and unjustified as the last line of one. Keying on the text would force the atlas to
   * describe one of those as the other.
   */
  it('keeps the cells strictly ordered by text, direction and advance', () => {
    const repeated = 'aa bb aa bb';
    for (const descriptor of [
      bake({ text: 'Hello world' }),
      cursive({ text: ARABIC_REPEATED }),
      bake({ text: repeated, maxWidthPx: 150, textAlign: 'justify' }),
    ]) {
      const cells = descriptor.glyphs;
      for (const [index, glyph] of cells.entries()) {
        if (index > 0) {
          const previous = cells[index - 1];
          // `<` on a JavaScript string is a UTF-16 code unit comparison, which is the comparison
          // Rust makes with `encode_utf16().cmp(...)`, so strictness here is strictness there.
          const ordered = previous.cluster < glyph.cluster
            || (previous.cluster === glyph.cluster
              && previous.advanceWidthPx < glyph.advanceWidthPx);
          expect(ordered, `${previous.cluster} then ${glyph.cluster}`).toBe(true);
        }
        expect(glyph.codePoints).toEqual([...glyph.cluster].map((character) => character.codePointAt(0)));
        expect(glyph.codePoints.length).toBeLessThanOrEqual(GLYPH_ATLAS_LIMITS.maxCellCodePoints);
      }
    }

    // The case the triple exists for: the same text at two advances, on one page, in one order.
    // `aa bb` wraps to two lines; the first is justified out to the wrap width and the last, which
    // CSS never justifies, keeps its natural one.
    const justified = bake({ text: repeated, maxWidthPx: 150, textAlign: 'justify' });
    const sameText = justified.glyphs.filter((glyph) => glyph.cluster === 'aa bb');
    expect(sameText.length).toBe(2);
    expect(sameText[0].advanceWidthPx).toBeLessThan(sameText[1].advanceWidthPx);
  });
});

describe('bakeGlyphAtlas determinism', () => {
  it('produces byte-identical descriptors for repeated bakes', () => {
    const request = { text: `${VIETNAMESE} ${KOREAN}`, fontSizePx: 42, lineHeightPx: 60, paddingPx: 2 };
    const first = bake(request);
    const second = bake(request);

    expect(second.contentHash).toBe(first.contentHash);
    expect(second.glyphs).toEqual(first.glyphs);
    expect(second.metrics).toEqual(first.metrics);
    expect(second.atlas).toEqual(first.atlas);
    expect(second.pixels).toEqual(first.pixels);
  });

  /**
   * A cell is a line, so the set that has to pack identically is the set of distinct LINES, and the
   * order that must not matter is the order the cues carrying them arrive in.
   */
  it('packs the same line set identically regardless of the cue order it arrives in', () => {
    const forward = bakeCues({ texts: ['abc abc', 'one two', 'three'] });
    const reversed = bakeCues({ texts: ['three', 'one two', 'abc abc'] });

    expect(forward.pages.length).toBe(1);
    expect(cellTextsOf(reversed.pages[0])).toEqual(cellTextsOf(forward.pages[0]));
    expect(reversed.pages[0].glyphs).toEqual(forward.pages[0].glyphs);
    expect(reversed.pages[0].atlas).toEqual(forward.pages[0].atlas);
    expect(reversed.pages[0].pixels).toEqual(forward.pages[0].pixels);
  });

  it('changes the content hash when any input that affects pixels changes', () => {
    const base = bake({ text: 'abc' });

    expect(bake({ text: 'abd' }).contentHash).not.toBe(base.contentHash);
    expect(bake({ text: 'abc', fontSizePx: 49 }).contentHash).not.toBe(base.contentHash);
    expect(bake({ text: 'abc', paddingPx: 3 }).contentHash).not.toBe(base.contentHash);
    expect(bake({ text: 'abc', face: { family: 'Editor Sans', weight: 700 } }).contentHash).not.toBe(base.contentHash);
  });

  /**
   * A change detector over the whole pipeline, and the reason it is a list of literals.
   *
   * `contentHash` folds the cell table, the packing, the pixels and every layout the page carries,
   * so any change to any of them moves a hash here. It does not certify that the CURRENT bytes are
   * right — nothing self-referential could — it certifies that a change to them is deliberate, which
   * is what stops a refactor from quietly moving a subtitle by a pixel.
   */
  it('bakes each request to the same bytes on every run', () => {
    const golden = [
      [{ text: 'Hello world' }, 'd29377c4'],
      [{ text: 'abc' }, '20671431'],
      [{ text: 'aa bb cc', fontSizePx: 50, maxWidthPx: 78 }, 'd42a8586'],
      [{ text: `${VIETNAMESE} ${KOREAN}`, fontSizePx: 42, lineHeightPx: 60, paddingPx: 2 }, '8cc593d1'],
      [{ text: 'aa (bb) cc' }, '3f48d28d'],
      [{ text: 'a\nb' }, '97992b12'],
      [{ text: 'hello world', textTransform: 'capitalize' }, '8196ac04'],
      [{ text: 'aa bb cc', maxWidthPx: 200, textAlign: 'justify' }, 'db32717a'],
      [{ text: ARABIC }, 'e40ff658'],
      [{ text: 'Straße', textTransform: 'uppercase', letterSpacingPx: 3 }, 'd9ed6e61'],
    ];

    for (const [request, contentHash] of golden) {
      expect(bake(request).contentHash, JSON.stringify(request)).toBe(contentHash);
    }
  });

  // Extended to every module the baker was split across. The split is what keeps `glyphAtlas.js`
  // inside the 600-line ceiling while it grew a shaping pass and a cell resolver, and a determinism
  // rule that only covered the file the code used to live in would have stopped proving anything.
  it('contains no clock or randomness in its source', () => {
    for (const module of [
      'glyphAtlas', 'glyphAtlasCells', 'glyphAtlasCore', 'glyphAtlasShaping', 'glyphAtlasSurface',
    ]) {
      const source = readFileSync(resolve(process.cwd(), `src/platform/${module}.js`), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      for (const forbidden of ['Math.random', 'Date', 'performance.now', 'getRandomValues', 'crypto']) {
        expect(source, `${module}.js`).not.toContain(forbidden);
      }
    }
  });
});

describe('bakeGlyphAtlas bounds', () => {
  it('rejects text longer than the code point limit instead of truncating', () => {
    const text = 'a'.repeat(GLYPH_ATLAS_LIMITS.maxTextCodePoints + 1);

    expect(codeOf(() => bake({ text }))).toBe('glyphAtlasTextTooLong');
    // A long cue that wraps, which is what a real one is: every line is its own cell and every
    // cell fits an atlas. The ceiling it meets first is `maxLayoutLines`, not the cell size.
    expect(() => bake({ text: 'word '.repeat(200).trimEnd(), maxWidthPx: 500 })).not.toThrow();
  });

  /**
   * A cell is a whole line, so a line wider than the largest atlas is a line that cannot be
   * rasterized at all. Wrapping is what keeps a real cue below it; `wordWrap: false` is CSS
   * `nowrap`, which genuinely has no wrap width, so a long enough run of it is refused.
   *
   * This is a bound the per-cluster cell did not have, and it is named rather than hidden.
   */
  it('rejects a single line too wide for the largest atlas', () => {
    const long = 'a'.repeat(1_000);

    expect(codeOf(() => bake({ text: long, wordWrap: false }))).toBe('glyphAtlasTooLarge');
    expect(() => bake({ text: long, maxWidthPx: 500 })).not.toThrow();
  });

  it('rejects more distinct lines than one atlas may hold', () => {
    const texts = Array.from(
      { length: GLYPH_ATLAS_LIMITS.maxGlyphCount + 1 },
      (_unused, index) => `line ${index}`
    );

    // Each cue is its own line, so this is a paging decision rather than a refusal: the run that
    // does not fit the open page opens the next one.
    expect(bakeCues({ texts }).pages.length).toBe(2);
  });

  it('rejects a combining-mark bomb inside a single cluster', () => {
    const zalgo = `a${ACUTE.repeat(GLYPH_ATLAS_LIMITS.maxClusterCodePoints)}`;

    expect(codeOf(() => bake({ text: zalgo }))).toBe('glyphAtlasClusterTooLong');
    expect(() => bake({ text: `a${ACUTE.repeat(GLYPH_ATLAS_LIMITS.maxClusterCodePoints - 1)}` })).not.toThrow();
  });

  it('rejects glyph cells that cannot fit the maximum atlas dimension', () => {
    const code = codeOf(() => bake({
      text: 'Wide',
      face: { family: 'Giant' },
      fontSizePx: GLYPH_ATLAS_LIMITS.maxFontSizePx,
    }));

    expect(code).toBe('glyphAtlasTooLarge');
  });

  it('rejects malformed requests with a typed error', () => {
    expect(codeOf(() => bake({ text: 42 }))).toBe('glyphAtlasInvalidRequest');
    expect(codeOf(() => bake({ text: 'a', fontSizePx: 0 }))).toBe('glyphAtlasInvalidRequest');
    expect(codeOf(() => bake({ text: 'a', fontSizePx: Number.NaN }))).toBe('glyphAtlasInvalidRequest');
    expect(codeOf(() => bake({ text: 'a', fontSizePx: GLYPH_ATLAS_LIMITS.maxFontSizePx + 1 }))).toBe('glyphAtlasInvalidRequest');
    expect(codeOf(() => bake({ text: 'a', paddingPx: 1.5 }))).toBe('glyphAtlasInvalidRequest');
    expect(codeOf(() => bake({ text: 'a', lineHeightPx: -1 }))).toBe('glyphAtlasInvalidRequest');
    expect(codeOf(() => bake({ text: 'a', face: { family: 'Editor Sans', weight: 0 } }))).toBe('glyphAtlasInvalidRequest');
    expect(codeOf(() => bake({ text: 'a', face: { family: 'Editor Sans', style: 'slanted' } }))).toBe('glyphAtlasInvalidRequest');
  });

  it('refuses a family name that could escape the CSS font shorthand', () => {
    for (const family of ['Evil", monospace; color: red', 'A\\B', 'a{b}', 'x;y', '', 'a'.repeat(65)]) {
      expect(codeOf(() => bake({ text: 'a', face: { family } }))).toBe('glyphAtlasInvalidRequest');
    }
  });

  it('rejects a surface that does not implement the measurement contract', () => {
    expect(codeOf(() => bakeGlyphAtlas(
      { text: 'a', face: { family: 'Editor Sans' }, fontSizePx: 48 },
      { surface: { measure: () => ({}) } }
    ))).toBe('glyphAtlasInvalidRequest');
  });

  it('rejects a surface whose metrics are incomplete', () => {
    const surface = { ...createFakeSurface(), measure: () => ({ width: 10 }) };

    expect(codeOf(() => bakeGlyphAtlas(
      { text: 'a', face: { family: 'Editor Sans' }, fontSizePx: 48 },
      { surface }
    ))).toBe('glyphAtlasMetricsUnavailable');
  });
});

/**
 * A cell is a whole shaped line, so what this suite proves is that the LINE survives: the text that
 * reaches the raster is the text that went in, code point for code point, whatever script it is
 * written in and however it is normalized. Cluster integrity is still this module's job in one
 * place — line breaking — and that is asserted directly rather than through a cell table.
 */
describe('bakeGlyphAtlas unicode coverage', () => {
  it('rasterizes each script as one line cell carrying the text verbatim', () => {
    for (const text of [
      VIETNAMESE, VIETNAMESE.normalize('NFD'), KOREAN, KOREAN.normalize('NFD'), ARABIC, HEBREW,
    ]) {
      const descriptor = bake({ text });

      expect(cellTextsOf(descriptor)).toEqual([text]);
      expect(descriptor.glyphs[0].codePoints)
        .toEqual([...text].map((character) => character.codePointAt(0)));
      expect(lineTextsOf(descriptor)).toEqual([text]);
    }
  });

  it('measures a decomposed run the same as its precomposed form', () => {
    const composed = bake({ text: VIETNAMESE });
    const decomposed = bake({ text: VIETNAMESE.normalize('NFD') });

    // Combining marks carry no advance, so the decomposed run measures the same width.
    expect(decomposed.metrics.runAdvanceWidthPx).toBe(composed.metrics.runAdvanceWidthPx);
    expect(decomposed.layout.lines[0].advanceWidthPx).toBe(composed.layout.lines[0].advanceWidthPx);
  });

  it('never breaks a line inside a grapheme cluster', () => {
    // Each Latin cluster advances 24.96px, so this width fits two of them and forces a break; the
    // clusters are two code points each, which is what a naive break would split.
    const descriptor = bake({ text: `e${ACUTE}x e${ACUTE}x e${ACUTE}x`, maxWidthPx: 80 });

    expect(lineTextsOf(descriptor)).toEqual([`e${ACUTE}x`, `e${ACUTE}x`, `e${ACUTE}x`]);
    for (const text of lineTextsOf(descriptor)) {
      expect(text.startsWith(ACUTE), 'a line may not begin with a combining mark').toBe(false);
    }
  });

  it('treats a ZWJ emoji sequence as one unbreakable unit', () => {
    const descriptor = bake({ text: FAMILY_EMOJI, requireExactFace: false });

    expect(descriptor.atlas.glyphCount).toBe(1);
    expect(descriptor.glyphs[0].cluster).toBe(FAMILY_EMOJI);
    expect(descriptor.glyphs[0].codePoints.length).toBe(7);
  });

  it('takes each cell direction from the paragraph its line belongs to', () => {
    const arabic = bake({ text: ARABIC });
    const hebrew = bake({ text: HEBREW });
    const mixed = bake({ text: `ok ${ARABIC}` });

    // A cell is a whole line and its ink is already in visual order, so `direction` reports which
    // way the paragraph runs rather than classifying a character. It is the direction the line was
    // measured and drawn under, which is the only thing a consumer could act on.
    expect(arabic.glyphs.every((glyph) => glyph.direction === 'rtl')).toBe(true);
    expect(arabic.metrics.baseDirection).toBe('rtl');
    expect(hebrew.glyphs.every((glyph) => glyph.direction === 'rtl')).toBe(true);
    expect(hebrew.metrics.baseDirection).toBe('rtl');
    // First strong character wins, exactly as UAX #9 P2/P3 resolves it.
    expect(mixed.metrics.baseDirection).toBe('ltr');
    expect(mixed.glyphs.every((glyph) => glyph.direction === 'ltr')).toBe(true);
  });

  it('bakes an empty atlas for empty text while still verifying the face', () => {
    const descriptor = bake({ text: '' });

    expect(descriptor.atlas).toMatchObject({ widthPx: 0, heightPx: 0, glyphCount: 0 });
    expect(descriptor.glyphs).toEqual([]);
    expect(descriptor.pixels.length).toBe(0);
    expect(descriptor.metrics.runAdvanceWidthPx).toBe(0);
    expect(descriptor.metrics.shapingResidualPx).toBe(0);
    expect(descriptor.metrics.baseDirection).toBe('ltr');
    expect(descriptor.metrics.lineHeightPx).toBe(48);
    expect(codeOf(() => bake({ text: '', face: { family: 'Missing Face' } }))).toBe('glyphAtlasFaceUnavailable');
  });

  it('keeps a whitespace-only line as an inkless cell that still stages', () => {
    const descriptor = bake({ text: '  \t\n ' });

    // Trailing whitespace hangs outside the alignment box in CSS, so a line that ENDS in it does not
    // rasterize it. A line made of nothing else keeps it, because `osg_compositor::CueRun::validate`
    // refuses a run that places no cell at all — stripping this line bare would turn a blank
    // subtitle line into a refused export.
    expect(descriptor.atlas).toMatchObject({ widthPx: 0, heightPx: 0 });
    expect(descriptor.pixels.length).toBe(0);
    expect(cellTextsOf(descriptor)).toEqual([' ', '  \t']);
    expect(descriptor.glyphs.every((glyph) => glyph.widthPx === 0 && glyph.heightPx === 0)).toBe(true);
    expect(descriptor.glyphs.every((glyph) => glyph.substituted === false)).toBe(true);
    expect(descriptor.layout.lines.every((line) => line.glyphs.length === 1)).toBe(true);
    expect(descriptor.metrics.baseDirection).toBe('ltr');
  });
});

describe('bakeGlyphAtlas face verification', () => {
  it('rejects a face the engine would not use at all', () => {
    expect(codeOf(() => bake({ text: 'Hello', face: { family: 'Missing Face' } }))).toBe('glyphAtlasFaceUnavailable');
  });

  it('rejects a face the engine substitutes for part of the text', () => {
    // "Latin Only" covers Basic Latin, so the Vietnamese clusters fall back to a generic.
    expect(codeOf(() => bake({ text: 'Tiếng Việt', face: { family: 'Latin Only' } }))).toBe('glyphAtlasFaceSubstituted');
    // Emoji fall past every generic to the last-resort face.
    expect(codeOf(() => bake({ text: 'hi 😀', face: { family: 'Editor Sans' } }))).toBe('glyphAtlasFaceSubstituted');
  });

  it('records substitution on the line that carries the uncovered character', () => {
    const descriptor = bake({ text: 'Tiếng Việt', face: { family: 'Latin Only' }, requireExactFace: false });

    // Substitution is probed PER GRAPHEME even though the raster is per line. It has to be: a line
    // of Latin with one uncovered character in it is drawn from the requested face nearly
    // everywhere, so probing the line as a whole would report the whole thing as covered and the
    // fallback would go unreported. This is the check that found 88 of 115 families substituted.
    expect(descriptor.face.substituted).toBe(true);
    expect(cellTextsOf(descriptor)).toEqual(['Tiếng Việt']);
    expect(descriptor.glyphs[0].substituted).toBe(true);

    const covered = bake({ text: 'Tieng Viet', face: { family: 'Latin Only' } });
    expect(covered.face.substituted).toBe(false);
    expect(covered.glyphs[0].substituted).toBe(false);
  });

  it('bakes different pixels for a substituted glyph than for a covered one', () => {
    const substituted = bake({ text: 'ế', face: { family: 'Latin Only' }, requireExactFace: false });
    const covered = bake({ text: 'ế', face: { family: 'Editor Sans' } });

    expect(substituted.contentHash).not.toBe(covered.contentHash);
    expect(substituted.pixels).not.toEqual(covered.pixels);
  });

  it('does not flag a face that merely coincides with one generic', () => {
    const faces = new Map(DEFAULT_FACES);
    // Same advance as `monospace`, different from `serif` and `sans-serif`.
    faces.set('twin', defineFace('twin', 0.6, NON_EMOJI, 0.7, 0.3));
    const descriptor = bake({ text: 'Hello', face: { family: 'Twin' } }, { faces });

    expect(descriptor.face.substituted).toBe(false);
    expect(descriptor.face.probes.filter((probe) => probe.participated).length).toBe(2);
  });

  it('fails closed when the surface cannot tell faces apart', () => {
    const faces = new Map(DEFAULT_FACES);
    for (const generic of ['monospace', 'serif', 'sans-serif']) {
      faces.set(generic, defineFace(generic, 0.5, NON_EMOJI));
    }

    expect(codeOf(() => bake({ text: 'Hello' }, { faces }))).toBe('glyphAtlasFaceUnverifiable');
  });

  it('lets document.fonts.check veto a face the metrics accepted', () => {
    expect(codeOf(() => bake({ text: 'Hello' }, { isFaceLoaded: () => false }))).toBe('glyphAtlasFaceLoading');
    expect(() => bake({ text: 'Hello' }, { isFaceLoaded: () => true })).not.toThrow();
    // An unknown answer must not override a measured result in either direction.
    expect(() => bake({ text: 'Hello' }, { isFaceLoaded: () => null })).not.toThrow();
    expect(codeOf(() => bake({ text: 'Hello', face: { family: 'Missing Face' } }, { isFaceLoaded: () => true })))
      .toBe('glyphAtlasFaceUnavailable');
  });
});

describe('createCanvas2dMeasurementSurface', () => {
  it('fails closed where no 2D context exists, which is the jsdom case', () => {
    expect(codeOf(() => createCanvas2dMeasurementSurface())).toBe('glyphAtlasSurfaceUnavailable');
    expect(codeOf(() => bakeGlyphAtlas({ text: 'a', face: { family: 'Editor Sans' }, fontSizePx: 48 })))
      .toBe('glyphAtlasSurfaceUnavailable');
  });
});
