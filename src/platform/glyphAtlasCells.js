/**
 * What an atlas cell is, how big its ink box is, and where it packs.
 *
 * A CELL IS ONE SHAPED LINE. Not a grapheme cluster, and not a contextual form of one. The line is
 * measured and rasterized by a single call into the engine, with its final face, size, transform,
 * letter spacing, word spacing and paragraph direction, and that one call produces the mask, the ink
 * box and the advance together.
 *
 * WHY IT USED TO BE A CLUSTER, AND WHY THAT COULD NOT WORK. A line was drawn by placing per-cluster
 * cells at accumulated pen positions, which requires the width of a run to equal the sum of its
 * parts. Kerning makes that false for ordinary Latin text; ligatures and cursive joining make it
 * false in a way no per-cluster spelling can repair. This module used to carry an elaborate
 * apparatus for the repair — zero-width-joiner spellings probed against progressive prefixes — and
 * it still ended in a refusal whenever two independent measurements disagreed by a ten-thousandth of
 * a pixel, which is how a plain edited subtitle stopped drawing at all. None of it is needed once
 * the thing measured and the thing drawn are the same object.
 *
 * WHAT A CELL COSTS NOW. Identity is per line rather than per character, so a document's cell count
 * follows its distinct LINES. That is the honest price: a cue list of a few hundred lines is a few
 * hundred cells, where an alphabet was a few dozen, and `glyphAtlasPaging.js` spends pages on it
 * instead of spending refusals on kerning.
 *
 * Determinism: packing is a deterministic shelf in the caller's sorted order, no clocks, no RNG.
 */

/**
 * A cell's identity on the wire: its text, the direction it was shaped in, and its advance.
 *
 * The same triple `crates/osg-scene/src/glyph/validate.rs` orders and de-duplicates cells by, so the
 * table this side builds is one that side accepts. It is a triple rather than the text alone because
 * one line's text can legitimately appear twice in a document with a different picture each time —
 * once in a right-to-left paragraph and once in a left-to-right one, or once justified to fill the
 * wrap width and once as the last line of its block. Word spacing is not in the key because it
 * cannot vary without the advance varying: if a line has no character the engine widens, its spacing
 * changed nothing and the two cells are the same raster.
 */
export const cellKeyOf = (cell) => `${cell.direction}|${cell.advanceWidthPx}|${cell.text}`;

const DIRECTION_RANK = Object.freeze({ ltr: 0, rtl: 1, neutral: 2 });

/**
 * The order `crates/osg-scene` re-derives cells in, and the order the shelf packer walks: by text in
 * UTF-16 code-unit order, then by direction, then by advance.
 *
 * JavaScript compares strings by UTF-16 code unit, which is what keeps astral text in the order the
 * native validator expects, and the direction rank is the declaration order of the `Direction` enum
 * it compares against.
 */
export const compareCells = (left, right) => {
  if (left.text !== right.text) return left.text < right.text ? -1 : 1;
  const rank = DIRECTION_RANK[left.direction] - DIRECTION_RANK[right.direction];
  if (rank !== 0) return rank;
  return left.advanceWidthPx - right.advanceWidthPx;
};

export const sortedUniqueCells = (cells) => {
  const unique = new Map();
  for (const cell of cells) unique.set(cellKeyOf(cell), cell);
  return [...unique.values()].sort(compareCells);
};

/** How many code points a cell's text carries, which is what the wire budgets. */
export const cellCodePoints = (cell) => [...cell.text].length;

/**
 * One cell's ink box, in atlas pixels, with the pen inside it.
 *
 * A cluster with no ink — whitespace, a format character — takes a zero-sized cell at the origin
 * rather than a padded empty one, so an inkless run packs to nothing at all.
 */
export const measureCell = (measurement, paddingPx) => {
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

/** Widths tried in order; the first that packs to a height no greater than itself wins. */
const ATLAS_WIDTH_CANDIDATES = Object.freeze([64, 128, 256, 512, 1_024, 2_048, 4_096]);

const nextPowerOfTwo = (value) => {
  let size = 1;
  while (size < value) size *= 2;
  return size;
};

/** Deterministic shelf packing in the caller's sorted order. No heuristics, no randomness. */
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

/**
 * Pack the cells into the smallest square-bounded atlas that holds them, or `null` when none of the
 * candidate widths can.
 *
 * The same cell set always produces the same atlas, because the candidate widths are fixed and the
 * shelf walks the caller's own sorted cell order. `null` rather than a failure, because the caller
 * has somewhere to go with it: paging tries the cells of one more cue against an open page and opens
 * a new one when they do not fit, which is not an error.
 *
 * `minWidthPx` skips candidates narrower than one the caller already knows is too narrow. Paging
 * fills a page cell by cell and re-packs on every growth, and a cell set that only ever grows can
 * never need a NARROWER atlas than it needed before — so carrying the last answer forward turns a
 * seven-width search into one or two. It is a starting point, never a floor on the result: a set
 * that has not reached `minWidthPx` yet still packs at whatever width fits, because the caller only
 * ever passes a width its own previous pack returned.
 */
export const packAtlas = (cells, minWidthPx = 0) => {
  const inked = cells.some((cell) => cell.widthPx > 0 && cell.heightPx > 0);
  if (!inked) return { widthPx: 0, heightPx: 0, placements: cells.map(() => ({ xPx: 0, yPx: 0 })) };
  for (const widthPx of ATLAS_WIDTH_CANDIDATES) {
    if (widthPx < minWidthPx) continue;
    const packed = shelfPack(cells, widthPx);
    if (packed !== null && packed.heightPx <= widthPx) {
      return { widthPx, heightPx: packed.heightPx, placements: packed.placements };
    }
  }
  return null;
};
