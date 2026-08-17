/**
 * Staging: how one baked glyph atlas leaves the WebView and reaches the native compositor.
 *
 * DIRECTION IS THE WHOLE POINT, and it is the thing most easily confused about this boundary.
 * The content security policy (`connect-src 'self' ipc: http://ipc.localhost`, no
 * `wasm-unsafe-eval`, no `blob:`) constrains what the WebView may RECEIVE from the loopback
 * capability server: it cannot `fetch`, stream or open a WebSocket to `127.0.0.1`, which is exactly
 * why composited frames come back the other way as `<img>` element loads
 * (`crates/osg-media-server/src/frames.rs`). Sending an atlas WebView -> Rust, once per text
 * revision, over the Tauri command boundary is the opposite direction and is permitted by that same
 * policy; `http://ipc.localhost` is the origin it already allows. Nothing in this module relaxes
 * anything for the receive direction, and nothing here introduces a new origin.
 *
 * Permitted is not unconditional. What crosses is:
 *   - bounded: the payload is measured and refused BEFORE the frame is built, so an atlas at the
 *     baker's own limits never becomes an IPC copy;
 *   - versioned twice: the frame contract (`GLYPH_ATLAS_STAGING_VERSION`) and the descriptor
 *     contract (`GLYPH_ATLAS_VERSION`) are carried and checked independently;
 *   - validated field by field, because a descriptor is the input to a native GPU upload;
 *   - free of native paths, credentials, process arguments and provider URLs — the payload has no
 *     field that could carry one, and the handle Rust returns is an opaque id.
 *
 * Determinism: no clocks, no RNG. The frame is a pure function of the descriptor, so the same text
 * revision always produces byte-identical staging input, and `contentHash` is a sound cache key.
 *
 * Errors never carry the pixel bytes, a path, or the user's subtitle text. Detail strings are field
 * paths and measured sizes only, and a native failure is reduced to a typed code.
 *
 * Frame layout (little-endian), one self-describing binary body:
 *
 *   offset  size  field
 *   0       8     magic "OSGATLAS"
 *   8       4     u32 frame version
 *   12      4     u32 metadata length in bytes
 *   16      m     metadata, UTF-8 JSON (see `buildMetadata`)
 *   16+m    p     pixels, tightly packed RGBA8, `bytesPerRow = widthPx * 4`
 *
 * The pixel length is deliberately not repeated in the header: it is `widthPx * heightPx * 4` from
 * the metadata, so the receiver cross-checks the body length against the declared atlas instead of
 * trusting a second copy of the same number.
 */

import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktopRaw } from './desktopRuntime';
import {
  GLYPH_ATLAS_LIMITS,
  GLYPH_ATLAS_VERSION,
  TEXT_ALIGNMENTS,
  TEXT_TRANSFORMS,
} from './glyphAtlas';

/** Version of the staging frame and of the native command contract, not of the atlas descriptor. */
export const GLYPH_ATLAS_STAGING_VERSION = 1;

export const GLYPH_ATLAS_STAGE_COMMAND = 'glyph_atlas_stage';
export const GLYPH_ATLAS_FRAME_MEDIA_TYPE = 'application/vnd.osg.glyph-atlas.v1';

const CONTENT_TYPE_HEADER = 'x-osg-content-type';
const FRAME_MAGIC = 'OSGATLAS';
const FRAME_HEADER_BYTES = 16;

export const GLYPH_ATLAS_STAGING_LIMITS = Object.freeze({
  /**
   * One staged atlas is held simultaneously by the WebView, the IPC layer and Rust, so the transient
   * cost is roughly three times this. 32 MiB therefore admits every atlas up to half the baker's
   * maximum area (for example 4096x2048, or 1024 cells of 128x128) while refusing the baker's
   * absolute worst case of 4096x4096 RGBA8, which would put ~192 MiB in flight for one text
   * revision. The worst case is measured, not estimated: see `glyphAtlasStaging.test.js`.
   */
  maxPayloadBytes: 32 * 1024 * 1024,
  /** Metadata is the glyph table and the layout; a megabyte is far above the measured worst case. */
  maxMetadataBytes: 1024 * 1024,
  /**
   * Live atlases the WebView will keep handles for, mirroring `MAX_STAGED_ATLASES` in
   * `apps/desktop/src-tauri/src/glyph_atlas.rs` so the cache does not forget an atlas the registry
   * still holds. One export stages one page per `MAX_ATLAS_PAGES`, and all of its pages must be
   * addressable at once when `render_start` resolves them — a cache smaller than that would simply
   * re-upload pages the registry already has. The entries are handles, not pixels, so the cost of
   * the larger bound is a few dozen small records.
   */
  maxStagedAtlases: 40,
});

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

/**
 * A symbol brand, not a string key: a JSON response from native code cannot forge it, so a handle
 * is provably something this module minted rather than something that arrived over IPC.
 */
const STAGED_GLYPH_ATLAS = Symbol('osg.stagedGlyphAtlas');

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBounded = (value, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum;
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

const hasExactKeys = (value, expectedKeys) => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
};

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

const CONTENT_HASH_PATTERN = /^[0-9a-f]{8}$/;
/** Mirrors the code shape `desktopRuntime` already guarantees for a sanitized bridge error. */
const NATIVE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,127}$/;
const DIRECTIONS = new Set(['ltr', 'rtl', 'neutral']);
/** The generic families the baker probes. Fixed, because the far side re-derives against the count. */
const FACE_PROBE_COUNT = 3;
const PROBE_KEYS = ['aloneWidthPx', 'chainedWidthPx', 'participated', 'probeFamily'];
const STYLES = new Set(['normal', 'italic', 'oblique']);
const CELL_ADVANCE_VERDICTS = new Set(['reproduces', 'refused']);
/** Sorted, because `hasExactKeys` compares against a sorted key list. */
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
      || [...glyph.cluster].length > GLYPH_ATLAS_LIMITS.maxClusterCodePoints) {
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

const validateDescriptor = (descriptor) => {
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

// Payload

/**
 * The exact metadata the native command receives. Written as explicit literals so key order — and
 * therefore the encoded bytes — is deterministic.
 *
 * Deliberately absent: `face.cssFont` and `face.probes`, which are WebView-internal evidence that
 * Rust has no use for because Rust never shapes text; and `glyph.codePoints`, which is derivable
 * from `cluster` and would be a second encoding of the same identity that could disagree with it.
 *
 * Deliberately present in full: `layout`. It is the authoritative answer to where every glyph goes,
 * and the only alternative to forwarding it is Rust reconstructing a pen from cell advances — a
 * second layout implementation that agrees with this one at zero letter spacing and one line, and
 * diverges everywhere else. Every field of it is carried; nothing here summarises or re-derives.
 */
const buildMetadata = (descriptor) => ({
  frameVersion: GLYPH_ATLAS_STAGING_VERSION,
  atlasVersion: descriptor.version,
  contentHash: descriptor.contentHash,
  face: {
    requestedFamily: descriptor.face.requestedFamily,
    weight: descriptor.face.weight,
    style: descriptor.face.style,
    fontSizePx: descriptor.face.fontSizePx,
    substituted: descriptor.face.substituted,
    cssFont: descriptor.face.cssFont,
    probes: descriptor.face.probes.map((probe) => ({
      probeFamily: probe.probeFamily,
      aloneWidthPx: probe.aloneWidthPx,
      chainedWidthPx: probe.chainedWidthPx,
      participated: probe.participated,
    })),
  },
  metrics: {
    ascentPx: descriptor.metrics.ascentPx,
    descentPx: descriptor.metrics.descentPx,
    lineHeightPx: descriptor.metrics.lineHeightPx,
    baselinePx: descriptor.metrics.baselinePx,
    runAdvanceWidthPx: descriptor.metrics.runAdvanceWidthPx,
    shapingResidualPx: descriptor.metrics.shapingResidualPx,
    baseDirection: descriptor.metrics.baseDirection,
    letterSpacingPx: descriptor.metrics.letterSpacingPx,
  },
  atlas: {
    widthPx: descriptor.atlas.widthPx,
    heightPx: descriptor.atlas.heightPx,
    paddingPx: descriptor.atlas.paddingPx,
    glyphCount: descriptor.atlas.glyphCount,
    pixelFormat: descriptor.atlas.pixelFormat,
    bytesPerRow: descriptor.atlas.bytesPerRow,
  },
  layout: {
    textTransform: descriptor.layout.textTransform,
    letterSpacingPx: descriptor.layout.letterSpacingPx,
    maxWidthPx: descriptor.layout.maxWidthPx,
    wordWrap: descriptor.layout.wordWrap,
    textAlign: descriptor.layout.textAlign,
    lineCount: descriptor.layout.lineCount,
    widthPx: descriptor.layout.widthPx,
    heightPx: descriptor.layout.heightPx,
    cellAdvanceLayout: descriptor.layout.cellAdvanceLayout,
    refusal: {
      shapingCrossesClusters: descriptor.layout.refusal.shapingCrossesClusters,
      directionNeedsBidi: descriptor.layout.refusal.directionNeedsBidi,
    },
    lines: descriptor.layout.lines.map((line) => ({
      glyphs: [...line.glyphs],
      penXPx: [...line.penXPx],
      advanceWidthPx: line.advanceWidthPx,
      measuredWidthPx: line.measuredWidthPx,
      shapingResidualPx: line.shapingResidualPx,
      baselineYPx: line.baselineYPx,
      justificationPx: line.justificationPx,
      endsParagraph: line.endsParagraph,
    })),
  },
  glyphs: descriptor.glyphs.map((glyph) => ({
    cluster: glyph.cluster,
    direction: glyph.direction,
    advanceWidthPx: glyph.advanceWidthPx,
    xPx: glyph.xPx,
    yPx: glyph.yPx,
    widthPx: glyph.widthPx,
    heightPx: glyph.heightPx,
    originXPx: glyph.originXPx,
    originYPx: glyph.originYPx,
    substituted: glyph.substituted,
  })),
});

const encodeMetadata = (descriptor) => new TextEncoder().encode(JSON.stringify(buildMetadata(descriptor)));

const measureFrame = (metadataBytes, pixelBytes) => Object.freeze({
  metadataBytes,
  pixelBytes,
  totalBytes: FRAME_HEADER_BYTES + metadataBytes + pixelBytes,
  budgetBytes: GLYPH_ATLAS_STAGING_LIMITS.maxPayloadBytes,
});

/**
 * Measure what staging this descriptor would put on the wire, without building the frame.
 *
 * This is the same measurement `stage` enforces, exposed so a caller (or a test) can learn the real
 * cost of an atlas before committing to it. `withinBudget` is false when either the whole frame or
 * the metadata alone exceeds its bound.
 */
export const measureGlyphAtlasPayload = (descriptor) => {
  validateDescriptor(descriptor);
  const measurement = measureFrame(encodeMetadata(descriptor).length, descriptor.pixels.length);
  return Object.freeze({
    ...measurement,
    withinBudget: measurement.totalBytes <= GLYPH_ATLAS_STAGING_LIMITS.maxPayloadBytes
      && measurement.metadataBytes <= GLYPH_ATLAS_STAGING_LIMITS.maxMetadataBytes,
  });
};

const buildFrame = (metadata, pixels) => {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + metadata.length + pixels.length);
  for (let index = 0; index < FRAME_MAGIC.length; index += 1) {
    frame[index] = FRAME_MAGIC.charCodeAt(index);
  }
  const header = new DataView(frame.buffer);
  header.setUint32(8, GLYPH_ATLAS_STAGING_VERSION, true);
  header.setUint32(12, metadata.length, true);
  frame.set(metadata, FRAME_HEADER_BYTES);
  frame.set(pixels, FRAME_HEADER_BYTES + metadata.length);
  return frame;
};

/** Refuses over-budget input before a single byte is copied for IPC. */
const prepareFrame = (descriptor) => {
  const metadata = encodeMetadata(descriptor);
  const measurement = measureFrame(metadata.length, descriptor.pixels.length);
  if (measurement.metadataBytes > GLYPH_ATLAS_STAGING_LIMITS.maxMetadataBytes
      || measurement.totalBytes > GLYPH_ATLAS_STAGING_LIMITS.maxPayloadBytes) {
    throw new GlyphAtlasStagingError(
      'glyphAtlasStagingPayloadTooLarge',
      'The baked glyph atlas exceeds the staging budget and was refused before any native call',
      measurement
    );
  }
  return { frame: buildFrame(metadata, descriptor.pixels), measurement };
};

// Native round trip

const rejected = (error) => {
  const failure = new GlyphAtlasStagingError(
    'glyphAtlasStagingRejected',
    'The desktop renderer did not accept the glyph atlas'
  );
  // Only an already-sanitized code crosses back. The native message, cause and stack are dropped:
  // they are the only fields that could ever carry a path, a process argument or the user's text.
  if (typeof error?.code === 'string' && NATIVE_CODE_PATTERN.test(error.code)) {
    failure.nativeCode = error.code;
  }
  return failure;
};

const toHandle = (descriptor, response, measurement) => {
  if (!hasExactKeys(response, ['atlasId', 'contentHash'])
      || !isUuidV7(response.atlasId)
      || response.contentHash !== descriptor.contentHash) {
    throw rejected(null);
  }
  return Object.freeze({
    [STAGED_GLYPH_ATLAS]: true,
    stagingVersion: GLYPH_ATLAS_STAGING_VERSION,
    atlasVersion: descriptor.version,
    atlasId: response.atlasId,
    contentHash: descriptor.contentHash,
    widthPx: descriptor.atlas.widthPx,
    heightPx: descriptor.atlas.heightPx,
    glyphCount: descriptor.atlas.glyphCount,
    payloadBytes: measurement.totalBytes,
  });
};

/** True only for a handle this module minted from a successful stage. */
export const isStagedGlyphAtlas = (value) => (
  isRecord(value) && value[STAGED_GLYPH_ATLAS] === true && Object.isFrozen(value)
);

/**
 * Create a stager: a bounded, content-addressed cache in front of the native stage command.
 *
 * The cache holds handles only — an opaque id and sizes. It never retains pixel bytes, so the
 * bound is an entry count rather than a byte budget, and an evicted revision simply re-stages.
 * Concurrent stages of the same `contentHash` share one in-flight call so a preview and an export
 * asking for the same text revision cannot upload it twice.
 */
export const createGlyphAtlasStager = ({ maxEntries = GLYPH_ATLAS_STAGING_LIMITS.maxStagedAtlases } = {}) => {
  if (!isBounded(maxEntries, 1, GLYPH_ATLAS_STAGING_LIMITS.maxStagedAtlases)) {
    throw new TypeError(`maxEntries must be an integer in 1..${GLYPH_ATLAS_STAGING_LIMITS.maxStagedAtlases}`);
  }

  const staged = new Map();
  const inFlight = new Map();

  /** Insertion order is recency order, so the least recently reused atlas is evicted first. */
  const reuse = (contentHash) => {
    const handle = staged.get(contentHash);
    if (handle === undefined) return undefined;
    staged.delete(contentHash);
    staged.set(contentHash, handle);
    return handle;
  };

  const remember = (handle) => {
    staged.set(handle.contentHash, handle);
    while (staged.size > maxEntries) staged.delete(staged.keys().next().value);
  };

  const send = async (descriptor) => {
    const { frame, measurement } = prepareFrame(descriptor);
    let response;
    try {
      response = await invokeDesktopRaw(
        GLYPH_ATLAS_STAGE_COMMAND,
        frame,
        { [CONTENT_TYPE_HEADER]: GLYPH_ATLAS_FRAME_MEDIA_TYPE }
      );
    } catch (error) {
      throw rejected(error);
    }
    const handle = toHandle(descriptor, response, measurement);
    remember(handle);
    return handle;
  };

  const stage = async (descriptor) => {
    validateDescriptor(descriptor);
    const { contentHash } = descriptor;
    const cached = reuse(contentHash);
    if (cached !== undefined) return cached;
    const pending = inFlight.get(contentHash);
    if (pending !== undefined) return pending;

    const started = send(descriptor);
    inFlight.set(contentHash, started);
    try {
      return await started;
    } finally {
      inFlight.delete(contentHash);
    }
  };

  return Object.freeze({
    stage,
    /** Inspect without affecting recency. */
    peek: (contentHash) => staged.get(contentHash),
    size: () => staged.size,
  });
};

const sharedStager = createGlyphAtlasStager();

/**
 * Stage a baked atlas through the process-wide stager and return the handle the renderer needs.
 *
 * The returned handle is the caller's reference to the native atlas; pass `handle.atlasId` on to
 * the render command. Repeating the same text revision returns the identical handle without
 * touching IPC.
 */
export const stageGlyphAtlas = (descriptor) => sharedStager.stage(descriptor);
