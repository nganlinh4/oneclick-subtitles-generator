// Field-by-field validation of a baked glyph atlas descriptor before it is staged for a native
// GPU upload, and the typed staging error every refusal is reported through.
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import {
  GLYPH_ATLAS_LIMITS,
  GLYPH_ATLAS_VERSION,
  TEXT_ALIGNMENTS,
  TEXT_TRANSFORMS,
} from './glyphAtlas';
import { hasExactKeys, isRecord } from './plainDataRecord';

export const GLYPH_ATLAS_STAGING_ERROR_CODES = Object.freeze([
  'glyphAtlasStagingInvalidDescriptor',
  'glyphAtlasStagingUnsupportedVersion',
  'glyphAtlasStagingPayloadTooLarge',
  'glyphAtlasStagingRejected',
]);

export class GlyphAtlasStagingError extends Error {
  /** `measurement` carries sizes only. It never carries content, a path or a native message. */
  constructor(code, message, measurement = null) {
    super(message);
    this.name = 'GlyphAtlasStagingError';
    this.code = code;
    this.measurement = measurement === null ? null : Object.freeze({ ...measurement });
  }
}

export const isBounded = (value, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// A glyph origin is signed, so it is bounded by magnitude rather than by range.
//
// `actualBoundingBoxLeft` is positive going *left* from the alignment point, and the baker pins
// textAlign to 'left', so the alignment point is the pen: any glyph whose ink starts to the right
// of the pen — that is, any glyph with a left side bearing wider than the 1px padding, which is
// most glyphs in most fonts — produces a negative originXPx. `actualBoundingBoxAscent` is likewise
// negative for a cluster with no ink above the baseline, such as an underscore.
//
// The Rust side already had this right: it models both as i32 and bounds them with `unsigned_abs`.
const isBoundedMagnitude = (value, maximum) => Number.isInteger(value) && Math.abs(value) <= maximum;

/** The same rule for a fractional quantity: signed, finite, bounded by magnitude rather than range. */
const isFiniteMagnitude = (value, maximum) => isFiniteNumber(value) && Math.abs(value) <= maximum;

export const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

const CONTENT_HASH_PATTERN = /^[0-9a-f]{8}$/;
const DIRECTIONS = new Set(['ltr', 'rtl', 'neutral']);
/** The generic families the baker probes. Fixed, because the far side re-derives against the count. */
const FACE_PROBE_COUNT = 3;
const PROBE_KEYS = ['aloneWidthPx', 'chainedWidthPx', 'participated', 'probeFamily'];
const STYLES = new Set(['normal', 'italic', 'oblique']);
const CELL_ADVANCE_VERDICTS = new Set(['reproduces', 'refused']);
const REFUSAL_KEYS = Object.freeze(['directionNeedsBidi', 'shapingCrossesClusters']);

/**
 * One magnitude bound for every layout coordinate, horizontal and vertical.
 *
 * `maxLayoutWidthPx` is the baker's own bound on the wrap arithmetic, and it also covers the
 * vertical axis by construction: the tallest in-bounds run is `maxLayoutLines` baselines apart, and
 * a line height large enough to exceed this bound over 64 lines is 16384px per line, far above the
 * 512px maximum face this module can bake.
 */
const LAYOUT_COORDINATE_LIMIT = GLYPH_ATLAS_LIMITS.maxLayoutWidthPx;
/** The widest of the baker's two letter-spacing bounds; the sign is meaning, not an error. */
const LETTER_SPACING_LIMIT = Math.max(
  Math.abs(GLYPH_ATLAS_LIMITS.minLetterSpacingPx),
  GLYPH_ATLAS_LIMITS.maxLetterSpacingPx
);

/** `detail` is a field path. Never a value, never a cluster, never a family name. */
const invalid = (detail) => {
  throw new GlyphAtlasStagingError(
    'glyphAtlasStagingInvalidDescriptor',
    `The glyph atlas descriptor cannot be staged: ${detail}`
  );
};

// Validation. A descriptor is the input to a native GPU upload, so it is checked here even though
// this module's own baker produced it: the caller may hand over a reconstructed or persisted one.

const validateFace = (face) => {
  if (!isRecord(face)) invalid('face is not an object');
  if (typeof face.requestedFamily !== 'string'
      || face.requestedFamily.length === 0
      || face.requestedFamily.length > GLYPH_ATLAS_LIMITS.maxFamilyCharacters) {
    invalid('face.requestedFamily is missing or out of bounds');
  }
  if (!isBounded(face.weight, 1, 1_000)) invalid('face.weight is out of bounds');
  if (!STYLES.has(face.style)) invalid('face.style is not a supported style');
  if (!isFiniteNumber(face.fontSizePx)
      || face.fontSizePx < GLYPH_ATLAS_LIMITS.minFontSizePx
      || face.fontSizePx > GLYPH_ATLAS_LIMITS.maxFontSizePx) {
    invalid('face.fontSizePx is out of bounds');
  }
  if (typeof face.substituted !== 'boolean') invalid('face.substituted is not a boolean');
  // The shaping evidence. It crosses deliberately, and carrying the REAL measurements is the whole
  // point: Rust re-derives the substitution verdict from them, so a face that silently fell back is
  // caught on the far side too. Synthesising them would turn that check into a rubber stamp, which
  // is exactly the failure this migration removes — so they are validated here, never invented.
  if (typeof face.cssFont !== 'string'
      || face.cssFont.length === 0
      || face.cssFont.length > GLYPH_ATLAS_LIMITS.maxFamilyCharacters * 2) {
    invalid('face.cssFont is missing or out of bounds');
  }
  if (!Array.isArray(face.probes) || face.probes.length !== FACE_PROBE_COUNT) {
    invalid('face.probes is not the expected probe set');
  }
  const seen = new Set();
  for (const [index, probe] of face.probes.entries()) {
    const at = (field) => `face.probes[${index}].${field}`;
    if (!hasExactKeys(probe, PROBE_KEYS)) invalid(`face.probes[${index}] has unexpected fields`);
    if (typeof probe.probeFamily !== 'string' || probe.probeFamily.length === 0) {
      invalid(at('probeFamily'));
    }
    if (seen.has(probe.probeFamily)) invalid(at('probeFamily is repeated'));
    seen.add(probe.probeFamily);
    if (!isFiniteNumber(probe.aloneWidthPx) || probe.aloneWidthPx < 0) invalid(at('aloneWidthPx'));
    if (!isFiniteNumber(probe.chainedWidthPx) || probe.chainedWidthPx < 0) invalid(at('chainedWidthPx'));
    if (typeof probe.participated !== 'boolean') invalid(at('participated'));
    // The one agreement the far side cannot re-derive without the widths, so it is checked here too.
    if (probe.participated !== (probe.aloneWidthPx !== probe.chainedWidthPx)) {
      invalid(at('participated disagrees with its own measurements'));
    }
  }
  if (!face.probes.some((probe) => probe.participated)) {
    invalid('face.probes records no participating family, so the face was never verified');
  }
};

// `letterSpacingPx` is a metric rather than a style field because the WebView already applied it to
// every cluster advance. Rust positions from the spacing that was actually laid out, never from a
// style value that some other stage may have scaled.
const METRIC_FIELDS = Object.freeze([
  'ascentPx', 'descentPx', 'lineHeightPx', 'baselinePx', 'runAdvanceWidthPx', 'shapingResidualPx',
  'letterSpacingPx',
]);

const validateMetrics = (metrics) => {
  if (!isRecord(metrics)) invalid('metrics is not an object');
  for (const field of METRIC_FIELDS) {
    if (!isFiniteNumber(metrics[field])) invalid(`metrics.${field} is not a finite number`);
  }
  if (metrics.baseDirection !== 'ltr' && metrics.baseDirection !== 'rtl') {
    invalid('metrics.baseDirection is not a resolved direction');
  }
};

const validateAtlas = (atlas) => {
  if (!isRecord(atlas)) invalid('atlas is not an object');
  const { widthPx, heightPx, paddingPx, glyphCount, pixelFormat, bytesPerRow } = atlas;
  if (!isBounded(widthPx, 0, GLYPH_ATLAS_LIMITS.maxAtlasDimensionPx)) invalid('atlas.widthPx is out of bounds');
  if (!isBounded(heightPx, 0, GLYPH_ATLAS_LIMITS.maxAtlasDimensionPx)) invalid('atlas.heightPx is out of bounds');
  // An inkless run packs to 0x0. Half a dimension is never a valid atlas.
  if ((widthPx === 0) !== (heightPx === 0)) invalid('atlas dimensions disagree about being empty');
  if (!isBounded(paddingPx, 0, GLYPH_ATLAS_LIMITS.maxPaddingPx)) invalid('atlas.paddingPx is out of bounds');
  if (!isBounded(glyphCount, 0, GLYPH_ATLAS_LIMITS.maxGlyphCount)) invalid('atlas.glyphCount is out of bounds');
  if (pixelFormat !== 'rgba8') invalid('atlas.pixelFormat is not rgba8');
  if (bytesPerRow !== widthPx * 4) invalid('atlas.bytesPerRow does not match atlas.widthPx');
  return atlas;
};

const validateGlyph = (glyph, atlas, index) => {
  const at = (field) => `glyphs[${index}].${field}`;
  if (!isRecord(glyph)) invalid(`glyphs[${index}] is not an object`);
  if (typeof glyph.cluster !== 'string'
      || glyph.cluster.length === 0
      || [...glyph.cluster].length > GLYPH_ATLAS_LIMITS.maxCellCodePoints) {
    invalid(at('cluster'));
  }
  if (!DIRECTIONS.has(glyph.direction)) invalid(at('direction'));
  if (!isFiniteNumber(glyph.advanceWidthPx) || glyph.advanceWidthPx < 0) invalid(at('advanceWidthPx'));
  if (typeof glyph.substituted !== 'boolean') invalid(at('substituted'));
  for (const field of ['xPx', 'yPx', 'widthPx', 'heightPx']) {
    if (!isBounded(glyph[field], 0, GLYPH_ATLAS_LIMITS.maxAtlasDimensionPx)) invalid(at(field));
  }
  for (const field of ['originXPx', 'originYPx']) {
    if (!isBoundedMagnitude(glyph[field], GLYPH_ATLAS_LIMITS.maxAtlasDimensionPx)) invalid(at(field));
  }
  // A cell that leaves the atlas would make Rust sample outside the uploaded texture.
  if (glyph.xPx + glyph.widthPx > atlas.widthPx || glyph.yPx + glyph.heightPx > atlas.heightPx) {
    invalid(`glyphs[${index}] falls outside the atlas`);
  }
};

/**
 * The authoritative layout, validated as strictly as the glyph table because Rust draws from it
 * without recomputing any of it.
 *
 * `lines[].glyphs` is in VISUAL order and `penXPx[i]` is that cell's exact line-relative pen, so the
 * compositor draws cell `glyphs[i]` at `penXPx[i]` on `baselineYPx` and never accumulates a pen from
 * advances, re-wraps, re-aligns or reorders. Every question about where a glyph goes was answered on
 * the WebView side, which is the only side holding the font stack and `Intl.Segmenter`.
 *
 * SIGNEDNESS IS THE TRAP, and this file already fell into it once with glyph origins. `penXPx` is
 * negative whenever tightened letter spacing pulls a line left of its own start, and
 * `letterSpacingPx` is negative for every tightened run. Both are therefore bounded by MAGNITUDE. A
 * non-negative range check here would refuse ordinary text at the native boundary.
 */
const validateLayoutLine = (line, atlas, index) => {
  const at = (field) => `layout.lines[${index}].${field}`;
  if (!isRecord(line)) invalid(`layout.lines[${index}] is not an object`);
  if (!Array.isArray(line.glyphs)) invalid(at('glyphs'));
  if (!Array.isArray(line.penXPx) || line.penXPx.length !== line.glyphs.length) {
    invalid(at('penXPx disagrees with glyphs in length'));
  }
  for (const cell of line.glyphs) {
    // A line that names a cell the atlas does not carry would make Rust draw from nothing.
    if (!isBounded(cell, 0, atlas.glyphCount - 1)) invalid(at('glyphs names a cell that does not exist'));
  }
  for (const pen of line.penXPx) {
    if (!isFiniteMagnitude(pen, LAYOUT_COORDINATE_LIMIT)) invalid(at('penXPx'));
  }
  for (const field of [
    'advanceWidthPx', 'measuredWidthPx', 'shapingResidualPx', 'baselineYPx', 'justificationPx',
  ]) {
    if (!isFiniteMagnitude(line[field], LAYOUT_COORDINATE_LIMIT)) invalid(at(field));
  }
  if (typeof line.endsParagraph !== 'boolean') invalid(at('endsParagraph'));
  return line.glyphs.length;
};

const validateLayout = (layout, atlas) => {
  if (!isRecord(layout)) invalid('layout is not an object');
  if (!TEXT_TRANSFORMS.includes(layout.textTransform)) invalid('layout.textTransform is not a supported transform');
  if (!TEXT_ALIGNMENTS.includes(layout.textAlign)) invalid('layout.textAlign is not a supported alignment');
  if (typeof layout.wordWrap !== 'boolean') invalid('layout.wordWrap is not a boolean');
  if (!isFiniteMagnitude(layout.letterSpacingPx, LETTER_SPACING_LIMIT)) invalid('layout.letterSpacingPx is out of bounds');
  if (layout.maxWidthPx !== null
      && (!isFiniteNumber(layout.maxWidthPx)
        || layout.maxWidthPx <= 0
        || layout.maxWidthPx > GLYPH_ATLAS_LIMITS.maxLayoutWidthPx)) {
    invalid('layout.maxWidthPx is out of bounds');
  }
  for (const field of ['widthPx', 'heightPx']) {
    if (!isFiniteMagnitude(layout[field], LAYOUT_COORDINATE_LIMIT)) invalid(`layout.${field} is out of bounds`);
  }
  if (!CELL_ADVANCE_VERDICTS.has(layout.cellAdvanceLayout)) invalid('layout.cellAdvanceLayout is not a verdict');
  if (!hasExactKeys(layout.refusal, REFUSAL_KEYS)
      || typeof layout.refusal.shapingCrossesClusters !== 'boolean'
      || typeof layout.refusal.directionNeedsBidi !== 'boolean') {
    invalid('layout.refusal is not the refusal record');
  }
  if (!Array.isArray(layout.lines) || layout.lines.length > GLYPH_ATLAS_LIMITS.maxLayoutLines) {
    invalid('layout.lines is missing or exceeds the line bound');
  }
  if (layout.lineCount !== layout.lines.length) invalid('layout.lineCount disagrees with layout.lines');
  let cells = 0;
  layout.lines.forEach((line, index) => { cells += validateLayoutLine(line, atlas, index); });
  if (cells > GLYPH_ATLAS_LIMITS.maxLayoutCells) invalid('layout exceeds the laid-out cell bound');
};

const validatePixels = (pixels, atlas) => {
  const expected = atlas.widthPx * atlas.heightPx * 4;
  if (!ArrayBuffer.isView(pixels) || pixels.BYTES_PER_ELEMENT !== 1) invalid('pixels is not a byte view');
  if (pixels.length !== expected) invalid('pixels length does not match the declared atlas');
};

export const validateDescriptor = (descriptor) => {
  if (!isRecord(descriptor)) invalid('descriptor is not an object');
  // Version is refused before anything else is read: an unknown descriptor shape must not be
  // interpreted at all, not even to report a better message.
  if (descriptor.version !== GLYPH_ATLAS_VERSION) {
    throw new GlyphAtlasStagingError(
      'glyphAtlasStagingUnsupportedVersion',
      `This build stages glyph atlas version ${GLYPH_ATLAS_VERSION} only`
    );
  }
  if (typeof descriptor.contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(descriptor.contentHash)) {
    invalid('contentHash is not an atlas content hash');
  }
  validateFace(descriptor.face);
  validateMetrics(descriptor.metrics);
  const atlas = validateAtlas(descriptor.atlas);
  if (!Array.isArray(descriptor.glyphs) || descriptor.glyphs.length !== atlas.glyphCount) {
    invalid('glyphs length disagrees with atlas.glyphCount');
  }
  descriptor.glyphs.forEach((glyph, index) => validateGlyph(glyph, atlas, index));
  validateLayout(descriptor.layout, atlas);
  validatePixels(descriptor.pixels, atlas);
  return descriptor;
};
