import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

import { compareFramePixels } from './nativeMediaOracle.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_EDGE = 16_384;
const DEFAULT_CHANNEL_DELTA_THRESHOLD = 8;
const DEFAULT_MINIMUM_CHANGED_PIXELS = 128;
const DEFAULT_MINIMUM_CHANGED_RATIO = 0.000_5;
const DEFAULT_MAXIMUM_MEDIA_PLATEAU_MS = 750;
const DEFAULT_MAXIMUM_COMPOSITOR_PLATEAU_MS = 1_000;

const describePng = (path) => {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `frame is not a regular file: ${path}`);
  assert.ok(stat.size >= 33 && stat.size <= MAX_FRAME_BYTES, (
    `frame byte length is outside the oracle boundary: ${stat.size}`
  ));
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), true, (
    `frame is not a PNG: ${path}`
  ));
  assert.equal(bytes.readUInt32BE(8), 13, `frame has no canonical IHDR length: ${path}`);
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR', `frame has no IHDR: ${path}`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && width <= MAX_FRAME_EDGE, `frame width is outside bounds: ${width}`);
  assert.ok(height > 0 && height <= MAX_FRAME_EDGE, `frame height is outside bounds: ${height}`);
  return Object.freeze({
    path,
    width,
    height,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
};

const assertSameGeometry = (reference, candidate) => {
  assert.deepEqual(
    [candidate.width, candidate.height],
    [reference.width, reference.height],
    'customization comparison frames do not share one composition geometry',
  );
};

const measuredSsim = (compare, referencePath, candidatePath) => {
  assert.equal(typeof compare, 'function', 'an independent SSIM comparator is required');
  const score = compare(referencePath, candidatePath);
  assert.ok(Number.isFinite(score) && score >= 0 && score <= 1, `invalid SSIM score: ${score}`);
  return score;
};

const measuredPixelChange = ({
  comparePixels,
  reference,
  candidate,
  channelDeltaThreshold,
}) => {
  assert.equal(typeof comparePixels, 'function', 'an independent RGBA pixel comparator is required');
  const result = comparePixels(reference.path, candidate.path, { channelDeltaThreshold });
  assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result), (
    'RGBA pixel comparator returned no measurement'
  ));
  assert.deepEqual(
    [result.width, result.height],
    [reference.width, reference.height],
    'RGBA pixel measurement does not describe the comparison frames',
  );
  const expectedPixels = reference.width * reference.height;
  assert.equal(result.totalPixels, expectedPixels, 'RGBA pixel measurement has a false pixel total');
  assert.ok(Number.isSafeInteger(result.changedPixels)
    && result.changedPixels >= 0
    && result.changedPixels <= expectedPixels, `invalid changed-pixel count: ${result.changedPixels}`);
  assert.ok(Number.isFinite(result.changedRatio)
    && result.changedRatio >= 0
    && result.changedRatio <= 1, `invalid changed-pixel ratio: ${result.changedRatio}`);
  const expectedRatio = result.changedPixels / expectedPixels;
  assert.ok(Math.abs(result.changedRatio - expectedRatio) <= Number.EPSILON * 8, (
    `changed-pixel ratio ${result.changedRatio} disagrees with count ${result.changedPixels}`
  ));
  assert.equal(result.channelDeltaThreshold, channelDeltaThreshold, (
    'RGBA pixel measurement used another channel threshold'
  ));
  assert.ok(Number.isSafeInteger(result.maximumChannelDelta)
    && result.maximumChannelDelta >= 0
    && result.maximumChannelDelta <= 255, (
    `invalid maximum RGBA channel delta: ${result.maximumChannelDelta}`
  ));
  assert.equal(
    result.maximumChannelDelta >= channelDeltaThreshold,
    result.changedPixels > 0,
    'RGBA pixel measurement contradicts its thresholded changed-pixel count',
  );
  return Object.freeze({ ...result });
};

export const describeCustomizationFrame = (path) => describePng(path);

const longestStrictPlateauMs = (samples, read, epsilon = 0) => {
  let plateauStartedAt = samples[0].atMs;
  let lastProgress = read(samples[0]);
  let longest = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index];
    const current = read(sample);
    if (current > lastProgress + epsilon) {
      longest = Math.max(longest, sample.atMs - plateauStartedAt);
      plateauStartedAt = sample.atMs;
      lastProgress = current;
    }
  }
  return Math.max(longest, samples.at(-1).atMs - plateauStartedAt);
};

/**
 * Verify one live style rebuild against observations from the actual video and compositor canvas.
 *
 * This deliberately accepts only measurements. The WebDriver journey owns every customer action;
 * this oracle cannot start playback, select a preset, seek media, or mutate application state.
 */
export const verifyLiveCustomizationPlayback = ({
  samples,
  mediaEvents = [],
  expectedCue = '0',
  beforePreset = 'Default',
  afterPreset,
  minimumElapsedMs = 2_800,
  maximumElapsedMs = 5_000,
  minimumMediaAdvanceSeconds = 2.2,
  minimumRevisionAdvance = 18,
  minimumPostStyleRevisionAdvance = 8,
  maximumMediaPlateauMs = DEFAULT_MAXIMUM_MEDIA_PLATEAU_MS,
  maximumCompositorPlateauMs = DEFAULT_MAXIMUM_COMPOSITOR_PLATEAU_MS,
}) => {
  assert.ok(Array.isArray(samples) && samples.length >= 30, (
    'live customization proof needs at least 30 animation-frame observations'
  ));
  assert.ok(Array.isArray(mediaEvents), 'live customization media events must be an array');
  assert.equal(typeof afterPreset, 'string', 'live customization proof needs the selected preset');
  assert.ok(afterPreset.length > 0 && afterPreset !== beforePreset, (
    'live customization proof needs two distinct named presets'
  ));
  assert.ok(Number.isFinite(minimumElapsedMs) && minimumElapsedMs > 0);
  assert.ok(Number.isFinite(maximumElapsedMs) && maximumElapsedMs >= minimumElapsedMs);
  assert.ok(Number.isFinite(minimumMediaAdvanceSeconds) && minimumMediaAdvanceSeconds > 0);
  assert.ok(Number.isSafeInteger(minimumRevisionAdvance) && minimumRevisionAdvance > 0);
  assert.ok(Number.isSafeInteger(minimumPostStyleRevisionAdvance)
    && minimumPostStyleRevisionAdvance > 0);
  assert.ok(Number.isFinite(maximumMediaPlateauMs) && maximumMediaPlateauMs > 0);
  assert.ok(Number.isFinite(maximumCompositorPlateauMs)
    && maximumCompositorPlateauMs > 0);

  for (const [index, sample] of samples.entries()) {
    assert.ok(sample !== null && typeof sample === 'object' && !Array.isArray(sample), (
      `live customization sample ${index} is invalid`
    ));
    assert.ok(Number.isFinite(sample.atMs) && sample.atMs >= 0, (
      `live customization sample ${index} has an invalid clock`
    ));
    assert.ok(Number.isFinite(sample.mediaTime) && sample.mediaTime >= 0, (
      `live customization sample ${index} has an invalid media time`
    ));
    assert.ok(Number.isSafeInteger(sample.revision) && sample.revision > 0, (
      `live customization sample ${index} has an invalid compositor revision`
    ));
    assert.ok(Number.isSafeInteger(sample.overlayRebuilds) && sample.overlayRebuilds > 0, (
      `live customization sample ${index} has an invalid overlay revision`
    ));
    if (index > 0) {
      assert.ok(sample.atMs > samples[index - 1].atMs, (
        `animation-frame clocks are not strictly increasing at sample ${index}`
      ));
      assert.ok(sample.mediaTime + 0.001 >= samples[index - 1].mediaTime, (
        `the source media clock moved backwards at sample ${index}`
      ));
      assert.ok(sample.revision >= samples[index - 1].revision, (
        `the compositor revision moved backwards at sample ${index}`
      ));
      assert.ok(sample.overlayRebuilds >= samples[index - 1].overlayRebuilds, (
        `the subtitle overlay revision moved backwards at sample ${index}`
      ));
    }
    assert.equal(sample.paused, false, `playback paused at animation-frame sample ${index}`);
    assert.equal(sample.ended, false, `playback ended at animation-frame sample ${index}`);
    assert.equal(sample.error, null, `the source video failed at sample ${index}`);
    assert.ok(sample.readyState >= 2, `the source video became unreadable at sample ${index}`);
    assert.ok(Array.isArray(sample.visibleErrors), (
      `live customization sample ${index} has no visible-error observation`
    ));
    assert.deepEqual(sample.visibleErrors, [], (
      `the native preview exposed a refusal/error at sample ${index}`
    ));
    assert.equal(sample.cue, expectedCue, (
      `the active subtitle blinked at sample ${index}: expected ${expectedCue}, got ${sample.cue}`
    ));
    assert.notEqual(sample.preview, 'refused', `the native preview refused at sample ${index}`);
    assert.equal(sample.previewCode, null, (
      `the native preview published ${sample.previewCode} at sample ${index}`
    ));
  }

  const allowedMediaEvents = new Set(['abort', 'emptied', 'error', 'playing', 'stalled', 'waiting']);
  let previousMediaEventAtMs = -1;
  for (const [index, event] of mediaEvents.entries()) {
    assert.ok(event !== null && typeof event === 'object' && !Array.isArray(event), (
      `live customization media event ${index} is invalid`
    ));
    assert.ok(allowedMediaEvents.has(event.type), `unexpected media event ${event.type}`);
    assert.ok(Number.isFinite(event.atMs) && event.atMs >= previousMediaEventAtMs, (
      `media event clocks moved backwards at event ${index}`
    ));
    assert.ok(Number.isFinite(event.mediaTime) && event.mediaTime >= 0, (
      `media event ${index} has no source clock`
    ));
    previousMediaEventAtMs = event.atMs;
  }
  const forbiddenEvents = new Set(['abort', 'emptied', 'error', 'stalled']);
  const failedEvents = mediaEvents.filter(({ type }) => forbiddenEvents.has(type));
  assert.deepEqual(failedEvents, [], 'the source video emitted a failure/stall event');
  const waitingRecoveries = [];
  for (const [index, waiting] of mediaEvents.entries()) {
    if (waiting.type !== 'waiting') continue;
    const playing = mediaEvents.slice(index + 1).find(event => event.type === 'playing');
    assert.ok(playing !== undefined, 'the source video waiting event never recovered to playing');
    const recoveryMs = playing.atMs - waiting.atMs;
    assert.ok(recoveryMs >= 0 && recoveryMs <= maximumMediaPlateauMs, (
      `the source video waiting recovery took ${recoveryMs}ms; `
      + `the continuity bound is ${maximumMediaPlateauMs}ms`
    ));
    waitingRecoveries.push(Object.freeze({
      waitingAtMs: waiting.atMs,
      playingAtMs: playing.atMs,
      recoveryMs,
    }));
  }

  const first = samples[0];
  const last = samples.at(-1);
  const elapsedMs = last.atMs - first.atMs;
  const mediaAdvancedSeconds = last.mediaTime - first.mediaTime;
  const revisionAdvance = last.revision - first.revision;
  assert.ok(elapsedMs >= minimumElapsedMs && elapsedMs <= maximumElapsedMs, (
    `live customization sample duration is outside bounds: ${elapsedMs}ms`
  ));
  assert.ok(mediaAdvancedSeconds >= minimumMediaAdvanceSeconds, (
    `the source media clock stalled: ${mediaAdvancedSeconds}s in ${elapsedMs}ms`
  ));
  assert.ok(revisionAdvance >= minimumRevisionAdvance, (
    `the native preview froze: only ${revisionAdvance} revisions in ${elapsedMs}ms`
  ));

  const transitionIndex = samples.findIndex(({ preset }) => preset === afterPreset);
  assert.ok(transitionIndex >= 3 && transitionIndex < samples.length - 3, (
    `the ${afterPreset} preset was not observed during continuous playback`
  ));
  assert.equal(
    samples.slice(0, transitionIndex).some(({ preset }) => preset === beforePreset),
    true,
    `the pre-change ${beforePreset} preset was not observed during playback`,
  );
  assert.equal(
    samples.slice(transitionIndex).every(({ preset }) => preset === afterPreset),
    true,
    `the selected ${afterPreset} preset did not remain active after its live rebuild`,
  );
  const transition = samples[transitionIndex];
  const postStyleRevisionAdvance = last.revision - transition.revision;
  assert.ok(last.overlayRebuilds > first.overlayRebuilds, (
    'the live preset action never rebuilt the native subtitle overlay'
  ));
  assert.ok(postStyleRevisionAdvance >= minimumPostStyleRevisionAdvance, (
    `the native preview froze after the style rebuild: only ${postStyleRevisionAdvance} revisions`
  ));

  const longestMediaPlateauMs = longestStrictPlateauMs(
    samples,
    ({ mediaTime }) => mediaTime,
    0.001,
  );
  const longestCompositorPlateauMs = longestStrictPlateauMs(
    samples,
    ({ revision }) => revision,
  );
  assert.ok(longestMediaPlateauMs <= maximumMediaPlateauMs, (
    `the source media clock stopped for ${longestMediaPlateauMs}ms`
  ));
  assert.ok(longestCompositorPlateauMs <= maximumCompositorPlateauMs, (
    `the composited video frame stopped for ${longestCompositorPlateauMs}ms`
  ));

  return Object.freeze({
    animationFrameSamples: samples.length,
    elapsedMs,
    mediaAdvancedSeconds,
    revisionAdvance,
    overlayRebuilds: last.overlayRebuilds - first.overlayRebuilds,
    postStyleRevisionAdvance,
    longestMediaPlateauMs,
    longestCompositorPlateauMs,
    transitionAtMs: transition.atMs,
    transitionMediaTime: transition.mediaTime,
    mediaEvents: mediaEvents.map((event) => ({ ...event })),
    waitingRecoveries: Object.freeze(waitingRecoveries),
  });
};

/**
 * Describe a compositor crop only after it matches the independently frozen harness envelope.
 */
export const describeCustomizationNativeFrame = (
  path,
  expectedGeometry,
) => {
  assert.ok(expectedGeometry !== null && typeof expectedGeometry === 'object', (
    'native customization frame needs independent expected geometry'
  ));
  const { width, height } = expectedGeometry;
  assert.ok(Number.isSafeInteger(width) && width > 0, 'expected native frame width is invalid');
  assert.ok(Number.isSafeInteger(height) && height > 0, 'expected native frame height is invalid');
  const frame = describePng(path);
  assert.deepEqual(
    [frame.width, frame.height],
    [width, height],
    'native customization frame does not match the independently expected compositor envelope',
  );
  return frame;
};

/**
 * Prove a UI action changed rendered pixels, not just React state or a canvas revision counter.
 */
export const verifyCustomizationTransition = ({
  beforePath,
  afterPath,
  compare,
  comparePixels = compareFramePixels,
  maximumSsim = 0.999_999,
  channelDeltaThreshold = DEFAULT_CHANNEL_DELTA_THRESHOLD,
  minimumChangedPixels = DEFAULT_MINIMUM_CHANGED_PIXELS,
  minimumChangedRatio = DEFAULT_MINIMUM_CHANGED_RATIO,
}) => {
  assert.ok(Number.isFinite(maximumSsim) && maximumSsim > 0 && maximumSsim <= 1);
  assert.ok(Number.isSafeInteger(channelDeltaThreshold)
    && channelDeltaThreshold >= 1 && channelDeltaThreshold <= 255, (
    'channelDeltaThreshold must be an integer from 1 through 255'
  ));
  assert.ok(Number.isSafeInteger(minimumChangedPixels) && minimumChangedPixels >= 1, (
    'minimumChangedPixels must be a positive safe integer'
  ));
  assert.ok(Number.isFinite(minimumChangedRatio)
    && minimumChangedRatio > 0 && minimumChangedRatio <= 1, (
    'minimumChangedRatio must be greater than zero and at most one'
  ));
  const before = describePng(beforePath);
  const after = describePng(afterPath);
  assertSameGeometry(before, after);
  assert.ok(minimumChangedPixels <= before.width * before.height, (
    'minimumChangedPixels exceeds the comparison frame'
  ));
  assert.notEqual(after.sha256, before.sha256, 'customization action left frame bytes unchanged');
  const ssim = measuredSsim(compare, beforePath, afterPath);
  assert.ok(ssim < maximumSsim, (
    `customization action was not materially visible: SSIM ${ssim} >= ${maximumSsim}`
  ));
  const pixels = measuredPixelChange({
    comparePixels,
    reference: before,
    candidate: after,
    channelDeltaThreshold,
  });
  assert.ok(pixels.changedPixels >= minimumChangedPixels, (
    `customization changed only ${pixels.changedPixels} thresholded pixels; `
    + `at least ${minimumChangedPixels} are required`
  ));
  assert.ok(pixels.changedRatio >= minimumChangedRatio, (
    `customization changed only ${(pixels.changedRatio * 100).toFixed(6)}% of pixels; `
    + `at least ${(minimumChangedRatio * 100).toFixed(6)}% are required`
  ));
  return Object.freeze({ before, after, ssim, pixels });
};

/**
 * Prove selecting the known preset returns to its pixels, instead of only relabelling the button.
 */
export const verifyCustomizationRestoration = ({
  baselinePath,
  restoredPath,
  divergentPaths,
  compare,
  minimumSsim = 0.995,
}) => {
  assert.ok(Array.isArray(divergentPaths) && divergentPaths.length > 0, (
    'restoration needs at least one independently changed frame'
  ));
  assert.ok(Number.isFinite(minimumSsim) && minimumSsim >= 0 && minimumSsim <= 1);
  const baseline = describePng(baselinePath);
  const restored = describePng(restoredPath);
  assertSameGeometry(baseline, restored);
  const restoredSsim = measuredSsim(compare, baselinePath, restoredPath);
  assert.ok(restoredSsim >= minimumSsim, (
    `known preset did not restore its pixels: SSIM ${restoredSsim} < ${minimumSsim}`
  ));

  const divergent = divergentPaths.map((path) => {
    const frame = describePng(path);
    assertSameGeometry(baseline, frame);
    assert.notEqual(frame.sha256, baseline.sha256, `divergent frame equals baseline: ${path}`);
    return Object.freeze({ frame, ssim: measuredSsim(compare, baselinePath, path) });
  });
  const closestDivergent = Math.max(...divergent.map(({ ssim }) => ssim));
  assert.ok(restoredSsim > closestDivergent, (
    `restored preset is no closer to baseline than changed styles: ${restoredSsim} <= ${closestDivergent}`
  ));
  return Object.freeze({ baseline, restored, restoredSsim, closestDivergent, divergent });
};
