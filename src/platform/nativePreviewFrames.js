/**
 * Preview transport: how a natively composited frame reaches the editor's `<img>`.
 *
 * DIRECTION, again, is the whole point. The content security policy allows
 * `connect-src 'self' ipc: http://ipc.localhost` and no `wasm-unsafe-eval` or `blob:`, so the
 * WebView cannot `fetch`, stream or open a WebSocket against the loopback capability server. It
 * *can* load `http://127.0.0.1:*` as an image, because `img-src` says so. This module therefore
 * asks Rust for a frame over the command boundary — the permitted direction, the same one
 * `glyphAtlasStaging.js` uses — and gets back a URL whose only legitimate use is an element load.
 * It never fetches that URL. Nothing here relaxes anything, and no new origin is introduced.
 *
 * Why this exists at all: preview and export are identical only if the same compositor drew both.
 * Once the editor's `<img>` shows what `crates/osg-compositor` produced, WYSIWYG stops being a
 * discipline that a hand-maintained second renderer keeps breaking and becomes a property of the
 * architecture. See `docs/rewrite/NATIVE_RENDERER.md`.
 *
 * What this module guarantees:
 *
 *   - **Bounded.** A scene is validated against the same bounds `crates/osg-scene` enforces and
 *     measured before it can become an IPC copy; in-flight requests and the URL cache are both
 *     capped, and the cache evicts least-recently-used so a long scrub cannot grow without limit.
 *   - **Coalesced.** Scrubbing produces one request per mousemove, not one native render per
 *     mousemove. At most `maxInFlight` renders run and exactly one request waits behind them; a
 *     newer request supersedes the waiting one, and the superseded request *settles* — it resolves
 *     with `status: 'superseded'` rather than hanging forever on a render that will never happen.
 *   - **Cancellable.** `close()` settles everything outstanding as `status: 'cancelled'` and marks
 *     the surface dead. A native response that arrives afterwards is dropped: it does not settle a
 *     caller a second time and it does not write to the cache.
 *   - **Honest.** A native refusal — an atlas whose cell advances cannot be trusted, an unavailable
 *     font, a scene the compositor will not draw — arrives as a typed error. It is never a blank
 *     frame that a user would read as an empty subtitle, and it is never silently retried.
 *   - **Leak-free.** Errors carry a code, a field path and measured sizes. Never a native path,
 *     never a credential, never the user's subtitle text, never a native message or stack. Nothing
 *     in this module logs.
 *
 * Determinism: no clocks and no RNG. `sceneRevision` is a pure function of the canonical scene, so
 * the same scene always produces the same cache key, and seeking to a frame twice hits the cache
 * instead of re-rendering.
 *
 * One honest limitation: a cached URL addresses a native frame registry that has its own bound and
 * its own expiry (`crates/osg-media-server/src/frames.rs`). A URL this module still holds can stop
 * resolving once Rust evicts or expires the sequence behind it. That surfaces as an element load
 * error, which the caller must treat as a miss: call `forget(outcome.cacheKey)` and request again.
 * This module deliberately does not poll, retry or hold a clock to hide that.
 */

import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { DESKTOP_RUNTIME_UNAVAILABLE, invokeDesktop } from './desktopRuntime';
import { isStagedGlyphAtlas } from './glyphAtlasStaging';

/** The native command this transport speaks to. */
export const NATIVE_PREVIEW_FRAME_COMMAND = 'preview_frame_render';

/** Mirrors `SCENE_SCHEMA_VERSION` in `crates/osg-scene/src/scene.rs`. */
export const NATIVE_PREVIEW_SCENE_VERSION = 1;

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

export const NATIVE_PREVIEW_ERROR_CODES = Object.freeze([
  'nativePreviewInvalidRequest',
  'nativePreviewInvalidScene',
  'nativePreviewInvalidAtlas',
  'nativePreviewSceneTooLarge',
  'nativePreviewSurfaceClosed',
  'nativePreviewUnavailable',
  'nativePreviewRejected',
]);

/** How a frame request settled. Only `ready` carries a URL. */
export const NATIVE_PREVIEW_OUTCOMES = Object.freeze(['ready', 'superseded', 'cancelled']);

export class NativePreviewFrameError extends Error {
  /** `measurement` carries sizes only. It never carries content, a path or a native message. */
  constructor(code, message, measurement = null) {
    super(message);
    this.name = 'NativePreviewFrameError';
    this.code = code;
    this.measurement = measurement === null ? null : Object.freeze({ ...measurement });
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBounded = (value, minimum, maximum) => (
  Number.isInteger(value) && value >= minimum && value <= maximum
);

const hasExactKeys = (value, expectedKeys) => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
};

const isUuidV4 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 4;
  } catch {
    return false;
  }
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

// Request validation. A scene is the input to a native GPU render, so it is checked here even
// though the editor produced it: the caller may hand over a reconstructed or persisted one.

const SCENE_KEYS = Object.freeze(['cues', 'face', 'heightPx', 'schemaVersion', 'timeline', 'widthPx']);
const TIMELINE_KEYS = Object.freeze(['fpsDenominator', 'fpsNumerator', 'frameCount', 'start']);
const FACE_KEYS = Object.freeze(['family', 'source', 'weight']);
const CUE_KEYS = Object.freeze(['end', 'start', 'text']);
const TIME_KEYS = Object.freeze(['denominator', 'numerator']);
const REQUEST_KEYS = Object.freeze(['atlas', 'frameIndex', 'scene']);

const failed = (code, message, measurement = null) => {
  throw new NativePreviewFrameError(code, message, measurement);
};

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
  if (!hasExactKeys(request, REQUEST_KEYS)) {
    failed('nativePreviewInvalidRequest', 'A preview frame request needs a scene, an atlas and a frame index');
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
    cacheKey: `${sceneRevision}:${request.atlas.atlasId}:${request.frameIndex}`,
    payload: Object.freeze({
      sceneRevision,
      atlasId: request.atlas.atlasId,
      atlasContentHash: request.atlas.contentHash,
      frameIndex: request.frameIndex,
      scene: canonicalScene,
    }),
  });
};

// The native round trip

const FRAME_URL_PATTERN = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/frame\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(0|[1-9][0-9]{0,8})\?token=[0-9a-f]{64}&frame_token=[0-9a-f]{64}$/;
/** Mirrors the signature-checked image types `osg-media-server` will publish a frame as. */
const FRAME_MIME_TYPES = new Set(['image/png', 'image/webp']);
const RESPONSE_KEYS = Object.freeze([
  'frameIndex', 'frameUrl', 'heightPx', 'mimeType', 'sequenceId', 'widthPx',
]);
/** Mirrors the code shape `desktopRuntime` already guarantees for a sanitized bridge error. */
const NATIVE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,127}$/;

const rejected = (error) => {
  const failure = new NativePreviewFrameError(
    'nativePreviewRejected',
    'The desktop renderer did not produce the requested preview frame'
  );
  // Only an already-sanitized code crosses back. The native message, cause and stack are dropped:
  // they are the only fields that could ever carry a path, a process argument or the user's text.
  if (typeof error?.code === 'string' && NATIVE_CODE_PATTERN.test(error.code)) {
    failure.nativeCode = error.code;
  }
  return failure;
};

const fromNativeError = (error) => {
  if (error?.code === DESKTOP_RUNTIME_UNAVAILABLE) {
    return new NativePreviewFrameError(
      'nativePreviewUnavailable',
      'Native preview frames require the desktop runtime'
    );
  }
  return rejected(error);
};

/**
 * Turn a native response into the outcome the caller may put in an `<img>`, or refuse it.
 *
 * The URL is matched against an anchored allowlist rather than parsed, so nothing but a loopback
 * frame capability can ever reach an element, and the frame it addresses is cross-checked against
 * the frame that was asked for. A response whose size disagrees with the scene is refused too: a
 * preview at the wrong size is exactly the silent divergence this transport exists to remove.
 */
const toOutcome = (payload, cacheKey, response) => {
  if (!hasExactKeys(response, RESPONSE_KEYS)) throw rejected(null);
  const match = typeof response.frameUrl === 'string' ? FRAME_URL_PATTERN.exec(response.frameUrl) : null;
  if (match === null) throw rejected(null);
  const [, portText, sequenceId, indexText] = match;
  const port = Number(portText);
  if (!isBounded(port, 1, 65_535)
      || String(port) !== portText
      || !isUuidV4(sequenceId)
      || response.sequenceId !== sequenceId
      || response.frameIndex !== payload.frameIndex
      || String(payload.frameIndex) !== indexText
      || !FRAME_MIME_TYPES.has(response.mimeType)
      || response.widthPx !== payload.scene.widthPx
      || response.heightPx !== payload.scene.heightPx) {
    throw rejected(null);
  }
  return Object.freeze({
    status: 'ready',
    url: response.frameUrl,
    frameIndex: payload.frameIndex,
    widthPx: response.widthPx,
    heightPx: response.heightPx,
    mimeType: response.mimeType,
    cacheKey,
  });
};

const settledOutcome = (status, frameIndex) => Object.freeze({
  status,
  url: null,
  frameIndex,
});

/**
 * Create a preview surface: one bounded, coalescing, cancellable client of the native compositor.
 *
 * A surface is the unit of both coalescing and teardown, so an editor creates one per place frames
 * are shown and closes it when that place goes away. There is deliberately no process-wide shared
 * surface: a shared one could not be torn down without cancelling somebody else's frames.
 */
export const createNativePreviewSurface = ({
  maxInFlight = NATIVE_PREVIEW_LIMITS.maxInFlight,
  maxCachedFrames = NATIVE_PREVIEW_LIMITS.maxCachedFrames,
} = {}) => {
  if (!isBounded(maxInFlight, 1, NATIVE_PREVIEW_LIMITS.maxInFlight)) {
    throw new TypeError(`maxInFlight must be an integer in 1..${NATIVE_PREVIEW_LIMITS.maxInFlight}`);
  }
  if (!isBounded(maxCachedFrames, 1, NATIVE_PREVIEW_LIMITS.maxCachedFrames)) {
    throw new TypeError(`maxCachedFrames must be an integer in 1..${NATIVE_PREVIEW_LIMITS.maxCachedFrames}`);
  }

  const cache = new Map();
  const inFlight = new Map();
  /** At most one request waits. A newer one takes its place and the older one settles. */
  let waiting = null;
  let closed = false;

  /** Insertion order is recency order, so the least recently used frame is evicted first. */
  const reuse = (cacheKey) => {
    const outcome = cache.get(cacheKey);
    if (outcome === undefined) return undefined;
    cache.delete(cacheKey);
    cache.set(cacheKey, outcome);
    return outcome;
  };

  const remember = (cacheKey, outcome) => {
    cache.set(cacheKey, outcome);
    while (cache.size > maxCachedFrames) cache.delete(cache.keys().next().value);
  };

  const createEntry = (prepared) => {
    const entry = { ...prepared, settled: false, resolve: null, reject: null };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    return entry;
  };

  const settle = (entry, outcome) => {
    if (entry.settled) return;
    entry.settled = true;
    entry.resolve(outcome);
  };

  const abandon = (entry, error) => {
    if (entry.settled) return;
    entry.settled = true;
    entry.reject(error);
  };

  /**
   * Start the waiting request once a render finishes. It cannot already be cached or in flight:
   * `requestFrame` checks both before it ever creates an entry, and neither set grows meanwhile.
   */
  const drain = () => {
    if (closed || waiting === null || inFlight.size >= maxInFlight) return;
    const next = waiting;
    waiting = null;
    dispatch(next);
  };

  const complete = (entry, outcome, error) => {
    inFlight.delete(entry.cacheKey);
    // A response that arrives after teardown may touch nothing: not the caller, who already
    // settled as cancelled, and not the cache, which no longer belongs to a live surface.
    if (closed) return;
    if (error === null) {
      remember(entry.cacheKey, outcome);
      settle(entry, outcome);
    } else {
      abandon(entry, error);
    }
    drain();
  };

  // Declared rather than assigned because `drain`, `dispatch` and `complete` are a genuine cycle:
  // a finished render drains the waiting request, which dispatches it, which completes in turn.
  function dispatch(entry) {
    inFlight.set(entry.cacheKey, entry);
    invokeDesktop(NATIVE_PREVIEW_FRAME_COMMAND, { request: entry.payload }).then(
      (response) => {
        let outcome;
        try {
          outcome = toOutcome(entry.payload, entry.cacheKey, response);
        } catch (error) {
          complete(entry, null, error);
          return;
        }
        complete(entry, outcome, null);
      },
      (error) => complete(entry, null, fromNativeError(error))
    );
  }

  /**
   * Ask for one frame. Resolves with a `ready` outcome carrying an element-loadable URL, with
   * `superseded` when a newer request for this surface replaced it, or with `cancelled` when the
   * surface was closed while it was outstanding. It rejects only on a real refusal.
   */
  const requestFrame = async (request) => {
    if (closed) {
      failed('nativePreviewSurfaceClosed', 'This preview surface has been closed');
    }
    const prepared = prepareNativePreviewRequest(request);

    const cached = reuse(prepared.cacheKey);
    if (cached !== undefined) return cached;
    const running = inFlight.get(prepared.cacheKey);
    if (running !== undefined) return running.promise;
    if (waiting !== null && waiting.cacheKey === prepared.cacheKey) return waiting.promise;

    const entry = createEntry(prepared);
    if (inFlight.size < maxInFlight) {
      dispatch(entry);
    } else {
      if (waiting !== null) settle(waiting, settledOutcome('superseded', waiting.payload.frameIndex));
      waiting = entry;
    }
    return entry.promise;
  };

  /**
   * Tear the surface down. Everything outstanding settles as `cancelled`, the cache is released,
   * and any later native response is dropped. Idempotent.
   */
  const close = () => {
    if (closed) return;
    closed = true;
    const outstanding = [...inFlight.values()];
    if (waiting !== null) outstanding.push(waiting);
    inFlight.clear();
    waiting = null;
    cache.clear();
    for (const entry of outstanding) {
      settle(entry, settledOutcome('cancelled', entry.payload.frameIndex));
    }
  };

  return Object.freeze({
    requestFrame,
    close,
    /** Drop one cached URL, for a caller whose element load failed. Returns whether it was held. */
    forget: (cacheKey) => (typeof cacheKey === 'string' && cache.delete(cacheKey)),
    /** Inspect without affecting recency. */
    peek: (cacheKey) => cache.get(cacheKey),
    stats: () => Object.freeze({
      cachedFrames: cache.size,
      inFlight: inFlight.size,
      waiting: waiting !== null,
      closed,
    }),
  });
};
