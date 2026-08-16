import { describe, expect, it } from 'vitest';

import { GLYPH_ATLAS_ERROR_CODES, GLYPH_ATLAS_LIMITS, bakeGlyphAtlas } from './glyphAtlas';
import { buildTextLayout } from './glyphAtlasShaping';
import {
  ACUTE,
  ADVANCE_PX,
  ARABIC,
  FAMILY_EMOJI,
  HEBREW,
  KOREAN,
  SHAPED_SIZE_PX,
  VIETNAMESE,
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

/**
 * Bidi. Every expectation below is written as the VISUAL string — what a reader sees from the left
 * edge of the line to the right edge — because that is what `lines[].glyphs` now carries. `reversed`
 * makes that readable in a left-to-right source file: a right-to-left word drawn left to right is
 * its own reverse.
 */
describe('bakeGlyphAtlas bidi', () => {
  const reversed = (text) => [...text].reverse().join('');
  const handled = { shapingCrossesClusters: false, directionNeedsBidi: false };

  it('leaves a run with no right-to-left content in logical order', () => {
    // The regression guard. Brackets are included deliberately: they are mirrored characters, and
    // refusing them where nothing is right-to-left would break every ordinary caption.
    for (const text of ['aa (bb) cc', VIETNAMESE, KOREAN, 'a\nb']) {
      const descriptor = shape({ text });
      expect(lineTextsOf(descriptor), text).toEqual(text.split('\n'));
      expect(descriptor.layout.cellAdvanceLayout, text).toBe('reproduces');
      expect(descriptor.layout.refusal, text).toEqual(handled);
      expect(descriptor.layout.textAlign, text).toBe('left');
    }
    const spaced = shape({ text: 'aa (bb) cc' });
    expect(spaced.layout.lines[0].penXPx)
      .toEqual([...Array(10).keys()].map((position) => position * ADVANCE_PX));
  });

  it('reverses a right-to-left run and now lets the compositor draw it', () => {
    const arabic = shape({ text: ARABIC });

    // The last letter of the word is drawn first, at pen zero, because it is the leftmost.
    expect(lineTextsOf(arabic)).toEqual([reversed(ARABIC)]);
    expect(arabic.layout.lines[0].penXPx).toEqual([0, 26, 52, 78, 104]);
    expect(arabic.layout.widthPx).toBe(ADVANCE_PX * 5);
    expect(arabic.layout.cellAdvanceLayout).toBe('reproduces');
    expect(arabic.layout.refusal).toEqual(handled);
    // CSS `start`: a right-to-left paragraph defaults to its right edge.
    expect(arabic.layout.textAlign).toBe('right');
    expect(shape({ text: ARABIC, textAlign: 'center' }).layout.textAlign).toBe('center');

    expect(lineTextsOf(shape({ text: HEBREW }))).toEqual([reversed(HEBREW)]);
  });

  it('places an embedded run of the other direction at the right end of it', () => {
    // A left-to-right paragraph: "ok" first, then the Hebrew block, which reads right to left.
    expect(lineTextsOf(shape({ text: `ok ${HEBREW}` }))).toEqual([`ok ${reversed(HEBREW)}`]);
    // A right-to-left paragraph: the Hebrew is first in reading order, so it is drawn last.
    expect(lineTextsOf(shape({ text: `${HEBREW} ok` }))).toEqual([`ok ${reversed(HEBREW)}`]);
    expect(shape({ text: `ok ${HEBREW}` }).layout.textAlign).toBe('left');
    expect(shape({ text: `${HEBREW} ok` }).layout.textAlign).toBe('right');

    // The number belongs to the right-to-left block, so it lands to the LEFT of the Hebrew word,
    // with its own digits still reading left to right.
    expect(lineTextsOf(shape({ text: `${HEBREW} 42` }))).toEqual([`42 ${reversed(HEBREW)}`]);
    expect(lineTextsOf(shape({ text: `ok ${HEBREW} 42` }))).toEqual([`ok 42 ${reversed(HEBREW)}`]);
  });

  it('separates European from Arabic numerals next to right-to-left text', () => {
    // After a Hebrew letter the digits stay European, so W5 pulls the percent sign into the number
    // and it is drawn on the number's right, exactly where it was typed.
    expect(lineTextsOf(shape({ text: `${HEBREW} 42%` }))).toEqual([`42% ${reversed(HEBREW)}`]);
    // After an Arabic letter W2 makes the same digits Arabic numbers, which W5 does not attach to,
    // so the percent sign resolves to the paragraph direction and moves to the number's LEFT.
    expect(lineTextsOf(shape({ text: `${ARABIC} 42%` }))).toEqual([`%42 ${reversed(ARABIC)}`]);
    // Arabic-Indic digits are already Arabic numbers, and keep their own order inside a left-to-
    // right paragraph rather than being reversed with the block around them.
    expect(lineTextsOf(shape({ text: 'ok ١٢٣' }))).toEqual(['ok ١٢٣']);
  });

  it('resolves neutral punctuation from the strong runs around it', () => {
    // Between two right-to-left runs the hyphen goes with them, so it stays between the two words.
    expect(lineTextsOf(shape({ text: `x ${HEBREW}-${HEBREW} y` })))
      .toEqual([`x ${reversed(HEBREW)}-${reversed(HEBREW)} y`]);
    // Between a right-to-left run and a left-to-right one it takes the PARAGRAPH direction, so the
    // same three characters land on opposite sides of the Latin word in the two paragraphs.
    expect(lineTextsOf(shape({ text: `${HEBREW} - abc` }))).toEqual([`abc - ${reversed(HEBREW)}`]);
    expect(lineTextsOf(shape({ text: `ok ${HEBREW} - abc` })))
      .toEqual([`ok ${reversed(HEBREW)} - abc`]);
  });

  it('resets a wrapped line trailing space to the paragraph level, so it hangs on the left', () => {
    const wrapped = shape({ text: `${HEBREW} ab cd`, maxWidthPx: ADVANCE_PX * 7 });

    expect(wrapped.layout.lineCount).toBe(2);
    // Without L1 the space would keep the Latin run's level and stay stranded between "ab" and the
    // next word; reset to the paragraph level it joins the right-to-left run and is drawn FIRST.
    expect(lineTextsOf(wrapped)).toEqual([` ab ${reversed(HEBREW)}`, 'cd']);
    // Hanging whitespace sits outside the alignment box, which starts at pen zero and is
    // advanceWidthPx wide — so on a right-to-left line it takes a negative pen.
    expect(wrapped.layout.lines[0].penXPx).toEqual([-26, 0, 26, 52, 78, 104, 130, 156]);
    expect(wrapped.layout.lines[0].advanceWidthPx).toBe(ADVANCE_PX * 7);
    expect(wrapped.layout.lines[1].penXPx).toEqual([0, 26]);
    expect(wrapped.layout.cellAdvanceLayout).toBe('reproduces');
  });

  it('refuses the constructs it does not implement instead of ordering them wrongly', () => {
    const refused = { shapingCrossesClusters: false, directionNeedsBidi: true };

    // Explicit embedding and override controls: X1-X8 are not implemented, in either direction of
    // text, so a run carrying one keeps logical order and says the order is not reproduced.
    const embedded = shape({ text: 'abc‫def‬' });
    expect(embedded.layout.cellAdvanceLayout).toBe('refused');
    expect(embedded.layout.refusal).toEqual(refused);
    expect(lineTextsOf(embedded)).toEqual(['abc‫def‬']);

    // Isolates: same reason.
    expect(shape({ text: `${HEBREW}⁦abc⁩` }).layout.refusal).toEqual(refused);

    // A mirrored character in a run with right-to-left content needs a glyph the atlas never baked,
    // so the run is refused rather than drawn with the wrong bracket.
    expect(shape({ text: `(${HEBREW})` }).layout.refusal).toEqual(refused);
    expect(shape({ text: `${HEBREW} <ok>` }).layout.refusal).toEqual(refused);
    // The same brackets with nothing right-to-left need no mirroring at all.
    expect(shape({ text: '(abc)' }).layout.refusal).toEqual(handled);
  });

  it('takes a forced paragraph direction, which is the seam rtlSupport lands on', () => {
    const text = 'a b ';
    const clusters = [...text];
    const unique = [...new Set(clusters)].sort();
    const layoutOf = (baseDirection) => buildTextLayout({
      text,
      clusters,
      cellIndexOf: new Map(unique.map((cluster, index) => [cluster, index])),
      advanceOf: new Map(unique.map((cluster) => [cluster, ADVANCE_PX])),
      textTransform: 'none',
      letterSpacingPx: 0,
      maxWidthPx: null,
      wordWrap: true,
      textAlign: 'left',
      lineHeightPx: 50,
      baselinePx: 40.5,
      measureLineWidth: (line) => [...line].length * ADVANCE_PX,
      runShapingResidualPx: 0,
      directionNeedsBidi: false,
      baseDirection,
      limits: GLYPH_ATLAS_LIMITS,
    });

    // Nothing in the text is right-to-left, so only the forced paragraph level moves it.
    const auto = layoutOf(null);
    expect(auto.lines[0].penXPx).toEqual([0, 26, 52, 78]);
    expect(auto.textAlign).toBe('left');

    const forced = layoutOf('rtl');
    // The two Latin letters keep their own order; the trailing space moves to the far left and
    // hangs, and the default alignment becomes the right edge.
    expect(forced.lines[0].glyphs.map((cell) => unique[cell]).join('')).toBe(' a b');
    expect(forced.lines[0].penXPx).toEqual([-26, 0, 26, 52]);
    expect(forced.lines[0].advanceWidthPx).toBe(ADVANCE_PX * 3);
    expect(forced.textAlign).toBe('right');
    expect(forced.cellAdvanceLayout).toBe('reproduces');
  });
});

describe('bakeGlyphAtlas layout honesty', () => {
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
