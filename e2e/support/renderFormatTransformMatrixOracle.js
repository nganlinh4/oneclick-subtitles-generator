import { strict as assert } from 'node:assert';

/**
 * Pure geometry/matrix logic for the renderFormatTransformMatrix journey.
 *
 * WHAT THE PUBLIC UI ACTUALLY OFFERS. `src/components/VideoRenderingSection/RenderSettingsRow.js`
 * exposes exactly two render-settings dropdowns: Resolution (360p/480p/720p/1080p/1440p/4K/8K) and
 * Frame Rate (24/25/30/50/60/120). There is no public container or codec choice anywhere in the
 * render surface -- `crates/osg-render/src/contract.rs`'s `RenderRequest` carries no such field, and
 * every native export is one fixed MP4/H.264+AAC container. The "container/codec options" axis the
 * capability names therefore has exactly one option, and the matrix below covers it by construction
 * rather than by iterating a choice that does not exist.
 *
 * The one transform this journey exercises -- `src/components/VideoCropControls.js`'s aspect-ratio
 * PRESET buttons -- is click-only (no pointer drag) and, per
 * `crates/osg-export/src/convert/dimensions.rs`, changes the OUTPUT frame's own aspect ratio rather
 * than padding a fixed canvas: `crop.aspectRatio` is intentionally never read, and the derived width
 * is `even(round(targetHeight * sourceAspect * (cropWidth / cropHeight)))`. `expectedRenderWidth`
 * below is that exact formula, so a crop case is verified against the real contract rather than a
 * guess about padding.
 */

/**
 * Canonical output height per public resolution choice, mirrored from
 * `crates/osg-render/src/contract.rs` (`RenderResolution::height`).
 */
export const RESOLUTION_CANONICAL_HEIGHT = Object.freeze({
  '360p': 360,
  '480p': 480,
  '720p': 720,
  '1080p': 1_080,
  '1440p': 1_440,
  '4K': 2_160,
  '8K': 4_320,
});

/** The exact, ordered Resolution dropdown options from `RenderSettingsRow.js`. */
export const RESOLUTION_DROPDOWN_OPTIONS = Object.freeze([
  '360p', '480p', '720p', '1080p', '1440p', '4K', '8K',
]);

/** The exact, ordered Frame Rate dropdown values from `RenderSettingsRow.js`. */
export const FRAME_RATE_DROPDOWN_OPTIONS = Object.freeze([24, 25, 30, 50, 60, 120]);

/**
 * The small, bounded matrix: 2 resolutions x 2 frame rates (the only two public render-settings
 * axes), plus one crop case that reuses one of those four combinations as its geometric baseline.
 */
export const RENDER_TRANSFORM_MATRIX_CASES = Object.freeze([
  Object.freeze({
    name: '360p-24fps', resolution: '360p', resolutionOptionIndex: 0,
    frameRate: 24, frameRateOptionIndex: 0, frameRatePrefix: '24 FPS', crop: null,
  }),
  Object.freeze({
    name: '360p-60fps', resolution: '360p', resolutionOptionIndex: 0,
    frameRate: 60, frameRateOptionIndex: 4, frameRatePrefix: '60 FPS', crop: null,
  }),
  Object.freeze({
    name: '720p-24fps', resolution: '720p', resolutionOptionIndex: 2,
    frameRate: 24, frameRateOptionIndex: 0, frameRatePrefix: '24 FPS', crop: null,
  }),
  Object.freeze({
    name: '720p-60fps', resolution: '720p', resolutionOptionIndex: 2,
    frameRate: 60, frameRateOptionIndex: 4, frameRatePrefix: '60 FPS', crop: null,
  }),
  Object.freeze({
    name: '720p-24fps-crop-1x1', resolution: '720p', resolutionOptionIndex: 2,
    frameRate: 24, frameRateOptionIndex: 0, frameRatePrefix: '24 FPS', crop: '1:1',
    baselineCase: '720p-24fps',
  }),
]);

for (const matrixCase of RENDER_TRANSFORM_MATRIX_CASES) {
  assert.equal(
    RESOLUTION_DROPDOWN_OPTIONS[matrixCase.resolutionOptionIndex],
    matrixCase.resolution,
    `matrix case ${matrixCase.name} names a resolution dropdown option that has moved`,
  );
  assert.equal(
    FRAME_RATE_DROPDOWN_OPTIONS[matrixCase.frameRateOptionIndex],
    matrixCase.frameRate,
    `matrix case ${matrixCase.name} names a frame rate dropdown option that has moved`,
  );
  assert.ok(
    matrixCase.crop === null || matrixCase.baselineCase !== undefined,
    `matrix case ${matrixCase.name} applies a crop but names no geometric baseline case`,
  );
}

/** Parse an ffprobe rational frame rate string ("24/1", "24000/1001") into a plain number. */
export const parseFrameRateFraction = (value) => {
  assert.equal(typeof value, 'string', 'a frame rate fraction must be a string');
  const match = /^(\d+)\/(\d+)$/u.exec(value.trim());
  assert.ok(match, `unrecognized frame rate fraction: ${value}`);
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  assert.ok(denominator > 0, `frame rate fraction has a zero denominator: ${value}`);
  return numerator / denominator;
};

/**
 * The output edge the native encoder actually receives, mirroring
 * `crates/osg-export/src/convert/dimensions.rs`'s `composed_width`: derived once from the source's
 * DISPLAY aspect and the crop rectangle's own ratio, rounded up to an even edge.
 */
export const expectedRenderWidth = (
  sourceWidth, sourceHeight, targetHeight, cropWidthPercent = 100, cropHeightPercent = 100,
) => {
  assert.ok(Number.isFinite(sourceWidth) && sourceWidth > 0, 'source width must be positive');
  assert.ok(Number.isFinite(sourceHeight) && sourceHeight > 0, 'source height must be positive');
  assert.ok(
    Number.isSafeInteger(targetHeight) && targetHeight > 0,
    'target height must be a positive integer',
  );
  assert.ok(
    Number.isFinite(cropWidthPercent) && cropWidthPercent > 0,
    'crop width percentage must be positive',
  );
  assert.ok(
    Number.isFinite(cropHeightPercent) && cropHeightPercent > 0,
    'crop height percentage must be positive',
  );
  const sourceAspect = sourceWidth / sourceHeight;
  const cropRatio = cropWidthPercent / cropHeightPercent;
  const rounded = Math.round(targetHeight * sourceAspect * cropRatio);
  return rounded % 2 === 0 ? rounded : rounded + 1;
};

/**
 * Prove one matrix case's decoded export matches its requested resolution/frame rate exactly and
 * its duration agrees with the timeline, independently of the durable scene the app reported.
 */
export const verifyRenderMatrixCase = ({
  probe, sourceProbe, expected, crop = null, durationToleranceSeconds = 0.3,
}) => {
  const video = probe?.streams?.find(({ codec_type: type }) => type === 'video');
  const audio = probe?.streams?.find(({ codec_type: type }) => type === 'audio');
  assert.ok(video, `matrix case ${expected.name} produced no video stream`);
  assert.ok(audio, `matrix case ${expected.name} produced no audio stream`);

  const canonicalHeight = RESOLUTION_CANONICAL_HEIGHT[expected.resolution];
  assert.ok(
    Number.isSafeInteger(canonicalHeight),
    `matrix case ${expected.name} names an unknown resolution`,
  );
  assert.equal(
    video.height, canonicalHeight,
    `matrix case ${expected.name} has the wrong output height`,
  );

  const sourceVideo = sourceProbe?.streams?.find(({ codec_type: type }) => type === 'video');
  assert.ok(
    sourceVideo,
    `matrix case ${expected.name} has no independently probed source video stream`,
  );
  const expectedWidth = expectedRenderWidth(
    sourceVideo.width,
    sourceVideo.height,
    canonicalHeight,
    crop?.width ?? 100,
    crop?.height ?? 100,
  );
  assert.equal(
    video.width, expectedWidth,
    `matrix case ${expected.name} decoded width disagrees with the source-aspect${crop ? '/crop' : ''} contract`,
  );

  const observedFrameRate = parseFrameRateFraction(video.avg_frame_rate ?? video.r_frame_rate);
  assert.ok(
    Math.abs(observedFrameRate - expected.frameRate) < 0.1,
    `matrix case ${expected.name} requested ${expected.frameRate}fps but decoded ${observedFrameRate}fps`,
  );

  const duration = Number(probe.format.duration);
  const sourceDuration = Number(sourceProbe.format.duration);
  assert.ok(
    Number.isFinite(duration) && Math.abs(duration - sourceDuration) <= durationToleranceSeconds,
    `matrix case ${expected.name} duration ${duration}s disagrees with the source timeline ${sourceDuration}s`,
  );

  return Object.freeze({
    video,
    audio,
    width: video.width,
    height: video.height,
    frameRate: observedFrameRate,
    duration,
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
  });
};
