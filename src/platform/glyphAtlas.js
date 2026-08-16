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
 * Shaping includes LINE BREAKING. The WebView owns the font stack and `Intl.Segmenter`, so it is the
 * only side that can break a line at a word-safe, cluster-safe boundary using real measured
 * advances. `descriptor.layout` therefore carries the per-line runs the compositor draws, rather
 * than the compositor guessing where a line ended. `glyphAtlasShaping.js` owns that pass, including
 * `textTransform`, `letterSpacing`, the wrap width and justification.
 *
 * Shaping also decides WHAT EACH CELL IS. A cluster whose glyph depends on its neighbours — every
 * cursive script does — cannot be rasterized alone, so `glyphAtlasCells.js` resolves each position's
 * contextual form and the cell is baked from that form's canonical spelling instead of from the bare
 * cluster. It is engaged only for a run the isolated cells cannot reproduce, so a script that does
 * not join bakes byte-for-byte the atlas it always did, and it hands the run back unresolved when no
 * spelling reproduces it, so a ligature or a kern still refuses rather than drawing the wrong glyph.
 *
 * Transport is deliberately NOT decided here. Raw frame bytes over IPC are forbidden by the
 * architecture, so `descriptor.pixels` is exposed as a plain RGBA byte view and the caller chooses
 * the staging route. `pixels.buffer` is a plain transferable ArrayBuffer for that purpose. This
 * module never touches IPC and never sees a native path.
 *
 * Determinism: no clocks, no RNG, no `Math.random`. Every field is a pure function of the request
 * and the measurement surface, so a seek is exact and repeatable.
 *
 * Caveat recorded rather than hidden: grapheme and word segmentation come from `Intl.Segmenter`, so
 * a host with a different ICU version can cluster new emoji sequences — or find word boundaries in
 * an unspaced script — differently. Both feed `contentHash`, so that surfaces as a different atlas
 * identity instead of silent divergence.
 */

import { measureCell, packAtlas, resolveContextualCells } from './glyphAtlasCells';
import {
  deepFreeze,
  fail,
  fnv1a32,
  hashText,
  invalidRequest,
  isFiniteNumber,
  round4,
} from './glyphAtlasCore';
import {
  TEXT_ALIGNMENTS,
  TEXT_TRANSFORMS,
  applyTextTransform,
  buildTextLayout,
} from './glyphAtlasShaping';
import { readMeasurement, resolveSurface } from './glyphAtlasSurface';

export { GLYPH_ATLAS_ERROR_CODES, GlyphAtlasError } from './glyphAtlasCore';
export { createCanvas2dMeasurementSurface } from './glyphAtlasSurface';
export { TEXT_ALIGNMENTS, TEXT_TRANSFORMS } from './glyphAtlasShaping';

export const GLYPH_ATLAS_VERSION = 1;

/**
 * The bounds this module enforces. `crates/osg-scene/src/glyph/limits.rs` mirrors them and
 * `crates/osg-scene/tests/glyph.rs` parses these entries straight out of this file, so a rename or a
 * reformat is a Rust test failure rather than a silent divergence.
 */
export const GLYPH_ATLAS_LIMITS = Object.freeze({
  maxTextCodePoints: 4_096,
  maxGlyphCount: 1_024,
  maxClusterCodePoints: 32,
  maxAtlasDimensionPx: 4_096,
  minFontSizePx: 4,
  maxFontSizePx: 512,
  maxFamilyCharacters: 64,
  maxPaddingPx: 8,
  // Layout bounds. `maxLayoutLines` and `maxLayoutCells` mirror `MAX_RUN_LINES` and `MAX_RUN_GLYPHS`
  // in crates/osg-compositor/src/subtitle.rs, so a run this module emits is one the compositor can
  // stage. They are structural bounds on the payload and are NOT the persisted `maxLines`, which
  // stays inert.
  maxLayoutLines: 64,
  maxLayoutCells: 4_096,
  // Bounds the wrap arithmetic rather than expressing a design limit: the widest sane wrap width in
  // atlas space is an 8K composition divided by the smallest bakeable scale, which is far below it.
  maxLayoutWidthPx: 1_048_576,
  minLetterSpacingPx: -100,
  maxLetterSpacingPx: 1_000,
});

/**
 * Probe families used to detect face substitution. They must be generic families that every engine
 * resolves to visibly different metrics; agreement between all three is what proves a face did not
 * participate in a measurement.
 */
const PROBE_FAMILIES = Object.freeze(['monospace', 'serif', 'sans-serif']);
const FACE_PROBE_TEXT = 'mmmmmmmmmmlliWQ';
/** Face-level vertical metrics are string-independent, so a fixed probe also covers empty text. */
const METRIC_PROBE_TEXT = 'Hxdpg';

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

const normalizeShaping = ({ textTransform, letterSpacingPx, maxWidthPx, wordWrap, textAlign }) => {
  if (!TEXT_TRANSFORMS.includes(textTransform)) {
    invalidRequest(`textTransform must be one of ${TEXT_TRANSFORMS.join(', ')}`);
  }
  if (!TEXT_ALIGNMENTS.includes(textAlign)) {
    invalidRequest(`textAlign must be one of ${TEXT_ALIGNMENTS.join(', ')}`);
  }
  if (typeof wordWrap !== 'boolean') invalidRequest('wordWrap must be a boolean');
  if (!isFiniteNumber(letterSpacingPx)
      || letterSpacingPx < GLYPH_ATLAS_LIMITS.minLetterSpacingPx
      || letterSpacingPx > GLYPH_ATLAS_LIMITS.maxLetterSpacingPx) {
    invalidRequest(
      `letterSpacingPx must be within ${GLYPH_ATLAS_LIMITS.minLetterSpacingPx}`
      + `..${GLYPH_ATLAS_LIMITS.maxLetterSpacingPx}`
    );
  }
  if (maxWidthPx !== null
      && (!isFiniteNumber(maxWidthPx) || maxWidthPx <= 0 || maxWidthPx > GLYPH_ATLAS_LIMITS.maxLayoutWidthPx)) {
    invalidRequest(`maxWidthPx must be null or within 0..${GLYPH_ATLAS_LIMITS.maxLayoutWidthPx}`);
  }
  return { textTransform, letterSpacingPx, maxWidthPx, wordWrap, textAlign };
};

const normalizeRequest = (request) => {
  if (request === null || typeof request !== 'object') invalidRequest('request must be an object');
  const {
    text, face, fontSizePx, lineHeightPx = null, paddingPx = 1, requireExactFace = true,
    textTransform = 'none', letterSpacingPx = 0, maxWidthPx = null, wordWrap = true,
    textAlign = 'left',
  } = request;

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
  const shaping = normalizeShaping({ textTransform, letterSpacingPx, maxWidthPx, wordWrap, textAlign });

  // The transform runs before the length bound because it is what decides the length: uppercasing
  // can lengthen a string, and the bound belongs to the text that is actually baked.
  const shaped = applyTextTransform(text, shaping.textTransform);
  if ([...shaped].length > GLYPH_ATLAS_LIMITS.maxTextCodePoints) {
    fail('glyphAtlasTextTooLong', `The text exceeds ${GLYPH_ATLAS_LIMITS.maxTextCodePoints} code points and is rejected rather than truncated`);
  }

  const normalizedFace = normalizeFace(face);
  return {
    text: shaped,
    face: { ...normalizedFace, fontSizePx },
    lineHeightPx,
    paddingPx,
    requireExactFace,
    ...shaping,
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

// Bake

const canonicalizeLayout = (layout) => [
  `${layout.textTransform}|${layout.letterSpacingPx}|${layout.maxWidthPx ?? 'none'}`,
  `${layout.wordWrap ? 1 : 0}|${layout.textAlign}|${layout.cellAdvanceLayout}`,
  `${layout.lineCount}|${layout.widthPx}|${layout.heightPx}`,
  ...layout.lines.map((line) => [
    line.glyphs.join('.'), line.penXPx.join('.'), line.advanceWidthPx, line.measuredWidthPx,
    line.shapingResidualPx, line.baselineYPx, line.justificationPx, line.endsParagraph ? 1 : 0,
  ].join(',')),
];

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
    `${metrics.letterSpacingPx}`,
    `${atlas.widthPx}|${atlas.heightPx}|${atlas.paddingPx}|${atlas.glyphCount}`,
    ...canonicalizeLayout(descriptor.layout),
    ...glyphs,
  ].join('\n');
};

/**
 * Bake the glyphs a text run needs into a packed atlas, and lay that run out into lines.
 *
 * `request` is `{ text, face: { family, weight = 400, style = 'normal' }, fontSizePx,
 * lineHeightPx = null, paddingPx = 1, requireExactFace = true, textTransform = 'none',
 * letterSpacingPx = 0, maxWidthPx = null, wordWrap = true, textAlign = 'left' }`; oversize input is
 * rejected, never truncated, and `requireExactFace` makes any substitution a hard failure.
 * `options.surface` injects the measurement surface and defaults to canvas 2D. Returns a frozen,
 * versioned descriptor whose `pixels` is tightly packed RGBA8 — its alpha channel is the coverage
 * mask — and whose `layout` is the per-line run the compositor draws. The caller owns staging both.
 *
 * A cell is rasterized from the CONTEXTUAL FORM the run gives its cluster, not always from the bare
 * cluster: see `glyphAtlasCells.js`. `glyphs[].cluster` therefore carries the text the cell was
 * baked from, which for a joined form is the cluster plus the zero-width joiners that spell it.
 */
export const bakeGlyphAtlas = (request, options = {}) => {
  const {
    text, face, lineHeightPx, paddingPx, requireExactFace,
    textTransform, letterSpacingPx, maxWidthPx, wordWrap, textAlign,
  } = normalizeRequest(request);
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
  const measureWidth = (value) => round4(readMeasurement(surface.measure(cssFont, value), 'a text run').width);
  const runAdvanceWidthPx = measureWidth(text);

  // One cell, from whatever text the run says that cell is: the bare cluster on the isolated path,
  // the cluster plus its context joiners on the contextual one.
  const measureCellText = (cellText) => {
    const measurement = readMeasurement(surface.measure(cssFont, cellText), 'a glyph cluster');
    const substituted = INKED_PATTERN.test(cellText) && probeCluster(surface, face, families, cellText);
    if (substituted && requireExactFace) {
      // The message names the face and nothing else: the cluster it failed on is the user's own
      // subtitle text, which never leaves this module in an error.
      fail('glyphAtlasFaceSubstituted', `The face "${face.family}" does not cover part of the text and the engine substituted another face`);
    }
    return {
      cluster: cellText,
      codePoints: [...cellText].map((character) => character.codePointAt(0)),
      direction: directionOf(cellText),
      advanceWidthPx: round4(measurement.width),
      substituted,
      cell: measureCell(measurement, paddingPx),
    };
  };

  const isolatedCells = uniqueClusters(clusters);
  const isolatedIndexOf = new Map(isolatedCells.map((cluster, index) => [cluster, index]));
  const isolatedEntries = isolatedCells.map(measureCellText);
  const isolatedAdvanceOf = new Map(isolatedEntries.map((entry) => [entry.cluster, entry.advanceWidthPx]));
  const isolatedResidualPx = round4(
    runAdvanceWidthPx - clusters.reduce((total, cluster) => total + isolatedAdvanceOf.get(cluster), 0)
  );

  // Non-zero means the engine applied kerning, a ligature or a contextual form across cluster
  // boundaries, so summing per-cell advances does not reproduce the run. That is the one condition
  // under which contextual cells are worth resolving, and resolving them is also what can make the
  // residual go away: the contextual advances come from the run's own progressive prefixes, so they
  // sum to the run exactly. A run nothing can spell per cluster comes back `null` and keeps both the
  // isolated cells and the residual that refuses to lay them out.
  const resolved = isolatedResidualPx === 0
    ? null
    : resolveContextualCells({ clusters, runAdvanceWidthPx, measureWidth, limits: GLYPH_ATLAS_LIMITS });

  const isolatedBake = {
    measured: isolatedEntries,
    advanceAt: (index) => isolatedAdvanceOf.get(clusters[index]),
    cellIndexAt: (index) => isolatedIndexOf.get(clusters[index]),
    shapingResidualPx: isolatedResidualPx,
  };
  const contextualBake = () => {
    const measured = resolved.cells.map(measureCellText);
    return {
      measured,
      advanceAt: resolved.advanceAt,
      cellIndexAt: resolved.cellIndexAt,
      shapingResidualPx: round4(
        runAdvanceWidthPx - clusters.reduce((total, _cluster, index) => total + resolved.advanceAt(index), 0)
      ),
    };
  };

  // Four cells where there was one is four times the atlas, so a run can resolve and still not fit.
  // Falling back to the isolated cells then loses the contextual forms, which is a worse picture but
  // a picture; failing the bake would lose the run entirely for a reason the caller cannot act on.
  let chosen = null;
  for (const bake of resolved === null ? [isolatedBake] : [contextualBake(), isolatedBake]) {
    const packed = packAtlas(bake.measured.map(({ cell }) => cell));
    if (packed === null) continue;
    chosen = { ...bake, atlas: packed };
    break;
  }
  if (chosen === null) {
    fail('glyphAtlasTooLarge', `The glyphs do not fit within a ${GLYPH_ATLAS_LIMITS.maxAtlasDimensionPx}px atlas`);
  }
  const { measured, advanceAt, cellIndexAt, shapingResidualPx, atlas } = chosen;

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

  const baseDirection = glyphs.length === 0
    ? 'ltr'
    : (clusters.map(directionOf).find((direction) => direction !== 'neutral') ?? 'ltr');
  const resolvedLineHeightPx = round4(lineHeightPx ?? ascentPx + descentPx);

  const layout = buildTextLayout({
    text,
    clusters,
    cellIndexOf: cellIndexAt,
    advanceOf: advanceAt,
    textTransform,
    letterSpacingPx,
    maxWidthPx,
    wordWrap,
    textAlign,
    lineHeightPx: resolvedLineHeightPx,
    baselinePx: ascentPx,
    measureLineWidth: (lineText) => readMeasurement(surface.measure(cssFont, lineText), 'a laid-out line').width,
    runShapingResidualPx: shapingResidualPx,
    directionNeedsBidi: baseDirection === 'rtl' || glyphs.some((glyph) => glyph.direction === 'rtl'),
    limits: GLYPH_ATLAS_LIMITS,
  });

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
      lineHeightPx: resolvedLineHeightPx,
      baselinePx: ascentPx,
      runAdvanceWidthPx,
      shapingResidualPx,
      baseDirection,
      // Carried in the metrics so the compositor positions from the spacing the WebView applied
      // rather than re-deriving it from a style field that was scaled somewhere else.
      letterSpacingPx: round4(letterSpacingPx),
    },
    atlas: {
      widthPx: atlas.widthPx,
      heightPx: atlas.heightPx,
      paddingPx,
      glyphCount: glyphs.length,
      pixelFormat: 'rgba8',
      bytesPerRow: atlas.widthPx * 4,
    },
    layout,
    glyphs,
  };

  const contentHash = fnv1a32(pixels, hashText(canonicalize(descriptor)))
    .toString(16)
    .padStart(8, '0');
  return deepFreeze({ ...descriptor, contentHash, pixels });
};
