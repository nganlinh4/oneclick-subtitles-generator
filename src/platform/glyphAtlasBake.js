/**
 * The bake itself: the atlas pages a cue list needs, and one run laid out against each cue's page.
 *
 * ONE SHAPING RESULT OWNS BOTH THE PIXELS AND THE PLACEMENT. A cell is a whole shaped line. The line
 * is handed to the engine once, with its final face, size, transform, letter spacing, word spacing
 * and paragraph direction, and that single call returns the mask, its ink box and its advance. The
 * number used to place the mask is the number that measuring the mask produced, so there is no
 * second quantity for it to disagree with.
 *
 * WHAT THAT REPLACED. A line used to be drawn by placing per-cluster cells at accumulated pen
 * positions, which is only correct if the width of a run equals the sum of its parts. Kerning makes
 * that false for ordinary Latin; ligatures and cursive joining make it false in a way no per-cluster
 * spelling can repair. The baker measured both ways and refused the run when they differed by
 * anything at all after rounding to four decimals — so editing a cue was enough to stop it drawing.
 * The apparatus that tried to repair it (zero-width-joiner spellings probed against progressive
 * prefixes) and the refusal it ended in are both gone; there is nothing left to reconcile.
 *
 * WHAT IT COSTS. Identity is per line rather than per character, so a document's cell count follows
 * its distinct LINES rather than its alphabet. `glyphAtlasPaging.js` spends pages on that.
 *
 * WHY ONE ENGINE FOR BOTH ENTRY POINTS. The preview bakes one cue at a time and the export bakes a
 * whole cue list, and the two must produce the *same* cells for the same text or the export stops
 * being a proof of the preview. So there is one pipeline, and the single-run entry point is the
 * one-element case of it: a call with one text produces a byte-identical descriptor, `contentHash`
 * included, to the one the preview receives.
 *
 * WHY A CUE LIST IS PAGED RATHER THAN UNIONED INTO ONE ATLAS. `osg_compositor::CueRun` validates its
 * cell indices against ONE glyph table, and a table is bounded at `maxGlyphCount` cells. So the cue
 * list is split across pages, each page is a table, and each cue is laid out against the page it
 * landed on. `glyphAtlasPaging.js` decides the split and `glyphAtlasPage.js` bakes one page.
 *
 * WHICH RUN A PAGE'S OWN `layout` AND RUN-SCOPED METRICS BELONG TO. The first cue that page serves.
 * A descriptor carries exactly one layout and one `runAdvanceWidthPx`, a page serves n cues, and the
 * first is the only choice that makes a one-cue call identical to what the preview already gets.
 * Every cue's own layout is returned alongside, in `runs`.
 *
 * Determinism: no clocks, no RNG. The cell table is sorted, the packing walks it in that order, and
 * every measurement is a pure function of the text, the options and the face, so the same request
 * bakes the same bytes.
 */

import { cellCodePoints, cellKeyOf, measureCell, sortedUniqueCells } from './glyphAtlasCells';
import { deepFreeze, fail, round4 } from './glyphAtlasCore';
import { FACE_PROBE_TEXT, METRIC_PROBE_TEXT, probeCluster, probeFace } from './glyphAtlasFace';
import { bakePage } from './glyphAtlasPage';
import { packRunAlone, partitionRunsIntoPages } from './glyphAtlasPaging';
import { buildCssFont, normalizeSharedRequest, normalizeText } from './glyphAtlasRequest';
import { buildTextLayout } from './glyphAtlasShaping';
import { readMeasurement, resolveSurface } from './glyphAtlasSurface';

const INKED_PATTERN = /[\p{L}\p{N}\p{S}\p{P}\p{M}]/u;

/**
 * Grapheme clusters, not code units and not code points, are the unit line breaking searches over: a
 * combining mark, a Hangul jamo sequence and an emoji ZWJ sequence each stay welded to their base,
 * so a line can never be broken through the middle of one. A fixed locale keeps the segmentation
 * independent of the host UI language.
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

/**
 * Bake `texts` into as many atlas pages as their lines need, and lay every one of them out.
 *
 * `request` carries everything but the text — the face, the raster geometry and the shaping options
 * — while `limits` and `version` arrive from `glyphAtlas.js`, which is the single home of both.
 * Returns `{ pages, runs, pageOfCue }`: `pages[p]` is a descriptor whose `pixels` is tightly packed
 * RGBA8 with the coverage mask in alpha, `runs[i]` is `texts[i]`'s layout indexed into
 * `pages[pageOfCue[i]]`, and `pages[p].layout` is the layout of the first cue that page serves. The
 * caller owns staging every page. `texts` must hold at least one string; the entry points guarantee
 * it.
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
  const resolvedLineHeightPx = round4(lineHeightPx ?? ascentPx + descentPx);

  /**
   * Every measurement the bake takes, with the run's letter spacing already applied.
   *
   * Memoized on the exact tuple that decides the result, because line breaking probes the same
   * prefixes repeatedly and a page rasterizes cells it has already measured. The key puts the text
   * last so a text containing the separator cannot spell another entry's key.
   */
  const measurements = new Map();
  const measureShaped = (text, wordSpacingPx, direction) => {
    const key = `${direction}|${wordSpacingPx}|${text}`;
    const known = measurements.get(key);
    if (known !== undefined) return known;
    const metrics = readMeasurement(
      surface.measure(cssFont, text, { letterSpacingPx, wordSpacingPx, direction }),
      'a shaped line',
    );
    measurements.set(key, metrics);
    return metrics;
  };
  const measureLine = (text, { wordSpacingPx, direction }) => (
    measureShaped(text, wordSpacingPx, direction).width
  );

  /**
   * The cell one laid-out line is drawn from, measured once and shared by every line that draws the
   * same picture.
   *
   * An empty line has no cell rather than an empty one: a cell with no text is not a thing the wire
   * can describe, and there is nothing to draw.
   */
  /**
   * Whether the engine had to fall back to another face for one grapheme.
   *
   * Probed PER CLUSTER even though a cell is a whole line, because that is the granularity the
   * question has an answer at: a line of Latin with one emoji in it is drawn from the requested face
   * almost everywhere, so probing the line as a whole would report it as covered and the emoji's
   * fallback would go unreported. This is the check that found 88 of 115 selectable families
   * silently substituted, and it only works one character at a time.
   */
  const substitutionByCluster = new Map();
  const clusterSubstituted = (cluster) => {
    const known = substitutionByCluster.get(cluster);
    if (known !== undefined) return known;
    const substituted = INKED_PATTERN.test(cluster)
      && probeCluster(surface, face, families, cluster);
    substitutionByCluster.set(cluster, substituted);
    return substituted;
  };

  const cellsByKey = new Map();
  const cellFor = (line) => {
    if (line.contentText.length === 0) return null;
    const key = cellKeyOf({
      direction: line.direction,
      advanceWidthPx: line.advanceWidthPx,
      text: line.contentText,
    });
    const known = cellsByKey.get(key);
    if (known !== undefined) return known;

    const metrics = measureShaped(line.contentText, line.wordSpacingPx, line.direction);
    const substituted = line.contentClusters.some(clusterSubstituted);
    if (substituted && requireExactFace) {
      // The message names the face and nothing else: the text it failed on is the user's own
      // subtitle, which never leaves this module in an error.
      fail('glyphAtlasFaceSubstituted', `The face "${face.family}" does not cover part of the text and the engine substituted another face`);
    }
    const cell = {
      key,
      text: line.contentText,
      direction: line.direction,
      wordSpacingPx: line.wordSpacingPx,
      advanceWidthPx: line.advanceWidthPx,
      codePoints: [...line.contentText].map((character) => character.codePointAt(0)),
      substituted,
      box: measureCell(metrics, paddingPx),
    };
    cellsByKey.set(key, cell);
    return cell;
  };

  // A work bound, not a capacity one. Every distinct cell below costs a measurement and six
  // substitution probes, and a document with more distinct cells than every page together could
  // carry cannot be baked whatever the pages do — so it is refused as soon as it is known rather
  // than after several hundred thousand canvas calls it was always going to throw away.
  const distinctCells = new Set();
  const noteCell = (key) => {
    distinctCells.add(key);
    if (distinctCells.size > limits.maxGlyphCount * limits.maxAtlasPages) {
      fail(
        'glyphAtlasTooManyPages',
        `The subtitles need more than ${limits.maxGlyphCount * limits.maxAtlasPages} distinct rasterized lines, which is more than ${limits.maxAtlasPages} glyph atlas pages can carry`
      );
    }
  };

  // Laid out against the run's OWN cell table, before any page exists, because the page a cue lands
  // on depends on the alignment its layout resolves to. Cell INDICES are the only part a page
  // changes, and `glyphAtlasPage.js` remaps them — every position on the line came from a
  // measurement and never from an index, so the picture does not move.
  const laid = shaped.map((text) => {
    const clusters = segmentClusters(text, limits);
    const layout = buildTextLayout({
      text,
      clusters,
      textTransform,
      letterSpacingPx,
      maxWidthPx,
      wordWrap,
      textAlign,
      baseDirection,
      lineHeightPx: resolvedLineHeightPx,
      baselinePx: ascentPx,
      measureLine,
      limits,
    });

    const perLine = layout.lines.map(cellFor);
    for (const cell of perLine) {
      if (cell !== null) noteCell(cell.key);
    }
    const cells = sortedUniqueCells(perLine.filter((cell) => cell !== null));
    const localIndexOf = new Map(cells.map((cell, index) => [cell.key, index]));
    const codePoints = cells.reduce((total, cell) => total + cellCodePoints(cell), 0);
    const runDirection = layout.lines[0]?.direction ?? 'ltr';

    return {
      cells,
      codePoints,
      textAlign: layout.textAlign,
      packed: packRunAlone(cells, codePoints, limits),
      runAdvanceWidthPx: round4(measureLine(text, { wordSpacingPx: 0, direction: runDirection })),
      // Zero by construction: a line's advance IS the measurement of the raster that ships.
      shapingResidualPx: 0,
      baseDirection: runDirection,
      // The wire layout, with this run's own cell indices. `contentText`, `lineText`, `direction`
      // and `wordSpacingPx` stay on this side: they identify the cell, and the cell already carries
      // them.
      layout: {
        textTransform: layout.textTransform,
        letterSpacingPx: layout.letterSpacingPx,
        maxWidthPx: layout.maxWidthPx,
        wordWrap: layout.wordWrap,
        textAlign: layout.textAlign,
        lineCount: layout.lineCount,
        widthPx: layout.widthPx,
        heightPx: layout.heightPx,
        cellAdvanceLayout: layout.cellAdvanceLayout,
        refusal: layout.refusal,
        lines: layout.lines.map((line, index) => {
          const cell = perLine[index];
          return {
            // One cell, drawn at the line's own left edge. Everything that used to be spelled out
            // here — visual order, per-cluster pens, letter spacing, justification — is inside the
            // mask, put there by the engine that shaped it.
            glyphs: cell === null ? [] : [localIndexOf.get(cell.key)],
            penXPx: cell === null ? [] : [0],
            advanceWidthPx: line.advanceWidthPx,
            measuredWidthPx: line.measuredWidthPx,
            shapingResidualPx: line.shapingResidualPx,
            baselineYPx: line.baselineYPx,
            justificationPx: line.justificationPx,
            endsParagraph: line.endsParagraph,
          };
        }),
      },
    };
  });

  const partitioned = partitionRunsIntoPages(laid, limits);
  const shared = {
    cssFont,
    face,
    metrics: {
      ascentPx,
      descentPx,
      lineHeightPx: resolvedLineHeightPx,
      baselinePx: ascentPx,
      letterSpacingPx: round4(letterSpacingPx),
    },
    letterSpacingPx,
    paddingPx,
    surface,
    version,
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
  return deepFreeze({ pages, runs, pageOfCue });
};
