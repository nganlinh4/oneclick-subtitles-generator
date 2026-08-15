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
import { GLYPH_ATLAS_LIMITS, GLYPH_ATLAS_VERSION } from './glyphAtlas';

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
  /** Metadata is the glyph table only; a megabyte is far above the measured worst case. */
  maxMetadataBytes: 1024 * 1024,
  /** Live atlases the WebView will keep handles for. Each one is a native GPU texture. */
  maxStagedAtlases: 8,
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
const STYLES = new Set(['normal', 'italic', 'oblique']);

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
};

const METRIC_FIELDS = Object.freeze([
  'ascentPx', 'descentPx', 'lineHeightPx', 'baselinePx', 'runAdvanceWidthPx', 'shapingResidualPx',
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
  },
  metrics: {
    ascentPx: descriptor.metrics.ascentPx,
    descentPx: descriptor.metrics.descentPx,
    lineHeightPx: descriptor.metrics.lineHeightPx,
    baselinePx: descriptor.metrics.baselinePx,
    runAdvanceWidthPx: descriptor.metrics.runAdvanceWidthPx,
    shapingResidualPx: descriptor.metrics.shapingResidualPx,
    baseDirection: descriptor.metrics.baseDirection,
  },
  atlas: {
    widthPx: descriptor.atlas.widthPx,
    heightPx: descriptor.atlas.heightPx,
    paddingPx: descriptor.atlas.paddingPx,
    glyphCount: descriptor.atlas.glyphCount,
    pixelFormat: descriptor.atlas.pixelFormat,
    bytesPerRow: descriptor.atlas.bytesPerRow,
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
