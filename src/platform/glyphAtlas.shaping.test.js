import { describe, expect, it } from 'vitest';

import { GLYPH_ATLAS_ERROR_CODES, GLYPH_ATLAS_LIMITS, bakeGlyphAtlas } from './glyphAtlas';
import {
  ACUTE,
  ADVANCE_PX,
  ARABIC,
  FAMILY_EMOJI,
  HEBREW,
  SHAPED_SIZE_PX,
  clustersOf,
  codeOf,
  createKerningSurface,
  lineTextsOf,
  shape,
} from './glyphAtlasTestFont';

/**
 * The shaping half of the baker: text transform, line breaking, letter spacing, line height and
 * justification. The fake font model these bake against — and the limits of what it can prove —
 * are documented on `glyphAtlasTestFont.js`.
 */

describe('bakeGlyphAtlas line breaking', () => {
  it('breaks at word boundaries using the measured advances', () => {
    const descriptor = shape({ text: 'aa bb cc', maxWidthPx: ADVANCE_PX * 3 });

    expect(lineTextsOf(descriptor)).toEqual(['aa ', 'bb ', 'cc']);
    // Trailing spaces hang past the wrap width, so they are not part of a line's width.
    expect(descriptor.layout.lines.map((line) => line.advanceWidthPx)).toEqual([52, 52, 52]);
    expect(descriptor.layout.widthPx).toBe(52);
    expect(descriptor.layout.lineCount).toBe(3);
    expect(Object.isFrozen(descriptor.layout.lines[0])).toBe(true);
  });

  it('leaves a word whole while it fits and splits one only when it cannot', () => {
    expect(lineTextsOf(shape({ text: 'aa bb', maxWidthPx: ADVANCE_PX * 3 })))
      .toEqual(['aa ', 'bb']);
    // No break opportunity exists inside a single word, so the only break left is a cluster one.
    expect(lineTextsOf(shape({ text: 'abcdefgh', maxWidthPx: ADVANCE_PX * 3 })))
      .toEqual(['abc', 'def', 'gh']);
    // The long word still starts on a line of its own rather than dragging the short one with it.
    expect(lineTextsOf(shape({ text: 'ab cdefgh', maxWidthPx: ADVANCE_PX * 3 })))
      .toEqual(['ab ', 'cde', 'fgh']);
  });

  it('never splits a grapheme cluster or an emoji sequence', () => {
    const combining = shape({ text: `abc${ACUTE}`, maxWidthPx: ADVANCE_PX * 2 });
    expect(lineTextsOf(combining)).toEqual(['ab', `c${ACUTE}`]);

    const emoji = shape({
      text: `${FAMILY_EMOJI}${FAMILY_EMOJI}`,
      maxWidthPx: SHAPED_SIZE_PX * 5,
      requireExactFace: false,
    });
    expect(lineTextsOf(emoji)).toEqual([FAMILY_EMOJI, FAMILY_EMOJI]);
    // One cell, referenced twice: an emergency break still lands between clusters, never inside one.
    expect(emoji.atlas.glyphCount).toBe(1);
    expect(emoji.glyphs[0].codePoints.length).toBe(7);
    expect(emoji.layout.lines.map((line) => line.glyphs)).toEqual([[0], [0]]);
  });

  it('honours hard breaks, including a CR LF pair and a blank paragraph', () => {
    expect(lineTextsOf(shape({ text: 'a\r\nb' }))).toEqual(['a', 'b']);

    const blank = shape({ text: 'a\n\nb' });
    expect(lineTextsOf(blank)).toEqual(['a', '', 'b']);
    expect(blank.layout.lines[1]).toMatchObject({ advanceWidthPx: 0, measuredWidthPx: 0, glyphs: [] });
    expect(blank.layout.lines.every((line) => line.endsParagraph)).toBe(true);
  });

  it('does not wrap at all when wordWrap is off, which is the shipped nowrap', () => {
    const wrapped = shape({ text: 'aa bb cc', maxWidthPx: ADVANCE_PX * 3 });
    const nowrap = shape({ text: 'aa bb cc', maxWidthPx: ADVANCE_PX * 3, wordWrap: false });

    expect(wrapped.layout.lineCount).toBe(3);
    expect(lineTextsOf(nowrap)).toEqual(['aa bb cc']);
    expect(nowrap.layout.lines[0].advanceWidthPx).toBe(ADVANCE_PX * 8);
    // A hard break is not wrapping, so it survives nowrap exactly as it does in CSS.
    expect(lineTextsOf(shape({ text: 'aa\nbb', maxWidthPx: 1, wordWrap: false }))).toEqual(['aa', 'bb']);
  });

  it('leaves maxLines inert, because the shipped renderer never applied it', () => {
    const request = { text: 'aa bb cc dd', maxWidthPx: ADVANCE_PX * 3 };
    const capped = shape({ ...request, maxLines: 1 });
    const uncapped = shape(request);

    expect(uncapped.layout.lineCount).toBe(4);
    expect(capped.layout).toEqual(uncapped.layout);
    expect(capped.contentHash).toBe(uncapped.contentHash);
  });
});

describe('bakeGlyphAtlas shaping inputs', () => {
  it('applies textTransform before segmentation, so the baked clusters change', () => {
    const plain = shape({ text: 'straße' });
    const upper = shape({ text: 'straße', textTransform: 'uppercase' });

    expect(clustersOf(plain)).toEqual(['a', 'e', 'r', 's', 't', 'ß']);
    // The sharp s uppercases to two letters, so the cluster count and the run width both change.
    expect(lineTextsOf(upper)).toEqual(['STRASSE']);
    expect(clustersOf(upper)).toEqual(['A', 'E', 'R', 'S', 'T']);
    expect(upper.metrics.runAdvanceWidthPx).toBe(ADVANCE_PX * 7);
    expect(plain.metrics.runAdvanceWidthPx).toBe(ADVANCE_PX * 6);
    expect(upper.layout.textTransform).toBe('uppercase');

    expect(lineTextsOf(shape({ text: 'ABC', textTransform: 'lowercase' }))).toEqual(['abc']);
    expect(lineTextsOf(shape({ text: 'hello world', textTransform: 'capitalize' })))
      .toEqual(['Hello World']);
    // The shipped renderer transforms twice — in JavaScript and again in CSS — and the JavaScript
    // pass lowercases the tail of every word. Reproduced, not corrected: this is what existing
    // projects look like, and changing it needs a release note rather than a quiet fix.
    expect(lineTextsOf(shape({ text: 'iPhone X', textTransform: 'capitalize' })))
      .toEqual(['Iphone X']);
  });

  it('carries letterSpacing into the metrics and into every pen position', () => {
    const spaced = shape({ text: 'ab', letterSpacingPx: 4 });

    expect(spaced.metrics.letterSpacingPx).toBe(4);
    expect(spaced.layout.letterSpacingPx).toBe(4);
    // Applied after every cluster including the last, the way a browser applies letter-spacing.
    expect(spaced.layout.lines[0].penXPx).toEqual([0, 30]);
    expect(spaced.layout.lines[0].advanceWidthPx).toBe(60);
    // The raster never changes: spacing is layout, so the same two cells are baked either way.
    expect(spaced.pixels).toEqual(shape({ text: 'ab' }).pixels);

    const plain = shape({ text: 'abc' });
    expect(plain.metrics.letterSpacingPx).toBe(0);
    // With no spacing the pen positions are exactly the advance accumulation the compositor
    // performs today, so the emitted layout and the shipped loop agree cell for cell.
    expect(plain.layout.lines[0].penXPx).toEqual([0, ADVANCE_PX, ADVANCE_PX * 2]);

    // Spacing changes where a line breaks, which is why it has to be applied before wrapping.
    expect(lineTextsOf(shape({ text: 'aa bb', maxWidthPx: ADVANCE_PX * 5 }))).toEqual(['aa bb']);
    expect(lineTextsOf(shape({ text: 'aa bb', maxWidthPx: ADVANCE_PX * 5, letterSpacingPx: 10 })))
      .toEqual(['aa ', 'bb']);
  });

  it('carries the line height into every baseline', () => {
    const natural = shape({ text: 'a\nb' });
    expect(natural.metrics.lineHeightPx).toBe(50);
    expect(natural.metrics.baselinePx).toBe(40.5);
    expect(natural.layout.lines.map((line) => line.baselineYPx)).toEqual([40.5, 90.5]);
    expect(natural.layout.heightPx).toBe(100);

    const tall = shape({ text: 'a\nb', lineHeightPx: 72 });
    expect(tall.metrics.lineHeightPx).toBe(72);
    expect(tall.layout.lines.map((line) => line.baselineYPx)).toEqual([40.5, 112.5]);
    expect(tall.layout.heightPx).toBe(144);
  });

  it('justifies every line but the last, and only when asked to', () => {
    const width = ADVANCE_PX * 5 + 30;
    const justified = shape({ text: 'aa bb cc', maxWidthPx: width, textAlign: 'justify' });

    expect(lineTextsOf(justified)).toEqual(['aa bb ', 'cc']);
    // One interior gap absorbs all 30px of slack, so the line fills the wrap width exactly.
    expect(justified.layout.lines[0].justificationPx).toBe(30);
    expect(justified.layout.lines[0].advanceWidthPx).toBe(width);
    expect(justified.layout.lines[0].penXPx).toEqual([0, 26, 52, 108, 134, 160]);
    // The last line of a paragraph is never justified, exactly as CSS leaves it.
    expect(justified.layout.lines[1]).toMatchObject({ justificationPx: 0, advanceWidthPx: 52 });

    const ragged = shape({ text: 'aa bb cc', maxWidthPx: width });
    expect(ragged.layout.textAlign).toBe('left');
    expect(ragged.layout.lines.every((line) => line.justificationPx === 0)).toBe(true);
    expect(ragged.layout.lines[0].advanceWidthPx).toBe(ADVANCE_PX * 5);
  });
});

describe('bakeGlyphAtlas layout honesty', () => {
  it('still refuses cell-advance layout for a right-to-left run', () => {
    const arabic = shape({ text: ARABIC });

    expect(arabic.metrics.baseDirection).toBe('rtl');
    expect(arabic.layout.cellAdvanceLayout).toBe('refused');
    expect(arabic.layout.refusal).toEqual({ shapingCrossesClusters: false, directionNeedsBidi: true });

    // First-strong says this run is left-to-right, and it still needs reordering, so wrapping it
    // does not make its cell order visual order.
    const mixed = shape({ text: `ok ${HEBREW}`, maxWidthPx: ADVANCE_PX * 3 });
    expect(mixed.metrics.baseDirection).toBe('ltr');
    expect(mixed.layout.lineCount).toBeGreaterThan(1);
    expect(mixed.layout.refusal.directionNeedsBidi).toBe(true);

    const clean = shape({ text: 'abc' });
    expect(clean.layout.cellAdvanceLayout).toBe('reproduces');
    expect(clean.layout.refusal).toEqual({ shapingCrossesClusters: false, directionNeedsBidi: false });
  });

  it('reports a per-line residual when shaping crosses cluster boundaries', () => {
    const surface = createKerningSurface();
    const kerned = bakeGlyphAtlas(
      { text: 'aa bb', face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX, maxWidthPx: ADVANCE_PX * 3 },
      { surface }
    );

    expect(lineTextsOf(kerned)).toEqual(['aa ', 'bb']);
    expect(kerned.metrics.shapingResidualPx).toBe(-2);
    expect(kerned.layout.lines.map((line) => line.measuredWidthPx)).toEqual([77, 51.5]);
    expect(kerned.layout.lines.map((line) => line.shapingResidualPx)).toEqual([-1, -0.5]);
    // The refusal the Rust descriptor reaches, reached here from the same two facts.
    expect(kerned.layout.cellAdvanceLayout).toBe('refused');
    expect(kerned.layout.refusal).toEqual({ shapingCrossesClusters: true, directionNeedsBidi: false });
  });

  it('records the wrapping inputs it was given', () => {
    const descriptor = shape({ text: 'aa bb', maxWidthPx: 200, wordWrap: false, textAlign: 'right' });

    expect(descriptor.layout).toMatchObject({
      textTransform: 'none', letterSpacingPx: 0, maxWidthPx: 200, wordWrap: false, textAlign: 'right',
    });
    expect(shape({ text: 'aa bb' }).layout.maxWidthPx).toBeNull();
  });

  it('changes the content hash when any shaping input changes', () => {
    const base = shape({ text: 'aa bb', maxWidthPx: 200 });

    for (const request of [
      { maxWidthPx: ADVANCE_PX * 3 },
      { maxWidthPx: 200, letterSpacingPx: 2 },
      { maxWidthPx: 200, textAlign: 'justify' },
      { maxWidthPx: 200, wordWrap: false },
      { maxWidthPx: 200, textTransform: 'uppercase' },
    ]) {
      expect(shape({ text: 'aa bb', ...request }).contentHash, JSON.stringify(request))
        .not.toBe(base.contentHash);
    }
  });
});

describe('bakeGlyphAtlas layout bounds', () => {
  it('caps the number of laid-out lines and declares the code it fails with', () => {
    expect(GLYPH_ATLAS_ERROR_CODES).toContain('glyphAtlasLayoutTooLarge');
    expect(GLYPH_ATLAS_LIMITS.maxLayoutLines).toBe(64);

    const atCap = shape({ text: `a${'\na'.repeat(GLYPH_ATLAS_LIMITS.maxLayoutLines - 1)}` });
    expect(atCap.layout.lineCount).toBe(GLYPH_ATLAS_LIMITS.maxLayoutLines);

    expect(codeOf(() => shape({ text: 'a\n'.repeat(GLYPH_ATLAS_LIMITS.maxLayoutLines) })))
      .toBe('glyphAtlasLayoutTooLarge');
    // A wrap width small enough to put one cluster on each line reaches the same cap.
    expect(codeOf(() => shape({ text: 'a'.repeat(200), maxWidthPx: 1 })))
      .toBe('glyphAtlasLayoutTooLarge');
  });

  it('caps the total run, which the text bound already implies', () => {
    // One cluster costs at least one code point, so a run that passes `maxTextCodePoints` cannot
    // exceed `maxLayoutCells`. The bound is still enforced, and it is still asserted equal, because
    // it is what `MAX_RUN_GLYPHS` in the compositor mirrors.
    expect(GLYPH_ATLAS_LIMITS.maxLayoutCells).toBe(GLYPH_ATLAS_LIMITS.maxTextCodePoints);

    const full = shape({ text: 'a'.repeat(GLYPH_ATLAS_LIMITS.maxTextCodePoints) });
    expect(full.layout.lines).toHaveLength(1);
    expect(full.layout.lines[0].glyphs).toHaveLength(GLYPH_ATLAS_LIMITS.maxTextCodePoints);
  });

  it('rejects shaping inputs outside their bounds', () => {
    for (const request of [
      { textTransform: 'smallcaps' },
      { textTransform: null },
      { textAlign: 'end' },
      { wordWrap: 'yes' },
      { letterSpacingPx: GLYPH_ATLAS_LIMITS.minLetterSpacingPx - 1 },
      { letterSpacingPx: GLYPH_ATLAS_LIMITS.maxLetterSpacingPx + 1 },
      { letterSpacingPx: Number.NaN },
      { maxWidthPx: 0 },
      { maxWidthPx: -1 },
      { maxWidthPx: Number.POSITIVE_INFINITY },
      { maxWidthPx: GLYPH_ATLAS_LIMITS.maxLayoutWidthPx + 1 },
    ]) {
      expect(codeOf(() => shape({ text: 'a', ...request })), JSON.stringify(request))
        .toBe('glyphAtlasInvalidRequest');
    }

    for (const request of [
      { letterSpacingPx: GLYPH_ATLAS_LIMITS.minLetterSpacingPx },
      { letterSpacingPx: GLYPH_ATLAS_LIMITS.maxLetterSpacingPx },
      { maxWidthPx: GLYPH_ATLAS_LIMITS.maxLayoutWidthPx },
      { maxWidthPx: null },
    ]) {
      expect(() => shape({ text: 'a', ...request }), JSON.stringify(request)).not.toThrow();
    }
  });

  it('applies the transform before the text bound, because the transform decides the length', () => {
    const half = 'ß'.repeat(GLYPH_ATLAS_LIMITS.maxTextCodePoints / 2 + 1);

    expect(() => shape({ text: half })).not.toThrow();
    // Each sharp s uppercases to two letters, so the same input is over the bound once transformed.
    expect(codeOf(() => shape({ text: half, textTransform: 'uppercase' })))
      .toBe('glyphAtlasTextTooLong');
  });
});
