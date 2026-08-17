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
 *     its association. That module records that the deleted browser preview's
 *     `getCompositionDimensions` associated the same inputs differently
 *     — `sourceAspect * ((cropWidth / 100) / (cropHeight / 100))` — and that floating-point
 *     multiplication is not associative, so the two forms round to different widths for a small
 *     fraction of crop shapes. Replacing that preview with this module is what removes the
 *     disagreement; a third association would have re-created it.
 *   - `previewTimeline` mirrors `RenderRequest::validate` in `crates/osg-render/src/contract.rs`
 *     and `build` in `crates/osg-export/src/convert/timeline.rs`, which between them own the
 *     TRIMMED timeline every frame index is an index into.
 *
 * ATLAS SPACE IS COMPENSATED IN ONE DIRECTION, ALWAYS. Everything the baker takes in atlas pixels —
 * the wrap width and the letter spacing — is a composition-space quantity divided by `glyphScale`,
 * because the compositor multiplies the whole layout by that same scale. A quantity passed straight
 * through is correct only while `glyphScale` happens to be the identity, which it is not once the
 * atlas font size is clamped or the composition is not 1080 high.
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
 * The code a wrap width the baker will not take is reported under.
 *
 * A CODE RATHER THAN A `null`, because the two states are not the same thing. A `null` reaches the
 * surface as dormancy, and dormancy is deliberately silent — no frame and no explanation — which is
 * the right answer for "the editor does not know the source size yet" and exactly the wrong one for
 * "this style is outside what can be baked". A user who moved a slider and got a blank panel with
 * nothing to read has been told their subtitle disappeared.
 */
export const PREVIEW_WRAP_WIDTH_UNSUPPORTED = 'previewWrapWidthUnsupported';

/**
 * The persisted `maxWidth` percentage bounds. Mirrors `max_width` in
 * `crates/osg-render/src/contract.rs` and `CUSTOMIZATION_NUMBER_BOUNDS` in `renderService.js`, both
 * of which accept 1..1000 — a box WIDER than the composition is a legitimate style, and the render
 * contract that the export is built through takes it.
 */
const MIN_MAX_WIDTH_PERCENT = 1;
const MAX_MAX_WIDTH_PERCENT = 1_000;

const wrapWidth = (widthPx) => Object.freeze({ widthPx, refusal: null });
const wrapRefusal = (refusal) => Object.freeze({ widthPx: null, refusal });
/** Neither a width nor a refusal: an input the export refuses too, so there is nothing to preview. */
const WRAP_WIDTH_DORMANT = Object.freeze({ widthPx: null, refusal: null });

/**
 * The wrap width the baker takes, in atlas pixels, for a persisted `maxWidth` percentage.
 *
 * `(maxWidth / 100) * compositionWidth / glyphScale`, which is the parity ledger's own expression.
 * The division by the glyph scale is the whole point: it converts a composition-space width into the
 * space the atlas was baked in, so the same style wraps at the same place at every resolution.
 *
 * THE WHOLE CONTRACT RANGE IS SUPPORTED. This used to refuse anything above 100%, which is neither
 * the contract's bound nor the shipped renderer's — CSS `max-width: 150%` is a box wider than its
 * parent, and `normalizeCustomization` accepts 1..1000 — so every project styled past 100 previewed
 * as a blank panel while the export rendered it.
 *
 * Returns `{ widthPx, refusal }`. `widthPx` is the derived width; `refusal` is a code for a width
 * the baker's own layout bound will not take. Both `null` means the inputs cannot produce a width at
 * all, which is the same state the render request builder refuses this style in.
 */
export const atlasWrapWidth = ({ maxWidthPercent, compositionWidthPx, glyphScale }) => {
  if (!isFiniteNumber(maxWidthPercent)
      || maxWidthPercent < MIN_MAX_WIDTH_PERCENT
      || maxWidthPercent > MAX_MAX_WIDTH_PERCENT) {
    return WRAP_WIDTH_DORMANT;
  }
  if (!isPositive(compositionWidthPx) || !isPositive(glyphScale)) return WRAP_WIDTH_DORMANT;
  const widthPx = ((maxWidthPercent / 100) * compositionWidthPx) / glyphScale;
  if (!isPositive(widthPx)) return WRAP_WIDTH_DORMANT;
  if (widthPx > GLYPH_ATLAS_LIMITS.maxLayoutWidthPx) return wrapRefusal(PREVIEW_WRAP_WIDTH_UNSUPPORTED);
  return wrapWidth(widthPx);
};

/**
 * The letter spacing the baker takes, in atlas pixels, for a persisted `letterSpacing`.
 *
 * The persisted value is authored against a 1080-high composition and scales with the composition
 * exactly as `fontSize` does — `getResponsiveScaledValue(customization.letterSpacing)` in the
 * deleted browser composition — so the composition-space quantity is
 * `scaleSubtitleStyleValue(letterSpacing, height)`, and the atlas-space one is that divided by the
 * glyph scale the compositor will multiply the whole layout by.
 *
 * THAT DIVISION IS THE POINT, and it used to be missing. The atlas font size is clamped into the
 * baker's 4..512 bounds while the contract accepts 1..1000, and `glyphScale` divides by the CLAMPED
 * size — so cells, pen positions and the wrap width are all compensated for the clamp and the raw
 * letter spacing was not. At a font size of 800 on a 1080p composition the scale is 1.5625, and
 * every gap between two clusters came out 56% wider than the style asks for.
 *
 * Returns `null` when no atlas-space value can be derived, which is the state the render request
 * builder refuses this style in.
 */
export const atlasLetterSpacingPx = ({ letterSpacing, compositionHeightPx, glyphScale }) => {
  if (!isFiniteNumber(letterSpacing) || !isPositive(compositionHeightPx) || !isPositive(glyphScale)) {
    return null;
  }
  return scaleSubtitleStyleValue(letterSpacing, compositionHeightPx) / glyphScale;
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
 * Where a playhead sits relative to the composition the export writes.
 *
 * Named states rather than a boolean, because "outside the trim window" and "past the last frame the
 * composition has" are different facts and a surface that conflates them is reporting one of them
 * wrongly. `trimEnd` itself is INSIDE the window and past the last frame whenever the window is an
 * exact number of frames long, so the two cases are not even nested.
 */
export const PREVIEW_PLAYHEAD = Object.freeze({
  /** On a frame the composition contains. The only state that carries an index. */
  inside: 'inside',
  /** Before `trimStart`: the source has this instant, the output does not. */
  beforeWindow: 'beforeWindow',
  /** After `trimEnd`: the source has this instant, the output does not. */
  afterWindow: 'afterWindow',
  /** Inside the window and past `frameCount - 1`, which the ceiling leaves room for. */
  pastLastFrame: 'pastLastFrame',
  /** No timeline to place it against yet. Dormancy, not a placement. */
  unknown: 'unknown',
});

const placed = (placement, frameIndex) => Object.freeze({ placement, frameIndex });
const UNPLACED = placed(PREVIEW_PLAYHEAD.unknown, null);

/**
 * The frame of the trimmed composition a SOURCE timestamp lands on, and why it lands on none.
 *
 * The playhead is a source instant and the composition starts at `trimStart`, so the index is
 * `floor((t - trimStart) * fps)` — the offset the source grid carries in
 * `crates/osg-export/src/convert/timeline.rs`, read the other way round. Floor rather than round,
 * because a frame covers the interval that starts at its own presentation time: the frame shown at
 * 1/30s - epsilon is frame 0, not frame 1. Seek must equal play, so this is the only place a preview
 * turns a time into an index.
 *
 * NOTHING IS CLAMPED. Frame 0 and frame `frameCount - 1` are both real exported frames, so answering
 * an out-of-range instant with one puts an exported pixel on screen at an instant it is not the
 * pixel for — which looks exactly like a correct preview and is the silent substitution this
 * migration exists to remove. This used to end in `Math.min(index, frameCount - 1)`, a clamp the
 * export has no counterpart for: `run_export` walks `0..plan.frame_count()` and
 * `PreviewHost::compose` refuses `frame_index >= frame_count` outright.
 *
 * The clamp was also not a safety net, because it clamped to the WRONG ceiling. The frame count here
 * is derived from the `<video>` element's `duration` and the native one from `MF_PD_DURATION`
 * through `probe_source`; those are two measurements of one file and they disagree on some
 * containers. When they do, the clamped index still exceeds the native composition — it merely
 * stopped this side from noticing. Asking only for indices this timeline contains is what this
 * module can honestly promise; an index the native side does not have then comes back as a stated
 * refusal rather than as a substituted frame.
 */
export const previewPlayhead = (timeSeconds, timeline) => {
  if (!isFiniteNumber(timeSeconds) || timeline === null || timeline === undefined) return UNPLACED;
  const {
    fpsNumerator, fpsDenominator, frameCount, trimStartSeconds, trimEndSeconds,
  } = timeline;
  if (!isPositive(fpsNumerator) || !isPositive(fpsDenominator) || !Number.isInteger(frameCount)) {
    return UNPLACED;
  }
  if (frameCount < 1) return UNPLACED;
  if (!isFiniteNumber(trimStartSeconds) || !isFiniteNumber(trimEndSeconds)) return UNPLACED;
  if (timeSeconds < trimStartSeconds) return placed(PREVIEW_PLAYHEAD.beforeWindow, null);
  if (timeSeconds > trimEndSeconds) return placed(PREVIEW_PLAYHEAD.afterWindow, null);
  const index = Math.floor(((timeSeconds - trimStartSeconds) * fpsNumerator) / fpsDenominator);
  if (index >= frameCount) return placed(PREVIEW_PLAYHEAD.pastLastFrame, null);
  return placed(PREVIEW_PLAYHEAD.inside, index);
};

/** The index alone, for a caller that only has to ask for a frame. `null` outside the composition. */
export const frameIndexForTime = (timeSeconds, timeline) => (
  previewPlayhead(timeSeconds, timeline).frameIndex
);
