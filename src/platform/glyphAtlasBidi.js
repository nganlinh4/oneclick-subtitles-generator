/**
 * The paragraph direction of a run: UAX #9 rules P2 and P3, and nothing else.
 *
 * WHY THIS IS ALL THAT IS LEFT. This module used to carry a working subset of the whole
 * Bidirectional Algorithm — weak types, neutrals, embedding levels, the L1 reset and the L2 reversal
 * — because a line was drawn as a sequence of per-cluster cells and *something* had to decide the
 * order those cells were placed in. A line is now rasterized once, as itself, by the browser's own
 * text engine with `direction` set from the level resolved here. That engine implements the entire
 * algorithm, so the visual order is inside the mask before this module could have an opinion about
 * it, and a second implementation could only ever disagree with the picture actually drawn.
 *
 * WHAT WENT WITH IT. The refusals. Explicit embeddings, overrides, isolates and mirrored characters
 * were refused rather than resolved, which was honest while the reordering lived here — but it meant
 * an Arabic subtitle containing an ordinary bracket did not draw at all. Those constructs are
 * handled correctly inside the mask now, so refusing them would be refusing text the product can
 * draw.
 *
 * WHAT REMAINS AND WHY IT CANNOT MOVE INTO THE MASK. The paragraph level decides one thing the mask
 * cannot express: which edge a line is anchored to when the caller asked for CSS `start`. That is an
 * alignment decision about the box, not about the glyphs inside it, so it is resolved here and
 * carried as data.
 *
 * P2 IS RESOLVED OVER THE WHOLE RUN, hard line breaks included: a cue is one block of text and must
 * not flip direction halfway down. UAX #9 explicitly allows a higher-level protocol to set the
 * paragraph level, and a subtitle cue is that protocol.
 *
 * Determinism: pure range tables and pure predicates. No clocks, no RNG, no locale.
 */

/** The UCD `DerivedBidiClass` default Arabic-letter blocks, verbatim. */
const AL_RANGES = Object.freeze([
  [0x0600, 0x07bf], [0x0860, 0x08ff], [0xfb50, 0xfdcf], [0xfdf0, 0xfdff], [0xfe70, 0xfeff],
  [0x10d00, 0x10d3f], [0x10ec0, 0x10eff], [0x10f30, 0x10f6f],
  [0x1ec70, 0x1ecbf], [0x1ed00, 0x1ed4f], [0x1ee00, 0x1eeff],
]);
/** The UCD `DerivedBidiClass` default right-to-left blocks, verbatim. */
const R_RANGES = Object.freeze([
  [0x0590, 0x05ff], [0x07c0, 0x085f], [0xfb1d, 0xfb4f],
  [0x10800, 0x10cff], [0x10d40, 0x10ebf], [0x10f00, 0x10f2f], [0x10f70, 0x10fff],
  [0x1e800, 0x1ec6f], [0x1ecc0, 0x1ecff], [0x1ed50, 0x1edff], [0x1ef00, 0x1efff],
]);

/**
 * The three invisible marks whose general category says nothing about their bidi class: the Arabic
 * letter mark is a strong Arabic letter, and the two directional marks are strong L and R. They
 * exist precisely to steer P2, so reading them is the whole point.
 */
const STRONG_OVERRIDES = new Map([[0x061c, 'al'], [0x200e, 'l'], [0x200f, 'r']]);

/** Isolate initiators, and the pop that closes them. P2 skips whatever sits between the two. */
const ISOLATE_INITIATORS = new Set([0x2066, 0x2067, 0x2068]);
const POP_DIRECTIONAL_ISOLATE = 0x2069;

/**
 * Characters that are strong left-to-right by default. Letters and letter-numbers cover the scripts
 * that are not in the right-to-left blocks above; decimal digits are deliberately NOT here, because
 * European digits are weak and a line opening with a number takes its direction from what follows.
 */
const STRONG_LEFT = /^[\p{L}\p{Nl}]$/u;

const inRanges = (codePoint, ranges) => {
  for (const [low, high] of ranges) {
    if (codePoint < low) return false;
    if (codePoint <= high) return true;
  }
  return false;
};

/** One code point's strong class, or `null` when it is weak or neutral and P2 passes over it. */
const strongClassOf = (codePoint) => {
  const override = STRONG_OVERRIDES.get(codePoint);
  if (override !== undefined) return override;
  if (inRanges(codePoint, AL_RANGES)) return 'al';
  if (inRanges(codePoint, R_RANGES)) return 'r';
  return STRONG_LEFT.test(String.fromCodePoint(codePoint)) ? 'l' : null;
};

/**
 * P2 and P3: the embedding level of the paragraph `clusters` spells.
 *
 * Returns 0 for a left-to-right paragraph and 1 for a right-to-left one. `baseDirection` forces the
 * answer when the caller already knows it, which is the seam the persisted `rtlSupport` boolean
 * lands on — the shipped renderer set CSS `direction` from that boolean rather than letting the text
 * decide, and this reproduces that.
 *
 * P2 scans for the first strong character and skips any isolated run: the text between an isolate
 * initiator and its matching pop is, by definition, not allowed to influence the direction outside
 * it. A run with no strong character at all is left-to-right, which is P3.
 */
export const paragraphLevelOf = (clusters, { baseDirection = null } = {}) => {
  if (baseDirection === 'ltr') return 0;
  if (baseDirection === 'rtl') return 1;

  let depth = 0;
  for (const cluster of clusters) {
    for (const character of cluster) {
      const codePoint = character.codePointAt(0);
      if (ISOLATE_INITIATORS.has(codePoint)) {
        depth += 1;
        continue;
      }
      if (codePoint === POP_DIRECTIONAL_ISOLATE) {
        if (depth > 0) depth -= 1;
        continue;
      }
      if (depth > 0) continue;
      const strong = strongClassOf(codePoint);
      if (strong === 'l') return 0;
      if (strong !== null) return 1;
    }
  }
  return 0;
};

/**
 * Whether a cluster is strongly right-to-left, for the coarse per-cell direction the descriptor
 * reports.
 *
 * PROVENANCE ONLY. It says which script a cell's text is written in; it does not decide where
 * anything is drawn, because a cell is a whole shaped line and its ink is already in visual order.
 */
export const isStrongRtl = (text) => {
  for (const character of text) {
    const strong = strongClassOf(character.codePointAt(0));
    if (strong === 'r' || strong === 'al') return true;
    if (strong === 'l') return false;
  }
  return false;
};
