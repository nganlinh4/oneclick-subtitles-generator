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
 * What a request must *be* — the field set the native command deserialises, the layer vocabulary,
 * the canonical encoding and the cache key — is `./nativePreviewRequest`, and is re-exported from
 * here so callers see one module. What is left here is the half that has state: dispatching,
 * coalescing, caching and teardown.
 *
 * What this module guarantees:
 *
 *   - **Bounded.** A request is validated against the same bounds the native command applies and
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
 *     font, a request the compositor will not draw — arrives as a typed error. It is never a blank
 *     frame that a user would read as an empty subtitle, and it is never silently retried.
 *   - **Leak-free.** Errors carry a code, a field path and measured sizes. Never a native path,
 *     never a credential, never the user's subtitle text, never a native message or stack. Nothing
 *     in this module logs.
 *
 * Determinism: no clocks and no RNG. `sceneRevision` is a pure function of the canonical request, so
 * the same request always produces the same cache key, and seeking to a frame twice hits the cache
 * instead of re-rendering.
 *
 * One honest limitation: a cached URL addresses a native frame registry that has its own bound and
 * its own expiry (`crates/osg-media-server/src/frames.rs`). A URL this module still holds can stop
 * resolving once Rust evicts or expires the sequence behind it. That surfaces as an element load
 * error, which the caller must treat as a miss: call `forget(outcome.cacheKey)` and request again.
 * This module deliberately does not poll, retry or hold a clock to hide that.
 */

import { DESKTOP_RUNTIME_UNAVAILABLE, invokeDesktop } from './desktopRuntime';
import {
  NATIVE_PREVIEW_DEFAULT_LAYER,
  NATIVE_PREVIEW_LAYERS,
  NATIVE_PREVIEW_LIMITS,
  NATIVE_PREVIEW_REQUEST_FIELDS,
  NATIVE_PREVIEW_SCHEMA_VERSION,
  NativePreviewFrameError,
  failed,
  hasExactKeys,
  isBounded,
  isUuidV4,
  prepareNativePreviewRequest,
} from './nativePreviewRequest';

// What a request must be lives in `./nativePreviewRequest`. It is re-exported here because this is
// the module the editor imports, and splitting a file is not a reason to make every caller learn
// where each half went.
export {
  NATIVE_PREVIEW_DEFAULT_LAYER,
  NATIVE_PREVIEW_LAYERS,
  NATIVE_PREVIEW_LIMITS,
  NATIVE_PREVIEW_REQUEST_FIELDS,
  NATIVE_PREVIEW_SCHEMA_VERSION,
  NativePreviewFrameError,
  prepareNativePreviewRequest,
};

/** The native command this transport speaks to. */
export const NATIVE_PREVIEW_FRAME_COMMAND = 'preview_frame_render';

export const NATIVE_PREVIEW_ERROR_CODES = Object.freeze([
  'nativePreviewInvalidRequest',
  'nativePreviewInvalidRender',
  'nativePreviewInvalidFace',
  'nativePreviewInvalidAtlas',
  'nativePreviewRequestTooLarge',
  'nativePreviewSurfaceClosed',
  'nativePreviewUnavailable',
  'nativePreviewRejected',
]);

/** How a frame request settled. Only `ready` carries a URL. */
export const NATIVE_PREVIEW_OUTCOMES = Object.freeze(['ready', 'superseded', 'cancelled']);

// The native round trip

const FRAME_URL_PATTERN = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/frame\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(0|[1-9][0-9]{0,8})\?token=[0-9a-f]{64}&frame_token=[0-9a-f]{64}$/;
/** Mirrors the signature-checked image types `osg-media-server` will publish a frame as. */
const FRAME_MIME_TYPES = new Set(['image/png', 'image/webp']);
/**
 * The exact field set `PreviewFrameResponse` in
 * `apps/desktop/src-tauri/src/preview/request.rs` serialises, sorted.
 *
 * Exported for the same reason the request's field set is: `preview::request::tests` reads this
 * array out of this file and compares it with what that struct actually serialises, so a field added
 * or renamed on either side fails a test rather than making every response unreadable at runtime.
 */
export const NATIVE_PREVIEW_RESPONSE_FIELDS = Object.freeze([
  'frameIndex', 'frameUrl', 'heightPx', 'layer', 'mimeType', 'sequenceId', 'widthPx',
]);
/** Mirrors the code shape `desktopRuntime` already guarantees for a sanitized bridge error. */
const NATIVE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,127}$/;

/**
 * Why a response was refused, as a bounded token.
 *
 * These name THIS side's checks, not the renderer's. They exist because all of them used to report
 * `nativePreviewRejected` with no further detail, so a customer — and a journey — could not tell a
 * malformed response from a frame of the wrong size, and the editor showed a code that named the
 * transport rather than the disagreement. Every value is a fixed identifier: no path, no size, no
 * URL and no subtitle text is ever carried.
 */
export const NATIVE_PREVIEW_RESPONSE_REFUSALS = Object.freeze([
  'previewResponseShape',
  'previewResponseUrl',
  'previewResponsePort',
  'previewResponseSequence',
  'previewResponseFrameIndex',
  'previewResponseMimeType',
  'previewResponseLayer',
  'previewResponseSize',
]);

const rejected = (error, reason = null) => {
  const failure = new NativePreviewFrameError(
    'nativePreviewRejected',
    'The desktop renderer did not produce the requested preview frame'
  );
  // Only an already-sanitized code crosses back. The native message, cause and stack are dropped:
  // they are the only fields that could ever carry a path, a process argument or the user's text.
  if (typeof error?.code === 'string' && NATIVE_CODE_PATTERN.test(error.code)) {
    failure.nativeCode = error.code;
  } else if (reason !== null) {
    // Enforced rather than trusted: a reason that is not in the declared vocabulary would reach the
    // interface as an unexplained token, which is the state this whole change exists to end.
    if (!NATIVE_PREVIEW_RESPONSE_REFUSALS.includes(reason)) {
      throw new NativePreviewFrameError(
        'nativePreviewRejected',
        'A preview response refusal used an undeclared reason'
      );
    }
    failure.nativeCode = reason;
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
 * the frame that was asked for. A response whose size disagrees with the composition the caller
 * expected is refused too: a preview at the wrong size is exactly the silent divergence this
 * transport exists to remove. So is one whose layer disagrees: an approximation shown where the
 * guaranteed frame was asked for is a wrong picture rather than a failure, and nothing downstream
 * could tell.
 */
const toOutcome = ({ payload, composition, cacheKey }, response) => {
  if (!hasExactKeys(response, NATIVE_PREVIEW_RESPONSE_FIELDS)) {
    throw rejected(null, 'previewResponseShape');
  }
  const match = typeof response.frameUrl === 'string' ? FRAME_URL_PATTERN.exec(response.frameUrl) : null;
  if (match === null) throw rejected(null, 'previewResponseUrl');
  const [, portText, sequenceId, indexText] = match;
  const port = Number(portText);
  // Each check names itself. They used to be one disjunction reporting one code, which meant a
  // frame that arrived for the wrong instant was indistinguishable from a malformed port — and the
  // only thing a customer could report was that the preview "was rejected".
  if (!isBounded(port, 1, 65_535) || String(port) !== portText) {
    throw rejected(null, 'previewResponsePort');
  }
  if (!isUuidV4(sequenceId) || response.sequenceId !== sequenceId) {
    throw rejected(null, 'previewResponseSequence');
  }
  if (response.frameIndex !== payload.frameIndex || String(payload.frameIndex) !== indexText) {
    throw rejected(null, 'previewResponseFrameIndex');
  }
  if (!FRAME_MIME_TYPES.has(response.mimeType)) {
    throw rejected(null, 'previewResponseMimeType');
  }
  if (response.layer !== payload.layer) {
    throw rejected(null, 'previewResponseLayer');
  }
  // Size last and on its own, because it is the one that fires for a reason the user could act on:
  // the renderer composed a frame for a different composition than the caller is showing.
  if (response.widthPx !== composition.widthPx || response.heightPx !== composition.heightPx) {
    throw rejected(null, 'previewResponseSize');
  }
  return Object.freeze({
    status: 'ready',
    url: response.frameUrl,
    frameIndex: payload.frameIndex,
    layer: response.layer,
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
          outcome = toOutcome(entry, response);
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
   *
   * `request.layer` is optional and defaults to `composited`. A `ready` outcome always states the
   * layer it carries, so a caller that switches between them can tell which one is on screen.
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
