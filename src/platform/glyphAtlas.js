/**
 * The single WebView glyph source for the native renderer.
 *
 * The architecture (docs/rewrite/NATIVE_RENDERER.md) is one Rust/GPU pixel compositor fed by one
 * glyph source. This module is that source: the WebView shapes and rasterizes the selected face
 * once, using the exact editor font bytes and the browser's own text stack, and hands native code a
 * bounded, versioned, immutable descriptor. Rust re-derives per-frame layout and animation from it
 * and emits textured quads; it never shapes text. That makes preview and export share identical
 * fonts and identical shaping by construction rather than by a test we have to keep passing.
 *
 * Transport is deliberately NOT decided here. Raw frame bytes over IPC are forbidden by the
 * architecture, so `descriptor.pixels` is exposed as a plain RGBA byte view and the caller chooses
 * the staging route. `pixels.buffer` is a plain transferable ArrayBuffer for that purpose. This
 * module never touches IPC and never sees a native path.
 *
 * Determinism: no clocks, no RNG, no `Date`, no `Math.random`. Every field is a pure function of the
 * request and the measurement surface, so a seek is exact and repeatable.
 *
 * Caveat recorded rather than hidden: grapheme segmentation comes from `Intl.Segmenter`, so a host
 * with a different ICU version can cluster new emoji sequences differently. The cluster list feeds
 * `contentHash`, so that surfaces as a different atlas identity instead of silent divergence.
 */

export const GLYPH_ATLAS_VERSION = 1;

export const GLYPH_ATLAS_LIMITS = Object.freeze({
  maxTextCodePoints: 4_096,
  maxGlyphCount: 1_024,
  maxClusterCodePoints: 32,
  maxAtlasDimensionPx: 4_096,
  minFontSizePx: 4,
  maxFontSizePx: 512,
  maxFamilyCharacters: 64,
  maxPaddingPx: 8,
});

export const GLYPH_ATLAS_ERROR_CODES = Object.freeze([
  'glyphAtlasInvalidRequest',
  'glyphAtlasTextTooLong',
  'glyphAtlasClusterTooLong',
  'glyphAtlasTooManyGlyphs',
  'glyphAtlasTooLarge',
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

const fail = (code, message) => {
  throw new GlyphAtlasError(code, message);
};

const invalidRequest = (detail) => fail('glyphAtlasInvalidRequest', `The glyph atlas request is invalid: ${detail}`);

/** Widths tried in order; the first that packs to a height no greater than itself wins. */
const ATLAS_WIDTH_CANDIDATES = Object.freeze([64, 128, 256, 512, 1_024, 2_048, 4_096]);

/**
 * Probe families used to detect face substitution. They must be generic families that every engine
 * resolves to visibly different metrics; agreement between all three is what proves a face did not
 * participate in a measurement.
 */
const PROBE_FAMILIES = Object.freeze(['monospace', 'serif', 'sans-serif']);
const FACE_PROBE_TEXT = 'mmmmmmmmmmlliWQ';
/** Face-level vertical metrics are string-independent, so a fixed probe also covers empty text. */
const METRIC_PROBE_TEXT = 'Hxdpg';

/** Every measurement the baker consumes must carry all of these, or the surface is not usable. */
const MEASUREMENT_FIELDS = Object.freeze([
  'width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight',
  'actualBoundingBoxAscent', 'actualBoundingBoxDescent',
  'fontBoundingBoxAscent', 'fontBoundingBoxDescent',
]);

const FAMILY_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const INKED_PATTERN = /[\p{L}\p{N}\p{S}\p{P}\p{M}]/u;
const STRONG_LTR_PATTERN = /[\p{L}\p{N}]/u;
/**
 * Strong right-to-left code point ranges, coarse by design: Hebrew through Arabic Extended-A,
 * the Arabic presentation forms, and the RTL supplementary planes. This is a first-strong
 * classification (UAX #9 P2/P3 in spirit), not a bidi implementation — the compositor receives the
 * direction as data and owns reordering.
 */
const RTL_RANGES = Object.freeze([
  [0x0590, 0x08ff],
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
  [0x10800, 0x10fff],
  [0x1e800, 0x1efff],
]);

const round4 = (value) => {
  const rounded = Math.round(value * 10_000) / 10_000;
  return rounded === 0 ? 0 : rounded;
};

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Freezes the metadata tree. Typed arrays are skipped because freezing one throws: `pixels` is
 * therefore the single mutable member, deliberately so, since staging transfers its `.buffer`.
 */
const deepFreeze = (value) => {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

/** Non-cryptographic identity for cache and revision comparison only. Never a security boundary. */
const fnv1a32 = (bytes, seed = 0x811c9dc5) => {
  let hash = seed;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

const hashText = (text, seed) => fnv1a32(new TextEncoder().encode(text), seed);

// Request validation

const quoteFamily = (family) => `"${family}"`;

const buildCssFont = (face, families) => {
  const list = families.map(quoteFamily).join(', ');
  return `${face.style} ${face.weight} ${round4(face.fontSizePx)}px ${list}`;
};

/** Generic families are keywords and must never be quoted. */
const buildProbeFont = (face, families, probeFamily) => {
  const quoted = families.map(quoteFamily);
  return `${face.style} ${face.weight} ${round4(face.fontSizePx)}px ${[...quoted, probeFamily].join(', ')}`;
};

const normalizeFace = (face) => {
  if (face === null || typeof face !== 'object') invalidRequest('face must be an object');
  const { family, weight = 400, style = 'normal' } = face;
  if (typeof family !== 'string' || family.length === 0) invalidRequest('face.family must be a non-empty string');
  if (family.length > GLYPH_ATLAS_LIMITS.maxFamilyCharacters) {
    invalidRequest(`face.family exceeds ${GLYPH_ATLAS_LIMITS.maxFamilyCharacters} characters`);
  }
  // Rejected, never escaped: a family name is interpolated into a CSS font shorthand, so anything
  // that could terminate the string or the declaration is refused outright.
  if (!FAMILY_PATTERN.test(family)) invalidRequest('face.family contains characters that are not allowed');
  if (!Number.isInteger(weight) || weight < 1 || weight > 1_000) invalidRequest('face.weight must be an integer in 1..1000');
  if (style !== 'normal' && style !== 'italic' && style !== 'oblique') {
    invalidRequest("face.style must be 'normal', 'italic' or 'oblique'");
  }
  return { family, weight, style };
};

const normalizeRequest = (request) => {
  if (request === null || typeof request !== 'object') invalidRequest('request must be an object');
  const { text, face, fontSizePx, lineHeightPx = null, paddingPx = 1, requireExactFace = true } = request;

  if (typeof text !== 'string') invalidRequest('text must be a string');
  if (typeof requireExactFace !== 'boolean') invalidRequest('requireExactFace must be a boolean');
  if (!isFiniteNumber(fontSizePx)) invalidRequest('fontSizePx must be a finite number');
  if (fontSizePx < GLYPH_ATLAS_LIMITS.minFontSizePx || fontSizePx > GLYPH_ATLAS_LIMITS.maxFontSizePx) {
    invalidRequest(`fontSizePx must be within ${GLYPH_ATLAS_LIMITS.minFontSizePx}..${GLYPH_ATLAS_LIMITS.maxFontSizePx}`);
  }
  if (lineHeightPx !== null && (!isFiniteNumber(lineHeightPx) || lineHeightPx <= 0)) {
    invalidRequest('lineHeightPx must be null or a positive finite number');
  }
  if (!Number.isInteger(paddingPx) || paddingPx < 0 || paddingPx > GLYPH_ATLAS_LIMITS.maxPaddingPx) {
    invalidRequest(`paddingPx must be an integer in 0..${GLYPH_ATLAS_LIMITS.maxPaddingPx}`);
  }

  if ([...text].length > GLYPH_ATLAS_LIMITS.maxTextCodePoints) {
    fail('glyphAtlasTextTooLong', `The text exceeds ${GLYPH_ATLAS_LIMITS.maxTextCodePoints} code points and is rejected rather than truncated`);
  }

  const normalizedFace = normalizeFace(face);
  return {
    text,
    face: { ...normalizedFace, fontSizePx },
    lineHeightPx,
    paddingPx,
    requireExactFace,
  };
};

// Segmentation

/**
 * Grapheme clusters, not code units and not code points, are the rasterization unit: a combining
 * mark, a Hangul jamo sequence and an emoji ZWJ sequence each stay welded to their base. A fixed
 * locale keeps the segmentation independent of the host UI language.
 */
const segmentClusters = (text) => {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    fail('glyphAtlasSegmenterUnavailable', 'Grapheme segmentation is unavailable, so the atlas cannot be baked deterministically');
  }
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const clusters = [];
  for (const { segment } of segmenter.segment(text)) {
    if ([...segment].length > GLYPH_ATLAS_LIMITS.maxClusterCodePoints) {
      fail('glyphAtlasClusterTooLong', `A grapheme cluster exceeds ${GLYPH_ATLAS_LIMITS.maxClusterCodePoints} code points`);
    }
    clusters.push(segment);
  }
  return clusters;
};

/** Sorted by code point sequence so the same glyph set always packs to the same atlas. */
const uniqueClusters = (clusters) => {
  const unique = [...new Set(clusters)];
  unique.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (unique.length > GLYPH_ATLAS_LIMITS.maxGlyphCount) {
    fail('glyphAtlasTooManyGlyphs', `The text needs more than ${GLYPH_ATLAS_LIMITS.maxGlyphCount} distinct glyph cells`);
  }
  return unique;
};

const isRtlCodePoint = (codePoint) => RTL_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);

const directionOf = (cluster) => {
  for (const character of cluster) {
    if (isRtlCodePoint(character.codePointAt(0))) return 'rtl';
  }
  return STRONG_LTR_PATTERN.test(cluster) ? 'ltr' : 'neutral';
};

// Measurement surface

const readMeasurement = (raw, what) => {
  if (raw === null || typeof raw !== 'object') {
    fail('glyphAtlasMetricsUnavailable', `The measurement surface returned no metrics for ${what}`);
  }
  const metrics = {};
  for (const field of MEASUREMENT_FIELDS) {
    const value = raw[field];
    if (!isFiniteNumber(value)) {
      fail('glyphAtlasMetricsUnavailable', `The measurement surface omitted ${field} for ${what}`);
    }
    metrics[field] = value;
  }
  return metrics;
};

/**
 * Canvas-backed surface used in the real WebView. Deterministic knobs are pinned explicitly:
 * kerning on, no letter or word spacing, and an LTR measurement direction — visual order is carried
 * in the descriptor as data, so the raster itself must not depend on the ambient direction.
 */
export const createCanvas2dMeasurementSurface = () => {
  const context = (() => {
    try {
      if (typeof document === 'undefined') return null;
      return document.createElement('canvas').getContext('2d', { willReadFrequently: true }) ?? null;
    } catch {
      return null;
    }
  })();
  if (context === null) {
    fail('glyphAtlasSurfaceUnavailable', 'A 2D canvas context is required to bake a glyph atlas');
  }

  const pin = (target) => Object.assign(target, {
    direction: 'ltr', fontKerning: 'normal', letterSpacing: '0px',
    wordSpacing: '0px', textAlign: 'left', textBaseline: 'alphabetic',
  });

  return {
    measure(cssFont, text) {
      pin(context);
      context.font = cssFont;
      return context.measureText(text);
    },
    isFaceLoaded(cssFont, text) {
      try {
        return document.fonts?.check?.(cssFont, text) ?? null;
      } catch {
        return null;
      }
    },
    createTarget(widthPx, heightPx) {
      const canvas = document.createElement('canvas');
      canvas.width = widthPx;
      canvas.height = heightPx;
      const target = canvas.getContext('2d', { willReadFrequently: true });
      if (target === null) {
        fail('glyphAtlasSurfaceUnavailable', 'A 2D canvas context is required to rasterize a glyph atlas');
      }
      pin(target);
      // White coverage on transparent black: the alpha channel is the coverage mask the compositor
      // multiplies by the scene colour, so colour never bakes into the atlas.
      target.fillStyle = '#ffffff';
      return {
        drawGlyph({ cssFont, text, penXPx, baselineYPx }) {
          pin(target);
          target.font = cssFont;
          target.fillText(text, penXPx, baselineYPx);
        },
        readPixels: () => target.getImageData(0, 0, widthPx, heightPx).data,
      };
    },
  };
};

const resolveSurface = (surface) => {
  if (surface === undefined || surface === null) return createCanvas2dMeasurementSurface();
  if (typeof surface.measure !== 'function' || typeof surface.createTarget !== 'function') {
    invalidRequest('surface must expose measure() and createTarget()');
  }
  return surface;
};

// Face substitution detection

/**
 * How substitution is detected.
 *
 * The browser never reports which face it actually used, and it silently substitutes both whole
 * families (the family is not installed) and individual glyphs (the family is installed but lacks
 * the code point). Trusting it is exactly how 88 of OSG's 115 selectable families ended up
 * silently substituted in the preview. So the face is measured, not trusted:
 *
 *   1. Measure a probe string in each of three generic families alone. If all three widths agree,
 *      the surface cannot tell faces apart at all (a stub `measureText`, a headless context with no
 *      fonts) and nothing it says is evidence — reject as unverifiable rather than guess.
 *   2. Measure the same probe as `"Requested", <generic>` for each generic. If the requested family
 *      participated, at least one chain differs from its generic alone.
 *   3. If every chain matches its generic exactly, the requested family contributed nothing: it is
 *      absent. Three independent generics agreeing by coincidence with a real face is not credible.
 *   4. Repeat per grapheme cluster to catch per-glyph fallback (emoji, CJK, rare diacritics) in an
 *      otherwise present family. Clusters with no ink are skipped: whitespace and format characters
 *      have nothing to substitute.
 *   5. `document.fonts.check` corroborates when the surface offers it. It is only allowed to
 *      *reject*: a `false` fails closed, a `true` never overrides a measured absence.
 */
const probeFace = (surface, face, families) => {
  const alone = PROBE_FAMILIES.map((probeFamily) => ({
    probeFamily,
    width: readMeasurement(
      surface.measure(`${face.style} ${face.weight} ${round4(face.fontSizePx)}px ${probeFamily}`, FACE_PROBE_TEXT),
      `probe family ${probeFamily}`
    ).width,
  }));
  const discriminating = new Set(alone.map(({ width }) => round4(width))).size > 1;
  if (!discriminating) {
    fail(
      'glyphAtlasFaceUnverifiable',
      'The measurement surface reports identical metrics for every generic family, so face identity cannot be verified'
    );
  }
  return alone.map(({ probeFamily, width }) => ({
    probeFamily,
    aloneWidthPx: round4(width),
    chainedWidthPx: round4(
      readMeasurement(
        surface.measure(buildProbeFont(face, families, probeFamily), FACE_PROBE_TEXT),
        `probe chain ${probeFamily}`
      ).width
    ),
  }));
};

const probeCluster = (surface, face, families, cluster) => PROBE_FAMILIES.every((probeFamily) => {
  const aloneWidth = readMeasurement(
    surface.measure(`${face.style} ${face.weight} ${round4(face.fontSizePx)}px ${probeFamily}`, cluster),
    `cluster probe ${probeFamily}`
  ).width;
  const chainedWidth = readMeasurement(
    surface.measure(buildProbeFont(face, families, probeFamily), cluster),
    `cluster chain ${probeFamily}`
  ).width;
  return round4(aloneWidth) === round4(chainedWidth);
});

// Packing

const nextPowerOfTwo = (value) => {
  let size = 1;
  while (size < value) size *= 2;
  return size;
};

/** Deterministic shelf packing in the sorted glyph order. No heuristics, no randomness. */
const shelfPack = (cells, atlasWidthPx) => {
  const placements = new Array(cells.length);
  let shelfYPx = 0;
  let shelfHeightPx = 0;
  let penXPx = 0;
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell.widthPx === 0 || cell.heightPx === 0) {
      placements[index] = { xPx: 0, yPx: 0 };
      continue;
    }
    if (cell.widthPx > atlasWidthPx) return null;
    if (penXPx + cell.widthPx > atlasWidthPx) {
      shelfYPx += shelfHeightPx;
      shelfHeightPx = 0;
      penXPx = 0;
    }
    placements[index] = { xPx: penXPx, yPx: shelfYPx };
    penXPx += cell.widthPx;
    if (cell.heightPx > shelfHeightPx) shelfHeightPx = cell.heightPx;
  }
  return { placements, heightPx: nextPowerOfTwo(shelfYPx + shelfHeightPx) };
};

const packAtlas = (cells) => {
  const inked = cells.some((cell) => cell.widthPx > 0 && cell.heightPx > 0);
  if (!inked) return { widthPx: 0, heightPx: 0, placements: cells.map(() => ({ xPx: 0, yPx: 0 })) };
  for (const widthPx of ATLAS_WIDTH_CANDIDATES) {
    const packed = shelfPack(cells, widthPx);
    if (packed !== null && packed.heightPx <= widthPx) {
      return { widthPx, heightPx: packed.heightPx, placements: packed.placements };
    }
  }
  return fail('glyphAtlasTooLarge', `The glyphs do not fit within a ${GLYPH_ATLAS_LIMITS.maxAtlasDimensionPx}px atlas`);
};

// Bake

const measureCell = (measurement, paddingPx) => {
  const left = Math.ceil(measurement.actualBoundingBoxLeft);
  const right = Math.ceil(measurement.actualBoundingBoxRight);
  const ascent = Math.ceil(measurement.actualBoundingBoxAscent);
  const descent = Math.ceil(measurement.actualBoundingBoxDescent);
  const inkWidthPx = left + right;
  const inkHeightPx = ascent + descent;
  if (inkWidthPx <= 0 || inkHeightPx <= 0) {
    return { widthPx: 0, heightPx: 0, originXPx: 0, originYPx: 0 };
  }
  return {
    widthPx: inkWidthPx + paddingPx * 2,
    heightPx: inkHeightPx + paddingPx * 2,
    originXPx: paddingPx + left,
    originYPx: paddingPx + ascent,
  };
};

const canonicalize = (descriptor) => {
  const glyphs = descriptor.glyphs.map((glyph) => [
    glyph.cluster, glyph.codePoints.join('.'), glyph.direction, glyph.advanceWidthPx,
    glyph.xPx, glyph.yPx, glyph.widthPx, glyph.heightPx,
    glyph.originXPx, glyph.originYPx, glyph.substituted ? 1 : 0,
  ].join(','));
  const { face, metrics, atlas } = descriptor;
  return [
    `v${descriptor.version}`,
    `${face.requestedFamily}|${face.weight}|${face.style}|${face.fontSizePx}|${face.substituted ? 1 : 0}`,
    `${metrics.ascentPx}|${metrics.descentPx}|${metrics.lineHeightPx}|${metrics.baselinePx}`,
    `${metrics.runAdvanceWidthPx}|${metrics.shapingResidualPx}|${metrics.baseDirection}`,
    `${atlas.widthPx}|${atlas.heightPx}|${atlas.paddingPx}|${atlas.glyphCount}`,
    ...glyphs,
  ].join('\n');
};

/**
 * Bake the glyphs a text run needs into a packed atlas.
 *
 * `request` is `{ text, face: { family, weight = 400, style = 'normal' }, fontSizePx,
 * lineHeightPx = null, paddingPx = 1, requireExactFace = true }`; oversize input is rejected, never
 * truncated, and `requireExactFace` makes any substitution a hard failure. `options.surface` injects
 * the measurement surface and defaults to canvas 2D. Returns a frozen, versioned descriptor whose
 * `pixels` is tightly packed RGBA8; its alpha channel is the coverage mask and the caller owns
 * staging it to native code.
 */
export const bakeGlyphAtlas = (request, options = {}) => {
  const { text, face, lineHeightPx, paddingPx, requireExactFace } = normalizeRequest(request);
  const surface = resolveSurface(options.surface);
  const families = [face.family];
  const cssFont = buildCssFont(face, families);

  const probes = probeFace(surface, face, families);
  const faceSubstituted = probes.every((probe) => probe.aloneWidthPx === probe.chainedWidthPx);
  if (faceSubstituted) {
    fail('glyphAtlasFaceUnavailable', `The face "${face.family}" is not the face the engine would use and was rejected`);
  }
  if (typeof surface.isFaceLoaded === 'function' && surface.isFaceLoaded(cssFont, FACE_PROBE_TEXT) === false) {
    fail('glyphAtlasFaceUnavailable', `The face "${face.family}" is not loaded`);
  }

  const faceMetrics = readMeasurement(surface.measure(cssFont, METRIC_PROBE_TEXT), 'face metrics');
  const ascentPx = round4(faceMetrics.fontBoundingBoxAscent);
  const descentPx = round4(faceMetrics.fontBoundingBoxDescent);

  const clusters = segmentClusters(text);
  const unique = uniqueClusters(clusters);

  const measured = unique.map((cluster) => {
    const measurement = readMeasurement(surface.measure(cssFont, cluster), 'a glyph cluster');
    const substituted = INKED_PATTERN.test(cluster) && probeCluster(surface, face, families, cluster);
    if (substituted && requireExactFace) {
      fail('glyphAtlasFaceSubstituted', `The face "${face.family}" does not cover "${cluster}" and the engine substituted another face`);
    }
    return {
      cluster,
      codePoints: [...cluster].map((character) => character.codePointAt(0)),
      direction: directionOf(cluster),
      advanceWidthPx: round4(measurement.width),
      substituted,
      cell: measureCell(measurement, paddingPx),
    };
  });

  const atlas = packAtlas(measured.map(({ cell }) => cell));
  if (atlas.widthPx > GLYPH_ATLAS_LIMITS.maxAtlasDimensionPx || atlas.heightPx > GLYPH_ATLAS_LIMITS.maxAtlasDimensionPx) {
    fail('glyphAtlasTooLarge', `The atlas exceeds ${GLYPH_ATLAS_LIMITS.maxAtlasDimensionPx}px`);
  }

  const glyphs = measured.map((entry, index) => ({
    cluster: entry.cluster,
    codePoints: entry.codePoints,
    direction: entry.direction,
    advanceWidthPx: entry.advanceWidthPx,
    xPx: atlas.placements[index].xPx,
    yPx: atlas.placements[index].yPx,
    widthPx: entry.cell.widthPx,
    heightPx: entry.cell.heightPx,
    originXPx: entry.cell.originXPx,
    originYPx: entry.cell.originYPx,
    substituted: entry.substituted,
  }));

  let pixels = new Uint8ClampedArray(0);
  if (atlas.widthPx > 0 && atlas.heightPx > 0) {
    const target = surface.createTarget(atlas.widthPx, atlas.heightPx);
    for (const glyph of glyphs) {
      if (glyph.widthPx === 0 || glyph.heightPx === 0) continue;
      target.drawGlyph({
        cssFont,
        text: glyph.cluster,
        penXPx: glyph.xPx + glyph.originXPx,
        baselineYPx: glyph.yPx + glyph.originYPx,
      });
    }
    const raw = target.readPixels();
    const expected = atlas.widthPx * atlas.heightPx * 4;
    if (!ArrayBuffer.isView(raw) || raw.length !== expected) {
      fail('glyphAtlasSurfaceUnavailable', 'The measurement surface returned an atlas of the wrong size');
    }
    pixels = raw instanceof Uint8ClampedArray ? raw : new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length);
  }

  const advanceByCluster = new Map(measured.map((entry) => [entry.cluster, entry.advanceWidthPx]));
  const clusterAdvanceSum = clusters.reduce((total, cluster) => total + advanceByCluster.get(cluster), 0);
  const runAdvanceWidthPx = round4(readMeasurement(surface.measure(cssFont, text), 'the text run').width);

  const descriptor = {
    version: GLYPH_ATLAS_VERSION,
    face: {
      requestedFamily: face.family,
      weight: face.weight,
      style: face.style,
      fontSizePx: round4(face.fontSizePx),
      cssFont,
      substituted: glyphs.some((glyph) => glyph.substituted),
      probes: probes.map((probe) => ({ ...probe, participated: probe.aloneWidthPx !== probe.chainedWidthPx })),
    },
    metrics: {
      ascentPx,
      descentPx,
      lineHeightPx: round4(lineHeightPx ?? ascentPx + descentPx),
      baselinePx: ascentPx,
      runAdvanceWidthPx,
      // Non-zero means the engine applied kerning, a ligature or a contextual form across cluster
      // boundaries, so summing per-cell advances does not reproduce the run. Surfaced instead of
      // hidden: the compositor must not lay out from cell advances alone when this is non-zero.
      shapingResidualPx: round4(runAdvanceWidthPx - clusterAdvanceSum),
      baseDirection: glyphs.length === 0
        ? 'ltr'
        : (clusters.map(directionOf).find((direction) => direction !== 'neutral') ?? 'ltr'),
    },
    atlas: {
      widthPx: atlas.widthPx,
      heightPx: atlas.heightPx,
      paddingPx,
      glyphCount: glyphs.length,
      pixelFormat: 'rgba8',
      bytesPerRow: atlas.widthPx * 4,
    },
    glyphs,
  };

  const contentHash = fnv1a32(pixels, hashText(canonicalize(descriptor)))
    .toString(16)
    .padStart(8, '0');
  return deepFreeze({ ...descriptor, contentHash, pixels });
};
