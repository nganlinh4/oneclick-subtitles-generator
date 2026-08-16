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
  clustersOf,
  codeOf,
  createFakeSurface,
  cursive,
  defineFace,
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

  it('reports the run advance and a shaping residual against the summed cells', () => {
    const descriptor = bake({ text: 'abc' });

    // The fake applies no kerning, so cell advances sum exactly to the run: residual is zero and a
    // real canvas is what would make it non-zero.
    expect(descriptor.metrics.runAdvanceWidthPx).toBe(74.88);
    expect(descriptor.metrics.shapingResidualPx).toBe(0);
  });

  /**
   * The cell list is what `crates/osg-scene/src/glyph/validate.rs` re-derives its ordering rule
   * against: cells are sorted by UTF-16 code unit and no two are the same text. Contextual cells
   * keep that true because a form is spelled differently from every other form of its cluster, which
   * is the whole reason the descriptor's shape did not have to change to carry them.
   */
  it('keeps the cells strictly ordered and self-describing, contextual or not', () => {
    for (const descriptor of [bake({ text: 'Hello world' }), cursive({ text: ARABIC_REPEATED })]) {
      const clusters = descriptor.glyphs.map((glyph) => glyph.cluster);

      expect(new Set(clusters).size).toBe(clusters.length);
      for (const [index, cluster] of clusters.entries()) {
        // `<` on a JavaScript string is a UTF-16 code unit comparison, which is the comparison Rust
        // makes with `encode_utf16().cmp(...)`, so strictness here is strictness there.
        if (index > 0) expect(clusters[index - 1] < cluster, cluster).toBe(true);
        expect(descriptor.glyphs[index].codePoints)
          .toEqual([...cluster].map((character) => character.codePointAt(0)));
        expect(descriptor.glyphs[index].codePoints.length)
          .toBeLessThanOrEqual(GLYPH_ATLAS_LIMITS.maxClusterCodePoints);
      }
    }
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

  it('packs the same glyph set identically regardless of the order it appears in', () => {
    const forward = bake({ text: 'abc abc' });
    const reversed = bake({ text: 'cba cba' });

    expect(clustersOf(reversed)).toEqual(clustersOf(forward));
    expect(reversed.glyphs).toEqual(forward.glyphs);
    expect(reversed.atlas).toEqual(forward.atlas);
    expect(reversed.pixels).toEqual(forward.pixels);
  });

  it('changes the content hash when any input that affects pixels changes', () => {
    const base = bake({ text: 'abc' });

    expect(bake({ text: 'abd' }).contentHash).not.toBe(base.contentHash);
    expect(bake({ text: 'abc', fontSizePx: 49 }).contentHash).not.toBe(base.contentHash);
    expect(bake({ text: 'abc', paddingPx: 3 }).contentHash).not.toBe(base.contentHash);
    expect(bake({ text: 'abc', face: { family: 'Editor Sans', weight: 700 } }).contentHash).not.toBe(base.contentHash);
  });

  /**
   * The regression guard for contextual cells, and the reason it is a list of literals.
   *
   * Every hash below was produced by the baker BEFORE it could bake a contextual form, so a run
   * whose clusters do not join has to reach the same atlas byte for byte — same cells, same
   * packing, same pixels, same layout. A face that joins is the only thing that may change.
   */
  it('bakes text that does not join to the same bytes it always did', () => {
    const golden = [
      [{ text: 'Hello world' }, 'd386bb0c'],
      [{ text: 'abc' }, 'bbd2c5ea'],
      [{ text: 'aa bb cc', fontSizePx: 50, maxWidthPx: 78 }, 'aa4eeaf8'],
      [{ text: `${VIETNAMESE} ${KOREAN}`, fontSizePx: 42, lineHeightPx: 60, paddingPx: 2 }, '98e5fb2a'],
      [{ text: 'aa (bb) cc' }, '3245e224'],
      [{ text: 'a\nb' }, '4f19578c'],
      [{ text: 'hello world', textTransform: 'capitalize' }, 'e98e286d'],
      [{ text: 'aa bb cc', maxWidthPx: 200, textAlign: 'justify' }, '972d53ee'],
      [{ text: ARABIC }, '28224bbd'],
      [{ text: 'Straße', textTransform: 'uppercase', letterSpacingPx: 3 }, 'a60e4633'],
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
    expect(() => bake({ text: 'a'.repeat(GLYPH_ATLAS_LIMITS.maxTextCodePoints) })).not.toThrow();
  });

  it('rejects more distinct glyphs than the atlas may hold', () => {
    const overLimit = Array.from(
      { length: GLYPH_ATLAS_LIMITS.maxGlyphCount + 1 },
      (_unused, index) => String.fromCodePoint(0x4e00 + index)
    ).join('');

    expect(codeOf(() => bake({ text: overLimit }))).toBe('glyphAtlasTooManyGlyphs');
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

describe('bakeGlyphAtlas unicode coverage', () => {
  it('keeps precomposed and decomposed Vietnamese in one cluster each', () => {
    const composed = bake({ text: VIETNAMESE });
    const decomposed = bake({ text: VIETNAMESE.normalize('NFD') });

    expect(clustersOf(composed)).toEqual([' ', 'T', 'V', 'g', 'i', 'n', 't', 'ế', 'ệ']);
    expect(clustersOf(decomposed)).toContain('ế'.normalize('NFD'));
    expect(decomposed.atlas.glyphCount).toBe(composed.atlas.glyphCount);
    // Combining marks carry no advance, so the decomposed run measures the same width.
    expect(decomposed.metrics.runAdvanceWidthPx).toBe(composed.metrics.runAdvanceWidthPx);
  });

  it('welds a standalone combining mark to its base', () => {
    const descriptor = bake({ text: `e${ACUTE}x` });

    expect(clustersOf(descriptor)).toEqual([`e${ACUTE}`, 'x']);
    expect(descriptor.glyphs[0].codePoints).toEqual([0x65, 0x301]);
  });

  it('treats a ZWJ emoji sequence as a single glyph cell', () => {
    const descriptor = bake({ text: FAMILY_EMOJI, requireExactFace: false });

    expect(descriptor.atlas.glyphCount).toBe(1);
    expect(descriptor.glyphs[0].cluster).toBe(FAMILY_EMOJI);
    expect(descriptor.glyphs[0].codePoints.length).toBe(7);
    expect(descriptor.glyphs[0].direction).toBe('neutral');
  });

  it('handles Korean syllables and their decomposed jamo', () => {
    const syllables = bake({ text: KOREAN });
    const jamo = bake({ text: KOREAN.normalize('NFD') });

    expect(clustersOf(syllables)).toEqual(['국', '어', '한']);
    expect(syllables.glyphs.every((glyph) => glyph.direction === 'ltr')).toBe(true);
    expect(jamo.atlas.glyphCount).toBe(3);
    expect(jamo.glyphs.every((glyph) => glyph.codePoints.length >= 2)).toBe(true);
  });

  it('marks Arabic and Hebrew clusters right-to-left and carries a base direction', () => {
    const arabic = bake({ text: ARABIC });
    const hebrew = bake({ text: HEBREW });
    const mixed = bake({ text: `ok ${ARABIC}` });

    expect(arabic.glyphs.every((glyph) => glyph.direction === 'rtl')).toBe(true);
    expect(arabic.metrics.baseDirection).toBe('rtl');
    expect(hebrew.glyphs.every((glyph) => glyph.direction === 'rtl')).toBe(true);
    expect(hebrew.metrics.baseDirection).toBe('rtl');
    // First strong character wins, exactly as UAX #9 P2/P3 would resolve it.
    expect(mixed.metrics.baseDirection).toBe('ltr');
    expect(mixed.glyphs.filter((glyph) => glyph.direction === 'rtl').length).toBe(5);
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

  it('keeps whitespace-only text as inkless cells that still carry advance', () => {
    const descriptor = bake({ text: '  \t\n ' });

    expect(descriptor.atlas).toMatchObject({ widthPx: 0, heightPx: 0 });
    expect(descriptor.pixels.length).toBe(0);
    expect(descriptor.glyphs.every((glyph) => glyph.widthPx === 0 && glyph.heightPx === 0)).toBe(true);
    expect(descriptor.glyphs.find((glyph) => glyph.cluster === ' ').advanceWidthPx).toBe(24.96);
    expect(descriptor.glyphs.every((glyph) => glyph.substituted === false)).toBe(true);
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

  it('records per-glyph substitution instead of failing when it is opted out of', () => {
    const descriptor = bake({ text: 'Tiếng Việt', face: { family: 'Latin Only' }, requireExactFace: false });

    expect(descriptor.face.substituted).toBe(true);
    const substituted = descriptor.glyphs.filter((glyph) => glyph.substituted).map((glyph) => glyph.cluster);
    expect(substituted).toEqual(['ế', 'ệ']);
    expect(descriptor.glyphs.find((glyph) => glyph.cluster === 'T').substituted).toBe(false);
    expect(descriptor.glyphs.find((glyph) => glyph.cluster === ' ').substituted).toBe(false);
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
    expect(codeOf(() => bake({ text: 'Hello' }, { isFaceLoaded: () => false }))).toBe('glyphAtlasFaceUnavailable');
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
