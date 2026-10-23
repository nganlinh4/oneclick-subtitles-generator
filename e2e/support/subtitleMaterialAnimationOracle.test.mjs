import { strict as assert } from 'node:assert';
import test from 'node:test';

import { easeSubtitle } from '../../src/components/previews/canvas/canvasSubtitleMath.js';

import {
  ANIMATION_CASES,
  ANIMATION_CUE,
  ANIMATION_EASING_VALUES,
  ANIMATION_PHASES,
  activeAnimationCueAt,
  expectedAnimationCueAt,
  verifyAnimationCoverage,
  verifyAnimationObservation,
} from './subtitleMaterialAnimationOracle.js';
import {
  animationObservationInput,
  clone,
} from './subtitleMaterialAnimationTestFixtures.js';

test('reviewed entry and exit samples are inside activeCueAtFrom fade windows', () => {
  const expectedEntry = expectedAnimationCueAt(ANIMATION_PHASES[0].seconds);
  assert.equal(expectedEntry.phase, 'fadingIn');
  assert.ok(Math.abs(expectedEntry.progress - 0.4) < 1e-9);
  const entry = activeAnimationCueAt(ANIMATION_PHASES[0].seconds);
  assert.equal(entry.phase, expectedEntry.phase);
  assert.ok(Math.abs(entry.progress - expectedEntry.progress) < 1e-9);
  const expectedSteady = expectedAnimationCueAt(ANIMATION_PHASES[1].seconds);
  const steady = activeAnimationCueAt(ANIMATION_PHASES[1].seconds);
  assert.deepEqual({ phase: steady.phase, progress: steady.progress }, expectedSteady);
  const expectedExit = expectedAnimationCueAt(ANIMATION_PHASES[2].seconds);
  assert.equal(expectedExit.phase, 'fadingOut');
  assert.ok(Math.abs(expectedExit.progress - 0.6) < 1e-9);
  const exit = activeAnimationCueAt(ANIMATION_PHASES[2].seconds);
  assert.equal(exit.phase, expectedExit.phase);
  assert.ok(Math.abs(exit.progress - expectedExit.progress) < 1e-9);
  assert.equal(expectedAnimationCueAt(ANIMATION_CUE.start - ANIMATION_CUE.fadeIn - 0.001), null);
  assert.equal(expectedAnimationCueAt(ANIMATION_CUE.end + ANIMATION_CUE.fadeOut + 0.001), null);
  assert.equal(activeAnimationCueAt(ANIMATION_CUE.start - ANIMATION_CUE.fadeIn - 0.001), null);
  assert.equal(activeAnimationCueAt(ANIMATION_CUE.end + ANIMATION_CUE.fadeOut + 0.001), null);
  assert.equal(activeAnimationCueAt(ANIMATION_CUE.start).phase, 'holding');
  assert.equal(activeAnimationCueAt(ANIMATION_CUE.end).phase, 'holding');
});

test('the bounded sweep anchors all seven easings and covers the other nine types once', () => {
  assert.equal(ANIMATION_CASES.length, 16);
  const anchors = ANIMATION_CASES.filter(item => item.sweep === 'easing-anchor');
  assert.equal(anchors.length, 7);
  assert.equal(new Set(anchors.map(item => item.type)).size, 1);
  assert.deepEqual(anchors.map(item => item.easing), ANIMATION_EASING_VALUES);
  assert.equal(new Set(ANIMATION_CASES.map(item => item.type)).size, 10);
  assert.equal(ANIMATION_CASES.filter(item => item.captureEvidence).length, 3);

  const observations = ANIMATION_CASES.map((animation, index) => ({
    id: animation.id,
    type: animation.type,
    easing: animation.easing,
    sweep: animation.sweep,
    finalSceneRevision: index + 20,
    easingFingerprint: `${animation.easing}-${index}`,
    easingSpatialFingerprint: `spatial-${animation.easing}-${index}`,
  }));
  assert.deepEqual(verifyAnimationCoverage(observations), { cases: 16, types: 10, easings: 7 });
  const ignoredEasing = clone(observations);
  for (const observation of ignoredEasing.filter(item => item.sweep === 'easing-anchor')) {
    observation.easingSpatialFingerprint = 'constant-position';
  }
  assert.throws(() => verifyAnimationCoverage(ignoredEasing), /ignored the anchor transform position/u);
});

test('animation proof rejects holding-window samples, frame reuse, transient refusals and stalls', () => {
  const verified = verifyAnimationObservation(animationObservationInput());
  assert.equal(verified.type, 'slide-up');
  assert.deepEqual(Object.keys(verified.phaseSamples), ['entry', 'steady', 'exit']);

  const wrongBoundary = animationObservationInput();
  wrongBoundary.samplesByPhase.entry[4].mediaTime = ANIMATION_CUE.start + 0.1;
  assert.throws(
    () => verifyAnimationObservation(wrongBoundary),
    /escaped its cue window|authored cue maths/u,
  );
  const reused = animationObservationInput();
  reused.frameProofs.exit.composed.frame.sha256 = reused.frameProofs.entry.composed.frame.sha256;
  assert.throws(() => verifyAnimationObservation(reused), /reused a frame/u);
  const contaminatedControl = animationObservationInput();
  contaminatedControl.frameProofs.entry.subtitleGeometry.bounds = {
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    areaPixels: 307_200,
  };
  assert.throws(
    () => verifyAnimationObservation(contaminatedControl),
    /contaminated across the full composition/u,
  );
  const constantGeometry = animationObservationInput();
  for (const phase of ['steady', 'exit']) {
    constantGeometry.frameProofs[phase].subtitleGeometry = clone(
      constantGeometry.frameProofs.entry.subtitleGeometry,
    );
    constantGeometry.frameProofs[phase].subtitlePixels.changedPixels = (
      constantGeometry.frameProofs.entry.subtitlePixels.changedPixels
    );
  }
  assert.throws(
    () => verifyAnimationObservation(constantGeometry),
    /constant subtitle geometry|slide-up entry did not start below/u,
  );
  const transientRefusal = animationObservationInput();
  transientRefusal.continuitySamples[160].recordedRefusals = ['refused:fontUnavailable'];
  assert.throws(() => verifyAnimationObservation(transientRefusal), /transient refusal/u);
  const betweenFrames = animationObservationInput();
  betweenFrames.transientTransitions.push({
    attribute: 'data-osg-cue-index', previous: '', current: '0', atMs: 100, mediaTime: 3,
  });
  assert.throws(() => verifyAnimationObservation(betweenFrames), /blinked between animation-frame samples/u);
  const oneFrameBlank = animationObservationInput();
  oneFrameBlank.continuitySamples[160].visual = {
    ...oneFrameBlank.continuitySamples[160].visual,
    hasVideo: false,
    hasOverlay: false,
    hasGlyphInk: false,
    visible: false,
    blank: true,
    black: true,
  };
  assert.throws(() => verifyAnimationObservation(oneFrameBlank), /blank frame reached the visible canvas/u);
  const stalled = animationObservationInput();
  stalled.continuitySamples = stalled.continuitySamples.map((sample, index) => ({
    ...sample,
    mediaTime: stalled.continuitySamples[0].mediaTime,
    revision: 200 + index,
  }));
  assert.throws(() => verifyAnimationObservation(stalled), /missed fade exit|playback skipped/u);
  const halfSecondCompositorFreeze = animationObservationInput();
  const frozenRevision = halfSecondCompositorFreeze.continuitySamples[119].revision;
  for (let index = 120; index <= 130; index += 1) {
    halfSecondCompositorFreeze.continuitySamples[index].revision = frozenRevision;
  }
  assert.throws(
    () => verifyAnimationObservation(halfSecondCompositorFreeze),
    /compositor plateaued/u,
  );
  const hiddenPublicationFreeze = animationObservationInput();
  const frozenPublication = hiddenPublicationFreeze.continuitySamples[119].visual.publication;
  for (let index = 120; index <= 130; index += 1) {
    hiddenPublicationFreeze.continuitySamples[index].visual.publication = frozenPublication;
  }
  assert.throws(
    () => verifyAnimationObservation(hiddenPublicationFreeze),
    /visible canvas publication plateaued/u,
  );

  const scale = ANIMATION_CASES.find(item => item.type === 'scale');
  const ignoredScale = animationObservationInput(scale);
  for (const proof of Object.values(ignoredScale.frameProofs)) proof.subtitleGeometry.bounds.areaPixels = 5_000;
  assert.throws(() => verifyAnimationObservation(ignoredScale), /scale entry did not occupy a smaller area/u);
});

test('the overshoot easing admits only its mathematically zero-opacity source frames', () => {
  const overshoot = ANIMATION_CASES.find(item => item.easing === 'cubic-bezier(0.68, -0.55, 0.265, 1.55)');
  // At exit-sample progress the overshoot easing has already driven the slide offset to ≈0, so a
  // truthful exit frame sits AT the holding position; the generic fixture's displaced exit would
  // now (correctly) be rejected as a stray.
  const settleOvershootExit = (fixture) => {
    fixture.frameProofs.exit.subtitleGeometry.centroidYRatio = (
      fixture.frameProofs.steady.subtitleGeometry.centroidYRatio + 0.005
    );
    return fixture;
  };
  const strayedExit = animationObservationInput(overshoot);
  assert.throws(
    () => verifyAnimationObservation(strayedExit),
    /strayed from holding at a near-zero eased offset/u,
  );
  const input = settleOvershootExit(animationObservationInput(overshoot));
  let expectedInvisible = 0;
  for (const sample of input.continuitySamples) {
    const active = activeAnimationCueAt(sample.mediaTime);
    if (active === null || easeSubtitle(active.progress, overshoot.easing) > 0) continue;
    expectedInvisible += 1;
    sample.visual = {
      ...sample.visual,
      hasOverlay: false,
      hasGlyphInk: false,
      sourceOnly: true,
    };
  }
  assert.ok(expectedInvisible > 0, 'the hostile fixture never reached the negative overshoot');
  const verified = verifyAnimationObservation(input);
  assert.equal(verified.visualSummary.intentionalZeroOpacitySamples, expectedInvisible);

  const missingInkAfterOpacityBecamePositive = settleOvershootExit(animationObservationInput(overshoot));
  for (const sample of missingInkAfterOpacityBecamePositive.continuitySamples) {
    const active = activeAnimationCueAt(sample.mediaTime);
    if (active === null || easeSubtitle(active.progress, overshoot.easing) > 0) continue;
    sample.visual = {
      ...sample.visual,
      hasOverlay: false,
      hasGlyphInk: false,
      sourceOnly: true,
    };
  }
  const visible = missingInkAfterOpacityBecamePositive.continuitySamples.find((sample) => {
    const active = activeAnimationCueAt(sample.mediaTime);
    return active !== null && easeSubtitle(active.progress, overshoot.easing) > 0;
  });
  visible.visual = {
    ...visible.visual,
    hasOverlay: false,
    hasGlyphInk: false,
    sourceOnly: true,
  };
  assert.throws(
    () => verifyAnimationObservation(missingInkAfterOpacityBecamePositive),
    /source-only frame reached/u,
  );

  const crossedBetweenPublicationAndWitness = settleOvershootExit(animationObservationInput(overshoot));
  for (const sample of crossedBetweenPublicationAndWitness.continuitySamples) {
    const active = activeAnimationCueAt(sample.visual.sourceTime);
    if (active === null || easeSubtitle(active.progress, overshoot.easing) > 0) continue;
    sample.visual = {
      ...sample.visual,
      hasOverlay: false,
      hasGlyphInk: false,
      sourceOnly: true,
    };
  }
  const crossing = crossedBetweenPublicationAndWitness.continuitySamples.find((sample) => {
    const before = activeAnimationCueAt(sample.mediaTime - 0.02);
    const after = activeAnimationCueAt(sample.mediaTime);
    return before !== null && after !== null
      && easeSubtitle(before.progress, overshoot.easing) <= 0
      && easeSubtitle(after.progress, overshoot.easing) > 0;
  });
  assert.ok(crossing, 'the hostile fixture has no publication/witness zero crossing');
  crossing.visual = {
    ...crossing.visual,
    sourceTime: crossing.mediaTime - 0.02,
    hasOverlay: false,
    hasGlyphInk: false,
    sourceOnly: true,
  };
  assert.doesNotThrow(() => verifyAnimationObservation(crossedBetweenPublicationAndWitness));

  const missingInkAtPublishedPositiveOpacity = settleOvershootExit(animationObservationInput(overshoot));
  for (const sample of missingInkAtPublishedPositiveOpacity.continuitySamples) {
    const active = activeAnimationCueAt(sample.visual.sourceTime);
    if (active === null || easeSubtitle(active.progress, overshoot.easing) > 0) continue;
    sample.visual = {
      ...sample.visual,
      hasOverlay: false,
      hasGlyphInk: false,
      sourceOnly: true,
    };
  }
  const inverse = missingInkAtPublishedPositiveOpacity.continuitySamples.find((sample) => {
    const before = activeAnimationCueAt(sample.mediaTime - 0.02);
    const after = activeAnimationCueAt(sample.mediaTime);
    return before !== null && after !== null
      && easeSubtitle(before.progress, overshoot.easing) <= 0
      && easeSubtitle(after.progress, overshoot.easing) > 0;
  });
  inverse.mediaTime -= 0.02;
  inverse.visual = {
    ...inverse.visual,
    sourceTime: inverse.mediaTime + 0.02,
    hasOverlay: false,
    hasGlyphInk: false,
    sourceOnly: true,
  };
  assert.throws(
    () => verifyAnimationObservation(missingInkAtPublishedPositiveOpacity),
    /source-only frame reached/u,
  );
});

test('media waiting is accepted only when playing recovers inside the compositor plateau bound', () => {
  const recovered = animationObservationInput();
  recovered.mediaEvents = [
    { type: 'waiting', atMs: 2_000, mediaTime: 2.45 },
    { type: 'playing', atMs: 2_280, mediaTime: 2.47 },
  ];
  const result = verifyAnimationObservation(recovered);
  assert.deepEqual(result.visualSummary.waitingRecoveries, [{
    waitingAtMs: 2_000,
    playingAtMs: 2_280,
    recoveryMs: 280,
  }]);

  const neverRecovered = animationObservationInput();
  neverRecovered.mediaEvents = [{ type: 'waiting', atMs: 2_000, mediaTime: 2.45 }];
  assert.throws(
    () => verifyAnimationObservation(neverRecovered),
    /waiting event never recovered to playing/u,
  );

  const recoveredTooLate = animationObservationInput();
  recoveredTooLate.mediaEvents = [
    { type: 'waiting', atMs: 2_000, mediaTime: 2.45 },
    { type: 'playing', atMs: 2_500, mediaTime: 2.47 },
  ];
  assert.throws(
    () => verifyAnimationObservation(recoveredTooLate),
    /waiting recovery took 500ms/u,
  );

  for (const type of ['abort', 'emptied', 'error']) {
    const fatal = animationObservationInput();
    fatal.mediaEvents = [{ type, atMs: 2_000, mediaTime: 2.45 }];
    assert.throws(
      () => verifyAnimationObservation(fatal),
      new RegExp(`fatal ${type} event`, 'u'),
    );
  }
});

test('animation durability rejects erasure of an earlier customization field', () => {
  const input = animationObservationInput();
  delete input.easingScene.scene.customization.field30;
  assert.throws(() => verifyAnimationObservation(input), /field set changed/u);
});
