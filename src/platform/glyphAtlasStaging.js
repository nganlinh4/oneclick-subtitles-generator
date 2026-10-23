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

import { invokeDesktopRaw } from './desktopRuntime';
import {
  GlyphAtlasStagingError,
  isBounded,
  isUuidV7,
  validateDescriptor,
} from './glyphAtlasStagingDescriptor';
import { hasExactKeys, isNativeErrorCode, isRecord } from './plainDataRecord';

export {
  GLYPH_ATLAS_STAGING_ERROR_CODES,
  GlyphAtlasStagingError,
} from './glyphAtlasStagingDescriptor';

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

/**
 * A symbol brand, not a string key: a JSON response from native code cannot forge it, so a handle
 * is provably something this module minted rather than something that arrived over IPC.
 */
const STAGED_GLYPH_ATLAS = Symbol('osg.stagedGlyphAtlas');

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
  if (isNativeErrorCode(error?.code)) {
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
