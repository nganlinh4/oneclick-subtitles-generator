/**
 * How a run's clusters become atlas cells: which text each cell is rasterized from, how big its ink
 * box is, and where it packs.
 *
 * WHY A CELL IS NOT ALWAYS ITS CLUSTER. The baker used to rasterize every grapheme cluster ALONE,
 * which is correct for a script whose glyphs do not depend on their neighbours and wrong for one
 * that joins. A real Arabic face draws ب four different ways — isolated, initial, medial, final —
 * and an isolated cell is therefore the wrong glyph in three of the four positions. It also makes
 * the measured run disagree with the sum of the cells, which is the residual that made
 * `cellAdvanceLayout` refuse the run outright, so cursive scripts did not draw at all.
 *
 * WHAT THIS MODULE DOES INSTEAD. A cell is rasterized from the CANONICAL SPELLING of the contextual
 * form the run gives that cluster. Unicode already has a spelling for exactly this: a zero-width
 * joiner on a side asks the shaper for the form that joins on that side, which is how every text
 * stack renders an isolated medial form. So the four candidates for a cluster are itself, itself
 * followed by a joiner, itself preceded by one, and itself surrounded by two.
 *
 * WHICH CANDIDATE IS RIGHT IS MEASURED, NEVER ASSUMED. This module carries no joining table, no
 * script ranges and no knowledge of Arabic; it asks the engine, twice. First for the advance the run
 * gives each position, from progressive prefixes ended the way the run ends them (see
 * `runAdvances`). Then for each candidate's own advance. A candidate is accepted only when the two
 * agree, and the least-marked one wins, so a script that does not join selects the bare cluster and
 * bakes exactly the cell it baked before.
 *
 * WHAT IT REFUSES. When no candidate reproduces a position's advance — a ligature, a kern, or any
 * shaping this spelling cannot express — the whole run is handed back unresolved and the caller
 * keeps the isolated cells and the refusal they carry. Refusing is the honest answer: the alternative
 * is a cell whose raster is not the glyph the engine would have drawn.
 *
 * ITS ONE LIMIT, recorded rather than hidden: the match is on ADVANCE, because an advance is all a
 * measurement surface exposes per candidate. A face whose two forms share an advance but not an
 * outline can therefore be spelled with the wrong one of the two. Nothing in the descriptor could
 * detect that without a per-glyph API no `WebView` offers.
 *
 * Determinism: no clocks, no RNG. Candidate order is fixed, packing is a deterministic shelf in the
 * caller's sorted order, and every measurement is a pure function of the text and the face.
 */

import { isFiniteNumber, round4 } from './glyphAtlasCore';

/**
 * The zero-width joiner, U+200D. Named rather than inlined because it appears in this module as a
 * REQUEST for a joined form, and in a descriptor's cluster text as part of an emoji sequence, and
 * those two uses must not be confused when reading either.
 */
export const CONTEXT_JOINER = '\u200d';

/**
 * The candidate spellings of one cluster's contextual form, least-marked first.
 *
 * Order is the tie-break, and it is the whole reason a Latin run is untouched: every candidate
 * measures the same in a face that does not join, so the bare cluster wins and the cell is
 * byte-identical to the one the isolated path bakes.
 */
const spellingsOf = (cluster) => [
  cluster,
  `${cluster}${CONTEXT_JOINER}`,
  `${CONTEXT_JOINER}${cluster}`,
  `${CONTEXT_JOINER}${cluster}${CONTEXT_JOINER}`,
];

/**
 * Sorted by UTF-16 code unit, which is the order `crates/osg-scene` re-derives cells in: strictly
 * increasing, no duplicates. Exported because the union of many runs' cells has to be built the same
 * way — appending one run's table to another's would violate that contract.
 */
export const sortedUnique = (values) => {
  const unique = [...new Set(values)];
  unique.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return unique;
};

const codePointCount = (text) => [...text].length;

/**
 * The advance the run gives each cluster position.
 *
 * Measuring a bare prefix would be wrong: truncating a word gives its last cluster the form it takes
 * at the END of a word, which is not the form the run gave it. Ending the prefix with a joiner
 * instead asks for the form that joins onwards — but only where the cluster that actually follows
 * could have been joined to, or the prefix would claim a join the run does not have and every
 * advance after it would be measured against the wrong picture.
 *
 * Whether a cluster can be joined to is itself measured, never assumed: a joiner in front of it
 * changes its advance exactly when it accepts one. So a space, a line separator and every Latin
 * letter end the prefix bare, and a cursive letter ends it joined.
 *
 * The boundaries telescope to the run's own measured advance whichever way each one was measured, so
 * the advances sum to the run exactly and the run-level shaping residual is structurally zero
 * whenever this resolution succeeds.
 */
const runAdvances = (clusters, runAdvanceWidthPx, measureWidth, acceptsJoin) => {
  const advances = new Array(clusters.length);
  let boundary = 0;
  let prefix = '';
  for (let index = 0; index < clusters.length; index += 1) {
    prefix += clusters[index];
    const following = clusters[index + 1];
    const next = following === undefined
      ? runAdvanceWidthPx
      : measureWidth(`${prefix}${acceptsJoin(following) ? CONTEXT_JOINER : ''}`);
    advances[index] = round4(next - boundary);
    boundary = next;
  }
  return advances;
};

/**
 * Resolve the run into contextual cells, or `null` when it cannot be.
 *
 * `null` is not a failure: it means the isolated cells the caller already has are the honest answer
 * for this run, together with the residual that refuses to lay them out.
 *
 * Every bound is checked here rather than raised as an error, for the same reason. A run whose
 * contextual cells would not fit the atlas is one this module declines to resolve, so the bake still
 * succeeds with the cells it had.
 */
export const resolveContextualCells = ({ clusters, runAdvanceWidthPx, measureWidth, limits }) => {
  if (clusters.length === 0) return null;

  const widths = new Map();
  const widthOf = (spelling) => {
    const known = widths.get(spelling);
    if (known !== undefined) return known;
    const width = round4(measureWidth(spelling));
    widths.set(spelling, width);
    return width;
  };
  const acceptsJoin = (cluster) => widthOf(`${CONTEXT_JOINER}${cluster}`) !== widthOf(cluster);

  const advances = runAdvances(clusters, runAdvanceWidthPx, measureWidth, acceptsJoin);
  // A negative advance is a kern pulling ink backwards, which no single-cluster spelling reproduces.
  if (advances.some((advance) => !isFiniteNumber(advance) || advance < 0)) return null;

  const spellings = new Array(clusters.length);
  for (let index = 0; index < clusters.length; index += 1) {
    const advance = advances[index];
    const match = spellingsOf(clusters[index]).find((spelling) => widthOf(spelling) === advance);
    if (match === undefined) return null;
    spellings[index] = match;
  }

  const unique = sortedUnique(spellings);
  if (unique.length > limits.maxGlyphCount) return null;
  if (unique.some((spelling) => codePointCount(spelling) > limits.maxClusterCodePoints)) return null;
  const codePoints = unique.reduce((total, spelling) => total + codePointCount(spelling), 0);
  if (codePoints > limits.maxTextCodePoints) return null;

  const cellIndexOf = new Map(unique.map((spelling, index) => [spelling, index]));
  return {
    cells: unique,
    advanceAt: (index) => advances[index],
    cellIndexAt: (index) => cellIndexOf.get(spellings[index]),
  };
};

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
 * The same glyph set always produces the same atlas, because the candidate widths are fixed and the
 * shelf walks the caller's own sorted cell order. `null` rather than a failure, because the caller
 * has a second cell set to try: a run whose contextual cells overflow the atlas still has its
 * isolated ones, and losing the contextual forms is better than losing the bake.
 */
export const packAtlas = (cells) => {
  const inked = cells.some((cell) => cell.widthPx > 0 && cell.heightPx > 0);
  if (!inked) return { widthPx: 0, heightPx: 0, placements: cells.map(() => ({ xPx: 0, yPx: 0 })) };
  for (const widthPx of ATLAS_WIDTH_CANDIDATES) {
    const packed = shelfPack(cells, widthPx);
    if (packed !== null && packed.heightPx <= widthPx) {
      return { widthPx, heightPx: packed.heightPx, placements: packed.placements };
    }
  }
  return null;
};
