/**
 * The fake font model the glyph atlas suites bake against, and the helpers that drive it.
 *
 * jsdom has no real canvas text stack, so every metric in those suites comes from this injected
 * model. What it reproduces faithfully — and therefore what the suites actually prove — is the
 * *structure* of browser text measurement: per-code-point face fallback down a CSS family list to a
 * last-resort face, zero-advance combining marks and joiners, inkless whitespace, and face metrics
 * that differ per family. Everything the baker derives from that structure (segmentation, bounds,
 * packing, substitution detection, line breaking, determinism, freezing, hashing) is testable
 * against it.
 *
 * It also reproduces CURSIVE JOINING: a face may give a cluster four different forms and four
 * different advances depending on its neighbours, so measuring a whole line is not the same as
 * measuring its characters and adding up. That is a structural property of every text stack, and it
 * is what makes a line mask testable here at all — what stays unprovable is the shape of the outline
 * each form actually has.
 *
 * It models `letterSpacing` and `wordSpacing` the way CSS applies them, because the baker measures a
 * whole line WITH its spacing rather than adding spacing to per-cluster advances afterwards. It does
 * NOT model `direction`: reordering does not change a line's width, and the fake has no glyphs to
 * reorder — so a right-to-left expectation here proves the option was carried, not that the ink
 * moved. Only a real canvas can prove that, which is what the real-binary journeys are for.
 *
 * What only a real canvas can prove, and is deliberately NOT claimed: true glyph outlines and ink
 * extents, real kerning and ligatures, which concrete forms a given Arabic face carries, and which
 * face a given engine substitutes. `createKerningSurface` below fakes the one consequence of kerning
 * the descriptor has to report, and does not claim to be kerning.
 *
 * This module is imported only by tests. It lives beside them rather than inside one of them so
 * that the baker suite and the shaping suite share a single font model instead of two that could
 * drift apart.
 */

import { expect } from 'vitest';

import { GlyphAtlasError, bakeGlyphAtlas, bakeGlyphAtlasForCues } from './glyphAtlas';

const COMBINING = /\p{M}/u;
const WHITESPACE = /\s/u;
export const ACUTE = String.fromCodePoint(0x0301);
/** Zero-width joiners, the zero-width space and the emoji variation selector carry no advance. */
const ZERO_ADVANCE = new Set([0x200b, 0x200c, 0x200d, 0xfe0f]);

export const defineFace = (id, advanceRatio, covers, ascentRatio = 0.8, descentRatio = 0.2) => ({
  id, advanceRatio, covers, ascentRatio, descentRatio,
});

export const NON_EMOJI = (codePoint) => codePoint < 0x1f000;

/**
 * Cursive joining, in the `ArabicShaping.txt` sense, for the one fake face that has it.
 *
 * `D` joins on both sides, `R` accepts a join from the letter before it but cannot join to the one
 * after it, and `C` — the zero-width joiner — causes a join without drawing anything. Everything
 * else is non-joining and takes no form at all, which is every other face in this file.
 */
const JOIN_DUAL = 'D';
const JOIN_RIGHT = 'R';
const JOIN_CAUSING = 'C';
const ZERO_WIDTH_JOINER = 0x200d;

/** The Arabic letters that cannot join to the letter after them, so a word breaks its stroke. */
const RIGHT_JOINING = new Set([0x0627, 0x062f, 0x0630, 0x0631, 0x0632, 0x0648]);

/** The blocks the fake cursive face joins in: Arabic through Arabic Extended-A. */
const cursiveJoining = (codePoint) => {
  if (codePoint < 0x0600 || codePoint > 0x08ff) return null;
  return RIGHT_JOINING.has(codePoint) ? JOIN_RIGHT : JOIN_DUAL;
};

/**
 * `count` distinct dual-joining clusters, for a fixture that needs many of them.
 *
 * Marks and format characters are skipped because neither is a cluster of its own: a mark welds
 * itself to the letter before it, which would make the fixture shorter than it says it is.
 */
export const dualJoining = (count) => {
  const letters = [];
  for (let codePoint = 0x0620; letters.length < count && codePoint <= 0x08ff; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    const standalone = !COMBINING.test(character) && !/[\p{Cf}\p{White_Space}]/u.test(character);
    if (standalone && !RIGHT_JOINING.has(codePoint)) letters.push(character);
  }
  return letters;
};

/**
 * Each contextual form's advance, as a fraction of the size. All four differ, which is exactly why
 * an isolated cell cannot reproduce a joined run: the sum of the isolated advances is not the run.
 */
export const CURSIVE_FORM_RATIOS = Object.freeze({
  isolated: 0.6, initial: 0.5, medial: 0.4, final: 0.55,
});

/** Distinct advance ratios: three generics an engine would resolve to different metrics. */
export const DEFAULT_FACES = new Map([
  ['monospace', defineFace('monospace', 0.6, NON_EMOJI)],
  ['serif', defineFace('serif', 0.55, NON_EMOJI, 0.78, 0.22)],
  ['sans-serif', defineFace('sans-serif', 0.5, NON_EMOJI, 0.82, 0.18)],
  ['editor sans', defineFace('editor-sans', 0.52, NON_EMOJI, 0.81, 0.19)],
  ['latin only', defineFace('latin-only', 0.48, (codePoint) => codePoint < 0x0250)],
  ['giant', defineFace('giant', 9, NON_EMOJI, 9, 3)],
  ['cursive arabic', {
    ...defineFace('cursive-arabic', 0.53, NON_EMOJI, 0.79, 0.21),
    joining: cursiveJoining,
  }],
]);

/** The face an engine falls back to when nothing in the family list covers a code point. */
const LAST_RESORT_FACE = defineFace('last-resort', 1, () => true, 0.9, 0.3);

const CSS_FONT = /^(normal|italic|oblique) (\d+) ([\d.]+)px (.+)$/;

const parseCssFont = (cssFont) => {
  const match = CSS_FONT.exec(cssFont);
  if (match === null) throw new Error(`fake surface cannot parse font: ${cssFont}`);
  return {
    fontSizePx: Number(match[3]),
    families: match[4].split(',').map((family) => family.trim().replace(/^"|"$/g, '').toLowerCase()),
  };
};

const hashOf = (text) => {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  return hash >>> 0;
};

/**
 * CSS `word-spacing` applies to word-separator characters, which CSS Text 3 defines as exactly the
 * space and the no-break space — not the tab, and not the ideographic space.
 */
const WORD_SEPARATORS = new Set([0x0020, 0x00a0]);

/**
 * What `letterSpacingPx` and `wordSpacingPx` add to a run, modelled the way CSS applies them.
 *
 * Letter spacing goes after every typographic unit INCLUDING the last, which is what makes a
 * browser's `measureText` wider than the glyphs alone; combining marks and joiners are not units of
 * their own, so they are skipped. Word spacing goes on the separators.
 *
 * This is here because the baker now measures a whole line WITH its spacing rather than adding
 * spacing to per-cluster advances afterwards, so a model that ignored the options would report a
 * width for text nobody draws — and justification, which solves for the spacing that fills a wrap
 * width, would have nothing to solve against.
 */
const spacingWidth = (text, letterSpacingPx, wordSpacingPx) => {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (WORD_SEPARATORS.has(codePoint)) width += wordSpacingPx;
    if (COMBINING.test(character) || ZERO_ADVANCE.has(codePoint)) continue;
    width += letterSpacingPx;
  }
  return width;
};


export const createFakeSurface = ({ faces = DEFAULT_FACES, isFaceLoaded } = {}) => {
  /** Per-code-point fallback down the family list, exactly as an engine resolves a run. */
  const resolve = (families, codePoint) => {
    for (const family of families) {
      const face = faces.get(family);
      if (face !== undefined && face.covers(codePoint)) return face;
    }
    return LAST_RESORT_FACE;
  };

  const firstRegistered = (families) => families
    .map((family) => faces.get(family))
    .find((face) => face !== undefined) ?? LAST_RESORT_FACE;

  /**
   * The contextual form of every character, or `null` where the face does not join.
   *
   * Combining marks are transparent — they neither join nor hide the letter behind them — which is
   * why the neighbour search walks past them instead of stopping at them.
   */
  const cursiveForms = (characters, characterFaces) => {
    const classes = characters.map((character, index) => (
      character.codePointAt(0) === ZERO_WIDTH_JOINER
        ? JOIN_CAUSING
        : characterFaces[index].joining?.(character.codePointAt(0)) ?? null
    ));
    const joinsForward = (joining) => joining === JOIN_DUAL || joining === JOIN_CAUSING;
    const neighbour = (index, step) => {
      for (let at = index + step; at >= 0 && at < characters.length; at += step) {
        if (!COMBINING.test(characters[at])) return classes[at];
      }
      return null;
    };
    const forms = classes.map((joining, index) => {
      if (joining === null || joining === JOIN_CAUSING) return null;
      const left = joinsForward(neighbour(index, -1));
      const right = joinsForward(joining) && neighbour(index, 1) !== null;
      if (left && right) return 'medial';
      if (right) return 'initial';
      return left ? 'final' : 'isolated';
    });
    return { classes, forms };
  };

  const shapeText = (cssFont, text) => {
    const { fontSizePx, families } = parseCssFont(cssFont);
    const characters = [...text];
    const characterFaces = characters.map((character) => resolve(families, character.codePointAt(0)));
    const { classes, forms } = cursiveForms(characters, characterFaces);
    const joiningAt = (index) => (index >= 0 && index < classes.length ? classes[index] : null);

    let advance = 0;
    let inked = false;
    // What the raster depends on: the drawn glyphs and their forms. A joiner a cursive letter
    // consumed asked for a form and drew nothing of its own, so it leaves no mark here either; one
    // between two non-joining characters — an emoji sequence — is content and stays.
    let signature = '';
    for (const [index, character] of characters.entries()) {
      const codePoint = character.codePointAt(0);
      const consumed = codePoint === ZERO_WIDTH_JOINER
        && (joiningAt(index - 1) !== null || joiningAt(index + 1) !== null);
      if (!consumed) signature += character;
      if (COMBINING.test(character) || ZERO_ADVANCE.has(codePoint)) {
        inked = true;
        continue;
      }
      const form = forms[index];
      advance += fontSizePx * (form === null ? characterFaces[index].advanceRatio : CURSIVE_FORM_RATIOS[form]);
      signature += form ?? '';
      if (!WHITESPACE.test(character)) inked = true;
    }
    return {
      fontSizePx,
      advance,
      inked,
      signature,
      metricFace: characterFaces[0] ?? firstRegistered(families),
    };
  };

  const measure = (cssFont, text, { letterSpacingPx = 0, wordSpacingPx = 0 } = {}) => {
    const { fontSizePx, advance: shapedAdvance, inked, metricFace } = shapeText(cssFont, text);
    const advance = shapedAdvance + spacingWidth(text, letterSpacingPx, wordSpacingPx);
    const inkWidth = inked ? Math.max(advance * 0.92, fontSizePx * 0.25) : 0;
    return {
      width: advance,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: inkWidth,
      actualBoundingBoxAscent: inked ? fontSizePx * metricFace.ascentRatio * 0.9 : 0,
      actualBoundingBoxDescent: inked ? fontSizePx * metricFace.descentRatio * 0.9 : 0,
      fontBoundingBoxAscent: fontSizePx * metricFace.ascentRatio,
      fontBoundingBoxDescent: fontSizePx * metricFace.descentRatio,
    };
  };

  return {
    measure,
    ...(isFaceLoaded === undefined ? {} : { isFaceLoaded }),
    createTarget(widthPx, heightPx) {
      const pixels = new Uint8ClampedArray(widthPx * heightPx * 4);
      return {
        drawGlyph({ cssFont, text, penXPx, baselineYPx, ...options }) {
          const metrics = measure(cssFont, text, options);
          const { metricFace, signature } = shapeText(cssFont, text);
          const right = Math.ceil(metrics.actualBoundingBoxRight);
          const ascent = Math.ceil(metrics.actualBoundingBoxAscent);
          const descent = Math.ceil(metrics.actualBoundingBoxDescent);
          // The options are part of the picture, so they are part of what the raster hashes to. Two
          // cells that share a text and differ in direction or word spacing must not be the same
          // pixels, or the atlas could describe one of them as the other and nothing would notice.
          const drawn = `${metricFace.id}:${options.direction ?? 'ltr'}`
            + `:${options.letterSpacingPx ?? 0}:${options.wordSpacingPx ?? 0}:${signature}`;
          const alpha = 32 + (hashOf(drawn) % 224);
          for (let y = baselineYPx - ascent; y < baselineYPx + descent; y += 1) {
            for (let x = penXPx; x < penXPx + right; x += 1) {
              if (x < 0 || y < 0 || x >= widthPx || y >= heightPx) continue;
              const offset = (y * widthPx + x) * 4;
              pixels[offset] = 255;
              pixels[offset + 1] = 255;
              pixels[offset + 2] = 255;
              pixels[offset + 3] = alpha;
            }
          }
        },
        readPixels: () => pixels,
      };
    },
  };
};

/**
 * A surface whose runs measure narrower than their cells sum to, which is what kerning does.
 *
 * Kerning is modelled on the ADVANCING characters only: a zero-advance format character sits
 * between two glyphs without separating them, so it neither creates a kern pair nor removes one.
 * That matters beyond realism — a joiner that changed the width here would let the contextual cell
 * resolver mistake a kern for a contextual form, and this surface exists precisely to be the case
 * that nothing can spell per cluster.
 */
export const createKerningSurface = () => {
  const base = createFakeSurface();
  const advancing = (text) => [...text].filter(
    (character) => !ZERO_ADVANCE.has(character.codePointAt(0)) && !COMBINING.test(character)
  ).length;
  return {
    ...base,
    measure: (cssFont, text) => {
      const metrics = base.measure(cssFont, text);
      return { ...metrics, width: metrics.width - Math.max(advancing(text) - 1, 0) * 0.5 };
    },
  };
};

/**
 * A surface with real ligatures: `ff` and `ffi` measure as ONE narrower glyph, not as the letters
 * they are spelled with.
 *
 * A ligature is the case contextual cells cannot express, and it has to be modelled honestly to
 * prove that. A joiner is transparent to the substitution here — it neither creates a ligature nor
 * breaks one — so the resolver measures the same ligature the run has and still finds that no
 * per-cluster spelling reproduces the position's advance.
 */
const LIGATURE_RATIOS = new Map([['ffi', 1.2], ['ff', 0.9]]);

export const createLigatureSurface = () => {
  const base = createFakeSurface();
  const ligatureWidth = (cssFont, text) => {
    const letters = [...text].filter((character) => character.codePointAt(0) !== 0x200d).join('');
    let width = 0;
    let position = 0;
    while (position < letters.length) {
      const ligature = [...LIGATURE_RATIOS.keys()].find(
        (candidate) => letters.startsWith(candidate, position)
      );
      if (ligature === undefined) {
        width += base.measure(cssFont, letters[position]).width;
        position += 1;
        continue;
      }
      width += parseCssFont(cssFont).fontSizePx * LIGATURE_RATIOS.get(ligature);
      position += ligature.length;
    }
    return width;
  };
  return {
    ...base,
    measure: (cssFont, text) => ({ ...base.measure(cssFont, text), width: ligatureWidth(cssFont, text) }),
  };
};

export const bake = (request, surfaceOptions) => bakeGlyphAtlas(
  { face: { family: 'Editor Sans' }, fontSizePx: 48, ...request },
  { surface: createFakeSurface(surfaceOptions) }
);

/** The same face and size as `bake`, over a whole cue list. */
export const bakeCues = (request, surfaceOptions) => bakeGlyphAtlasForCues(
  { face: { family: 'Editor Sans' }, fontSizePx: 48, ...request },
  { surface: createFakeSurface(surfaceOptions) }
);

/**
 * Shaping fixtures measure in whole numbers on purpose: 'Editor Sans' advances 0.52 of the size, so
 * a 50px bake gives every Latin cluster an advance of exactly 26px, its ascent is 40.5px and its
 * natural line height is 50px. A wrap width is then a cluster count, and an expectation is a number
 * that can be checked by hand rather than a value copied out of a failure message.
 */
export const SHAPED_SIZE_PX = 50;
export const ADVANCE_PX = 26;

export const shape = (request, surfaceOptions) => bake(
  { fontSizePx: SHAPED_SIZE_PX, ...request },
  surfaceOptions
);

/**
 * A bake against the one face that joins, at the same round size the shaping fixtures use: every
 * contextual advance is then a whole number — isolated 30, initial 25, medial 20, final 27.5 — so an
 * expectation about a cursive run can be checked by hand.
 */
export const CURSIVE_FAMILY = 'Cursive Arabic';

export const cursive = (request, surfaceOptions) => bakeGlyphAtlas(
  { face: { family: CURSIVE_FAMILY }, fontSizePx: SHAPED_SIZE_PX, ...request },
  { surface: createFakeSurface(surfaceOptions) }
);

/**
 * The text of each cell in the page's own table order.
 *
 * A cell is a whole shaped line, so this is the set of distinct lines the atlas rasterized — not an
 * alphabet. Two entries can share a text and differ in direction or advance, which is exactly what
 * the ordering rule allows for.
 */
export const cellTextsOf = (descriptor) => descriptor.glyphs.map((glyph) => glyph.cluster);

/** One cell's coverage, sampled at the middle of its ink so two forms can be told apart. */
export const cellAlphaOf = (descriptor, cell) => {
  const glyph = descriptor.glyphs[cell];
  const x = glyph.xPx + Math.floor(glyph.widthPx / 2);
  const y = glyph.yPx + Math.floor(glyph.heightPx / 2);
  return descriptor.pixels[(y * descriptor.atlas.widthPx + x) * 4 + 3];
};

export const codeOf = (run) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GlyphAtlasError);
    return error.code;
  }
  throw new Error('expected the bake to be rejected');
};

export const clustersOf = (descriptor) => descriptor.glyphs.map((glyph) => glyph.cluster);

/** The text of each laid-out line, reconstructed from the cells the line actually indexes. */
export const lineTextsOf = (descriptor) => descriptor.layout.lines.map(
  (line) => line.glyphs.map((cell) => descriptor.glyphs[cell].cluster).join('')
);

// Normalization is pinned explicitly so the fixtures do not depend on how this file was encoded.
export const VIETNAMESE = 'Tiếng Việt'.normalize('NFC');
export const KOREAN = '한국어'.normalize('NFC');
export const ARABIC = 'مرحبا'.normalize('NFC');
/** One dual-joining letter three times over: initial, medial and final forms of the same cluster. */
export const ARABIC_REPEATED = 'ببب'.normalize('NFC');
export const HEBREW = 'שלום'.normalize('NFC');
export const FAMILY_EMOJI = '👩‍👩‍👧‍👦';
