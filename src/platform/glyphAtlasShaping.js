/**
 * Text shaping for the glyph atlas: transform, segment, break into lines, justify.
 *
 * WHY THIS IS HERE AND NOT IN RUST. The architecture (docs/rewrite/NATIVE_RENDERER.md) is one
 * compositor fed by one glyph source. The `WebView` owns the font stack and `Intl.Segmenter`, so it
 * owns shaping; the compositor draws cells at pen positions. Line breaking is shaping — it depends
 * on measured advances, on grapheme clusters and on word boundaries — so it belongs on this side of
 * the boundary, and the atlas emits the per-line runs the compositor draws rather than leaving the
 * compositor to guess where a line ended.
 *
 * WHAT EACH INPUT DOES, and where the shipped renderer put it:
 *
 * - `textTransform` runs FIRST, before segmentation and before any measurement, because case
 *   mapping is not a per-character operation: the sharp s uppercases to two letters, and so does the
 *   fi ligature, so the cluster count, the distinct-glyph set and every advance change with it.
 *   Transforming after shaping would measure text nobody sees.
 * - `letterSpacingPx` is a layout quantity, added to every cluster's advance including the last, the
 *   way a browser applies CSS `letter-spacing`. It is never baked into the raster.
 * - `lineHeightPx` and `baselinePx` place each line's baseline, so the compositor reads a position
 *   rather than recomputing one.
 * - `maxWidthPx` is the wrap width IN ATLAS PIXEL SPACE — the space the atlas was baked in, where
 *   the face is `fontSizePx` tall. The compositor scales the whole run by `fontSize / atlasFontSize`,
 *   so a caller converts a composition-space width by dividing by that same ratio. Passing a
 *   composition-space width directly would wrap at the wrong place at every resolution but one.
 * - `wordWrap` is the shipped boolean, which selects CSS `white-space: pre-wrap` against `nowrap`.
 *   False therefore means no soft break at all, not "break differently".
 * - `textAlign` is carried, and only `justify` changes what this module emits. Left, centre and
 *   right are decided by the compositor from the box anchor, which is where the shipped renderer
 *   decided them too.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 * - `maxLines` is INERT and stays inert. It is validated and persisted end to end today and the
 *   shipped renderer never applied it, so applying it now would silently truncate text in projects
 *   that already look the way their author left them. This module has no `maxLines` input; the line
 *   cap it does enforce is a structural bound on the payload, not a user setting.
 * - Bidi reordering. Direction is classified first-strong and carried as data. A run that needs
 *   reordering is reported as refusing cell-advance layout, exactly as `osg-scene` refuses it.
 *
 * Determinism: no clocks, no RNG. `Intl.Segmenter` is pinned to one locale so segmentation cannot
 * follow the host UI language, and case mapping uses the locale-independent `toUpperCase`.
 */

import { fail, round4 } from './glyphAtlasCore';

/** The shipped `textTransform` vocabulary, from `subtitleCustomizationDefaults`. */
export const TEXT_TRANSFORMS = Object.freeze(['none', 'uppercase', 'lowercase', 'capitalize']);

/** The shipped `textAlign` vocabulary. Only `justify` reaches this module's output. */
export const TEXT_ALIGNMENTS = Object.freeze(['left', 'center', 'right', 'justify']);

const SEGMENTER_LOCALE = 'en';

/**
 * Whitespace that offers a line-break opportunity. `\s` is deliberately not used: it also matches
 * the no-break space, the figure space and the narrow no-break space, which exist precisely so a
 * line does NOT break at them.
 */
const BREAKING_SPACE = /^[\t \u1680\u2000-\u2006\u2008-\u200a\u205f\u3000]$/;

/**
 * Clusters that are a hard line break. A set rather than a pattern because two of them are
 * control characters, which a regular expression may not carry, and because CR LF clusters as one
 * grapheme and has to be recognised as that one string rather than as two alternatives.
 */
const LINE_SEPARATORS = new Set([
  '\r\n', '\n', '\r', '\u000b', '\u000c', '\u0085', '\u2028', '\u2029',
]);

/** The shipped renderer's own capitalize pass, reproduced below; `\w` is ASCII by design there. */
const SHIPPED_WORD = /\w\S*/g;

const requireSegmenter = () => {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    fail(
      'glyphAtlasSegmenterUnavailable',
      'Text segmentation is unavailable, so the atlas cannot be shaped deterministically'
    );
  }
};

const wordSegmenter = () => {
  requireSegmenter();
  return new Intl.Segmenter(SEGMENTER_LOCALE, { granularity: 'word' });
};

/**
 * CSS `text-transform: capitalize`: uppercase the first typographic letter unit of each word and
 * leave the rest alone.
 */
const cssCapitalize = (text) => {
  const graphemes = new Intl.Segmenter(SEGMENTER_LOCALE, { granularity: 'grapheme' });
  let result = '';
  for (const { segment, isWordLike } of wordSegmenter().segment(text)) {
    if (!isWordLike) {
      result += segment;
      continue;
    }
    const [first] = [...graphemes.segment(segment)];
    result += first.segment.toUpperCase() + segment.slice(first.segment.length);
  }
  return result;
};

/**
 * Apply `textTransform` exactly as the shipped renderer applies it, which is TWICE for `capitalize`.
 *
 * `SubtitledVideo.tsx` rewrites the string in JavaScript (`\w\S*` -> first character upper, rest
 * LOWER) and then also sets `textTransform` on the element, so the browser's own capitalize runs on
 * the already-rewritten text. Reproducing the composition rather than the intent is deliberate: it
 * is what existing projects look like today. The two agree for ordinary text — "hello world"
 * capitalizes to "Hello World" either way — and differ only where the shipped pass lowercases the
 * tail ("iPhone" becomes "Iphone", not "IPhone") or where a word begins outside ASCII, which the
 * shipped `\w` cannot see. Both are shipped defects; changing them is a `fixed` disposition with a
 * release note, not something this module may decide on its own.
 *
 * `uppercase` and `lowercase` are idempotent under Unicode default case conversion, so applying them
 * once reproduces the shipped double application exactly.
 */
export const applyTextTransform = (text, transform) => {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize': {
      requireSegmenter();
      const shipped = text.replace(
        SHIPPED_WORD,
        (word) => word.charAt(0).toUpperCase() + word.substring(1).toLowerCase()
      );
      return cssCapitalize(shipped);
    }
    default:
      return text;
  }
};

const isBreakingSpace = (cluster) => BREAKING_SPACE.test(cluster);

const isLineSeparator = (cluster) => LINE_SEPARATORS.has(cluster);

/**
 * Cluster indices at which a line may begin.
 *
 * Two independent sources, because neither alone is enough. `Intl.Segmenter` word boundaries give
 * the break before every word, which is what makes CJK — where there is no space to break at — wrap
 * at all. The whitespace rule gives the break before anything that follows a run of spaces,
 * including punctuation and symbols that are not word-like. A break is never offered inside a
 * grapheme cluster because the entire search space is cluster indices.
 */
const breakOpportunities = (text, clusters) => {
  const clusterAtOffset = new Map();
  let offset = 0;
  for (const [index, cluster] of clusters.entries()) {
    clusterAtOffset.set(offset, index);
    offset += cluster.length;
  }

  const opportunities = new Set();
  for (const { index, isWordLike } of wordSegmenter().segment(text)) {
    if (!isWordLike || index === 0) continue;
    const cluster = clusterAtOffset.get(index);
    if (cluster !== undefined) opportunities.add(cluster);
  }
  for (const [index, cluster] of clusters.entries()) {
    if (index > 0 && isBreakingSpace(clusters[index - 1]) && !isBreakingSpace(cluster)) {
      opportunities.add(index);
    }
  }
  return opportunities;
};

/**
 * Break a run into lines and emit what the compositor needs to draw them.
 *
 * Returns the layout. `lines[].glyphs` index the atlas cells in the order they are drawn, and
 * `lines[].penXPx` is the line-relative pen for each of those cells, so letter spacing and
 * justification are already applied and nothing downstream recomputes them.
 */
export const buildTextLayout = ({
  text,
  clusters,
  cellIndexOf,
  advanceOf,
  textTransform,
  letterSpacingPx,
  maxWidthPx,
  wordWrap,
  textAlign,
  lineHeightPx,
  baselinePx,
  measureLineWidth,
  runShapingResidualPx,
  directionNeedsBidi,
  limits,
}) => {
  const placeable = clusters.filter((cluster) => !isLineSeparator(cluster)).length;
  if (placeable > limits.maxLayoutCells) {
    fail('glyphAtlasLayoutTooLarge', `A laid-out run exceeds ${limits.maxLayoutCells} cells`);
  }

  // `wordWrap: false` is CSS `white-space: nowrap`, so there is no wrap width at all rather than a
  // different way of choosing one.
  const wrapWidthPx = wordWrap ? maxWidthPx : null;
  const opportunities = clusters.length === 0 ? new Set() : breakOpportunities(text, clusters);
  const advanceAt = (index) => advanceOf.get(clusters[index]) + letterSpacingPx;

  /** Greedy fill, one hard-broken paragraph at a time. */
  const wrapParagraph = (indices) => {
    const wrapped = [];
    let start = 0;
    let position = 0;
    let penXPx = 0;
    let opportunity = -1;
    let inked = -1;
    while (position < indices.length) {
      const index = indices[position];
      if (position > start && opportunities.has(index)) opportunity = position;
      const space = isBreakingSpace(clusters[index]);
      // A trailing space never forces a break: it hangs past the wrap width, as it does in CSS.
      // `inked >= start` is also what guarantees progress — it cannot hold until a cluster after
      // `start` has been placed, so the break below is always strictly ahead of the line start.
      const overflows = wrapWidthPx !== null && !space && inked >= start
        && round4(penXPx + advanceAt(index)) > round4(wrapWidthPx);
      if (overflows) {
        // A word boundary when there is one; otherwise this cluster, which is the only case where a
        // word is split at all — a single word wider than the whole line.
        const breakAt = opportunity > start ? opportunity : position;
        wrapped.push(indices.slice(start, breakAt));
        start = breakAt;
        position = breakAt;
        penXPx = 0;
        opportunity = -1;
        inked = -1;
        continue;
      }
      if (!space) inked = position;
      penXPx += advanceAt(index);
      position += 1;
    }
    wrapped.push(indices.slice(start));
    return wrapped;
  };

  const buildLine = (indices, lineNumber, endsParagraph) => {
    let contentEnd = indices.length;
    while (contentEnd > 0 && isBreakingSpace(clusters[indices[contentEnd - 1]])) contentEnd -= 1;

    const gaps = new Set();
    for (let position = 1; position < contentEnd; position += 1) {
      if (isBreakingSpace(clusters[indices[position]])) gaps.add(position);
    }
    let contentAdvancePx = 0;
    for (let position = 0; position < contentEnd; position += 1) {
      contentAdvancePx += advanceAt(indices[position]);
    }
    // CSS justifies every line but the last of its block, and only when there is a gap to grow.
    const justifiable = textAlign === 'justify' && !endsParagraph
      && wrapWidthPx !== null && gaps.size > 0 && wrapWidthPx > contentAdvancePx;
    const justificationPx = justifiable ? round4((wrapWidthPx - contentAdvancePx) / gaps.size) : 0;

    const penXPx = [];
    let pen = 0;
    for (const [position, index] of indices.entries()) {
      penXPx.push(round4(pen));
      pen += advanceAt(index) + (gaps.has(position) ? justificationPx : 0);
    }

    const lineText = indices.map((index) => clusters[index]).join('');
    const measuredWidthPx = lineText.length === 0 ? 0 : round4(measureLineWidth(lineText));
    const cellAdvancePx = indices.reduce(
      (total, index) => total + advanceOf.get(clusters[index]),
      0
    );
    return {
      glyphs: indices.map((index) => cellIndexOf.get(clusters[index])),
      penXPx,
      // What alignment measures: trailing spaces hang, so they are not part of the line's width.
      advanceWidthPx: round4(contentAdvancePx + justificationPx * gaps.size),
      measuredWidthPx,
      // The same honesty the run-level residual carries, per line: non-zero means the engine moved
      // ink across a cluster boundary on this line, so these pen positions do not reproduce it.
      shapingResidualPx: lineText.length === 0 ? 0 : round4(measuredWidthPx - cellAdvancePx),
      baselineYPx: round4(baselinePx + lineNumber * lineHeightPx),
      justificationPx,
      endsParagraph,
    };
  };

  const lines = [];
  if (clusters.length > 0) {
    const paragraphs = [[]];
    for (const [index, cluster] of clusters.entries()) {
      if (isLineSeparator(cluster)) paragraphs.push([]);
      else paragraphs[paragraphs.length - 1].push(index);
    }
    for (const paragraph of paragraphs) {
      const wrapped = wrapParagraph(paragraph);
      for (const [position, indices] of wrapped.entries()) {
        if (lines.length === limits.maxLayoutLines) {
          fail('glyphAtlasLayoutTooLarge', `A laid-out run exceeds ${limits.maxLayoutLines} lines`);
        }
        lines.push(buildLine(indices, lines.length, position === wrapped.length - 1));
      }
    }
  }

  const shapingCrossesClusters = runShapingResidualPx !== 0
    || lines.some((line) => line.shapingResidualPx !== 0);
  return {
    textTransform,
    letterSpacingPx: round4(letterSpacingPx),
    maxWidthPx: maxWidthPx === null ? null : round4(maxWidthPx),
    wordWrap,
    textAlign,
    lineCount: lines.length,
    widthPx: lines.reduce((widest, line) => Math.max(widest, line.advanceWidthPx), 0),
    heightPx: round4(lines.length * lineHeightPx),
    // The same verdict `GlyphAtlasDescriptor::cell_advance_layout` reaches in Rust, stated here so
    // the two cannot drift. Wrapping does not weaken it: the pen positions are measured advances,
    // and a run whose shaping crosses clusters or needs bidi is still refused.
    cellAdvanceLayout: shapingCrossesClusters || directionNeedsBidi ? 'refused' : 'reproduces',
    refusal: { shapingCrossesClusters, directionNeedsBidi },
    lines,
  };
};
