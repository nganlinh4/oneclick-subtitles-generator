import { strict as assert } from 'node:assert';

import {
  ANIMATION_CASES,
  ANIMATION_EASING_VALUES,
  ANIMATION_PHASES,
  MAXIMUM_CONTINUITY_PLATEAU_MS,
  sweepEasedProgress,
} from './subtitleMaterialAnimationCases.js';
import {
  assertCompleteVisibleSample,
  assertFrameProof,
  assertPhaseFrames,
  assertPlaybackContinuity,
  assertRecoveredMediaEvents,
  assertTemporalPhase,
  geometryFingerprint,
  longestPlateauMs,
  spatialFingerprint,
} from './subtitleMaterialAnimationContinuity.js';
import { assertCompleteCustomization, assertSceneAuthority } from './subtitleMaterialAnimationMaterial.js';

export {
  ANIMATION_CASES,
  ANIMATION_CUE,
  ANIMATION_EASING_VALUES,
  ANIMATION_PHASES,
  ANIMATION_TYPE_VALUES,
  MATERIAL_GROUPS,
  activeAnimationCueAt,
  expectedAnimationCueAt,
  materialControlTokens,
  sweepEasedProgress,
} from './subtitleMaterialAnimationCases.js';
export {
  verifyMaterialAction,
  verifyMaterialCoverage,
  verifySubtitleContainment,
} from './subtitleMaterialAnimationMaterial.js';

/**
 * Prove a font-bearing preset rebuild never publishes an incomplete visible composition.
 *
 * `transition` is captured synchronously before the public click. Samples before the first overlay
 * rebuild are therefore the old, complete pixels retained while the new atlas is pending; samples
 * whose revision advances are the browser-visible publications made during and after the rebuild.
 */
export const verifyLiveFontPresetTransition = ({
  samples,
  publications,
  mediaEvents,
  transientTransitions,
  transition,
  beforePreset,
  afterPreset,
  beforeFontFamily,
  afterFontFamily,
}) => {
  const context = `${beforePreset}→${afterPreset} live font/preset transition`;
  assert.ok(Array.isArray(samples) && samples.length >= 6, `${context}: pixel witness is too sparse`);
  assert.ok(Array.isArray(publications), `${context}: publication ledger is absent`);
  assert.ok(Array.isArray(transientTransitions), `${context}: state-transition ledger is absent`);
  assert.equal(typeof beforePreset, 'string', `${context}: prior preset is absent`);
  assert.equal(typeof afterPreset, 'string', `${context}: selected preset is absent`);
  assert.notEqual(afterPreset, beforePreset, `${context}: preset did not change`);
  assert.equal(typeof beforeFontFamily, 'string', `${context}: prior font family is absent`);
  assert.equal(typeof afterFontFamily, 'string', `${context}: selected font family is absent`);
  assert.notEqual(afterFontFamily, beforeFontFamily, `${context}: preset did not exercise a font change`);
  assert.ok(transition !== null && typeof transition === 'object', `${context}: marker is absent`);
  assert.ok(Number.isFinite(transition.atMs) && transition.atMs >= 0, `${context}: marker clock is invalid`);
  assert.ok(Number.isSafeInteger(transition.revision) && transition.revision > 0, (
    `${context}: marker revision is invalid`
  ));
  assert.ok(Number.isSafeInteger(transition.overlayRebuilds) && transition.overlayRebuilds > 0, (
    `${context}: marker overlay revision is invalid`
  ));
  assertCompleteVisibleSample({
    atMs: transition.atMs,
    mediaTime: transition.mediaTime,
    revision: transition.revision,
    overlayRebuilds: transition.overlayRebuilds,
    visual: transition.visual,
  }, `${context}: complete pre-change pixels`);

  const recoveries = assertRecoveredMediaEvents(mediaEvents, context);
  const foreignTransitions = transientTransitions.filter(({ attribute }) => (
    attribute !== 'data-osg-preview'
  ));
  assert.deepEqual(foreignTransitions, [], `${context}: cue or refusal code changed during rebuild`);
  const statusTransitions = transientTransitions.filter(({ attribute }) => (
    attribute === 'data-osg-preview'
  ));
  assert.equal(statusTransitions.length % 2, 0, `${context}: preview pending state never recovered`);
  for (let index = 0; index < statusTransitions.length; index += 2) {
    const pending = statusTransitions[index];
    const recovered = statusTransitions[index + 1];
    assert.deepEqual(
      [pending.previous, pending.current, recovered.previous, recovered.current],
      ['ready', 'pending', 'pending', 'ready'],
      `${context}: preview state left the atomic ready/pending contract`,
    );
    assert.ok(
      recovered.atMs >= pending.atMs
        && recovered.atMs - pending.atMs <= MAXIMUM_CONTINUITY_PLATEAU_MS,
      `${context}: preview pending state exceeded the continuity bound`,
    );
  }
  const duringTransition = samples.filter(sample => sample.atMs >= transition.atMs);
  assert.ok(duringTransition.length >= 3, `${context}: rebuild was not observed over animation frames`);
  const rebuiltAt = duringTransition.findIndex(sample => (
    sample.overlayRebuilds > transition.overlayRebuilds
  ));
  assert.ok(rebuiltAt >= 0, `${context}: selected preset never published a rebuilt overlay`);
  const pending = duringTransition.slice(0, rebuiltAt);
  for (const sample of pending) {
    assert.equal(sample.overlayRebuilds, transition.overlayRebuilds, (
      `${context}: pending sample crossed the overlay boundary`
    ));
    assertCompleteVisibleSample(sample, `${context}: prior pixels during pending`);
  }

  for (const sample of duringTransition) {
    assert.deepEqual(sample.visibleErrors, [], `${context}: visible error during rebuild`);
    assert.deepEqual(sample.recordedRefusals, [], `${context}: preview refusal during rebuild`);
  }
  const published = publications.filter(frame => (
    frame.atMs >= transition.atMs && frame.revision > transition.revision
  ));
  assert.ok(published.length >= 2, `${context}: too few new visible frames were published`);
  for (const [index, frame] of published.entries()) {
    assert.ok(Number.isSafeInteger(frame.revision) && frame.revision > transition.revision, (
      `${context}: publication ${index} has an invalid frame revision`
    ));
    if (index > 0) {
      assert.ok(frame.revision > published[index - 1].revision, (
        `${context}: frame publication revisions did not increase`
      ));
    }
    assert.deepEqual(frame.visibleErrors, [], `${context}: visible error reached a publication`);
    assert.deepEqual(frame.recordedRefusals, [], `${context}: preview refusal reached a publication`);
    assertCompleteVisibleSample(frame, `${context}: newly published frame`);
  }
  assert.ok(published.some(sample => sample.overlayRebuilds > transition.overlayRebuilds), (
    `${context}: new font pixels were never published`
  ));
  assert.ok(longestPlateauMs(
    duringTransition,
    sample => sample.mediaTime,
  ) < MAXIMUM_CONTINUITY_PLATEAU_MS, `${context}: media plateaued`);
  assert.ok(longestPlateauMs(
    duringTransition,
    sample => sample.revision,
  ) < MAXIMUM_CONTINUITY_PLATEAU_MS, `${context}: compositor plateaued`);

  return Object.freeze({
    beforePreset,
    afterPreset,
    beforeFontFamily,
    afterFontFamily,
    pendingSamples: pending.length + 1,
    publishedFrames: published.length,
    overlayRebuilds: duringTransition.at(-1).overlayRebuilds - transition.overlayRebuilds,
    waitingRecoveries: recoveries,
    pendingStatusCycles: statusTransitions.length / 2,
  });
};

export const verifyAnimationObservation = ({
  animation,
  beforeRevision,
  expectedProjectId,
  expectedTypeCustomization,
  expectedFinalCustomization,
  typeScene,
  easingScene,
  continuitySamples,
  samplesByPhase,
  frameProofs,
  phaseTransitions,
  entryChange,
  transientTransitions,
  mediaEvents,
}) => {
  assert.ok(ANIMATION_CASES.includes(animation), 'animation case is outside the frozen sweep');
  if (animation.editType) {
    assert.ok(typeScene?.sceneRevision > beforeRevision, `${animation.id}: type scene did not advance`);
  } else {
    assert.equal(typeScene?.sceneRevision, beforeRevision, `${animation.id}: unchanged type created a revision`);
  }
  assertSceneAuthority(typeScene, expectedProjectId, `${animation.id}: type scene`);
  assertCompleteCustomization(
    typeScene?.scene?.customization,
    expectedTypeCustomization,
    `${animation.id}: type scene`,
  );

  const entry = frameProofs.entry.subtitleGeometry;
  const steady = frameProofs.steady.subtitleGeometry;
  const exit = frameProofs.exit.subtitleGeometry;
  const minimumShift = 0.001;
  // The measurable slide displacement at each sampled instant is `1 - eased(progress)` of the
  // full offset. A decisive factor demands its direction; a factor the easing has already driven
  // to ≈0 at the sample instant demands nearness to the holding position instead; an overshoot
  // factor (negative) demands the opposite direction. Sample progress values mirror
  // ANIMATION_PHASES (entry 0.4, exit 0.6).
  const DECISIVE_SLIDE_FACTOR = 0.15;
  const NEAR_HOLD_RATIO = 0.02;
  const slidePhaseClaim = ({ phase, sign, sample, steadyRatio, awayLabel, towardLabel }) => {
    const phaseProgress = phase === 'entry' ? 0.4 : 0.6;
    const factor = 1 - sweepEasedProgress(animation.easing, phaseProgress);
    const shift = sample - steadyRatio;
    if (factor >= DECISIVE_SLIDE_FACTOR) {
      assert.ok(sign * shift > minimumShift, (
        `${animation.id}: ${animation.type} ${phase} did not ${awayLabel}`
      ));
      return;
    }
    if (factor <= -DECISIVE_SLIDE_FACTOR) {
      assert.ok(sign * shift < -minimumShift, (
        `${animation.id}: ${animation.type} ${phase} did not overshoot ${towardLabel}`
      ));
      return;
    }
    assert.ok(Math.abs(shift) <= NEAR_HOLD_RATIO, (
      `${animation.id}: ${animation.type} ${phase} strayed from holding at a near-zero eased offset (factor ${factor.toFixed(4)}, shift ${shift.toFixed(4)})`
    ));
  };
  const SLIDE_AXES = {
    'slide-up': { axis: 'y', entrySign: 1, exitSign: -1, entryAway: 'start below its holding position', exitAway: 'leave above its holding position' },
    'slide-down': { axis: 'y', entrySign: -1, exitSign: 1, entryAway: 'start above its holding position', exitAway: 'leave below its holding position' },
    'slide-left': { axis: 'x', entrySign: 1, exitSign: -1, entryAway: 'start to the right', exitAway: 'leave to the left' },
    'slide-right': { axis: 'x', entrySign: -1, exitSign: 1, entryAway: 'start to the left', exitAway: 'leave to the right' },
  };
  if (SLIDE_AXES[animation.type] !== undefined) {
    const spec = SLIDE_AXES[animation.type];
    const read = geometry => (spec.axis === 'y' ? geometry.centroidYRatio : geometry.centroidXRatio);
    slidePhaseClaim({
      phase: 'entry',
      sign: spec.entrySign,
      sample: read(entry),
      steadyRatio: read(steady),
      awayLabel: spec.entryAway,
      towardLabel: 'past its holding position',
    });
    slidePhaseClaim({
      phase: 'exit',
      sign: spec.exitSign,
      sample: read(exit),
      steadyRatio: read(steady),
      awayLabel: spec.exitAway,
      towardLabel: 'past its holding position',
    });
  } else if (animation.type === 'scale') {
    assert.ok(entry.bounds.areaPixels < steady.bounds.areaPixels * 0.98, (
      `${animation.id}: scale entry did not occupy a smaller area`
    ));
    assert.ok(exit.bounds.areaPixels < steady.bounds.areaPixels * 0.98, (
      `${animation.id}: scale exit did not occupy a smaller area`
    ));
  } else if (animation.type === 'bounce') {
    assert.ok(Math.abs(entry.bounds.areaPixels - steady.bounds.areaPixels) >= steady.bounds.areaPixels * 0.01, (
      `${animation.id}: bounce entry kept a constant area`
    ));
  } else if (animation.type === 'flip') {
    assert.ok(entry.bounds.width < steady.bounds.width * 0.98, (
      `${animation.id}: flip entry kept the holding width`
    ));
    assert.ok(exit.bounds.width < steady.bounds.width * 0.98, (
      `${animation.id}: flip exit kept the holding width`
    ));
  } else if (animation.type === 'rotate') {
    assert.ok(Math.abs(entry.bounds.areaPixels - steady.bounds.areaPixels) >= steady.bounds.areaPixels * 0.01, (
      `${animation.id}: rotate entry kept a constant area`
    ));
    assert.ok(Math.abs(exit.bounds.areaPixels - steady.bounds.areaPixels) >= steady.bounds.areaPixels * 0.01, (
      `${animation.id}: rotate exit kept a constant area`
    ));
  } else if (animation.type === 'typewriter') {
    assert.ok(entry.changedPixels < steady.changedPixels * 0.95, (
      `${animation.id}: typewriter entry revealed the complete cue`
    ));
  } else if (animation.type === 'fade') {
    assert.ok(entry.meanChangedChannelDelta < exit.meanChangedChannelDelta, (
      `${animation.id}: fade entry did not carry less energy than exit`
    ));
    assert.ok(exit.meanChangedChannelDelta < steady.meanChangedChannelDelta, (
      `${animation.id}: fade exit did not carry less energy than holding`
    ));
  }
  if (animation.editEasing) {
    assert.ok(easingScene?.sceneRevision > typeScene.sceneRevision, `${animation.id}: easing scene did not advance`);
  } else {
    assert.equal(easingScene?.sceneRevision, typeScene.sceneRevision, `${animation.id}: unchanged easing created a revision`);
  }
  assertSceneAuthority(easingScene, expectedProjectId, `${animation.id}: final scene`);
  assertCompleteCustomization(
    easingScene?.scene?.customization,
    expectedFinalCustomization,
    `${animation.id}: final scene`,
  );
  const visualSummary = assertPlaybackContinuity(
    continuitySamples,
    mediaEvents,
    animation,
  );
  assert.deepEqual(transientTransitions, [], (
    `${animation.type}/${animation.easing}: preview/cue blinked between animation-frame samples`
  ));
  for (const phase of ANIMATION_PHASES) {
    assertTemporalPhase(samplesByPhase?.[phase.name], phase, `${animation.type}/${animation.easing}`);
    assertFrameProof(frameProofs?.[phase.name], `${animation.type}/${phase.name}`);
  }
  assertPhaseFrames({ animation, frameProofs, phaseTransitions });
  if (animation.index > 0) {
    assert.ok(entryChange?.pixels?.changedPixels >= 64, `${animation.type}: entry pixels equal the previous animation`);
    assert.ok(entryChange.pixels.changedRatio >= 0.000_1, `${animation.type}: entry delta is negligible`);
  }
  return Object.freeze({
    id: animation.id,
    type: animation.type,
    easing: animation.easing,
    sweep: animation.sweep,
    typeSceneRevision: typeScene.sceneRevision,
    easingSceneRevision: easingScene.sceneRevision,
    finalSceneRevision: easingScene.sceneRevision,
    phaseSamples: Object.freeze(Object.fromEntries(
      ANIMATION_PHASES.map(phase => [phase.name, samplesByPhase[phase.name].length]),
    )),
    sourceDeltas: Object.freeze(Object.fromEntries(
      ANIMATION_PHASES.map(phase => [phase.name, frameProofs[phase.name].subtitlePixels.changedPixels]),
    )),
    visualSummary,
    entryChangedPixels: entryChange?.pixels?.changedPixels ?? null,
    easingFingerprint: ANIMATION_PHASES
      .filter(phase => phase.name !== 'steady')
      .map(phase => geometryFingerprint(frameProofs[phase.name])).join('|'),
    easingSpatialFingerprint: ANIMATION_PHASES
      .filter(phase => phase.name !== 'steady')
      .map(phase => spatialFingerprint(frameProofs[phase.name])).join('|'),
  });
};

export const verifyAnimationCoverage = observations => {
  assert.ok(Array.isArray(observations), 'animation observations must be an array');
  assert.deepEqual(observations.map(item => item.id), ANIMATION_CASES.map(item => item.id), (
    'the bounded animation/easing sweep is incomplete'
  ));
  assert.deepEqual(
    [...new Set(observations.map(item => item.easing))].sort(),
    [...new Set(ANIMATION_CASES.map(item => item.easing))].sort(),
    'the seven easing functions are not covered',
  );
  for (let index = 1; index < observations.length; index += 1) {
    assert.ok(observations[index].finalSceneRevision > observations[index - 1].finalSceneRevision, (
      `animation scene revision did not increase at ${observations[index].type}`
    ));
  }
  const anchors = observations.filter(item => item.sweep === 'easing-anchor');
  assert.equal(anchors.length, ANIMATION_EASING_VALUES.length, 'the fixed-type easing sweep is incomplete');
  assert.equal(new Set(anchors.map(item => item.type)).size, 1, 'easing sweep changed animation type');
  assert.equal(new Set(anchors.map(item => item.easingFingerprint)).size, anchors.length, (
    'one or more easings produced constant/indistinguishable anchor geometry'
  ));
  assert.equal(new Set(anchors.map(item => item.easingSpatialFingerprint)).size, anchors.length, (
    'one or more easings ignored the anchor transform position'
  ));
  return Object.freeze({
    cases: observations.length,
    types: new Set(observations.map(item => item.type)).size,
    easings: new Set(observations.map(item => item.easing)).size,
  });
};
