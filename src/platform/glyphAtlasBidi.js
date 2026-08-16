/**
 * Visual order for the glyph atlas: the subset of the Unicode Bidirectional Algorithm (UAX #9) that
 * the baker resolves, and the constructs it refuses rather than gets wrong.
 *
 * WHY THIS IS HERE AND NOT IN RUST. Same reason as the rest of shaping: the compositor draws cells
 * at pen positions and never reorders anything. Every question about where a glyph goes is answered
 * on this side, which is the only side with the font stack, `Intl.Segmenter` and the browser's own
 * text engine. A first-strong classification carried as data is not bidi support — it made the
 * compositor decline to draw Arabic or Hebrew at all — so the reordering happens here and
 * `lines[].glyphs` leaves in VISUAL order.
 *
 * WHAT IS RESOLVED, rule by rule:
 *
 * - P2/P3   paragraph embedding level from the first strong L/R/AL cluster of the whole run. The run
 *           is treated as ONE paragraph even when it carries hard line breaks, so a cue cannot flip
 *           direction halfway down. UAX #9 explicitly allows a higher-level protocol to set the
 *           paragraph level, and a subtitle cue is one block of text.
 * - X10     the run is a single isolating run sequence, because explicit formatting and isolates are
 *           refused below, so `sos` and `eos` are both the paragraph direction.
 * - W1-W7   marks inherit their base, European digits become Arabic digits after an Arabic letter,
 *           Arabic letters become R, separators between matching digits join them, terminators next
 *           to European digits join them, whatever is left of ES/ET/CS becomes neutral, and European
 *           digits after a left-to-right strong become left-to-right.
 * - N1/N2   neutrals between two strongs of the same direction take that direction (digits count as
 *           right-to-left for this), and everything else takes the embedding direction.
 * - I1/I2   levels: in an even paragraph R goes up one and EN/AN go up two, so digits inside
 *           right-to-left text survive the two reversals in their own order; in an odd paragraph
 *           L/EN/AN all go up one.
 * - L1      on each LINE, segment and paragraph separators, and any whitespace run before one of
 *           those or at the end of the line, reset to the paragraph level. This is what puts a
 *           wrapped line's trailing space at the visual START of a right-to-left line instead of
 *           leaving it stranded inside the last left-to-right word.
 * - L2      reverse each maximal run at each level from the highest down to the lowest odd level.
 *
 * WHAT IS REFUSED, and why refusing is the honest answer:
 *
 * - Explicit embedding and override controls (LRE/RLE/LRO/RLO/PDF, U+202A..U+202E) and isolates
 *   (LRI/RLI/FSI/PDI, U+2066..U+2069). X1-X8 and the isolating-run-sequence machinery are not
 *   implemented, and laying such a run out in logical order is silently wrong rather than visibly
 *   missing. Refused wherever they appear, in any direction of text.
 * - Mirrored characters — brackets, angle quotes, mathematical delimiters, anything with
 *   `Bidi_Mirrored` — inside a run that has right-to-left content. N0 pairing is not implemented,
 *   and mirroring needs a DIFFERENT GLYPH from the one the atlas baked: an opening parenthesis in a
 *   right-to-left context is drawn with the closing parenthesis's outline. The atlas has one cell
 *   per grapheme and cannot substitute it, so the whole run is refused. A bracket in text with no
 *   right-to-left content needs no mirroring and is not refused.
 *
 * Two limits that are NOT this module's to fix, recorded so they are not mistaken for bidi bugs:
 *
 * - Cursive joining. A real Arabic face shapes ب differently at the start, middle and end of a word,
 *   and the atlas bakes one isolated cell per grapheme cluster. That divergence shows up as a
 *   non-zero `shapingResidualPx`, which already refuses cell-advance layout through the OTHER
 *   refusal flag. So Hebrew, Thaana and Divehi run through this module and draw; Arabic still
 *   refuses, for a reason that has nothing to do with ordering.
 * - `rtlSupport` itself. The shipped renderer sets CSS `direction: rtl|ltr` from that boolean, which
 *   FORCES the paragraph level rather than deriving it. This module derives it (P2/P3) because the
 *   baker has no direction input to pass down; see `buildTextLayout`'s `baseDirection` argument,
 *   which is the seam that boolean lands on.
 *
 * The character-class table is derived from ranges, never from enumerated code points, and leans on
 * the engine's own Unicode tables (`\p{Mn}`, `\p{Cf}`, `\p{White_Space}`, `\p{Bidi_Mirrored}`) for
 * everything a range would state badly. The strong right-to-left ranges are the UCD
 * `DerivedBidiClass` default blocks verbatim, so an unassigned code point in a right-to-left block
 * classifies the way Unicode says it must.
 *
 * Determinism: no clocks, no RNG, no locale. Same clusters in, same levels and same order out.
 */

// Bidi classes. Only the ones this subset resolves are named; everything else lands in ON.
const L = 'L';
const R = 'R';
const AL = 'AL';
const EN = 'EN';
const ES = 'ES';
const ET = 'ET';
const AN = 'AN';
const CS = 'CS';
const NSM = 'NSM';
const BN = 'BN';
const B = 'B';
const S = 'S';
const WS = 'WS';
const ON = 'ON';

/** The constructs this module refuses, as the reason it reports. */
export const BIDI_REFUSALS = Object.freeze({
  explicitFormatting: 'explicitFormatting',
  mirrored: 'mirrored',
});

/** UAX #9 explicit formatting: embeddings, overrides and isolates. Never interpreted, only refused. */
const EXPLICIT_FORMATTING = Object.freeze([[0x202a, 0x202e], [0x2066, 0x2069]]);

/**
 * The three invisible marks whose general category (format) says nothing about their bidi class:
 * the Arabic letter mark is a strong Arabic letter, and the two directional marks are strong.
 */
const CLASS_OVERRIDES = new Map([[0x061c, AL], [0x200e, L], [0x200f, R]]);

const PARAGRAPH_SEPARATORS = new Set([0x000a, 0x000d, 0x001c, 0x001d, 0x001e, 0x0085, 0x2029]);
const SEGMENT_SEPARATORS = new Set([0x0009, 0x000b, 0x001f]);
/** Form feed is a control character whose bidi class is whitespace, which no category test reaches. */
const CONTROL_WHITESPACE = 0x000c;

// Ranges below are ascending and non-overlapping, which `inRanges` relies on to stop early.

/** Arabic-Indic digits and the number signs that group them. */
const AN_RANGES = Object.freeze([
  [0x0600, 0x0605], [0x0660, 0x0669], [0x066b, 0x066c], [0x06dd, 0x06dd],
  [0x0890, 0x0891], [0x08e2, 0x08e2], [0x10d30, 0x10d39], [0x10e60, 0x10e7e],
]);
/** European digits, including the extended Arabic-Indic set, which is EN and not AN. */
const EN_RANGES = Object.freeze([
  [0x0030, 0x0039], [0x00b2, 0x00b3], [0x00b9, 0x00b9], [0x06f0, 0x06f9],
  [0x2070, 0x2070], [0x2074, 0x2079], [0x2080, 0x2089], [0xff10, 0xff19],
]);
/** European separators: the signs that join two European digits. */
const ES_RANGES = Object.freeze([
  [0x002b, 0x002b], [0x002d, 0x002d], [0x207a, 0x207b], [0x208a, 0x208b],
  [0x2212, 0x2212], [0xfb29, 0xfb29], [0xfe62, 0xfe63], [0xff0b, 0xff0b], [0xff0d, 0xff0d],
]);
/** European terminators: the signs that attach to a number without being one. */
const ET_RANGES = Object.freeze([
  [0x0023, 0x0025], [0x00a2, 0x00a5], [0x00b0, 0x00b1], [0x0609, 0x060a], [0x066a, 0x066a],
  [0x2030, 0x2034], [0x20a0, 0x20bf], [0xff03, 0xff05], [0xffe0, 0xffe1], [0xffe5, 0xffe6],
]);
/** Common separators, including the no-break spaces, which are separators rather than whitespace. */
const CS_RANGES = Object.freeze([
  [0x002c, 0x002c], [0x002e, 0x002f], [0x003a, 0x003a], [0x00a0, 0x00a0], [0x060c, 0x060c],
  [0x202f, 0x202f], [0x2044, 0x2044], [0xfe50, 0xfe50], [0xfe52, 0xfe52], [0xfe55, 0xfe55],
  [0xff0c, 0xff0c], [0xff0e, 0xff0f], [0xff1a, 0xff1a],
]);
/** The neutral punctuation that sits inside an otherwise strong right-to-left block. */
const ON_RANGES = Object.freeze([
  [0x0606, 0x0607], [0x060e, 0x060f], [0x06de, 0x06de], [0x06e9, 0x06e9], [0x07f6, 0x07f9],
]);
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

const NON_SPACING_MARK = /^[\p{Mn}\p{Me}]$/u;
const FORMAT_OR_CONTROL = /^[\p{Cf}\p{Cc}]$/u;
const WHITE_SPACE = /^\p{White_Space}$/u;
const STRONG_LEFT = /^[\p{L}\p{Nl}\p{Nd}]$/u;
/** Every character whose glyph must be swapped for its pair when drawn right-to-left. */
const MIRRORED = /\p{Bidi_Mirrored}/u;

const inRanges = (codePoint, ranges) => {
  for (const [low, high] of ranges) {
    if (codePoint < low) return false;
    if (codePoint <= high) return true;
  }
  return false;
};

/**
 * One character's bidi class. `character` is exactly one code point, never a whole cluster: the
 * category tests are anchored and a longer string would silently fail every one of them.
 *
 * Order matters twice over: the number ranges come before the format-character test because the
 * Arabic number signs are format characters with a numeric class, and the separator ranges come
 * before the whitespace test because the no-break spaces are whitespace by category and separators
 * by bidi class.
 */
const bidiClassOf = (character) => {
  const codePoint = character.codePointAt(0);
  const override = CLASS_OVERRIDES.get(codePoint);
  if (override !== undefined) return override;
  if (PARAGRAPH_SEPARATORS.has(codePoint)) return B;
  if (SEGMENT_SEPARATORS.has(codePoint)) return S;
  if (codePoint === CONTROL_WHITESPACE) return WS;
  if (inRanges(codePoint, AN_RANGES)) return AN;
  if (inRanges(codePoint, EN_RANGES)) return EN;
  if (inRanges(codePoint, ES_RANGES)) return ES;
  if (inRanges(codePoint, ET_RANGES)) return ET;
  if (inRanges(codePoint, CS_RANGES)) return CS;
  if (NON_SPACING_MARK.test(character)) return NSM;
  if (FORMAT_OR_CONTROL.test(character)) return BN;
  if (WHITE_SPACE.test(character)) return WS;
  if (inRanges(codePoint, ON_RANGES)) return ON;
  if (inRanges(codePoint, AL_RANGES)) return AL;
  if (inRanges(codePoint, R_RANGES)) return R;
  return STRONG_LEFT.test(character) ? L : ON;
};

/**
 * A grapheme cluster's bidi class is its base character's.
 *
 * The combining marks welded into the cluster would each resolve to NSM and then inherit that same
 * base through W1, so reading the base directly is the same answer without the detour.
 */
const clusterBidiClass = (cluster) => bidiClassOf(String.fromCodePoint(cluster.codePointAt(0)));

/** P2/P3: the first strong cluster decides, and a run with no strong cluster is left-to-right. */
const firstStrongLevel = (classes) => {
  for (const type of classes) {
    if (type === L) return 0;
    if (type === R || type === AL) return 1;
  }
  return 0;
};

/** W1-W7, over the single isolating run sequence the refusals above guarantee. */
const resolveWeakTypes = (classes, sos) => {
  const types = [...classes];

  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === NSM) types[index] = index === 0 ? sos : types[index - 1];
  }

  let strong = sos;
  for (let index = 0; index < types.length; index += 1) {
    const type = types[index];
    if (type === L || type === R || type === AL) strong = type;
    else if (type === EN && strong === AL) types[index] = AN;
  }

  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === AL) types[index] = R;
  }

  for (let index = 1; index < types.length - 1; index += 1) {
    const before = types[index - 1];
    const after = types[index + 1];
    if (types[index] === ES && before === EN && after === EN) types[index] = EN;
    else if (types[index] === CS && before === after && (before === EN || before === AN)) {
      types[index] = before;
    }
  }

  for (let index = 0; index < types.length; index += 1) {
    if (types[index] !== ET) continue;
    let end = index;
    while (end < types.length && types[end] === ET) end += 1;
    // Neither boundary is ever a digit, so a terminator run at either end of the sequence attaches
    // to nothing and falls through to W6.
    const before = index === 0 ? sos : types[index - 1];
    const after = end === types.length ? null : types[end];
    if (before === EN || after === EN) {
      for (let position = index; position < end; position += 1) types[position] = EN;
    }
    index = end - 1;
  }

  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === ET || types[index] === ES || types[index] === CS) types[index] = ON;
  }

  strong = sos;
  for (let index = 0; index < types.length; index += 1) {
    const type = types[index];
    if (type === L || type === R) strong = type;
    else if (type === EN && strong === L) types[index] = L;
  }
  return types;
};

/**
 * Neutrals, and the boundary-neutral characters folded in with them.
 *
 * UAX #9 §5.2 keeps boundary neutrals at the level of what precedes them; treating them as ordinary
 * neutrals instead is observationally identical here, because every one of them is invisible and
 * carries no advance, so no pen position depends on which side of a run it lands on.
 */
const NEUTRAL = new Set([B, S, WS, ON, BN]);

const strongDirectionOf = (type) => {
  if (type === L) return L;
  if (type === R || type === EN || type === AN) return R;
  return null;
};

/** N1 and N2. */
const resolveNeutralTypes = (types, sos, eos, embedding) => {
  const resolved = [...types];
  for (let index = 0; index < resolved.length; index += 1) {
    if (!NEUTRAL.has(resolved[index])) continue;
    let end = index;
    while (end < resolved.length && NEUTRAL.has(resolved[end])) end += 1;
    const before = index === 0 ? sos : strongDirectionOf(resolved[index - 1]);
    const after = end === resolved.length ? eos : strongDirectionOf(resolved[end]);
    const direction = before !== null && before === after ? before : embedding;
    for (let position = index; position < end; position += 1) resolved[position] = direction;
    index = end - 1;
  }
  return resolved;
};

/** I1 and I2. Only L, R, EN and AN survive the neutral pass, so nothing else is considered. */
const resolveLevels = (types, paragraphLevel) => types.map((type) => {
  if (paragraphLevel % 2 === 0) {
    if (type === R) return paragraphLevel + 1;
    if (type === EN || type === AN) return paragraphLevel + 2;
    return paragraphLevel;
  }
  return type === L || type === EN || type === AN ? paragraphLevel + 1 : paragraphLevel;
});

const refusedConstructIn = (clusters, mirroringMatters) => {
  for (const cluster of clusters) {
    for (const character of cluster) {
      if (inRanges(character.codePointAt(0), EXPLICIT_FORMATTING)) {
        return BIDI_REFUSALS.explicitFormatting;
      }
    }
    if (mirroringMatters && MIRRORED.test(cluster)) return BIDI_REFUSALS.mirrored;
  }
  return null;
};

/**
 * Resolve one run's paragraph level and per-cluster embedding levels.
 *
 * `rtlHint` is the caller's own coarse "this run has right-to-left code points" signal. It only ever
 * widens the mirroring refusal, so a classifier disagreement refuses rather than guesses.
 * `baseDirection` forces the paragraph level when the caller knows it — `'ltr'`, `'rtl'`, or `null`
 * to resolve it from the first strong cluster.
 *
 * `refusedConstruct` non-null means the caller must NOT use `levels`: the run carries something this
 * subset does not implement and the compositor has to decline to draw it.
 */
export const analyzeRunBidi = (clusters, { rtlHint = false, baseDirection = null } = {}) => {
  const classes = clusters.map(clusterBidiClass);
  const paragraphLevel = baseDirection === null
    ? firstStrongLevel(classes)
    : (baseDirection === 'rtl' ? 1 : 0);
  const containsRtl = rtlHint || classes.some((type) => type === R || type === AL);
  const refusedConstruct = refusedConstructIn(clusters, containsRtl || paragraphLevel === 1);

  const boundary = paragraphLevel % 2 === 1 ? R : L;
  const weak = resolveWeakTypes(classes, boundary);
  const neutral = resolveNeutralTypes(weak, boundary, boundary, boundary);
  const levels = resolveLevels(neutral, paragraphLevel);

  return {
    paragraphLevel,
    classes,
    levels,
    refusedConstruct,
    // The whole run sits at the paragraph level and the paragraph is left-to-right, so L1 can only
    // rewrite a level to the value it already has and L2 finds no odd level to reverse. Skipping
    // both is what keeps the common Latin path byte-identical to the layout that predates bidi.
    reorders: paragraphLevel !== 0 || levels.some((level) => level !== 0),
  };
};

/** L1: separators, and the whitespace that leads into one or ends the line, return to the base. */
const resetLineLevels = (lineClasses, lineLevels, paragraphLevel) => {
  const reset = [...lineLevels];
  let trailing = true;
  for (let index = reset.length - 1; index >= 0; index -= 1) {
    const type = lineClasses[index];
    if (type === B || type === S) {
      reset[index] = paragraphLevel;
      trailing = true;
    } else if (trailing && (type === WS || type === BN)) {
      reset[index] = paragraphLevel;
    } else {
      trailing = false;
    }
  }
  return reset;
};

/** L2: reverse each maximal run at each level, highest first, down to the lowest odd level. */
const reorderByLevel = (levels) => {
  const order = levels.map((_, index) => index);
  let highest = 0;
  let lowestOdd = Number.MAX_SAFE_INTEGER;
  for (const level of levels) {
    if (level > highest) highest = level;
    if (level % 2 === 1 && level < lowestOdd) lowestOdd = level;
  }
  for (let level = highest; level >= lowestOdd; level -= 1) {
    let start = -1;
    for (let index = 0; index <= levels.length; index += 1) {
      if (index < levels.length && levels[index] >= level) {
        if (start < 0) start = index;
        continue;
      }
      if (start < 0) continue;
      for (let low = start, high = index - 1; low < high; low += 1, high -= 1) {
        const held = order[low];
        order[low] = order[high];
        order[high] = held;
      }
      start = -1;
    }
  }
  return order;
};

/**
 * The visual order of one line, as positions into the line's own cluster list.
 *
 * `indices` are the run's cluster indices in logical order, which is the order the line was broken
 * in; the returned array says which of those positions is drawn first, second and so on, left to
 * right. L1 runs before L2 because the level a trailing space is reset to decides which END of the
 * line it lands on.
 */
export const visualOrderOfLine = ({ indices, analysis }) => {
  const lineLevels = indices.map((index) => analysis.levels[index]);
  const lineClasses = indices.map((index) => analysis.classes[index]);
  return reorderByLevel(resetLineLevels(lineClasses, lineLevels, analysis.paragraphLevel));
};
