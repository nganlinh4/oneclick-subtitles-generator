/**
 * Primitives every glyph atlas module shares: the typed error, the rounding rule, the freeze, and
 * the non-cryptographic identity hash.
 *
 * These live apart from `glyphAtlas.js` for one structural reason. `crates/osg-scene/tests/glyph.rs`
 * reads `GLYPH_ATLAS_LIMITS` and `GLYPH_ATLAS_VERSION` straight out of the baker's own source with
 * `include_str!`, so that file has to stay the single home of those two declarations *and* stay
 * inside the 600-line ceiling as the baker grows. Splitting the primitives out keeps both true, and
 * it also lets the shaping module raise the same typed errors without importing the baker back,
 * which would be an import cycle.
 *
 * Determinism: no clocks, no RNG. Every function here is a pure function of its arguments.
 */

/**
 * Every code a glyph atlas failure can carry. The list is exported so a caller can exhaustively
 * handle them and so a test can prove no two codes collide.
 */
export const GLYPH_ATLAS_ERROR_CODES = Object.freeze([
  'glyphAtlasInvalidRequest',
  'glyphAtlasTextTooLong',
  'glyphAtlasClusterTooLong',
  'glyphAtlasTooManyGlyphs',
  'glyphAtlasTooLarge',
  'glyphAtlasLayoutTooLarge',
  'glyphAtlasSegmenterUnavailable',
  'glyphAtlasSurfaceUnavailable',
  'glyphAtlasMetricsUnavailable',
  'glyphAtlasFaceUnverifiable',
  'glyphAtlasFaceUnavailable',
  'glyphAtlasFaceSubstituted',
]);

export class GlyphAtlasError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GlyphAtlasError';
    this.code = code;
  }
}

/** Messages carry bounds and field names only — never the user's subtitle text and never a path. */
export const fail = (code, message) => {
  throw new GlyphAtlasError(code, message);
};

export const invalidRequest = (detail) => fail(
  'glyphAtlasInvalidRequest',
  `The glyph atlas request is invalid: ${detail}`
);

/**
 * The single rounding rule for every measured quantity that leaves this module tree.
 *
 * Four decimals is far below a device pixel at any bakeable size, and normalising negative zero
 * matters because `-0` and `0` serialize differently and would make two identical bakes disagree.
 */
export const round4 = (value) => {
  const rounded = Math.round(value * 10_000) / 10_000;
  return rounded === 0 ? 0 : rounded;
};

export const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Freezes the metadata tree. Typed arrays are skipped because freezing one throws: `pixels` is
 * therefore the single mutable member, deliberately so, since staging transfers its `.buffer`.
 */
export const deepFreeze = (value) => {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

/** Non-cryptographic identity for cache and revision comparison only. Never a security boundary. */
export const fnv1a32 = (bytes, seed = 0x811c9dc5) => {
  let hash = seed;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

export const hashText = (text, seed) => fnv1a32(new TextEncoder().encode(text), seed);
