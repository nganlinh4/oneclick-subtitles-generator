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
 * - `letterSpacingPx` is applied by the engine itself, as CSS `letter-spacing`, when the line is
 *   measured and when it is drawn — so it is part of the raster, and the advance reported already
 *   carries it. It used to be added to each cluster's advance by this module instead, which was a
 *   second opinion about a quantity the engine had already applied.
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
 *   decided them too. The one value this module resolves is the default of a right-to-left
 *   paragraph: `left` becomes `right`, which is what CSS `start` means once the direction is
 *   right-to-left.
 * - `baseDirection` forces the paragraph embedding level instead of deriving it from the first
 *   strong character. It is the seam the persisted `rtlSupport` boolean lands on, because the
 *   shipped renderer set CSS `direction` from that boolean rather than letting the text decide.
 *
 * BIDI. This module resolves the paragraph level (`glyphAtlasBidi.js`) and nothing else. A line is
 * rasterized once, as itself, with `direction` set from that level, so the browser's own text engine
 * applies the whole Bidirectional Algorithm and the visual order is inside the mask. Line breaking
 * still happens in LOGICAL order, because a break opportunity is a property of the text and not of
 * the picture — UAX #9 agrees, and applies L1 and L2 per line AFTER breaking, which is exactly the
 * order things happen in here.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 * - `maxLines` is INERT and stays inert. It is validated and persisted end to end today and the
 *   shipped renderer never applied it, so applying it now would silently truncate text in projects
 *   that already look the way their author left them. This module has no `maxLines` input; the line
 *   cap it does enforce is a structural bound on the payload, not a user setting.
 *
 * Determinism: no clocks, no RNG. `Intl.Segmenter` is pinned to one locale so segmentation cannot
 * follow the host UI language, and case mapping uses the locale-independent `toUpperCase`.
 */

import { paragraphLevelOf } from './glyphAtlasBidi';
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
 * Break a run into lines, and measure each line as the single shaped object it is.
 *
 * Returns the layout. Each line carries the TEXT it draws — `lineText` with its trailing spaces and
 * `contentText` without them — plus the word spacing that justifies it and the direction that orders
 * it. The baker rasterizes exactly that text, with exactly those options, and the advance reported
 * here is the width that same measurement returned. There is no second quantity to agree with.
 *
 * `measureLine(text, { wordSpacingPx, direction })` is the authoritative measurement, injected so
 * this module never touches a font stack. It is the same call the baker uses to produce the raster,
 * which is what makes the advance and the pixels one operation rather than two.
 *
 * WRAPPING IS MEASURED, NOT ACCUMULATED. A candidate line's width used to be the sum of its
 * clusters' advances, which kerning and ligatures make wrong by up to several pixels — so a line
 * could be broken one word early or one word late. Each candidate is now measured as itself. The
 * search is a binary one over the break opportunities, because a line only gets wider as clusters
 * are added, so a whole paragraph costs a handful of measurements rather than one per cluster.
 */
export const buildTextLayout = ({
  text,
  clusters,
  textTransform,
  letterSpacingPx,
  maxWidthPx,
  wordWrap,
  textAlign,
  lineHeightPx,
  baselinePx,
  measureLine,
  baseDirection = null,
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

  // Resolved once for the whole run, because the run is one paragraph: a hard line break inside a
  // cue must not flip the cue's direction halfway down. It selects the direction every line is
  // measured and drawn under, so the browser's own bidi pass runs at the right embedding level.
  const paragraphLevel = paragraphLevelOf(clusters, { baseDirection });
  const direction = paragraphLevel === 1 ? 'rtl' : 'ltr';

  /**
   * The text a line actually draws: its clusters minus the trailing breaking spaces.
   *
   * Trailing whitespace hangs outside the alignment box in CSS, so rasterizing it would put the
   * line's ink in the wrong place relative to its own advance — off to the left in a right-to-left
   * line, where the hanging space is drawn first.
   */
  const contentClustersOf = (indices) => {
    let end = indices.length;
    while (end > 0 && isBreakingSpace(clusters[indices[end - 1]])) end -= 1;
    // A line of NOTHING BUT whitespace keeps it. Hanging is what CSS does to whitespace at the end
    // of a line of content, and there is no content here for it to hang after — but the reason it
    // matters is downstream: `osg_compositor::CueRun::validate` refuses a run that places no cell,
    // so stripping this line bare would turn a blank subtitle line into a refused export.
    if (end === 0) return indices.map((index) => clusters[index]);
    return indices.slice(0, end).map((index) => clusters[index]);
  };
  const contentTextOf = (indices) => contentClustersOf(indices).join('');

  const widthOf = (content, wordSpacingPx) => (content.length === 0
    ? 0
    : round4(measureLine(content, { wordSpacingPx, direction })));

  /**
   * The last candidate in an ascending list that still fits, or `null` when none does.
   *
   * A binary search, which is exact here for the same reason greedy filling is: a line's width is
   * monotonic in the clusters added to it.
   */
  const lastFitting = (candidates, fits) => {
    let low = 0;
    let high = candidates.length - 1;
    let best = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (fits(candidates[middle])) {
        best = candidates[middle];
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  };

  /** Greedy fill, one hard-broken paragraph at a time. */
  const wrapParagraph = (indices) => {
    if (wrapWidthPx === null || indices.length === 0) return [indices];
    const limit = round4(wrapWidthPx);
    const wrapped = [];
    let start = 0;
    while (start < indices.length) {
      const fits = (end) => widthOf(contentTextOf(indices.slice(start, end)), 0) <= limit;
      if (fits(indices.length)) break;

      const points = [];
      for (let position = start + 1; position < indices.length; position += 1) {
        if (opportunities.has(indices[position])) points.push(position);
      }
      let breakAt = lastFitting(points, fits);
      if (breakAt === null) {
        // A single word wider than the whole line, which is the only case where a word is split at
        // all. Never at `start` itself: that would not advance, and the loop would not terminate.
        const inside = [];
        for (let position = start + 1; position < indices.length; position += 1) inside.push(position);
        breakAt = lastFitting(inside, fits) ?? start + 1;
      }
      wrapped.push(indices.slice(start, breakAt));
      start = breakAt;
    }
    wrapped.push(indices.slice(start));
    return wrapped;
  };

  /**
   * The word spacing that fills `targetPx`, and the width the line measures at with it applied.
   *
   * The sensitivity is MEASURED rather than derived from a space count: which characters an engine
   * widens for `word-spacing` is a property of that engine, and one measurement at zero and one at a
   * single pixel give the exact slope for this line without this module having to hold an opinion.
   * The result is measured again so the advance reported is the advance of the raster that ships,
   * not the advance that was solved for.
   */
  const justifyTo = (content, targetPx) => {
    const zero = widthOf(content, 0);
    if (content.length === 0 || zero >= targetPx) return { wordSpacingPx: 0, advanceWidthPx: zero };
    const perPixel = round4(widthOf(content, 1) - zero);
    if (perPixel <= 0) return { wordSpacingPx: 0, advanceWidthPx: zero };
    const wordSpacingPx = round4((targetPx - zero) / perPixel);
    return { wordSpacingPx, advanceWidthPx: widthOf(content, wordSpacingPx) };
  };

  const buildLine = (indices, lineNumber, endsParagraph) => {
    let lineText = '';
    for (const index of indices) lineText += clusters[index];
    const content = contentTextOf(indices);
    // CSS justifies every line but the last of its block, and only when there is room to grow.
    const justifiable = textAlign === 'justify' && !endsParagraph && wrapWidthPx !== null;
    const { wordSpacingPx, advanceWidthPx } = justifiable
      ? justifyTo(content, round4(wrapWidthPx))
      : { wordSpacingPx: 0, advanceWidthPx: widthOf(content, 0) };
    return {
      lineText,
      contentText: content,
      // The clusters that spell `contentText`, carried so the baker can ask which of them the engine
      // had to substitute a face for. Substitution is a property of a CHARACTER, not of a line: a
      // line is mostly covered by the requested face even when one emoji in it is not, so probing
      // the line as a whole would report the whole thing as covered.
      contentClusters: contentClustersOf(indices),
      direction,
      wordSpacingPx,
      // What alignment measures, and what the raster is: one number from one measurement of one
      // text. `measuredWidthPx` is the same number rather than a second opinion about it, and
      // `shapingResidualPx` is therefore zero by construction rather than by luck. Both stay on the
      // wire because they are the PROOF the two agree, which a consumer can check.
      advanceWidthPx,
      measuredWidthPx: advanceWidthPx,
      shapingResidualPx: 0,
      baselineYPx: round4(baselinePx + lineNumber * lineHeightPx),
      justificationPx: wordSpacingPx,
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

  return {
    textTransform,
    letterSpacingPx: round4(letterSpacingPx),
    maxWidthPx: maxWidthPx === null ? null : round4(maxWidthPx),
    wordWrap,
    // CSS `start`: the default edge of a right-to-left paragraph is its right one. Only the default
    // is resolved; centre, right and justify are the caller's explicit choice and stay untouched.
    textAlign: paragraphLevel === 1 && textAlign === 'left' ? 'right' : textAlign,
    lineCount: lines.length,
    widthPx: lines.reduce((widest, line) => Math.max(widest, line.advanceWidthPx), 0),
    heightPx: round4(lines.length * lineHeightPx),
    // The verdict `GlyphAtlasDescriptor::cell_advance_layout` reaches in Rust. The baker cannot
    // produce anything else any more: a line's advance IS its raster's measurement, so there is no
    // pair of numbers left to disagree. The field stays on the wire because Rust must still refuse a
    // descriptor that claims otherwise, whatever produced it.
    cellAdvanceLayout: 'reproduces',
    refusal: { shapingCrossesClusters: false, directionNeedsBidi: false },
    lines,
  };
};
