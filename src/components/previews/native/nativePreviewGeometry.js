/**
 * The geometry every native preview request is built from: composition size, glyph scale, the
 * wrap width the baker takes, and the frame a timestamp lands on.
 *
 * THIS IS THE UNIT-CONVERSION FILE, and the conversion it exists for is the one the parity ledger
 * held open. `maxWidth` is persisted as a PERCENTAGE of the composition. The baker takes
 * `maxWidthPx` in ATLAS pixel space, and the atlas is baked once at its own font size and then
 * scaled by the compositor (`crates/osg-compositor/src/geometry.rs`:
 * `glyph_scale = scale_subtitle_style_value(font_size, height) / atlas.face().font_size_px`). A
 * composition-space width passed straight through would wrap correctly at exactly one resolution
 * and wrongly at every other, silently, with no error anywhere. So the width is divided by that
 * same glyph scale here, which makes the atlas-space wrap width a property of the STYLE rather than
 * of the resolution the user happens to be previewing at.
 *
 * Everything else here is a mirror of a Rust derivation rather than a second opinion about it:
 *
 *   - `roundTwoDecimalsLikeJavaScript` / `scaleSubtitleStyleValue` mirror
 *     `crates/osg-scene/src/scale.rs`, including that sizes scale with composition height and that
 *     the result is rounded the way `Number.prototype.toFixed(2)` rounds rather than the way Rust
 *     rounds. `toFixed` IS the authority here, so this is the original rather than a reimplementation.
 *   - `compositionSize` mirrors `crates/osg-export/src/convert/dimensions.rs` exactly, INCLUDING
 *     its association. That module records that `getCompositionDimensions` in
 *     `src/components/RemotionVideoPreview.js` associates the same inputs differently
 *     — `sourceAspect * ((cropWidth / 100) / (cropHeight / 100))` — and that floating-point
 *     multiplication is not associative, so the two forms round to different widths for a small
 *     fraction of crop shapes. Replacing the Remotion preview with this module is what removes that
 *     disagreement; a third association would have re-created it.
 *   - `previewTimeline` mirrors `RenderRequest::validate` in `crates/osg-render/src/contract.rs`
 *     and `build` in `crates/osg-export/src/convert/timeline.rs`, which between them own the
 *     TRIMMED timeline every frame index is an index into.
 *
 * Determinism: no clocks, no RNG, no state. Every function is a pure function of its arguments.
 */

import { GLYPH_ATLAS_LIMITS } from '../../../platform/glyphAtlas';

/**
 * The resolution ladder, mirroring `RenderResolution::height` in `crates/osg-render/src/contract.rs`.
 * The composition height is taken from here unchanged; only the width is derived.
 */
export const RESOLUTION_HEIGHTS = Object.freeze({
  '360p': 360,
  '480p': 480,
  '720p': 720,
  '1080p': 1_080,
  '1440p': 1_440,
  '4K': 2_160,
  '8K': 4_320,
});

/** The height every subtitle style value is authored against. */
const REFERENCE_HEIGHT_PX = 1_080;

/** The edges `crates/osg-export/src/convert/dimensions.rs` accepts. */
const MIN_OUTPUT_EDGE = 2;
const MAX_OUTPUT_EDGE = 15_360;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isPositive = (value) => isFiniteNumber(value) && value > 0;

/** Rounds an edge up to the even number the encoder requires. Mirrors `even()`. */
const even = (value) => (value % 2 === 0 ? value : value + 1);

/**
 * Round to two decimals the way `Number.prototype.toFixed(2)` does.
 *
 * `crates/osg-scene/src/scale.rs` reimplements this rounding in Rust precisely so the two agree; on
 * this side the built-in is the definition, so calling it is the mirror rather than an approximation
 * of one. Non-finite input is returned unchanged, exactly as the Rust function returns it unchanged.
 */
export const roundTwoDecimalsLikeJavaScript = (value) => (
  isFiniteNumber(value) ? Number(value.toFixed(2)) : value
);

/**
 * Scale a style value authored against a 1080-high composition to `compositionHeightPx`.
 *
 * Mirrors `scale_subtitle_style_value`. Margins deliberately do NOT use this — they are a fixed
 * 1920x1080 percentage and are therefore resolution-independent — which is one of the shipped
 * renderer's two coexisting scaling maths and is reproduced rather than tidied away.
 */
export const scaleSubtitleStyleValue = (value, compositionHeightPx) => (
  roundTwoDecimalsLikeJavaScript((value * compositionHeightPx) / REFERENCE_HEIGHT_PX)
);

/**
 * The factor the compositor multiplies every atlas cell, pen and baseline by.
 *
 * Mirrors `Metrics::resolve` in `crates/osg-compositor/src/geometry.rs`. Returns `null` rather than
 * a guess when the inputs cannot produce one, because a wrong scale is a silently mis-wrapped
 * preview and a missing one is a request that is simply not made.
 */
export const glyphScaleForComposition = ({ fontSize, compositionHeightPx, atlasFontSizePx }) => {
  if (!isPositive(fontSize) || !isPositive(compositionHeightPx) || !isPositive(atlasFontSizePx)) {
    return null;
  }
  const scaledFontSizePx = scaleSubtitleStyleValue(fontSize, compositionHeightPx);
  if (!isPositive(scaledFontSizePx)) return null;
  return scaledFontSizePx / atlasFontSizePx;
};

/**
 * The wrap width the baker takes, in atlas pixels, for a persisted `maxWidth` percentage.
 *
 * `(maxWidth / 100) * compositionWidth / glyphScale`, which is the parity ledger's own expression.
 * The division by the glyph scale is the whole point: it converts a composition-space width into the
 * space the atlas was baked in, so the same style wraps at the same place at every resolution.
 *
 * Returns `null` for an input that cannot produce a usable width, or for a width outside the bound
 * `bakeGlyphAtlas` enforces. A caller that gets `null` must decline to build a request rather than
 * bake without a wrap width, because wrapping nowhere is a visibly different subtitle.
 */
export const atlasMaxWidthPx = ({ maxWidthPercent, compositionWidthPx, glyphScale }) => {
  if (!isPositive(maxWidthPercent) || maxWidthPercent > 100) return null;
  if (!isPositive(compositionWidthPx) || !isPositive(glyphScale)) return null;
  const widthPx = ((maxWidthPercent / 100) * compositionWidthPx) / glyphScale;
  if (!isPositive(widthPx) || widthPx > GLYPH_ATLAS_LIMITS.maxLayoutWidthPx) return null;
  return widthPx;
};

/**
 * The output frame size one preview composes at.
 *
 * Mirrors `composition_size` in `crates/osg-export/src/convert/dimensions.rs` term for term:
 * the height is the ladder's, the width is `round(height * sourceAspect * (crop.width /
 * crop.height))`, and both edges are rounded up to even because the encoder cannot take an odd one.
 * `crop.aspectRatio` is not read, for the reason that module documents at length: the aspect buttons
 * express themselves by reshaping the rectangle, so consulting the field would apply the ratio twice.
 *
 * Returns `null` when the crop implies a width the request contract would refuse.
 */
export const compositionSize = ({ resolution, sourceWidthPx, sourceHeightPx, crop }) => {
  const ladderHeight = RESOLUTION_HEIGHTS[resolution];
  if (!isPositive(ladderHeight) || !isPositive(sourceWidthPx) || !isPositive(sourceHeightPx)) {
    return null;
  }
  const cropWidth = isPositive(crop?.width) ? crop.width : 100;
  const cropHeight = isPositive(crop?.height) ? crop.height : 100;
  const heightPx = even(ladderHeight);
  const sourceAspect = sourceWidthPx / sourceHeightPx;
  const effectiveAspect = sourceAspect * (cropWidth / cropHeight);
  const rounded = Math.round(heightPx * effectiveAspect);
  if (!(rounded >= MIN_OUTPUT_EDGE && rounded <= MAX_OUTPUT_EDGE)) return null;
  return Object.freeze({ widthPx: even(rounded), heightPx });
};

/**
 * The exact rational frame rate for a persisted frame-rate number.
 *
 * 29.97 and 59.94 are the two the ladder offers that are not integers, and both are exactly
 * `n * 1000 / 1001` rather than the decimal the UI displays. Mirrors
 * `crates/osg-scene/src/timeline.rs`, where a float frame rate is what makes long exports drift.
 */
export const exactFrameRate = (frameRate) => {
  if (frameRate === 29.97) return Object.freeze({ fpsNumerator: 30_000, fpsDenominator: 1_001 });
  if (frameRate === 59.94) return Object.freeze({ fpsNumerator: 60_000, fpsDenominator: 1_001 });
  if (!Number.isInteger(frameRate) || frameRate < 1 || frameRate > 120) return null;
  return Object.freeze({ fpsNumerator: frameRate, fpsDenominator: 1 });
};

/** The grid `secondsToMicros` in `renderService.js` quantises every instant in a request onto. */
const MICROS_PER_SECOND = 1_000_000;

/** A second count as the whole microseconds a render request carries it as, or `null`. */
const microseconds = (seconds) => (
  isFiniteNumber(seconds) && seconds >= 0 ? Math.round(seconds * MICROS_PER_SECOND) : null
);

/**
 * The composition timeline a preview frame is an index into: the TRIMMED one, which is the only one
 * the export has.
 *
 * MIRRORS `RenderRequest::validate` in `crates/osg-render/src/contract.rs` — `trim_end_us` defaults
 * to the source duration, the window is refused unless `trim_start_us < trim_end_us <=
 * source_duration_us`, and `duration_frames` is `ceil((trim_end_us - trim_start_us) * fps / 1e6)` —
 * and `build` in `crates/osg-export/src/convert/timeline.rs`, which offsets that same grid to the
 * trim point so the scene starts at zero where the source starts at `trimStart`. Those two are the
 * authority. Nothing here is a second rule, and in particular the frame count is NOT derived from
 * the `<video>` element's duration: a trimmed project has fewer frames than its source has, and an
 * index into the wrong one names a different instant than the export writes.
 *
 * The window is quantised to microseconds first, because that is the grid the request itself carries
 * — a trim the preview rounded differently from the request would put the composition's zero in a
 * different place than the conversion does.
 *
 * `trimEndSeconds` of zero means "to the end of the source", exactly as `normalizeSettings` in
 * `renderService.js` reads it. Returns `null` for a window whose BOUNDS the render contract would
 * refuse, which is dormancy: the export refuses the same window, so there is no frame to preview.
 * The contract's `MAX_RENDER_FRAMES` ceiling is deliberately NOT mirrored — nothing on this side
 * mirrors it, for the export either — so a project past it reaches the compositor and comes back as
 * a stated refusal rather than as a preview that quietly shows nothing.
 */
export const previewTimeline = ({
  frameRate,
  durationSeconds,
  trimStartSeconds = 0,
  trimEndSeconds = 0,
}) => {
  const rate = exactFrameRate(frameRate);
  const durationUs = microseconds(durationSeconds);
  const startUs = microseconds(trimStartSeconds);
  const requestedEndUs = microseconds(trimEndSeconds);
  if (rate === null || durationUs === null || durationUs < 1) return null;
  if (startUs === null || requestedEndUs === null) return null;
  const endUs = requestedEndUs === 0 ? durationUs : requestedEndUs;
  if (startUs >= endUs || endUs > durationUs) return null;
  const frameCount = Math.ceil(
    ((endUs - startUs) * rate.fpsNumerator) / (rate.fpsDenominator * MICROS_PER_SECOND),
  );
  if (!Number.isInteger(frameCount) || frameCount < 1) return null;
  return Object.freeze({
    ...rate,
    frameCount,
    trimStartSeconds: startUs / MICROS_PER_SECOND,
    trimEndSeconds: endUs / MICROS_PER_SECOND,
  });
};

/**
 * The frame of the trimmed composition a SOURCE timestamp lands on, or `null` when the playhead is
 * outside the trim window.
 *
 * The playhead is a source instant and the composition starts at `trimStart`, so the index is
 * `floor((t - trimStart) * fps)` — the offset the source grid carries in
 * `crates/osg-export/src/convert/timeline.rs`, read the other way round. Floor rather than round,
 * because a frame covers the interval that starts at its own presentation time: the frame shown at
 * 1/30s - epsilon is frame 0, not frame 1. Seek must equal play, so this is the only place a preview
 * turns a time into an index.
 *
 * NULL RATHER THAN A CLAMP OUTSIDE THE WINDOW. A playhead before the trim point or past the trim end
 * is an instant the export does not contain, and clamping it to frame 0 or to the last frame would
 * put a real exported frame on screen at an instant it is not the frame for — the same silent
 * substitution this migration exists to remove. The caller goes dormant and shows the `<video>`
 * instead, which is honestly "the source, here, where the output has nothing".
 *
 * Inside the window the last frame still covers the closing instant: `frameCount` is a CEILING, so
 * `trimEnd` itself lands one past the last index whenever the window is an exact number of frames
 * long. That single clamp is the ceiling read back, not a guess about a frame that does not exist.
 */
export const frameIndexForTime = (timeSeconds, timeline) => {
  if (!isFiniteNumber(timeSeconds) || timeline === null || timeline === undefined) return null;
  const {
    fpsNumerator, fpsDenominator, frameCount, trimStartSeconds, trimEndSeconds,
  } = timeline;
  if (!isPositive(fpsNumerator) || !isPositive(fpsDenominator) || !Number.isInteger(frameCount)) {
    return null;
  }
  if (frameCount < 1) return null;
  if (!isFiniteNumber(trimStartSeconds) || !isFiniteNumber(trimEndSeconds)) return null;
  if (timeSeconds < trimStartSeconds || timeSeconds > trimEndSeconds) return null;
  const index = Math.floor(((timeSeconds - trimStartSeconds) * fpsNumerator) / fpsDenominator);
  return Math.min(Math.max(index, 0), frameCount - 1);
};
