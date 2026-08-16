/**
 * The bake itself: one atlas, one or many runs laid out against it.
 *
 * WHY ONE ENGINE FOR BOTH ENTRY POINTS. The preview bakes one cue at a time and the export bakes a
 * whole cue list, and the two must produce the *same* cells for the same text or the export stops
 * being a proof of the preview. So there is one pipeline, and the single-run entry point is the
 * one-element case of it: a call with one text produces a byte-identical descriptor, `contentHash`
 * included, to the one the preview has always received.
 *
 * WHY A CUE LIST IS NOT n ATLASES. `osg_compositor::SubtitleScene` validates every staged run's cell
 * indices against ONE glyph table, and refuses a run count that is not the cue count. n separate
 * atlases cannot be used and cannot be merged natively, so an export of n cues is one atlas whose
 * cell table covers the union of every cue's cells, plus n layouts against that same table.
 *
 * WHAT THE UNION IS OVER. Not characters — FORMS. A cluster's cell depends on the form the run gives
 * it (see `glyphAtlasCells.js`), so `ب` initial in one cue and `ب` medial in another are two cells,
 * and each cue's layout indexes the one its own run resolved. The table is `sortedUnique` over the
 * cell texts, which is the strictly-increasing, duplicate-free order `crates/osg-scene` re-derives;
 * appending one run's cells to another's would violate it.
 *
 * WHICH RUN THE DESCRIPTOR'S OWN `layout` AND RUN-SCOPED METRICS BELONG TO. The first. The descriptor
 * shape carries exactly one layout and one `runAdvanceWidthPx`, a cue list has n of each, and the
 * first is the only choice that makes a one-cue call identical to what the preview already gets.
 * Every cue's own layout is returned alongside, in `runs`. The cue-set caller is responsible for the
 * agreements that a single carried layout cannot express across n cues — see `bakeGlyphAtlasForCues`.
 *
 * Determinism: no clocks, no RNG. The cell table is sorted, the packing walks it in that order, and
 * every measurement is a pure function of the text and the face, so the same request bakes the same
 * bytes.
 */

import { measureCell, packAtlas, resolveContextualCells, sortedUnique } from './glyphAtlasCells';
import { deepFreeze, fail, fnv1a32, hashText, round4 } from './glyphAtlasCore';
import { FACE_PROBE_TEXT, METRIC_PROBE_TEXT, probeCluster, probeFace } from './glyphAtlasFace';
import { buildCssFont, normalizeSharedRequest, normalizeText } from './glyphAtlasRequest';
import { buildTextLayout } from './glyphAtlasShaping';
import { readMeasurement, resolveSurface } from './glyphAtlasSurface';

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

const isRtlCodePoint = (codePoint) => RTL_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);

const directionOf = (cluster) => {
  for (const character of cluster) {
    if (isRtlCodePoint(character.codePointAt(0))) return 'rtl';
  }
  return STRONG_LTR_PATTERN.test(cluster) ? 'ltr' : 'neutral';
};

/**
 * Grapheme clusters, not code units and not code points, are the rasterization unit: a combining
 * mark, a Hangul jamo sequence and an emoji ZWJ sequence each stay welded to their base. A fixed
 * locale keeps the segmentation independent of the host UI language.
 */
const segmentClusters = (text, limits) => {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    fail('glyphAtlasSegmenterUnavailable', 'Grapheme segmentation is unavailable, so the atlas cannot be baked deterministically');
  }
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const clusters = [];
  for (const { segment } of segmenter.segment(text)) {
    if ([...segment].length > limits.maxClusterCodePoints) {
      fail('glyphAtlasClusterTooLong', `A grapheme cluster exceeds ${limits.maxClusterCodePoints} code points`);
    }
    clusters.push(segment);
  }
  return clusters;
};

const codePointCount = (text) => [...text].length;

/**
 * Which bound a candidate cell table breaks, or `null` when it breaks none.
 *
 * Both bounds are on the TABLE, not on one run: `crates/osg-scene` enforces the glyph count and the
 * total cluster code points against the descriptor's own cell list, so a cue set whose union
 * overflows either is one no descriptor could carry. Returned rather than raised because the
 * contextual table has a fallback and the isolated one does not.
 */
const tableOverflow = (cellTexts, limits) => {
  if (cellTexts.length > limits.maxGlyphCount) return 'glyphAtlasTooManyGlyphs';
  const codePoints = cellTexts.reduce((total, cellText) => total + codePointCount(cellText), 0);
  return codePoints > limits.maxTextCodePoints ? 'glyphAtlasTextTooLong' : null;
};

const OVERFLOW_MESSAGES = Object.freeze({
  glyphAtlasTooManyGlyphs: (limits) => `More than ${limits.maxGlyphCount} distinct glyph cells are needed`,
  glyphAtlasTextTooLong: (limits) => `The distinct glyph cells exceed ${limits.maxTextCodePoints} code points and are rejected rather than truncated`,
});

const canonicalizeLayout = (layout) => [
  `${layout.textTransform}|${layout.letterSpacingPx}|${layout.maxWidthPx ?? 'none'}`,
  `${layout.wordWrap ? 1 : 0}|${layout.textAlign}|${layout.cellAdvanceLayout}`,
  `${layout.lineCount}|${layout.widthPx}|${layout.heightPx}`,
  ...layout.lines.map((line) => [
    line.glyphs.join('.'), line.penXPx.join('.'), line.advanceWidthPx, line.measuredWidthPx,
    line.shapingResidualPx, line.baselineYPx, line.justificationPx, line.endsParagraph ? 1 : 0,
  ].join(',')),
];

/**
 * The descriptor's identity, as lines. Every run is folded in, the first through the descriptor's
 * own layout and the rest appended, so two cue sets that share a cell table but not a layout are
 * two different atlases. A one-run bake appends nothing, which is what keeps its hash the hash it
 * has always had.
 */
const canonicalize = (descriptor, extraRuns) => {
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
    ...extraRuns.flatMap(canonicalizeLayout),
  ].join('\n');
};

/**
 * Bake one atlas for `texts` and lay every one of them out against it.
 *
 * `request` carries everything but the text — the face, the raster geometry and the shaping options
 * — while `limits` and `version` arrive from `glyphAtlas.js`, which is the single home of both.
 * Returns `{ descriptor, runs }`: `runs[i]` is `texts[i]`'s layout, `runs[0]` is the descriptor's own
 * `layout`, and `descriptor.pixels` is tightly packed RGBA8 whose alpha channel is the coverage
 * mask. The caller owns staging both, and owns whatever agreements across runs its own contract
 * needs. `texts` must hold at least one string; the entry points guarantee it.
 */
export const bakeAtlas = ({ texts, request, limits, version }, options = {}) => {
  const {
    face, lineHeightPx, paddingPx, requireExactFace,
    textTransform, letterSpacingPx, maxWidthPx, wordWrap, textAlign, baseDirection,
  } = normalizeSharedRequest(request, limits);
  const shaped = texts.map((text) => normalizeText(text, textTransform, limits));
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
  const measureWidth = (value) => round4(readMeasurement(surface.measure(cssFont, value), 'a text run').width);

  // One cell, from whatever text the run says that cell is: the bare cluster on the isolated path,
  // the cluster plus its context joiners on the contextual one. Memoized because a cue list asks for
  // the same cell from many runs and each answer costs seven measurements.
  const measured = new Map();
  const measureCellText = (cellText) => {
    const known = measured.get(cellText);
    if (known !== undefined) return known;
    const measurement = readMeasurement(surface.measure(cssFont, cellText), 'a glyph cluster');
    const substituted = INKED_PATTERN.test(cellText) && probeCluster(surface, face, families, cellText);
    if (substituted && requireExactFace) {
      // The message names the face and nothing else: the cluster it failed on is the user's own
      // subtitle text, which never leaves this module in an error.
      fail('glyphAtlasFaceSubstituted', `The face "${face.family}" does not cover part of the text and the engine substituted another face`);
    }
    const entry = {
      cluster: cellText,
      codePoints: [...cellText].map((character) => character.codePointAt(0)),
      direction: directionOf(cellText),
      advanceWidthPx: round4(measurement.width),
      substituted,
      cell: measureCell(measurement, paddingPx),
    };
    measured.set(cellText, entry);
    return entry;
  };

  const segmented = shaped.map((text) => ({
    text,
    clusters: segmentClusters(text, limits),
    runAdvanceWidthPx: measureWidth(text),
  }));

  // The isolated table is the fallback, so its bounds are raised rather than returned: nothing else
  // is left to try. It is also the smaller of the two tables — a contextual cell is only ever added
  // beside the cluster it spells — so checking it first refuses an oversize cue set before any of it
  // is measured.
  // Accumulated into a set rather than flattened first: a long track has millions of cluster
  // positions and only as many distinct cells as its alphabet has.
  const isolatedUnique = new Set();
  for (const run of segmented) {
    for (const cluster of run.clusters) isolatedUnique.add(cluster);
  }
  const isolatedCells = sortedUnique(isolatedUnique);
  const isolatedOverflow = tableOverflow(isolatedCells, limits);
  if (isolatedOverflow !== null) fail(isolatedOverflow, OVERFLOW_MESSAGES[isolatedOverflow](limits));
  const isolatedAdvanceOf = new Map(
    isolatedCells.map((cellText) => [cellText, measureCellText(cellText).advanceWidthPx])
  );

  // Non-zero means the engine applied kerning, a ligature or a contextual form across cluster
  // boundaries, so summing per-cell advances does not reproduce that run. That is the one condition
  // under which contextual cells are worth resolving, and resolving them is also what can make the
  // residual go away: the contextual advances come from the run's own progressive prefixes, so they
  // sum to the run exactly. A run nothing can spell per cluster resolves to `null` and keeps both
  // the isolated cells and the residual that refuses to lay them out.
  const resolvedRuns = segmented.map((run) => {
    const isolatedResidualPx = round4(
      run.runAdvanceWidthPx - run.clusters.reduce((total, cluster) => total + isolatedAdvanceOf.get(cluster), 0)
    );
    return {
      ...run,
      isolatedResidualPx,
      resolved: isolatedResidualPx === 0
        ? null
        : resolveContextualCells({
          clusters: run.clusters,
          runAdvanceWidthPx: run.runAdvanceWidthPx,
          measureWidth,
          limits,
        }),
    };
  });

  const isolatedPlan = (run) => ({
    cellTextAt: (index) => run.clusters[index],
    advanceAt: (index) => isolatedAdvanceOf.get(run.clusters[index]),
    shapingResidualPx: run.isolatedResidualPx,
  });
  const contextualPlan = (run) => {
    if (run.resolved === null) return isolatedPlan(run);
    const { cells, advanceAt, cellIndexAt } = run.resolved;
    return {
      cellTextAt: (index) => cells[cellIndexAt(index)],
      advanceAt,
      shapingResidualPx: round4(
        run.runAdvanceWidthPx - run.clusters.reduce((total, _cluster, index) => total + advanceAt(index), 0)
      ),
    };
  };

  const buildTable = (planOf) => {
    const plans = resolvedRuns.map(planOf);
    const unique = new Set();
    for (const [run, plan] of plans.entries()) {
      const { clusters } = resolvedRuns[run];
      for (let position = 0; position < clusters.length; position += 1) unique.add(plan.cellTextAt(position));
    }
    const cellTexts = sortedUnique(unique);
    if (tableOverflow(cellTexts, limits) !== null) return null;
    const entries = cellTexts.map(measureCellText);
    const atlas = packAtlas(entries.map(({ cell }) => cell));
    if (atlas === null) return null;
    return { plans, entries, atlas, cellIndexOf: new Map(cellTexts.map((cellText, index) => [cellText, index])) };
  };

  // Four cells where there was one is four times the atlas, so a cue set can resolve and still not
  // fit. Falling back to the isolated cells then loses the contextual forms, which is a worse picture
  // but a picture; failing the bake would lose every run for a reason the caller cannot act on.
  const candidates = resolvedRuns.some((run) => run.resolved !== null)
    ? [contextualPlan, isolatedPlan]
    : [isolatedPlan];
  let chosen = null;
  for (const planOf of candidates) {
    chosen = buildTable(planOf);
    if (chosen !== null) break;
  }
  if (chosen === null) {
    fail('glyphAtlasTooLarge', `The glyphs do not fit within a ${limits.maxAtlasDimensionPx}px atlas`);
  }
  const { plans, entries, atlas, cellIndexOf } = chosen;

  const glyphs = entries.map((entry, index) => ({
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

  const resolvedLineHeightPx = round4(lineHeightPx ?? ascentPx + descentPx);

  // The coarse first-strong classification the descriptor has always reported. It is PROVENANCE
  // only: the layout resolves the real paragraph level through UAX #9, and the two can legitimately
  // disagree — a run opening with an Arabic comma is neutral to the algorithm and 'rtl' to a block
  // test. Where they disagree, the layout is the answer. Derived per run, so one right-to-left cue
  // does not widen what the bidi pass refuses in a Latin one.
  const baseDirectionOf = (run) => (run.clusters.length === 0
    ? 'ltr'
    : (run.clusters.map(directionOf).find((direction) => direction !== 'neutral') ?? 'ltr'));

  const layouts = resolvedRuns.map((run, index) => {
    const plan = plans[index];
    const cellIndexAt = (position) => cellIndexOf.get(plan.cellTextAt(position));
    const metricsBaseDirection = baseDirectionOf(run);
    return buildTextLayout({
      text: run.text,
      clusters: run.clusters,
      cellIndexOf: cellIndexAt,
      advanceOf: plan.advanceAt,
      textTransform,
      letterSpacingPx,
      maxWidthPx,
      wordWrap,
      textAlign,
      baseDirection,
      lineHeightPx: resolvedLineHeightPx,
      baselinePx: ascentPx,
      measureLineWidth: (lineText) => readMeasurement(surface.measure(cssFont, lineText), 'a laid-out line').width,
      runShapingResidualPx: plan.shapingResidualPx,
      directionNeedsBidi: metricsBaseDirection === 'rtl'
        || run.clusters.some((_cluster, position) => glyphs[cellIndexAt(position)].direction === 'rtl'),
      limits,
    });
  });

  const descriptor = {
    version,
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
      runAdvanceWidthPx: resolvedRuns[0].runAdvanceWidthPx,
      shapingResidualPx: plans[0].shapingResidualPx,
      baseDirection: baseDirectionOf(resolvedRuns[0]),
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
    layout: layouts[0],
    glyphs,
  };

  const contentHash = fnv1a32(pixels, hashText(canonicalize(descriptor, layouts.slice(1))))
    .toString(16)
    .padStart(8, '0');
  return {
    descriptor: deepFreeze({ ...descriptor, contentHash, pixels }),
    runs: deepFreeze(layouts),
  };
};
