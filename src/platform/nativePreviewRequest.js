/**
 * What a native preview frame request must be, checked before anything native is called.
 *
 * Split from `nativePreviewFrames.js`, which owns the other half of the boundary: dispatching a
 * request, coalescing a scrub into it, caching what comes back and tearing it all down. The seam is
 * real rather than a line count — everything here is a pure function of the request, holds no state,
 * touches no bridge and can be run by a caller that has not decided to render anything yet.
 *
 * WHAT CROSSES IS THE EXPORT'S OWN REQUEST. A preview frame is drawn from the same
 * `RenderRequest` an export is built from, plus the four things one frame needs that a whole export
 * does not: which frame, which staged atlas, which face the editor resolved, and the revision the
 * caller believes it is looking at. `crates/osg-export/src/convert/` then makes every style, crop,
 * trim, resolution and frame-rate decision once, for both surfaces. A preview-shaped scene carrying
 * a second description of the style would be exactly the divergence this boundary exists to close,
 * which is why this module validates a render request and never builds one.
 *
 * The field set below is the one `PreviewFrameRequest` in
 * `apps/desktop/src-tauri/src/preview/request.rs` deserialises, and that struct is
 * `deny_unknown_fields`: one extra, missing or renamed field fails the request before any lifecycle
 * work runs. Tests on both sides derive the other side's field set from its source rather than
 * transcribing it, so neither end can move alone.
 *
 * Errors carry a code, a field path and measured sizes. Never a value, never a family the user
 * typed, never a line of subtitle text, never a native path or message. Nothing here logs.
 *
 * Determinism: no clocks and no RNG. The payload is written as explicit literals, so key order —
 * and therefore both the encoded bytes and `sceneRevision` — is fixed.
 */

import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { isStagedGlyphAtlas } from './glyphAtlasStaging';

/** Mirrors `PREVIEW_SCHEMA_VERSION` in `apps/desktop/src-tauri/src/preview.rs`. */
export const NATIVE_PREVIEW_SCHEMA_VERSION = 1;

/**
 * The exact field set the native command deserialises, in the order the payload writes them.
 *
 * Named here rather than left implicit in the literal below because both ends have to agree on it:
 * `preview::request::tests` reads this array out of this file and deserialises a request built from
 * it, so a field added, removed or renamed on either side fails a test instead of failing every
 * preview frame at runtime. `nativePreviewFrames.test.js` reads `request.rs` for the same reason,
 * from the other direction.
 */
export const NATIVE_PREVIEW_REQUEST_FIELDS = Object.freeze([
  'schemaVersion',
  'sceneRevision',
  'atlasId',
  'atlasContentHash',
  'frameIndex',
  'face',
  'render',
  'layer',
]);

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
   * The encoded payload one request may carry. The whole render request travels on every request,
   * which keeps the command contract to a single call; this bound is what stops that from becoming
   * an unbounded IPC copy during a scrub.
   */
  maxRequestBytes: 4 * 1024 * 1024,
  // The remaining bounds mirror the native side so a request that cannot be read is refused here
  // rather than after a round trip. They are deliberately identical values, not approximations.
  /** Mirrors `MAX_IDENTITY_BYTES` in `apps/desktop/src-tauri/src/preview.rs`. */
  maxIdentityBytes: 128,
  /** Mirrors `MAX_FACE_BYTES` in `crates/osg-scene/src/scene.rs`. */
  maxFaceBytes: 256,
  /** Mirrors `MAX_LYRIC_TEXT_BYTES` in `crates/osg-render/src/contract.rs`. */
  maxCueTextBytes: 16 * 1024,
  /**
   * Cues one request may name.
   *
   * One staged atlas carries one laid-out run, and the compositor needs one staged run per cue, so
   * a request may name at most the one cue the atlas actually holds. ZERO is not a failure: an
   * instant between cues is an ordinary frame, on which the video underlay, the crop and the canvas
   * backfill are all still composed. `PreviewFrameRequest::check` applies the same bound.
   */
  maxLyricsPerRequest: 1,
  /** Mirrors `MAX_RENDER_FRAMES` in `crates/osg-render/src/contract.rs`, as an index. */
  maxFrameIndex: 1_000_000 - 1,
  /** The output edges `crates/osg-export/src/convert/dimensions.rs` accepts. */
  minDimensionPx: 2,
  maxDimensionPx: 15_360,
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

/**
 * A bounded, control-free token the native side only ever compares.
 *
 * Mirrors `is_opaque_identity` in `apps/desktop/src-tauri/src/preview/request.rs` exactly, so a
 * revision or content hash that side would refuse never costs a round trip.
 */
const isOpaqueIdentity = (value) => (
  typeof value === 'string'
  && value.length > 0
  && utf8Length(value) <= NATIVE_PREVIEW_LIMITS.maxIdentityBytes
  && /^[A-Za-z0-9\-_:]+$/.test(value)
);

/** Non-cryptographic identity for cache and revision comparison only. Never a security boundary. */
const fnv1a32 = (bytes) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

const REQUEST_KEYS = Object.freeze(['atlas', 'composition', 'face', 'frameIndex', 'render']);
/** The same request, having named a layer. Optional, so no existing caller has to say `composited`. */
const REQUEST_KEYS_WITH_LAYER = Object.freeze([...REQUEST_KEYS, 'layer'].sort());
/** Mirrors `RenderRequest` in `crates/osg-render/src/contract.rs`, which is `deny_unknown_fields`. */
const RENDER_KEYS = Object.freeze([
  'crop', 'customization', 'lyrics', 'narrationArtifactId', 'projectId', 'settings', 'sourceAssetId',
]);
/** Mirrors `RenderLyric` in the same file. */
const LYRIC_KEYS = Object.freeze(['endUs', 'id', 'startUs', 'text']);
const FACE_KEYS = Object.freeze(['family', 'source', 'weight']);
const COMPOSITION_KEYS = Object.freeze(['heightPx', 'widthPx']);

// `detail` is a field path in every one of these. Never a value, never a cue's text, never a family
// the user typed.

const invalidRequest = (detail) => failed(
  'nativePreviewInvalidRequest',
  `The preview frame request cannot be drawn: ${detail}`
);

const invalidRender = (detail) => failed(
  'nativePreviewInvalidRender',
  `The preview render request cannot be drawn: ${detail}`
);

/**
 * The face the editor resolved and baked from, checked against the bounds `crates/osg-scene`
 * enforces so an unusable face is refused before a round trip rather than after one.
 */
const validateFace = (face) => {
  const invalid = (detail) => failed(
    'nativePreviewInvalidFace',
    `The preview face cannot be drawn: ${detail}`
  );
  if (!hasExactKeys(face, FACE_KEYS)) invalid('face is not a resolved face');
  for (const field of ['family', 'source']) {
    const value = face[field];
    if (typeof value !== 'string'
        || value.length === 0
        || utf8Length(value) > NATIVE_PREVIEW_LIMITS.maxFaceBytes
        || hasControlCharacter(value)) {
      invalid(`face.${field} is missing or out of bounds`);
    }
  }
  // A face that never resolved is the failure the migration exists to stop hiding, so a request may
  // not carry a weight the renderer would have to guess at.
  if (!isBounded(face.weight, 100, 900) || face.weight % 100 !== 0) {
    invalid('face.weight is not a resolved weight');
  }
  return Object.freeze({ family: face.family, source: face.source, weight: face.weight });
};

/**
 * The render request, checked for what belongs to THIS boundary and nothing else.
 *
 * Deliberately shallow, for the same reason `PreviewFrameRequest::check` is: `buildNativeRenderRequest`
 * owns the render contract's own bounds and `RenderRequest::validate` re-applies them against the
 * real source, so re-stating any of them here would create a third vocabulary to keep in step. What
 * is checked is the shape — a request this module did not receive from that builder cannot reach the
 * command — and the one bound the preview transport itself imposes: how many cues a single staged
 * atlas can draw.
 */
const validateRender = (render) => {
  if (!hasExactKeys(render, RENDER_KEYS)) invalidRender('render is not a native render request');
  const { lyrics } = render;
  if (!Array.isArray(lyrics) || lyrics.length > NATIVE_PREVIEW_LIMITS.maxLyricsPerRequest) {
    invalidRender('render.lyrics names more cues than the staged atlas holds runs for');
  }
  lyrics.forEach((lyric, index) => {
    if (!hasExactKeys(lyric, LYRIC_KEYS)) invalidRender(`render.lyrics[${index}] is not a cue`);
    if (typeof lyric.text !== 'string'
        || lyric.text.length === 0
        || utf8Length(lyric.text) > NATIVE_PREVIEW_LIMITS.maxCueTextBytes) {
      invalidRender(`render.lyrics[${index}].text is empty or too long`);
    }
    if (!Number.isSafeInteger(lyric.startUs) || lyric.startUs < 0
        || !Number.isSafeInteger(lyric.endUs) || lyric.endUs <= lyric.startUs) {
      invalidRender(`render.lyrics[${index}] does not end after it starts`);
    }
  });
  return render;
};

/**
 * The size the caller expects the composed frame to be.
 *
 * Not part of the payload: the native side derives the composition from the source it probes, the
 * resolution and the crop, and there is exactly one place that decision is made. It is carried
 * beside the payload so the transport can refuse a frame that came back at another size, because a
 * preview at the wrong size is precisely the silent divergence this boundary exists to remove.
 */
const validateComposition = (composition) => {
  if (!hasExactKeys(composition, COMPOSITION_KEYS)) invalidRequest('composition is not a frame size');
  for (const field of COMPOSITION_KEYS) {
    // Odd edges are refused here for the same reason the conversion refuses them: the encoder this
    // feeds requires even ones, and finding out at encode time wastes a whole render.
    if (!isBounded(composition[field], NATIVE_PREVIEW_LIMITS.minDimensionPx, NATIVE_PREVIEW_LIMITS.maxDimensionPx)
        || composition[field] % 2 !== 0) {
      invalidRequest(`composition.${field} is not a supported composition dimension`);
    }
  }
  return Object.freeze({ widthPx: composition.widthPx, heightPx: composition.heightPx });
};

/**
 * Validate a request and reduce it to what crosses the boundary, without calling anything native.
 *
 * Exported so a caller can learn what a request costs — and whether it is renderable at all — before
 * committing to a render. `requestBytes` is the canonical JSON encoding, which is what IPC carries.
 */
export const prepareNativePreviewRequest = (request) => {
  if (!hasExactKeys(request, REQUEST_KEYS) && !hasExactKeys(request, REQUEST_KEYS_WITH_LAYER)) {
    invalidRequest('a request needs a render request, a face, a composition size, an atlas and a frame index');
  }
  // Absent means the composited frame. A layer this build does not draw is refused rather than
  // quietly defaulted: a caller that asked for the cheap path and silently got the expensive one
  // would be slow for a reason nothing reports, and the reverse would show an approximation where a
  // guarantee was expected.
  const layer = request.layer === undefined ? NATIVE_PREVIEW_DEFAULT_LAYER : request.layer;
  if (!NATIVE_PREVIEW_LAYERS.includes(layer)) {
    invalidRequest('layer names a layer this build does not draw');
  }
  // A handle this module did not mint cannot name a native atlas, and a request rendered without one
  // would silently draw nothing.
  if (!isStagedGlyphAtlas(request.atlas) || !isOpaqueIdentity(request.atlas.contentHash)) {
    failed('nativePreviewInvalidAtlas', 'The glyph atlas has not been staged for the native renderer');
  }
  const face = validateFace(request.face);
  const render = validateRender(request.render);
  const composition = validateComposition(request.composition);
  // The exact bound is the converted timeline's, which is derived natively from the source that is
  // probed, so the frame count is not known on this side and is deliberately not guessed at. What is
  // refused here is an index no timeline could have; the native command refuses the rest.
  if (!isBounded(request.frameIndex, 0, NATIVE_PREVIEW_LIMITS.maxFrameIndex)) {
    invalidRequest('frameIndex is not one a converted timeline could have');
  }

  // The revision names the picture, not the instant: everything the compositor draws from except
  // which frame of it. Two requests that differ only in `frameIndex` are therefore two frames of one
  // revision, which is what lets a native frame that finishes after an edit be recognised as stale.
  const revisionBytes = utf8.encode(JSON.stringify([face, render, composition]));
  // The byte length joins the hash so two different requests have to collide on both to share a
  // cache entry, which is the only way a stale frame could reach the screen.
  const sceneRevision = `${fnv1a32(revisionBytes).toString(16).padStart(8, '0')}-${revisionBytes.length}`;
  const payload = Object.freeze({
    schemaVersion: NATIVE_PREVIEW_SCHEMA_VERSION,
    sceneRevision,
    atlasId: request.atlas.atlasId,
    atlasContentHash: request.atlas.contentHash,
    frameIndex: request.frameIndex,
    face,
    render,
    layer,
  });

  const measurement = Object.freeze({
    requestBytes: utf8Length(JSON.stringify(payload)),
    budgetBytes: NATIVE_PREVIEW_LIMITS.maxRequestBytes,
  });
  if (measurement.requestBytes > NATIVE_PREVIEW_LIMITS.maxRequestBytes) {
    failed(
      'nativePreviewRequestTooLarge',
      'The preview request exceeds the transport budget and was refused before any native call',
      measurement
    );
  }

  return Object.freeze({
    sceneRevision,
    measurement,
    composition,
    // The layer joins the key because two layers of one instant are two different pictures. Sharing
    // an entry between them is the one way a transparent overlay could end up on a paused surface.
    cacheKey: `${sceneRevision}:${request.atlas.atlasId}:${request.frameIndex}:${layer}`,
    payload,
  });
};
