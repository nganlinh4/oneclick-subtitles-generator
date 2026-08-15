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
 * What only a real canvas can prove, and is deliberately NOT claimed: true glyph outlines and ink
 * extents, real kerning and ligatures, Arabic contextual joining forms, and which concrete face a
 * given engine substitutes. `createKerningSurface` below fakes the one consequence of kerning the
 * descriptor has to report, and does not claim to be kerning.
 *
 * This module is imported only by tests. It lives beside them rather than inside one of them so
 * that the baker suite and the shaping suite share a single font model instead of two that could
 * drift apart.
 */

import { expect } from 'vitest';

import { GlyphAtlasError, bakeGlyphAtlas } from './glyphAtlas';

const COMBINING = /\p{M}/u;
const WHITESPACE = /\s/u;
export const ACUTE = String.fromCodePoint(0x0301);
/** Zero-width joiners, the zero-width space and the emoji variation selector carry no advance. */
const ZERO_ADVANCE = new Set([0x200b, 0x200c, 0x200d, 0xfe0f]);

export const defineFace = (id, advanceRatio, covers, ascentRatio = 0.8, descentRatio = 0.2) => ({
  id, advanceRatio, covers, ascentRatio, descentRatio,
});

export const NON_EMOJI = (codePoint) => codePoint < 0x1f000;

/** Distinct advance ratios: three generics an engine would resolve to different metrics. */
export const DEFAULT_FACES = new Map([
  ['monospace', defineFace('monospace', 0.6, NON_EMOJI)],
  ['serif', defineFace('serif', 0.55, NON_EMOJI, 0.78, 0.22)],
  ['sans-serif', defineFace('sans-serif', 0.5, NON_EMOJI, 0.82, 0.18)],
  ['editor sans', defineFace('editor-sans', 0.52, NON_EMOJI, 0.81, 0.19)],
  ['latin only', defineFace('latin-only', 0.48, (codePoint) => codePoint < 0x0250)],
  ['giant', defineFace('giant', 9, NON_EMOJI, 9, 3)],
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

  const shapeText = (cssFont, text) => {
    const { fontSizePx, families } = parseCssFont(cssFont);
    let advance = 0;
    let inked = false;
    let metricFace = null;
    for (const character of text) {
      const face = resolve(families, character.codePointAt(0));
      if (metricFace === null) metricFace = face;
      if (COMBINING.test(character) || ZERO_ADVANCE.has(character.codePointAt(0))) {
        inked = true;
        continue;
      }
      advance += fontSizePx * face.advanceRatio;
      if (!WHITESPACE.test(character)) inked = true;
    }
    return { fontSizePx, advance, inked, metricFace: metricFace ?? firstRegistered(families) };
  };

  const measure = (cssFont, text) => {
    const { fontSizePx, advance, inked, metricFace } = shapeText(cssFont, text);
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
        drawGlyph({ cssFont, text, penXPx, baselineYPx }) {
          const metrics = measure(cssFont, text);
          const { metricFace } = shapeText(cssFont, text);
          const right = Math.ceil(metrics.actualBoundingBoxRight);
          const ascent = Math.ceil(metrics.actualBoundingBoxAscent);
          const descent = Math.ceil(metrics.actualBoundingBoxDescent);
          const alpha = 32 + (hashOf(`${metricFace.id}:${text}`) % 224);
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
 * A surface whose runs measure narrower than their cells sum to, which is what kerning, a ligature
 * or a contextual form does. The fake font model cannot produce one, and it is the only condition
 * that makes `shapingResidualPx` non-zero.
 */
export const createKerningSurface = () => {
  const base = createFakeSurface();
  return {
    ...base,
    measure: (cssFont, text) => {
      const metrics = base.measure(cssFont, text);
      return { ...metrics, width: metrics.width - Math.max([...text].length - 1, 0) * 0.5 };
    },
  };
};

export const bake = (request, surfaceOptions) => bakeGlyphAtlas(
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
export const HEBREW = 'שלום'.normalize('NFC');
export const FAMILY_EMOJI = '👩‍👩‍👧‍👦';
