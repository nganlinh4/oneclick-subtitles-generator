import { strict as assert } from 'node:assert';

import { audioWindow } from './narrationJourneyOracle.js';

/**
 * Pure comparison logic for the renderAudioNarrationMix journey: two native renders of the SAME
 * project, differing only in whether the render section's "Aligned Narration" mix was selected,
 * must keep identical container geometry and differ measurably in decoded audio energy at every
 * narration cue's placement window.
 *
 * Kept independent of `narrationJourneyOracle.js`'s `verifyNarrationOnlyExportMix`: that helper
 * proves a narration-ONLY mix (source muted) replaced the source track entirely. This module proves
 * the opposite-shaped claim -- an A/B toggle of the SAME control on an otherwise-unchanged project
 * produces a measurable difference -- without assuming a mixing direction (an implementation may
 * duck the original track under narration rather than simply summing onto it).
 */

/** The smallest decoded-RMS delta that counts as "measurable" rather than encoder/dither noise. */
export const NARRATION_MIX_RMS_FLOOR = 0.004;

const streamsByType = (probe) => Object.freeze({
  video: probe?.streams?.find(({ codec_type: type }) => type === 'video') ?? null,
  audio: probe?.streams?.find(({ codec_type: type }) => type === 'audio') ?? null,
});

/**
 * Two renders of the same project, one with narration mixed in and one without, must keep the same
 * container geometry -- same video dimensions/frame rate, same audio format, same duration -- so a
 * later energy comparison is actually isolating the narration control rather than an unrelated
 * settings drift between the two Render clicks.
 */
export const verifyStructuralAudioParity = ({ withProbe, withoutProbe, toleranceSeconds = 0.3 }) => {
  const withStreams = streamsByType(withProbe);
  const withoutStreams = streamsByType(withoutProbe);
  assert.ok(withStreams.video && withStreams.audio, (
    'the narration-mix render has no single video/audio stream pair'
  ));
  assert.ok(withoutStreams.video && withoutStreams.audio, (
    'the baseline render has no single video/audio stream pair'
  ));
  assert.equal(withStreams.video.width, withoutStreams.video.width, (
    'the two renders disagree on video width'
  ));
  assert.equal(withStreams.video.height, withoutStreams.video.height, (
    'the two renders disagree on video height'
  ));
  assert.equal(
    withStreams.video.avg_frame_rate,
    withoutStreams.video.avg_frame_rate,
    'the two renders disagree on frame rate',
  );
  assert.equal(
    withStreams.audio.sample_rate,
    withoutStreams.audio.sample_rate,
    'the two renders disagree on audio sample rate',
  );
  assert.equal(
    withStreams.audio.channels,
    withoutStreams.audio.channels,
    'the two renders disagree on audio channel count',
  );
  const withDuration = Number(withProbe.format.duration);
  const withoutDuration = Number(withoutProbe.format.duration);
  assert.ok(
    Number.isFinite(withDuration) && Number.isFinite(withoutDuration)
      && Math.abs(withDuration - withoutDuration) <= toleranceSeconds,
    `the two renders disagree on duration: ${withDuration}s vs ${withoutDuration}s`,
  );
  return Object.freeze({ withDuration, withoutDuration });
};

/**
 * Prove decoded audio energy differs at every narration placement between the two renders.
 *
 * No mixing direction is assumed: an implementation may duck the original track under narration
 * instead of summing onto it, so only a measurable difference -- not a guaranteed increase -- is
 * required at each window. The overall envelope is checked the same way as a final sanity bound.
 */
export const verifyNarrationMixWindows = ({
  withNarration,
  withoutNarration,
  placements,
  minimumRmsDelta = NARRATION_MIX_RMS_FLOOR,
}) => {
  assert.ok(
    Array.isArray(placements) && placements.length > 0,
    'no narration placement windows were supplied',
  );
  assert.ok(
    Number.isFinite(minimumRmsDelta) && minimumRmsDelta > 0,
    'the narration-mix RMS floor must be a positive number',
  );
  const deltas = placements.map((placement, index) => {
    const withWindow = audioWindow(withNarration, placement.start, placement.end);
    const withoutWindow = audioWindow(withoutNarration, placement.start, placement.end);
    const delta = withWindow.maximumRms - withoutWindow.maximumRms;
    assert.ok(
      Math.abs(delta) >= minimumRmsDelta,
      `narration cue ${index + 1} (${placement.start}s-${placement.end}s) shows no measurable `
        + `audio difference: withNarration=${withWindow.maximumRms}, `
        + `withoutNarration=${withoutWindow.maximumRms}`,
    );
    return Object.freeze({
      cueId: placement.cueId,
      start: placement.start,
      end: placement.end,
      withMaximumRms: withWindow.maximumRms,
      withoutMaximumRms: withoutWindow.maximumRms,
      delta,
    });
  });
  assert.ok(
    Math.abs(withNarration.maximumRms - withoutNarration.maximumRms) >= minimumRmsDelta,
    'the two renders show no measurable difference in overall decoded audio energy',
  );
  return Object.freeze(deltas);
};

export const RENDER_AUDIO_NARRATION_MIX_ORACLE = Object.freeze({
  rmsFloor: NARRATION_MIX_RMS_FLOOR,
});
