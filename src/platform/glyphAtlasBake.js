/**
 * The bake itself: the atlas pages a cue list needs, and one run laid out against each cue's page.
 *
 * WHY ONE ENGINE FOR BOTH ENTRY POINTS. The preview bakes one cue at a time and the export bakes a
 * whole cue list, and the two must produce the *same* cells for the same text or the export stops
 * being a proof of the preview. So there is one pipeline, and the single-run entry point is the
 * one-element case of it: a call with one text produces a byte-identical descriptor, `contentHash`
 * included, to the one the preview has always received.
 *
 * WHY A CUE LIST IS PAGED RATHER THAN UNIONED INTO ONE ATLAS. `osg_compositor::CueRun` validates its
 * cell indices against ONE glyph table, and a table is bounded at `maxGlyphCount` cells. A union
 * over every cue therefore held a document hostage to its own alphabet: Latin never noticed, and
 * Chinese, Korean or emoji-heavy tracks were refused. So the cue list is split across pages, each
 * page is a table, and each cue is laid out against the page it landed on. `glyphAtlasPaging.js`
 * decides the split and `glyphAtlasPage.js` bakes one page.
 *
 * WHAT A PAGE'S TABLE IS OVER. Not characters — FORMS. A cluster's cell depends on the form the run
 * gives it (see `glyphAtlasCells.js`), so `ب` initial in one cue and `ب` medial in another are two
 * cells, and each cue's layout indexes the one its own run resolved. A page's table is `sortedUnique`
 * over its cues' cell texts, which is the strictly-increasing, duplicate-free order
 * `crates/osg-scene` re-derives; appending one run's cells to another's would violate it.
 *
 * WHICH RUN A PAGE'S OWN `layout` AND RUN-SCOPED METRICS BELONG TO. The first cue that page serves.
 * A descriptor carries exactly one layout and one `runAdvanceWidthPx`, a page serves n cues, and the
 * first is the only choice that makes a one-cue call identical to what the preview already gets.
 * Every cue's own layout is returned alongside, in `runs`.
 *
 * Determinism: no clocks, no RNG. The cell table is sorted, the packing walks it in that order, and
 * every measurement is a pure function of the text and the face, so the same request bakes the same
 * bytes.
 */

import { measureCell, packAtlas, resolveContextualCells, sortedUnique } from './glyphAtlasCells';
import { deepFreeze, fail, round4 } from './glyphAtlasCore';
import { FACE_PROBE_TEXT, METRIC_PROBE_TEXT, probeCluster, probeFace } from './glyphAtlasFace';
import { bakePage } from './glyphAtlasPage';
import { packRunAlone, partitionRunsIntoPages, tableOverflow } from './glyphAtlasPaging';
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

const totalCodePoints = (cellTexts) => cellTexts.reduce(
  (total, cellText) => total + codePointCount(cellText),
  0,
);

/**
 * Bake `texts` into as many atlas pages as their alphabet needs, and lay every one of them out.
 *
 * `request` carries everything but the text — the face, the raster geometry and the shaping options
 * — while `limits` and `version` arrive from `glyphAtlas.js`, which is the single home of both.
 * Returns `{ pages, runs, pageOfCue }`: `pages[p]` is a descriptor whose `pixels` is tightly packed
 * RGBA8 with the coverage mask in alpha, `runs[i]` is `texts[i]`'s layout indexed into
 * `pages[pageOfCue[i]]`, and `pages[p].layout` is the layout of the first cue that page serves. The
 * caller owns staging every page. `texts` must hold at least one string; the entry points guarantee
 * it.
 *
 * A cue list whose alphabet fits one page produces exactly one, and a single text always does — so
 * the preview's one-cue bake is byte-identical to the page an export of that same cue produces,
 * which is what makes the export a proof of the preview rather than merely similar to it.
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

  // Accumulated into a set rather than flattened first: a long track has millions of cluster
  // positions and only as many distinct cells as its alphabet has.
  const isolatedUnique = new Set();
  for (const run of segmented) {
    for (const cluster of run.clusters) isolatedUnique.add(cluster);
  }
  // The one whole-document bound, and it is a work bound rather than a capacity one: every distinct
  // cluster below is measured, at seven measurements each on the contextual path, and a document
  // with more distinct clusters than every page together could carry cannot be baked whatever the
  // pages do. Refusing here means that document costs one set walk instead of a few hundred thousand
  // canvas measurements it was always going to throw away.
  if (isolatedUnique.size > limits.maxGlyphCount * limits.maxAtlasPages) {
    fail(
      'glyphAtlasTooManyPages',
      `The subtitles use more than ${limits.maxGlyphCount * limits.maxAtlasPages} distinct characters, which is more than ${limits.maxAtlasPages} glyph atlas pages can carry`
    );
  }
  const isolatedCells = sortedUnique(isolatedUnique);
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

  const cellsOfPlan = (run, plan) => {
    const unique = new Set();
    for (let position = 0; position < run.clusters.length; position += 1) {
      unique.add(plan.cellTextAt(position));
    }
    return sortedUnique(unique);
  };
  const cellOf = (cellText) => measureCellText(cellText).cell;

  // Four cells where there was one is four times the table, so a run can resolve contextually and
  // still not fit a page alone. Falling back to its isolated cells then loses the contextual forms,
  // which is a worse picture but a picture.
  //
  // WHY THE FALLBACK IS PER RUN AND NO LONGER PER DOCUMENT. It used to be one decision for every
  // cue: an oversize cue dragged every other cue down to isolated cells with it, so a track with one
  // long Arabic line drew the whole document in the wrong glyph forms. It also meant a cue's cells
  // depended on which cues it happened to be baked beside, which is exactly the preview/export
  // divergence this pipeline exists to remove — the preview bakes one cue, the export bakes them
  // all. Deciding per run makes a cue's cells a function of that cue and nothing else.
  const planned = resolvedRuns.map((run) => {
    const isolated = isolatedPlan(run);
    const isolatedCellTexts = cellsOfPlan(run, isolated);
    if (run.resolved !== null) {
      const contextual = contextualPlan(run);
      const cellTexts = cellsOfPlan(run, contextual);
      const codePoints = totalCodePoints(cellTexts);
      if (tableOverflow(cellTexts, codePoints, limits) === null) {
        const packed = packAtlas(cellTexts.map(cellOf));
        if (packed !== null) return { run, plan: contextual, cellTexts, codePoints, packed };
      }
    }
    const codePoints = totalCodePoints(isolatedCellTexts);
    return {
      run,
      plan: isolated,
      cellTexts: isolatedCellTexts,
      codePoints,
      // Nothing is left to try, so this refuses rather than returning null.
      packed: packRunAlone(isolatedCellTexts, codePoints, cellOf, limits),
    };
  });

  const resolvedLineHeightPx = round4(lineHeightPx ?? ascentPx + descentPx);

  // The coarse first-strong classification the descriptor has always reported. It is PROVENANCE
  // only: the layout resolves the real paragraph level through UAX #9, and the two can legitimately
  // disagree — a run opening with an Arabic comma is neutral to the algorithm and 'rtl' to a block
  // test. Where they disagree, the layout is the answer. Derived per run, so one right-to-left cue
  // does not widen what the bidi pass refuses in a Latin one.
  const baseDirectionOf = (run) => (run.clusters.length === 0
    ? 'ltr'
    : (run.clusters.map(directionOf).find((direction) => direction !== 'neutral') ?? 'ltr'));

  // Laid out against the run's OWN cell table, before any page exists, because the page a cue lands
  // on depends on the alignment its layout resolves to. Indices are the only part a page changes,
  // and `glyphAtlasPage.js` remaps them — geometry, wrapping, pen positions and visual order all
  // come from advances and never from an index, so the picture does not move.
  const laid = planned.map((entry) => {
    const { run, plan, cellTexts } = entry;
    const localIndexOf = new Map(cellTexts.map((cellText, index) => [cellText, index]));
    const cellIndexAt = (position) => localIndexOf.get(plan.cellTextAt(position));
    const baseDirectionOfRun = baseDirectionOf(run);
    const layout = buildTextLayout({
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
      directionNeedsBidi: baseDirectionOfRun === 'rtl'
        || run.clusters.some((_cluster, position) => measureCellText(plan.cellTextAt(position)).direction === 'rtl'),
      limits,
    });
    return {
      ...entry,
      layout,
      textAlign: layout.textAlign,
      runAdvanceWidthPx: run.runAdvanceWidthPx,
      shapingResidualPx: plan.shapingResidualPx,
      baseDirection: baseDirectionOfRun,
    };
  });

  const partitioned = partitionRunsIntoPages(laid, cellOf, limits);
  const shared = {
    cssFont,
    face,
    metrics: {
      ascentPx,
      descentPx,
      lineHeightPx: resolvedLineHeightPx,
      baselinePx: ascentPx,
      // Carried in the metrics so the compositor positions from the spacing the WebView applied
      // rather than re-deriving it from a style field that was scaled somewhere else.
      letterSpacingPx: round4(letterSpacingPx),
    },
    paddingPx,
    surface,
    version,
    measureCellText,
    probes: probes.map((probe) => ({ ...probe, participated: probe.aloneWidthPx !== probe.chainedWidthPx })),
  };

  const pages = [];
  const runs = new Array(laid.length);
  const pageOfCue = new Array(laid.length);
  for (const [index, page] of partitioned.entries()) {
    const { descriptor, layouts } = bakePage({ page, runs: laid, shared });
    pages.push(descriptor);
    page.cues.forEach((cue, position) => {
      runs[cue] = layouts[position];
      pageOfCue[cue] = index;
    });
  }

  return {
    pages: deepFreeze(pages),
    runs: deepFreeze(runs),
    pageOfCue: deepFreeze(pageOfCue),
  };
};
