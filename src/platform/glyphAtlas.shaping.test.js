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
  cellTextsOf,
  codeOf,
  createKerningSurface,
  lineTextsOf,
  shape,
} from './glyphAtlasTestFont';

/**
 * The shaping half of the baker: text transform, line breaking, letter spacing, line height,
 * justification and bidi. The fake font model these bake against — and the limits of what it can
 * prove — are documented on `glyphAtlasTestFont.js`.
 *
 * A cell is one shaped LINE, so `lineTextsOf` reports the text each line was rasterized from: its
 * clusters minus the trailing breaking spaces, which hang outside the alignment box in CSS and are
 * therefore not part of the mask or its advance.
 */

describe('bakeGlyphAtlas line breaking', () => {
  it('breaks at word boundaries using the measured advances', () => {
    const descriptor = shape({ text: 'aa bb cc', maxWidthPx: ADVANCE_PX * 3 });

    // Trailing spaces hang past the wrap width, so they are neither rasterized nor measured.
    expect(lineTextsOf(descriptor)).toEqual(['aa', 'bb', 'cc']);
    expect(descriptor.layout.lines.map((line) => line.advanceWidthPx)).toEqual([52, 52, 52]);
    // Three lines with the same text, the same direction and the same advance are one cell.
    expect(cellTextsOf(descriptor)).toEqual(['aa', 'bb', 'cc']);
    expect(descriptor.layout.lines.map((line) => line.penXPx)).toEqual([[0], [0], [0]]);
    expect(descriptor.layout.widthPx).toBe(52);
    expect(descriptor.layout.lineCount).toBe(3);
    expect(Object.isFrozen(descriptor.layout.lines[0])).toBe(true);
  });

  it('leaves a word whole while it fits and splits one only when it cannot', () => {
    expect(lineTextsOf(shape({ text: 'aa bb', maxWidthPx: ADVANCE_PX * 3 })))
      .toEqual(['aa', 'bb']);
    // No break opportunity exists inside a single word, so the only break left is a cluster one.
    expect(lineTextsOf(shape({ text: 'abcdefgh', maxWidthPx: ADVANCE_PX * 3 })))
      .toEqual(['abc', 'def', 'gh']);
    // The long word still starts on a line of its own rather than dragging the short one with it.
    expect(lineTextsOf(shape({ text: 'ab cdefgh', maxWidthPx: ADVANCE_PX * 3 })))
      .toEqual(['ab', 'cde', 'fgh']);
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

    expect(cellTextsOf(plain)).toEqual(['straße']);
    // The sharp s uppercases to two letters, so the cluster count and the run width both change.
    expect(lineTextsOf(upper)).toEqual(['STRASSE']);
    expect(cellTextsOf(upper)).toEqual(['STRASSE']);
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

  it('bakes letterSpacing into the line, because the engine applies it', () => {
    const spaced = shape({ text: 'ab', letterSpacingPx: 4 });
    const plain = shape({ text: 'ab' });

    expect(spaced.metrics.letterSpacingPx).toBe(4);
    expect(spaced.layout.letterSpacingPx).toBe(4);
    // Applied after every cluster including the last, the way a browser applies letter-spacing, and
    // the advance reported is the width the engine returned with it already applied.
    expect(spaced.layout.lines[0].advanceWidthPx).toBe(60);
    expect(plain.layout.lines[0].advanceWidthPx).toBe(ADVANCE_PX * 2);

    // THE RASTER CHANGES, which it did not when a cell was a cluster. Spacing is part of what the
    // line looks like, so the line is measured and drawn with it; a mask baked without it would be
    // a picture of different text than the advance describes.
    expect(spaced.pixels).not.toEqual(plain.pixels);

    // Spacing changes where a line breaks, which is why it is applied before wrapping too.
    expect(lineTextsOf(shape({ text: 'aa bb', maxWidthPx: ADVANCE_PX * 5 }))).toEqual(['aa bb']);
    expect(lineTextsOf(shape({ text: 'aa bb', maxWidthPx: ADVANCE_PX * 5, letterSpacingPx: 10 })))
      .toEqual(['aa', 'bb']);
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

    expect(lineTextsOf(justified)).toEqual(['aa bb', 'cc']);
    // The word spacing that fills the wrap width is SOLVED FOR by measurement — one measurement at
    // zero and one at a single pixel give the exact slope — and then measured again, so the advance
    // reported is the advance of the raster that ships rather than the one that was solved for.
    expect(justified.layout.lines[0].justificationPx).toBe(30);
    expect(justified.layout.lines[0].advanceWidthPx).toBe(width);
    // The justified line and the same text unjustified are two rasters, and therefore two cells.
    expect(cellTextsOf(justified)).toEqual(['aa bb', 'cc']);
    // The last line of a paragraph is never justified, exactly as CSS leaves it.
    expect(justified.layout.lines[1]).toMatchObject({ justificationPx: 0, advanceWidthPx: 52 });

    const ragged = shape({ text: 'aa bb cc', maxWidthPx: width });
    expect(ragged.layout.textAlign).toBe('left');
    expect(ragged.layout.lines.every((line) => line.justificationPx === 0)).toBe(true);
    expect(ragged.layout.lines[0].advanceWidthPx).toBe(ADVANCE_PX * 5);
  });
});

/**
 * Bidi. What this module still decides is the PARAGRAPH LEVEL — which edge a line is anchored to
 * when the caller asked for CSS `start` — and nothing else.
 *
 * WHY THERE ARE NO VISUAL-ORDER EXPECTATIONS HERE ANY MORE. A line is rasterized once, as itself,
 * with `direction` set from that level, so the browser's own text engine applies the whole
 * Bidirectional Algorithm and the visual order is inside the mask before this module could have an
 * opinion about it. The working UAX #9 subset that used to live in `glyphAtlasBidi.js` — weak types,
 * neutrals, embedding levels, the L1 reset, the L2 reversal — is gone, because a second
 * implementation of an algorithm the engine already ran could only ever disagree with the picture
 * actually drawn.
 *
 * WHAT THIS SUITE CAN AND CANNOT PROVE. The fake font model has no glyphs to reorder, so it cannot
 * show that the ink moved; it shows that the level was resolved, carried into the measurement and
 * carried into the raster. That the INK is ordered correctly is proved on a real font stack by the
 * `unicodeCues` journey in `e2e/`, which is where mixed-direction text belongs.
 */
describe('bakeGlyphAtlas bidi', () => {
  const handled = { shapingCrossesClusters: false, directionNeedsBidi: false };

  it('resolves the paragraph level from the first strong character', () => {
    for (const [text, direction, align] of [
      ['aa (bb) cc', 'ltr', 'left'],
      [VIETNAMESE, 'ltr', 'left'],
      [KOREAN, 'ltr', 'left'],
      [ARABIC, 'rtl', 'right'],
      [HEBREW, 'rtl', 'right'],
      [`ok ${HEBREW}`, 'ltr', 'left'],
      [`${HEBREW} ok`, 'rtl', 'right'],
      // European digits are weak, so a run opening with them takes the direction of whatever strong
      // character comes next — which is P2 refusing to guess, not this module doing so.
      [`42 ${HEBREW}`, 'rtl', 'right'],
      ['42 ok', 'ltr', 'left'],
      // No strong character at all is left-to-right, which is P3.
      ['42 %', 'ltr', 'left'],
    ]) {
      const descriptor = shape({ text });

      expect(descriptor.metrics.baseDirection, text).toBe(direction);
      expect(descriptor.layout.textAlign, text).toBe(align);
      expect(descriptor.glyphs.every((glyph) => glyph.direction === direction), text).toBe(true);
      expect(descriptor.layout.refusal, text).toEqual(handled);
    }
    // Only the CSS `start` default is resolved; an explicit alignment is the caller's own choice.
    expect(shape({ text: ARABIC, textAlign: 'center' }).layout.textAlign).toBe('center');
    expect(shape({ text: ARABIC, textAlign: 'right' }).layout.textAlign).toBe('right');
  });

  it('skips an isolated run when resolving the level, as P2 requires', () => {
    // The text between an isolate initiator and its matching pop is, by definition, not allowed to
    // decide the direction outside it — so the Latin inside the isolate does not make this
    // paragraph left-to-right, and the Hebrew after it does make it right-to-left.
    expect(shape({ text: '\u2066abc\u2069 ' + HEBREW }).metrics.baseDirection).toBe('rtl');
    // An unterminated isolate swallows the rest of the run, which leaves nothing strong: P3.
    expect(shape({ text: '\u2066' + HEBREW }).metrics.baseDirection).toBe('ltr');
  });

  it('keeps a line in logical order and hands the ordering to the engine', () => {
    // The cell's text is what was typed, because the cell is what gets handed to the engine to
    // shape. What a reader sees is inside the raster.
    expect(cellTextsOf(shape({ text: HEBREW }))).toEqual([HEBREW]);
    expect(lineTextsOf(shape({ text: `ok ${HEBREW}` }))).toEqual([`ok ${HEBREW}`]);
    expect(lineTextsOf(shape({ text: `${HEBREW} 42%` }))).toEqual([`${HEBREW} 42%`]);

    // The direction reaches the raster: the same text under two paragraph levels is two pictures,
    // so an atlas can never describe one of them as the other.
    const auto = shape({ text: 'a b' });
    const forced = shape({ text: 'a b', baseDirection: 'rtl' });
    expect(forced.metrics.baseDirection).toBe('rtl');
    expect(forced.glyphs[0].direction).toBe('rtl');
    expect(forced.pixels).not.toEqual(auto.pixels);
    expect(forced.contentHash).not.toBe(auto.contentHash);
  });

  it('no longer refuses the constructs the engine handles inside the mask', () => {
    // Every one of these used to refuse, and the refusal reached the compositor as "do not draw
    // this cue". Explicit embedding controls and isolates were never implemented; a MIRRORED
    // character — an ordinary bracket — was refused anywhere near right-to-left text, which is the
    // one that broke real captions. The engine implements all of them, so refusing them now would
    // be refusing text the product draws correctly.
    for (const text of [
      'abc\u202bdef\u202c',
      `${HEBREW}\u2066abc\u2069`,
      `(${HEBREW})`,
      `${HEBREW} <ok>`,
      '(abc)',
    ]) {
      const descriptor = shape({ text });

      expect(descriptor.layout.refusal, text).toEqual(handled);
      expect(descriptor.layout.cellAdvanceLayout, text).toBe('reproduces');
      expect(cellTextsOf(descriptor), text).toEqual([text]);
    }
  });

  it('takes a forced paragraph direction, which is the seam rtlSupport lands on', () => {
    const text = 'a b ';
    const clusters = [...text];
    const layoutOf = (baseDirection) => buildTextLayout({
      text,
      clusters,
      textTransform: 'none',
      letterSpacingPx: 0,
      maxWidthPx: null,
      wordWrap: true,
      textAlign: 'left',
      lineHeightPx: 50,
      baselinePx: 40.5,
      measureLine: (line) => [...line].length * ADVANCE_PX,
      baseDirection,
      limits: GLYPH_ATLAS_LIMITS,
    });

    // Nothing in the text is right-to-left, so only the forced level moves it.
    const auto = layoutOf(null);
    expect(auto.textAlign).toBe('left');
    expect(auto.lines[0].direction).toBe('ltr');

    const forced = layoutOf('rtl');
    expect(forced.textAlign).toBe('right');
    expect(forced.lines[0].direction).toBe('rtl');
    // Trailing whitespace hangs outside the alignment box in either direction, so the content the
    // raster is made from — and the width it is measured at — are the same three characters.
    expect(forced.lines[0].contentText).toBe('a b');
    expect(forced.lines[0].advanceWidthPx).toBe(ADVANCE_PX * 3);
    expect(forced.cellAdvanceLayout).toBe('reproduces');
  });
});

describe('bakeGlyphAtlas layout honesty', () => {
  it('reports no residual under kerning, because the line is measured as itself', () => {
    const kerned = bakeGlyphAtlas(
      { text: 'aa bb', face: { family: 'Editor Sans' }, fontSizePx: SHAPED_SIZE_PX, maxWidthPx: ADVANCE_PX * 3 },
      { surface: createKerningSurface() }
    );

    // Kerning moves ink across a cluster boundary. That used to make the sum of the cells disagree
    // with the run, and the disagreement refused the whole cue — which is how an ordinary edited
    // subtitle stopped drawing. The line is one cell now, and its advance came from measuring that
    // very line, so there is no second number for it to differ from.
    expect(cellTextsOf(kerned)).toEqual(['aa', 'bb']);
    expect(lineTextsOf(kerned)).toEqual(['aa', 'bb']);
    expect(kerned.metrics.shapingResidualPx).toBe(0);
    expect(kerned.layout.lines.map((line) => line.shapingResidualPx)).toEqual([0, 0]);
    expect(kerned.layout.cellAdvanceLayout).toBe('reproduces');
    expect(kerned.layout.refusal).toEqual({ shapingCrossesClusters: false, directionNeedsBidi: false });
    // And the widths reported are the KERNED ones, not the summed ones a per-cluster layout used.
    expect(kerned.layout.lines.map((line) => line.advanceWidthPx)).toEqual([51.5, 51.5]);
    expect(kerned.layout.lines.map((line) => line.measuredWidthPx)).toEqual([51.5, 51.5]);
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

  it('bounds the cells a run may lay out, which is what the compositor mirrors', () => {
    expect(GLYPH_ATLAS_LIMITS.maxLayoutCells).toBe(GLYPH_ATLAS_LIMITS.maxTextCodePoints);

    // A cell is a line, so a run's own cells are its LINES and the ceiling it meets first is
    // `maxLayoutLines`. The cell bound stays mirrored because `MAX_RUN_GLYPHS` in the compositor is
    // the array it sizes, and a descriptor arriving from anywhere else is not obliged to send one
    // cell per line.
    const full = shape({ text: 'a'.repeat(100) });
    expect(full.layout.lines).toHaveLength(1);
    expect(full.layout.lines[0].glyphs).toHaveLength(1);
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

    // Wrapped, because a cell is a whole line: an unwrapped run this long would be one texture far
    // wider than any atlas, which is a different refusal than the one under test.
    expect(() => shape({ text: half, maxWidthPx: 900 })).not.toThrow();
    // Each sharp s uppercases to two letters, so the same input is over the bound once transformed.
    expect(codeOf(() => shape({ text: half, maxWidthPx: 900, textTransform: 'uppercase' })))
      .toBe('glyphAtlasTextTooLong');
  });
});
