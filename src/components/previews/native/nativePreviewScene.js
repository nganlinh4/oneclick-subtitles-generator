/**
 * The render request, the face and the bake request one native preview frame is composed from.
 *
 * Three things travel together for a single frame and they have to agree, so they are built in one
 * place rather than assembled by each surface:
 *
 *   - the RENDER REQUEST, built by `buildNativeRenderRequest` — the export's own builder, not a
 *     preview-shaped copy of it — and narrowed to the one cue the staged atlas holds a run for;
 *   - the FACE, resolved to exactly one family and one byte source or honestly refused;
 *   - the BAKE REQUEST for `bakeGlyphAtlas`, whose `maxWidthPx` is the ledger conversion in
 *     `nativePreviewGeometry.js`.
 *
 * ONE CUE PER REQUEST, and this is a property of the transport rather than a simplification. A
 * staged atlas carries exactly one `layout` — one laid-out run — while `crates/osg-export` pairs one
 * atlas with one `CueRun` per cue. The preview command takes a single atlas handle, so the request
 * it accompanies may name only the run that atlas actually holds. Sending the whole cue list with a
 * single-run atlas would ask the compositor to draw cues it has no layout for.
 *
 * That costs nothing in fidelity: the shipped selection rule takes the FIRST cue whose fade-widened
 * window contains the instant and considers no other, so exactly one cue is ever on screen. The cue
 * is selected here with the same rule `crates/osg-scene/src/cues.rs` uses, fade window included, so
 * the cue the preview bakes is the cue the export would draw.
 *
 * NO CUE AT ALL IS A FRAME, NOT A FAILURE. The instants between cues are ordinary frames: the video
 * underlay, the crop and the canvas backfill are all still composed, and the request simply names no
 * cue. `PreviewFrameRequest::check` accepts that, and so does everything after it.
 *
 * Determinism: no clocks, no RNG. Times become whole microseconds rather than floats, so the same
 * timestamp always produces the same request bytes and therefore the same `sceneRevision`.
 */

import { bakeGlyphAtlas } from '../../../platform/glyphAtlas';
import { NATIVE_PREVIEW_LIMITS } from '../../../platform/nativePreviewFrames';
import { buildNativeRenderRequest } from '../../../platform/renderService';
import {
  FONT_WEIGHT_MAXIMUM,
  FONT_WEIGHT_MINIMUM,
  normalizeFontWeight,
  resolveFontIdentity,
} from '../../../services/fontIdentity';
import {
  atlasMaxWidthPx,
  glyphScaleForComposition,
} from './nativePreviewGeometry';

/** The grid `secondsToMicros` in `renderService.js` quantises every cue bound onto. */
const MICROS_PER_SECOND = 1_000_000;

/** The font size the atlas is baked at, clamped into the baker's own bounds. */
const MIN_ATLAS_FONT_SIZE_PX = 4;
const MAX_ATLAS_FONT_SIZE_PX = 512;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);

const utf8 = new TextEncoder();
const withinFaceBudget = (value) => (
  typeof value === 'string'
  && value.length > 0
  && utf8.encode(value).length <= NATIVE_PREVIEW_LIMITS.maxFaceBytes
  && !/\p{Cc}/u.test(value)
);

/**
 * Which cue is on screen at `timeSeconds`.
 *
 * Mirrors `select_cue` in `crates/osg-scene/src/cues.rs`, including both of its surprises: the fade
 * window widens a cue's visibility so it appears before its own start and lingers past its end, and
 * the FIRST match wins so overlapping cues disappear rather than stack. Both are shipped behaviour
 * and are reproduced deliberately.
 */
export const selectPreviewCue = (cues, timeSeconds, { fadeInDuration = 0, fadeOutDuration = 0 } = {}) => {
  if (!Array.isArray(cues) || !isFiniteNumber(timeSeconds)) return null;
  const fadeIn = isFiniteNumber(fadeInDuration) && fadeInDuration > 0 ? fadeInDuration : 0;
  const fadeOut = isFiniteNumber(fadeOutDuration) && fadeOutDuration > 0 ? fadeOutDuration : 0;
  return cues.find((cue) => (
    isFiniteNumber(cue?.start)
    && isFiniteNumber(cue?.end)
    && timeSeconds >= cue.start - fadeIn
    && timeSeconds <= cue.end + fadeOut
  )) ?? null;
};

/**
 * The cue list a preview may draw from: finite, non-empty, ordered, and free of cues that collapse
 * to zero length once quantised to the render contract's microsecond grid.
 *
 * Sorting is deliberate rather than incidental. The transport refuses an out-of-order list because
 * first-match selection would silently hide cues in one, and the editor's arrays are not guaranteed
 * ordered after an edit.
 */
export const previewCueList = (subtitles) => {
  if (!Array.isArray(subtitles)) return [];
  return subtitles
    .filter((cue) => (
      isFiniteNumber(cue?.start)
      && isFiniteNumber(cue?.end)
      && typeof cue.text === 'string'
      && cue.text.length > 0
      && Math.round(cue.end * MICROS_PER_SECOND) > Math.round(Math.max(cue.start, 0) * MICROS_PER_SECOND)
      && utf8.encode(cue.text).length <= NATIVE_PREVIEW_LIMITS.maxCueTextBytes
    ))
    .map((cue) => ({ start: Math.max(cue.start, 0), end: cue.end, text: cue.text }))
    .sort((left, right) => left.start - right.start);
};

/**
 * The one face a preview may draw with, or `null`.
 *
 * `null` is not a failure to report at the user: it is the honest state the migration exists to
 * produce, where the shipped renderer asked for a family by CSS name, got a substitute and said
 * nothing. A surface that cannot resolve a face declines to request a native frame rather than
 * previewing a face the export would not use.
 */
export const previewFace = ({ fontFamily, fontWeight, platform, managedPackInstalled = false, isSystemFaceInstalled = null }) => {
  const resolution = resolveFontIdentity({
    fontFamily,
    fontWeight,
    fontStyle: 'normal',
    platform,
    managedPackInstalled,
    isSystemFaceInstalled,
  });
  if (resolution.status !== 'exact') return null;
  const { identity } = resolution;
  const weight = normalizeFontWeight(identity.weight);
  if (weight === null || weight < FONT_WEIGHT_MINIMUM || weight > FONT_WEIGHT_MAXIMUM) return null;
  if (!withinFaceBudget(identity.family) || !withinFaceBudget(identity.key)) return null;
  return Object.freeze({ family: identity.family, source: identity.key, weight });
};

/**
 * The bake request for one cue's text, in the atlas's own pixel space.
 *
 * The atlas is baked at the UNSCALED style size — the size the value was authored against — so one
 * bake serves every resolution and the compositor scales it. `glyphScale` therefore relates the
 * atlas to the composition, and `maxWidthPx` is the persisted percentage converted through it.
 *
 * Returns `null` when the wrap width cannot be derived, because baking without one wraps nowhere and
 * a subtitle that does not wrap is a visibly different subtitle rather than a near miss.
 */
export const atlasBakeRequest = ({ customization, text, compositionWidthPx, compositionHeightPx, face }) => {
  const {
    fontSize, lineHeight, letterSpacing, textAlign, textTransform, wordWrap, maxWidth, rtlSupport,
  } = customization;
  if (!isFiniteNumber(fontSize) || fontSize <= 0) return null;
  const atlasFontSizePx = clamp(fontSize, MIN_ATLAS_FONT_SIZE_PX, MAX_ATLAS_FONT_SIZE_PX);
  const glyphScale = glyphScaleForComposition({ fontSize, compositionHeightPx, atlasFontSizePx });
  if (glyphScale === null) return null;
  const maxWidthPx = atlasMaxWidthPx({
    maxWidthPercent: maxWidth,
    compositionWidthPx,
    glyphScale,
  });
  if (maxWidthPx === null) return null;
  return Object.freeze({
    request: Object.freeze({
      text,
      face: { family: face.family, weight: face.weight, style: 'normal' },
      fontSizePx: atlasFontSizePx,
      lineHeightPx: isFiniteNumber(lineHeight) && lineHeight > 0 ? lineHeight * atlasFontSizePx : null,
      letterSpacingPx: isFiniteNumber(letterSpacing) ? letterSpacing : 0,
      maxWidthPx,
      wordWrap: wordWrap !== false,
      textAlign,
      textTransform,
      // The persisted setting forces the paragraph level. Left null, the baker resolves it from the
      // text itself through UAX #9 P2/P3, which is right for mixed content and wrong for a caller
      // who has told us the subtitle is right-to-left.
      baseDirection: rtlSupport === true ? 'rtl' : null,
      requireExactFace: true,
    }),
    glyphScale,
    atlasFontSizePx,
  });
};

/** Bake one cue's atlas. Separated from the request so the conversion is testable without a canvas. */
export const bakePreviewAtlas = (bake, options = undefined) => bakeGlyphAtlas(bake.request, options ?? {});

/**
 * The audio and trim a preview composes at, which no preview surface chooses.
 *
 * Neither reaches a pixel — a preview frame carries no audio, and both editor surfaces preview the
 * whole source rather than a trimmed range — so these are the literals
 * `renderAndExportDesktopPreview` writes its files with rather than a second set to keep in step.
 */
const PREVIEW_AUDIO_AND_TRIM = Object.freeze({
  originalAudioVolume: 100,
  narrationVolume: 0,
  trimStart: 0,
  trimEnd: 0,
});

/** The whole frame, for a surface that offers no crop. Matches the download handler's own crop. */
export const PREVIEW_FULL_FRAME_CROP = Object.freeze({
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  aspectRatio: null,
  canvasBgMode: 'solid',
  canvasBgColor: '#000000',
  canvasBgBlur: 24,
  flipX: false,
  flipY: false,
});

/**
 * One cue that exists only so the export's own builder will produce a request, and never leaves this
 * function.
 *
 * `buildNativeRenderRequest` refuses an empty lyric list, because an EXPORT with nothing to draw is
 * a request nobody meant. A preview frame is not an export: an instant between cues is an ordinary
 * frame, and the underlay, the crop and the canvas backfill are still composed. So a cue-less
 * instant is built through the same builder — with the same style, crop, resolution and frame rate,
 * validated by the same code — and the probe is dropped before the request is returned. Nothing
 * synthetic reaches the payload, which `nativePreviewScene.test.js` asserts by content.
 */
const PROBE_CUE = Object.freeze({ id: 'probe', start: 0, end: 1, text: 'x' });

/**
 * The render request one preview frame is drawn from: the export's own request, narrowed to the cue
 * the staged atlas holds a run for.
 *
 * `cue` is the single selected cue, or `null` for an instant with nothing on screen — which is a
 * legitimate frame to render, not an error.
 *
 * Returns `null` when the editor's own state cannot produce a request the render contract accepts,
 * which is dormancy rather than failure: the export would refuse the same state, and a preview that
 * guessed past it would be previewing something the user cannot get.
 */
export const previewRenderRequest = ({
  sourceAsset,
  projectId,
  cue,
  customization,
  resolution,
  frameRate,
  crop = PREVIEW_FULL_FRAME_CROP,
}) => {
  if (sourceAsset === null || sourceAsset === undefined || typeof projectId !== 'string') return null;
  try {
    const built = buildNativeRenderRequest({
      sourceAsset,
      projectId,
      lyrics: [cue ?? PROBE_CUE],
      settings: { resolution, frameRate, ...PREVIEW_AUDIO_AND_TRIM },
      customization,
      crop,
    });
    return cue === null ? Object.freeze({ ...built, lyrics: [] }) : built;
  } catch {
    return null;
  }
};
