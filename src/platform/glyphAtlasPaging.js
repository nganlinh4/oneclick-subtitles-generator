/**
 * How a cue list is split across atlas pages.
 *
 * WHY PAGES EXIST. One atlas holds at most `maxGlyphCount` cells, and that bound is on the ALPHABET
 * — the union of every cue's distinct glyph forms. Latin saturates it at a few dozen cells however
 * long the track, so a single atlas was never a limit there. A large character set is different: a
 * Chinese film uses a few thousand distinct ideographs, a Korean track reaches into the syllable
 * blocks, an emoji-heavy lyric video keeps introducing new sequences. Those documents are ordinary
 * product input and they overflowed one atlas, so the export refused them. Pages remove that ceiling
 * without raising the per-atlas bound the native validators enforce.
 *
 * WHY PAGING IS CHEAP HERE. `osg_scene::cues::active_cue_at` selects exactly ONE cue per frame, so a
 * frame draws from exactly one page. The compositor binds that page and no other; nothing is
 * resident that the frame does not sample, and nothing about the draw changes because a document
 * has many pages rather than one.
 *
 * WHY THE SPLIT IS BY CUE ORDER. Cues arrive in time order and neighbouring cues share vocabulary,
 * so a greedy walk keeps a page's cells dense and the page count near the minimum. It is also the
 * only order in which the split is stable: re-baking the same track must produce the same pages, or
 * two runs of the same export would disagree.
 *
 * WHAT CLOSES A PAGE. The cell count, the cell code points, whether the cells still pack into an
 * atlas, and the resolved text alignment. The last one is not a capacity bound: the compositor
 * aligns every cue by its ATLAS's alignment, because CSS `start` resolves against the paragraph's
 * own direction and only the shaper can decide it. One atlas therefore carries one alignment, and a
 * document mixing a right-to-left cue with a left-to-right one used to be refused outright. With
 * pages those cues simply land on different pages, each aligned as its own direction demands.
 *
 * Determinism: no clocks, no RNG. Every decision is a pure function of the cells, the limits and the
 * cue order.
 */

import { packAtlas } from './glyphAtlasCells';
import { fail } from './glyphAtlasCore';

const codePointCount = (text) => [...text].length;

/**
 * Merge a run's sorted cells into a page's sorted cells, keeping the order `crates/osg-scene`
 * re-derives: strictly increasing by UTF-16 code unit, no duplicates.
 *
 * A linear merge rather than concat-and-sort, because this runs once per cue that introduces a new
 * cell and the sort would dominate a long track.
 */
const mergeSorted = (left, right) => {
  const merged = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left[leftIndex];
    const b = right[rightIndex];
    if (a === b) {
      merged.push(a);
      leftIndex += 1;
      rightIndex += 1;
    } else if (a < b) {
      merged.push(a);
      leftIndex += 1;
    } else {
      merged.push(b);
      rightIndex += 1;
    }
  }
  while (leftIndex < left.length) merged.push(left[leftIndex++]);
  while (rightIndex < right.length) merged.push(right[rightIndex++]);
  return merged;
};

/**
 * Which capacity bound a candidate cell table breaks, or `null` when it breaks none.
 *
 * Both are the bounds `crates/osg-scene` enforces on ONE atlas's cell list, so a table that passes
 * here is one a descriptor can carry. The pack is checked separately by the caller, which holds the
 * width hint that keeps it cheap.
 */
export const tableOverflow = (cellTexts, codePoints, limits) => {
  if (cellTexts.length > limits.maxGlyphCount) return 'glyphAtlasTooManyGlyphs';
  return codePoints > limits.maxTextCodePoints ? 'glyphAtlasTextTooLong' : null;
};

const OVERFLOW_MESSAGES = Object.freeze({
  glyphAtlasTooManyGlyphs: (limits) => `More than ${limits.maxGlyphCount} distinct glyph cells are needed for a single cue`,
  glyphAtlasTextTooLong: (limits) => `A single cue's distinct glyph cells exceed ${limits.maxTextCodePoints} code points and are rejected rather than truncated`,
});

/** A page under construction, and the bookkeeping that keeps adding to it cheap. */
const openPage = (run, index) => ({
  cellTexts: run.cellTexts,
  cellSet: new Set(run.cellTexts),
  codePoints: run.codePoints,
  textAlign: run.textAlign,
  cues: [index],
  // The width the cells last packed at. They only ever grow, so the next pack never needs a
  // narrower atlas and the search can start here.
  widthPx: run.packed.widthPx,
  heightPx: run.packed.heightPx,
  packed: run.packed,
});

/**
 * Split `runs` into pages, greedily and in cue order.
 *
 * `runs[i]` is `{ cellTexts, codePoints, textAlign, packed }` — the run's own sorted cell table, its
 * code-point total, the alignment its layout resolved to, and the pack of its cells ALONE, which the
 * caller has already proven fits. `cellOf` gives a cell text's ink box. Returns one entry per page:
 * `{ cellTexts, packed, cues }`, where `cues` holds the indices of the cues that page serves, in cue
 * order.
 *
 * Refuses rather than truncating when the document needs more pages or more atlas bytes than the
 * budget allows. Both refusals are actionable — a smaller font size or fewer distinct characters —
 * and both are budget decisions, not incidental ceilings: the byte budget is what the staging
 * registry will hold resident, and a document past it would be evicted mid-export instead.
 */
export const partitionRunsIntoPages = (runs, cellOf, limits) => {
  const pages = [];
  // One page open per resolved alignment, because an alignment is the one reason to split that
  // spare capacity cannot fix. A track that alternates between a right-to-left cue and a
  // left-to-right one — a bilingual lyric video, a film with translated signage — would otherwise
  // open a page per cue and exhaust the budget on a document with a two-letter alphabet. A page's
  // cues need not be contiguous in time: the compositor uploads the active cue's page each frame, so
  // there is nothing for locality to save.
  const open = new Map();
  let opened = 0;
  let bytes = 0;

  const close = (page) => {
    bytes += page.widthPx * page.heightPx * 4;
    if (bytes > limits.maxTotalAtlasBytes) {
      fail(
        'glyphAtlasPixelBudget',
        `The subtitles need more glyph atlas memory than the ${Math.floor(limits.maxTotalAtlasBytes / (1024 * 1024))} MiB the renderer will hold, so they were not rendered at a reduced quality`
      );
    }
    pages.push(Object.freeze({
      cellTexts: page.cellTexts,
      packed: page.packed,
      cues: page.cues,
    }));
  };

  const start = (run, index) => {
    opened += 1;
    if (opened > limits.maxAtlasPages) {
      fail(
        'glyphAtlasTooManyPages',
        `The subtitles need more than ${limits.maxAtlasPages} glyph atlas pages, so they were not rendered in a reduced set of glyphs`
      );
    }
    const page = openPage(run, index);
    open.set(run.textAlign, page);
    return page;
  };

  for (const [index, run] of runs.entries()) {
    const current = open.get(run.textAlign);
    if (current === undefined) {
      start(run, index);
      continue;
    }
    // The common case for any long track: the alphabet saturated pages ago and this cue adds
    // nothing, so there is no merge to do and no pack to redo.
    if (run.cellTexts.every((cellText) => current.cellSet.has(cellText))) {
      current.cues.push(index);
      continue;
    }

    const fresh = run.cellTexts.filter((cellText) => !current.cellSet.has(cellText));
    const cellTexts = mergeSorted(current.cellTexts, fresh);
    const codePoints = current.codePoints
      + fresh.reduce((total, cellText) => total + codePointCount(cellText), 0);
    const packed = tableOverflow(cellTexts, codePoints, limits) === null
      ? packAtlas(cellTexts.map(cellOf), current.widthPx)
      : null;
    if (packed === null) {
      close(current);
      start(run, index);
      continue;
    }

    current.cellTexts = cellTexts;
    for (const cellText of fresh) current.cellSet.add(cellText);
    current.codePoints = codePoints;
    current.cues.push(index);
    current.widthPx = packed.widthPx;
    current.heightPx = packed.heightPx;
    current.packed = packed;
  }
  // Insertion order, which is the order the alignments first appeared: deterministic, and the same
  // for the same cue list however many times it is baked.
  for (const page of open.values()) close(page);
  return pages;
};

/**
 * The pack of one run's own cells, or a refusal.
 *
 * A run that does not fit a page ALONE cannot be paged around — there is no smaller unit to split
 * into — so this is where an over-budget cue is refused, naming the bound it broke. The caller has
 * already tried the run's contextual cells and fallen back to its isolated ones, so reaching here
 * means neither table fits.
 */
export const packRunAlone = (cellTexts, codePoints, cellOf, limits) => {
  const overflow = tableOverflow(cellTexts, codePoints, limits);
  if (overflow !== null) fail(overflow, OVERFLOW_MESSAGES[overflow](limits));
  const packed = packAtlas(cellTexts.map(cellOf));
  if (packed === null) {
    fail('glyphAtlasTooLarge', `The glyphs do not fit within a ${limits.maxAtlasDimensionPx}px atlas`);
  }
  return packed;
};
