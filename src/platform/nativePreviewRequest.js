/**
 * What a native preview frame request must be, checked before anything native is called.
 *
 * Split from `nativePreviewFrames.js`, which owns the other half of the boundary: dispatching a
 * request, coalescing a scrub into it, caching what comes back and tearing it all down. The seam is
 * real rather than a line count — everything here is a pure function of the request, holds no state,
 * touches no bridge and can be run by a caller that has not decided to render anything yet.
 *
 * A scene is the input to a native GPU render, so it is checked here even though the editor produced
 * it: the caller may hand over a reconstructed or persisted one. Bounds are the ones
 * `crates/osg-scene` enforces, deliberately identical values rather than approximations, so an
 * unrenderable scene is refused before a round trip instead of after one.
 *
 * Errors carry a code, a field path and measured sizes. Never a value, never a family the user
 * typed, never a line of subtitle text, never a native path or message. Nothing here logs.
 *
 * Determinism: no clocks and no RNG. The canonical scene is written as explicit literals, so key
 * order — and therefore both the encoded bytes and `sceneRevision` — is fixed.
 */

import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { isStagedGlyphAtlas } from './glyphAtlasStaging';

/** Mirrors `SCENE_SCHEMA_VERSION` in `crates/osg-scene/src/scene.rs`. */
export const NATIVE_PREVIEW_SCENE_VERSION = 1;

/**
 * Which layer of the composition a request asks for. Mirrors `PreviewLayer` in
 * `apps/desktop/src-tauri/src/preview/request.rs`.
 *
 * `composited` is the whole frame as the export writes it and is the DEFAULT, because it is the one
 * with a guarantee attached: it is the exported pixel. `subtitles` is the pass alone on a
 * transparent ground, for an element to lay over the editor's own `<video>`.
 *
 * WHAT THE SUBTITLE LAYER DOES NOT GUARANTEE, stated here because this is where it is chosen: the
 * final blend is then performed by the browser, over a frame the browser's own video decoder
 * colour-managed on its own terms. Chroma subsampling, that colour management and the browser's
 * straight-alpha compositing all land between what our compositor drew and what the screen shows.
 * The result is close, never exact. It is the responsive path for continuous playback only, it is
 * never what a user judges, and it must never be the last thing on screen — which is why every
 * surface where a decision gets made asks for `composited`, and why pausing re-renders.
 */
export const NATIVE_PREVIEW_LAYERS = Object.freeze(['composited', 'subtitles']);

/** The layer a request that names none is asking for: the guaranteed one. */
export const NATIVE_PREVIEW_DEFAULT_LAYER = 'composited';

export const NATIVE_PREVIEW_LIMITS = Object.freeze({
  /**
   * Native renders allowed to run at once. Two keeps the compositor busy while the newest request
   * still waits behind them, so a burst of scrub events costs at most three renders: the two in
   * flight and the one that superseded every other waiter.
   */
  maxInFlight: 2,
  /** Frame URLs retained. Each entry is a short opaque string, so the bound is a count. */
  maxCachedFrames: 64,
  /**
   * The canonical scene encoding one request may carry. The scene travels whole on every request,
   * which keeps the command contract to a single call; this bound is what stops that from becoming
   * an unbounded IPC copy during a scrub.
   */
  maxSceneBytes: 4 * 1024 * 1024,
  // The remaining bounds mirror `crates/osg-scene` so an unrenderable scene is refused here rather
  // than after a round trip. They are deliberately identical values, not approximations.
  maxCues: 100_000,
  maxCueTextBytes: 4_096,
  maxFaceBytes: 256,
  minDimensionPx: 16,
  maxDimensionPx: 7_680,
  maxFrameCount: 2_700_000,
  maxFpsNumerator: 120_000,
  maxFpsDenominator: 1_001,
});

export class NativePreviewFrameError extends Error {
  /** `measurement` carries sizes only. It never carries content, a path or a native message. */
  constructor(code, message, measurement = null) {
    super(message);
    this.name = 'NativePreviewFrameError';
    this.code = code;
    this.measurement = measurement === null ? null : Object.freeze({ ...measurement });
  }
}

// The shape predicates. Exported because the response side of the boundary checks a native reply
// exactly as strictly as this side checks a request, and two copies of "exactly these keys" would be
// two things to keep in step.

export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const isBounded = (value, minimum, maximum) => (
  Number.isInteger(value) && value >= minimum && value <= maximum
);

export const hasExactKeys = (value, expectedKeys) => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
};

export const isUuidV4 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 4;
  } catch {
    return false;
  }
};

export const failed = (code, message, measurement = null) => {
  throw new NativePreviewFrameError(code, message, measurement);
};

const utf8 = new TextEncoder();
const utf8Length = (value) => utf8.encode(value).length;
const hasControlCharacter = (value) => /\p{Cc}/u.test(value);

/** Non-cryptographic identity for cache and revision comparison only. Never a security boundary. */
const fnv1a32 = (bytes) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

const SCENE_KEYS = Object.freeze(['cues', 'face', 'heightPx', 'schemaVersion', 'timeline', 'widthPx']);
const TIMELINE_KEYS = Object.freeze(['fpsDenominator', 'fpsNumerator', 'frameCount', 'start']);
const FACE_KEYS = Object.freeze(['family', 'source', 'weight']);
const CUE_KEYS = Object.freeze(['end', 'start', 'text']);
const TIME_KEYS = Object.freeze(['denominator', 'numerator']);
const REQUEST_KEYS = Object.freeze(['atlas', 'frameIndex', 'scene']);
/** The same request, having named a layer. Optional, so no existing caller has to say `composited`. */
const REQUEST_KEYS_WITH_LAYER = Object.freeze(['atlas', 'frameIndex', 'layer', 'scene']);

/** `detail` is a field path. Never a value, never a cue's text, never a family the user typed. */
const invalidScene = (detail) => failed(
  'nativePreviewInvalidScene',
  `The preview scene cannot be rendered: ${detail}`
);

const validateTime = (time, path) => {
  if (!hasExactKeys(time, TIME_KEYS)) invalidScene(`${path} is not an exact time`);
  if (!Number.isSafeInteger(time.numerator) || time.numerator < 0) invalidScene(`${path}.numerator`);
  if (!Number.isSafeInteger(time.denominator) || time.denominator < 1) invalidScene(`${path}.denominator`);
};

/** Exact, through `BigInt`, because cross-multiplying two safe integers is not itself safe. */
const compareExact = (left, right) => {
  const scaledLeft = BigInt(left.numerator) * BigInt(right.denominator);
  const scaledRight = BigInt(right.numerator) * BigInt(left.denominator);
  if (scaledLeft === scaledRight) return 0;
  return scaledLeft < scaledRight ? -1 : 1;
};

const validateTimeline = (timeline) => {
  if (!hasExactKeys(timeline, TIMELINE_KEYS)) invalidScene('timeline is not a frame grid');
  if (!isBounded(timeline.fpsNumerator, 1, NATIVE_PREVIEW_LIMITS.maxFpsNumerator)) {
    invalidScene('timeline.fpsNumerator is out of bounds');
  }
  if (!isBounded(timeline.fpsDenominator, 1, NATIVE_PREVIEW_LIMITS.maxFpsDenominator)) {
    invalidScene('timeline.fpsDenominator is out of bounds');
  }
  if (!isBounded(timeline.frameCount, 1, NATIVE_PREVIEW_LIMITS.maxFrameCount)) {
    invalidScene('timeline.frameCount is out of bounds');
  }
  validateTime(timeline.start, 'timeline.start');
};

const validateFace = (face) => {
  if (!hasExactKeys(face, FACE_KEYS)) invalidScene('face is not a resolved face');
  for (const field of ['family', 'source']) {
    const value = face[field];
    if (typeof value !== 'string'
        || value.length === 0
        || utf8Length(value) > NATIVE_PREVIEW_LIMITS.maxFaceBytes
        || hasControlCharacter(value)) {
      invalidScene(`face.${field} is missing or out of bounds`);
    }
  }
  // A face that never resolved is the failure the migration exists to stop hiding, so a scene may
  // not carry a weight the renderer would have to guess at.
  if (!isBounded(face.weight, 100, 900) || face.weight % 100 !== 0) {
    invalidScene('face.weight is not a resolved weight');
  }
};

const validateCues = (cues) => {
  if (!Array.isArray(cues) || cues.length > NATIVE_PREVIEW_LIMITS.maxCues) {
    invalidScene('cues is not a bounded cue list');
  }
  let previousStart = null;
  cues.forEach((cue, index) => {
    if (!hasExactKeys(cue, CUE_KEYS)) invalidScene(`cues[${index}] is not a cue`);
    if (typeof cue.text !== 'string'
        || cue.text.length === 0
        || utf8Length(cue.text) > NATIVE_PREVIEW_LIMITS.maxCueTextBytes) {
      invalidScene(`cues[${index}].text is empty or too long`);
    }
    validateTime(cue.start, `cues[${index}].start`);
    validateTime(cue.end, `cues[${index}].end`);
    if (compareExact(cue.end, cue.start) !== 1) invalidScene(`cues[${index}] does not end after it starts`);
    // Selection takes the first match, so an out-of-order list silently hides cues.
    if (previousStart !== null && compareExact(cue.start, previousStart) === -1) {
      invalidScene(`cues[${index}] starts before the cue before it`);
    }
    previousStart = cue.start;
  });
};

const validateScene = (scene) => {
  if (!hasExactKeys(scene, SCENE_KEYS)) invalidScene('scene is not a preview scene');
  // Version is refused before anything else is read: an unknown scene shape must not be
  // interpreted at all, not even to report a better message.
  if (scene.schemaVersion !== NATIVE_PREVIEW_SCENE_VERSION) {
    failed(
      'nativePreviewInvalidScene',
      `This build renders preview scene version ${NATIVE_PREVIEW_SCENE_VERSION} only`
    );
  }
  for (const field of ['widthPx', 'heightPx']) {
    // Odd dimensions are refused here for the same reason the scene crate refuses them: the
    // encoder this feeds requires even ones, and finding out at encode time wastes a whole render.
    if (!isBounded(scene[field], NATIVE_PREVIEW_LIMITS.minDimensionPx, NATIVE_PREVIEW_LIMITS.maxDimensionPx)
        || scene[field] % 2 !== 0) {
      invalidScene(`scene.${field} is not a supported composition dimension`);
    }
  }
  validateTimeline(scene.timeline);
  validateFace(scene.face);
  validateCues(scene.cues);
  return scene;
};

/**
 * The exact scene the native command receives. Written as explicit literals so key order — and
 * therefore both the encoded bytes and `sceneRevision` — is deterministic.
 */
const canonicalizeScene = (scene) => ({
  schemaVersion: NATIVE_PREVIEW_SCENE_VERSION,
  widthPx: scene.widthPx,
  heightPx: scene.heightPx,
  timeline: {
    fpsNumerator: scene.timeline.fpsNumerator,
    fpsDenominator: scene.timeline.fpsDenominator,
    frameCount: scene.timeline.frameCount,
    start: { numerator: scene.timeline.start.numerator, denominator: scene.timeline.start.denominator },
  },
  face: {
    family: scene.face.family,
    source: scene.face.source,
    weight: scene.face.weight,
  },
  cues: scene.cues.map((cue) => ({
    text: cue.text,
    start: { numerator: cue.start.numerator, denominator: cue.start.denominator },
    end: { numerator: cue.end.numerator, denominator: cue.end.denominator },
  })),
});

/**
 * Validate a request and reduce it to what crosses the boundary, without calling anything native.
 *
 * Exported so a caller can learn what a scene costs — and whether it is renderable at all — before
 * committing to a render. `sceneBytes` is the canonical JSON encoding, which is what IPC carries.
 */
export const prepareNativePreviewRequest = (request) => {
  if (!hasExactKeys(request, REQUEST_KEYS) && !hasExactKeys(request, REQUEST_KEYS_WITH_LAYER)) {
    failed('nativePreviewInvalidRequest', 'A preview frame request needs a scene, an atlas and a frame index');
  }
  // Absent means the composited frame. A layer this build does not draw is refused rather than
  // quietly defaulted: a caller that asked for the cheap path and silently got the expensive one
  // would be slow for a reason nothing reports, and the reverse would show an approximation where a
  // guarantee was expected.
  const layer = request.layer === undefined ? NATIVE_PREVIEW_DEFAULT_LAYER : request.layer;
  if (!NATIVE_PREVIEW_LAYERS.includes(layer)) {
    failed('nativePreviewInvalidRequest', 'A preview frame request names a layer this build does not draw');
  }
  // A handle this module did not mint cannot name a native atlas, and a scene rendered without one
  // would silently draw nothing.
  if (!isStagedGlyphAtlas(request.atlas)) {
    failed('nativePreviewInvalidAtlas', 'The glyph atlas has not been staged for the native renderer');
  }
  const scene = validateScene(request.scene);
  if (!isBounded(request.frameIndex, 0, scene.timeline.frameCount - 1)) {
    failed('nativePreviewInvalidRequest', 'The frame index is not inside the scene timeline');
  }

  const canonicalScene = canonicalizeScene(scene);
  const encoded = utf8.encode(JSON.stringify(canonicalScene));
  const measurement = Object.freeze({
    sceneBytes: encoded.length,
    budgetBytes: NATIVE_PREVIEW_LIMITS.maxSceneBytes,
  });
  if (measurement.sceneBytes > NATIVE_PREVIEW_LIMITS.maxSceneBytes) {
    failed(
      'nativePreviewSceneTooLarge',
      'The preview scene exceeds the transport budget and was refused before any native call',
      measurement
    );
  }

  // The byte length joins the hash so two different scenes have to collide on both to share a
  // cache entry, which is the only way a stale frame could reach the screen.
  const sceneRevision = `${fnv1a32(encoded).toString(16).padStart(8, '0')}-${measurement.sceneBytes}`;
  return Object.freeze({
    sceneRevision,
    measurement,
    // The layer joins the key because two layers of one instant are two different pictures. Sharing
    // an entry between them is the one way a transparent overlay could end up on a paused surface.
    cacheKey: `${sceneRevision}:${request.atlas.atlasId}:${request.frameIndex}:${layer}`,
    payload: Object.freeze({
      sceneRevision,
      atlasId: request.atlas.atlasId,
      atlasContentHash: request.atlas.contentHash,
      frameIndex: request.frameIndex,
      layer,
      scene: canonicalScene,
    }),
  });
};
