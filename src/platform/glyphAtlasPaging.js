/**
 * How a cue list is split across atlas pages.
 *
 * WHY PAGES EXIST. One atlas holds at most `maxGlyphCount` cells, and a cell is one shaped LINE. So
 * the bound is on a document's distinct LINES: a few dozen cues share one page comfortably, and a
 * feature-length track does not. Pages remove that ceiling without raising the per-atlas bound the
 * native validators enforce. They existed for a large character set when a cell was a character, and
 * they carry an ordinary track now.
 *
 * WHY PAGING IS CHEAP HERE. `osg_scene::cues::active_cue_at` selects exactly ONE cue per frame, so a
 * frame draws from exactly one page. The compositor binds that page and no other; nothing is
 * resident that the frame does not sample, and nothing about the draw changes because a document
 * has many pages rather than one. That is also why a per-line cell table is affordable at all: only
 * one cue's lines are ever on the GPU.
 *
 * WHY THE SPLIT IS BY CUE ORDER. It is the only order in which the split is stable: re-baking the
 * same track must produce the same pages, or two runs of the same export would disagree.
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

import { cellCodePoints, compareCells, packAtlas } from './glyphAtlasCells';
import { fail } from './glyphAtlasCore';

/**
 * Merge a run's sorted cells into a page's sorted cells, keeping the order `crates/osg-scene`
 * re-derives: strictly increasing by text, then direction, then advance, with no duplicates.
 *
 * A linear merge rather than concat-and-sort, because this runs once per cue that introduces a new
 * cell and the sort would dominate a long track. `right` holds only cells the page does not already
 * have, so the equal case cannot arise and is not handled.
 */
const mergeSorted = (left, right) => {
  const merged = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (compareCells(left[leftIndex], right[rightIndex]) < 0) merged.push(left[leftIndex++]);
    else merged.push(right[rightIndex++]);
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
export const tableOverflow = (cells, codePoints, limits) => {
  if (cells.length > limits.maxGlyphCount) return 'glyphAtlasTooManyGlyphs';
  return codePoints > limits.maxAtlasCodePoints ? 'glyphAtlasTextTooLong' : null;
};

const OVERFLOW_MESSAGES = Object.freeze({
  glyphAtlasTooManyGlyphs: (limits) => `More than ${limits.maxGlyphCount} distinct rasterized lines are needed for a single cue`,
  glyphAtlasTextTooLong: (limits) => `A single cue's rasterized lines exceed ${limits.maxAtlasCodePoints} code points and are rejected rather than truncated`,
});

/** A page under construction, and the bookkeeping that keeps adding to it cheap. */
const openPage = (run, index) => ({
  cells: run.cells,
  cellSet: new Set(run.cells.map((cell) => cell.key)),
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
 * `runs[i]` is `{ cells, codePoints, textAlign, packed }` — the run's own sorted cell table, its
 * code-point total, the alignment its layout resolved to, and the pack of its cells ALONE, which the
 * caller has already proven fits. Returns one entry per page: `{ cells, packed, cues }`, where
 * `cues` holds the indices of the cues that page serves, in cue order.
 *
 * Refuses rather than truncating when the document needs more pages or more atlas bytes than the
 * budget allows. Both refusals are actionable — a smaller font size or fewer distinct characters —
 * and both are budget decisions, not incidental ceilings: the byte budget is what the staging
 * registry will hold resident, and a document past it would be evicted mid-export instead.
 */
export const partitionRunsIntoPages = (runs, limits) => {
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
      cells: page.cells,
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
    if (run.cells.every((cell) => current.cellSet.has(cell.key))) {
      current.cues.push(index);
      continue;
    }

    const fresh = run.cells.filter((cell) => !current.cellSet.has(cell.key));
    const cells = mergeSorted(current.cells, fresh);
    const codePoints = current.codePoints
      + fresh.reduce((total, cell) => total + cellCodePoints(cell), 0);
    const packed = tableOverflow(cells, codePoints, limits) === null
      ? packAtlas(cells.map((cell) => cell.box), current.widthPx)
      : null;
    if (packed === null) {
      close(current);
      start(run, index);
      continue;
    }

    current.cells = cells;
    for (const cell of fresh) current.cellSet.add(cell.key);
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
 * into — so this is where an over-budget cue is refused, naming the bound it broke.
 */
export const packRunAlone = (cells, codePoints, limits) => {
  const overflow = tableOverflow(cells, codePoints, limits);
  if (overflow !== null) fail(overflow, OVERFLOW_MESSAGES[overflow](limits));
  const packed = packAtlas(cells.map((cell) => cell.box));
  if (packed === null) {
    fail('glyphAtlasTooLarge', `The glyphs do not fit within a ${limits.maxAtlasDimensionPx}px atlas`);
  }
  return packed;
};
