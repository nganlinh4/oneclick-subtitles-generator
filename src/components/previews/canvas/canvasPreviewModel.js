/**
 * Pure state of the canvas preview: backing-store sizing, failure classification and the
 * output-grid scene clock shared by every draw path.
 */
import { compositionSize, exactFrameRate } from '../native/nativePreviewGeometry';

const MAX_DEVICE_PIXEL_RATIO = 1.5;
const MAX_CANVAS_WIDTH = 1_600;
const MAX_CANVAS_HEIGHT = 1_000;
const RETRYABLE_PREVIEW_FAILURES = new Set([
  'canvasPreviewUnavailable',
  // A face accepted by the product-level identity resolver can still be between stylesheet
  // installation and FontFaceSet activation. The exact same request becomes valid when the
  // browser finishes loading the face, so caching this as deterministic freezes restored projects.
  'glyphAtlasFaceLoading',
  'glyphAtlasSurfaceUnavailable',
]);

/** Adapt the native geometry contract once; canvas maths deliberately uses terse width/height. */
export const canvasCompositionSize = (input) => {
  const size = compositionSize(input);
  return size === null ? null : Object.freeze({ width: size.widthPx, height: size.heightPx });
};

/** Size the backing store with one scale so its aspect ratio always matches its CSS box. */
export const canvasBackingSize = ({ width, height }, devicePixelRatio = 1) => {
  if (!(width > 0) || !(height > 0)) return Object.freeze({ width: 1, height: 1 });
  const scale = Math.min(
    Math.max(1, Number(devicePixelRatio) || 1),
    MAX_DEVICE_PIXEL_RATIO,
    MAX_CANVAS_WIDTH / width,
    MAX_CANVAS_HEIGHT / height,
  );
  return Object.freeze({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  });
};

export const platformName = () => {
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('mac os') || agent.includes('macintosh')) return 'macos';
  if (agent.includes('linux') || agent.includes('x11')) return 'linux';
  return null;
};

export const stateKey = (state) => `${state.status}|${state.code ?? ''}|${state.retryable === true}`;

/** Distinguish a temporary canvas allocation failure from a request that will deterministically
 * fail for the same atlas key. Unknown failures stay non-retryable instead of becoming a loop. */
export const canvasPreviewFailure = (error) => {
  const candidate = typeof error?.code === 'string'
    ? error.code
    : error?.message === 'canvasPreviewUnavailable'
      ? error.message
      : 'canvasPreviewRejected';
  const code = /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(candidate)
    ? candidate
    : 'canvasPreviewRejected';
  return Object.freeze({ code, retryable: RETRYABLE_PREVIEW_FAILURES.has(code) });
};

/**
 * The source decoder and the exported composition do not necessarily share a frame grid. A 15 fps
 * source legitimately holds its 1.2 s frame while a 30 fps export evaluates the subtitle scene at
 * 1.266666… s. Keep the scene on the authored output grid instead of delaying cue/easing time to
 * the source frame's presentation timestamp.
 */
export const previewSceneTime = (transportTime, frameRate, trimStart = 0) => {
  const time = Number(transportTime);
  const origin = Number(trimStart);
  const rate = exactFrameRate(frameRate);
  if (!Number.isFinite(time) || !Number.isFinite(origin) || rate === null) return 0;
  const position = (time - origin) * rate.fpsNumerator / rate.fpsDenominator;
  const arithmeticEpsilon = Number.EPSILON * Math.max(1, Math.abs(position)) * 8;
  const frame = Math.floor(position + arithmeticEpsilon);
  return origin + frame * rate.fpsDenominator / rate.fpsNumerator;
};

/** The clock a transport-only draw carries: the transport target, never a decoded PTS. */
export const transportOnlyClock = (video) => ({
  mediaTime: null,
  transportTime: video?.currentTime,
  provenance: 'transport-only',
});

/** The output-grid scene instant for the element's current transport time. */
export const transportSceneTime = (video, snapshot) => previewSceneTime(
  video?.currentTime,
  snapshot?.frameRate,
  snapshot?.trimStart,
);
