import { strict as assert } from 'node:assert';
import test from 'node:test';

import { easeSubtitle } from '../../src/components/previews/canvas/canvasSubtitleMath.js';

import {
  measureRgbaDominantDifferenceComponent,
  measureRgbaDifferenceGeometry,
  measureRgbaPixelSignal,
} from './nativeMediaOracle.js';
import {
  ANIMATION_CASES,
  ANIMATION_CUE,
  ANIMATION_EASING_VALUES,
  ANIMATION_PHASES,
  MATERIAL_GROUPS,
  activeAnimationCueAt,
  expectedAnimationCueAt,
  materialControlTokens,
  verifyAnimationCoverage,
  verifyAnimationObservation,
  verifyLiveFontPresetTransition,
  verifyMaterialAction,
  verifyMaterialCoverage,
  verifySubtitleContainment,
} from './subtitleMaterialAnimationOracle.js';

const clone = value => JSON.parse(JSON.stringify(value));
const PROJECT_ID = 'project-a';

const completeCustomization = (overrides = {}) => ({
  preset: 'custom',
  fontSize: 53,
  animationType: 'slide-up',
  animationEasing: 'linear',
  ...Object.fromEntries(Array.from({ length: 52 }, (_, index) => [`field${index}`, index])),
  ...overrides,
});

const drawableState = () => ({
  canvas: { revision: 12, overlayRebuilds: 4, cue: '0', width: 640, height: 480 },
  preview: { status: 'ready', code: null },
  video: { paused: true, readyState: 4, error: null },
  currentErrors: [],
  recordedErrors: [],
  recordedRefusals: [],
});

const changedFrame = () => ({
  ssim: 0.98,
  pixels: { changedPixels: 512, changedRatio: 0.01, maximumChannelDelta: 200 },
});

const materialObservations = () => materialControlTokens().map((token, index) => ({
  token,
  sceneRevision: index + 2,
}));

const geometry = index => ({
  width: 640,
  height: 480,
  changedPixels: 2_048 + (index * 97),
  centroidXRatio: 0.45 + (index * 0.01),
  centroidYRatio: 0.4 - (index * 0.1),
  bounds: {
    x: 100 + (index * 7),
    y: 80 - (index * 9),
    width: 180 + index,
    height: 70 + index,
    areaPixels: 4_096 + (index * 211),
  },
  meanChangedChannelDelta: 50 + (index * 11),
});

const frameProof = (phase, index) => ({
  mediaTime: phase.seconds,
  composed: { frame: { sha256: `composed-${index}` } },
  composedSignal: {
    totalPixels: 307_200, opaqueRatio: 1, nearBlackRatio: 0.2, meanLuma: 90,
  },
  sourceSignal: {
    totalPixels: 307_200, opaqueRatio: 1, nearBlackRatio: 0.25, meanLuma: 82,
  },
  subtitlePixels: {
    changedPixels: 2_048 + (index * 97),
    changedRatio: (2_048 + (index * 97)) / 307_200,
    maximumChannelDelta: 220,
  },
  subtitleGeometry: geometry(index),
});

const phaseSamples = phase => Array.from({ length: 10 }, (_, index) => ({
  atMs: index * 50,
  mediaTime: (phase.minimum + 0.02)
    + (index * ((phase.maximum - phase.minimum - 0.04) / 9)),
  revision: 100 + index,
  overlayRebuilds: 8,
  cue: '0',
  preview: 'ready',
  previewCode: null,
  paused: false,
  ended: false,
  readyState: 4,
  error: null,
  visibleErrors: [],
  recordedRefusals: [],
}));

const continuitySamples = () => Array.from({ length: 360 }, (_, index) => {
  const mediaTime = ANIMATION_CUE.witnessStart
    + (index * ((ANIMATION_CUE.witnessEnd - ANIMATION_CUE.witnessStart) / 359));
  return {
    atMs: index * 50,
    mediaTime,
    revision: 200 + index,
    overlayRebuilds: 8,
    cue: '0',
    preview: 'ready',
    previewCode: null,
    paused: false,
    ended: false,
    readyState: 4,
    error: null,
    visibleErrors: [],
    recordedRefusals: [],
    visual: {
      mode: 'tainted-operation-trace',
      classified: true,
      publication: index + 1,
      method: 'drawImage',
      hasVideo: true,
      hasOverlay: true,
      hasGlyphInk: true,
      visible: true,
      blank: false,
      transparent: false,
      black: false,
      sourceOnly: false,
      sourceTime: mediaTime,
      pixelHash: null,
    },
  };
});

const animationObservationInput = (animation = ANIMATION_CASES[0]) => {
  const expectedTypeCustomization = completeCustomization({
    animationType: animation.type,
    animationEasing: animation.editEasing ? 'prior-easing' : animation.easing,
  });
  const expectedFinalCustomization = completeCustomization({
    animationType: animation.type,
    animationEasing: animation.easing,
  });
  return {
    animation,
    beforeRevision: 10,
    expectedProjectId: PROJECT_ID,
    expectedTypeCustomization,
    expectedFinalCustomization,
    typeScene: {
      projectId: PROJECT_ID,
      sceneRevision: animation.editType ? 11 : 10,
      schemaVersion: 1,
      scene: { customization: clone(expectedTypeCustomization) },
    },
    easingScene: {
      projectId: PROJECT_ID,
      sceneRevision: animation.editEasing ? (animation.editType ? 12 : 11) : 11,
      schemaVersion: 1,
      scene: { customization: clone(expectedFinalCustomization) },
    },
    continuitySamples: continuitySamples(),
    samplesByPhase: Object.fromEntries(ANIMATION_PHASES.map(phase => [phase.name, phaseSamples(phase)])),
    frameProofs: Object.fromEntries(ANIMATION_PHASES.map((phase, index) => [
      phase.name, frameProof(phase, index),
    ])),
    phaseTransitions: {
      entryToSteady: changedFrame(), steadyToExit: changedFrame(), entryToExit: changedFrame(),
    },
    entryChange: changedFrame(),
    transientTransitions: [],
    mediaEvents: [],
  };
};

const liveFontPresetInput = () => {
  const samples = continuitySamples().slice(0, 14).map((sample, index) => ({
    ...sample,
    atMs: index * 40,
    mediaTime: 8 + (index * 0.04),
    revision: 300 + index,
    overlayRebuilds: index < 5 ? 20 : 21,
    visual: {
      ...sample.visual,
      publication: 500 + index,
      sourceTime: 8 + (index * 0.04),
    },
  }));
  return {
    samples,
    publications: samples.slice(3).map(sample => clone(sample)),
    mediaEvents: [],
    transientTransitions: [
      {
        attribute: 'data-osg-preview', previous: 'ready', current: 'pending', atMs: 95, mediaTime: 8.1,
      },
      {
        attribute: 'data-osg-preview', previous: 'pending', current: 'ready', atMs: 135, mediaTime: 8.14,
      },
    ],
    transition: {
      atMs: 80,
      mediaTime: samples[2].mediaTime,
      revision: samples[2].revision,
      overlayRebuilds: samples[2].overlayRebuilds,
      visual: clone(samples[2].visual),
    },
    beforePreset: 'default',
    afterPreset: 'gaming',
    beforeFontFamily: "'Google Sans', sans-serif",
    afterFontFamily: "'Impact', sans-serif",
  };
};

test('the material matrix is unique and covers every public material vocabulary', () => {
  assert.equal(MATERIAL_GROUPS.length, 7);
  const tokens = materialControlTokens();
  assert.equal(new Set(tokens).size, tokens.length);
  assert.ok(tokens.length >= 50);
  for (const value of ['none', 'solid', 'dashed', 'dotted', 'double']) {
    assert.ok(tokens.includes(`border-${value}`));
  }
  for (const value of ['0deg', '90deg', '45deg', '135deg', '180deg', '270deg']) {
    assert.ok(tokens.includes(`gradient-${value}`));
  }
  for (const value of ['top', 'center', 'bottom', 'custom']) {
    assert.ok(tokens.includes(`position-${value}`));
  }
  for (const value of ['left', 'right', 'justify', 'center']) {
    assert.ok(tokens.includes(`align-${value}`));
  }
});

test('one material action needs a complete cumulative 56-field scene and measured pixel delta', () => {
  const spec = MATERIAL_GROUPS[0].actions[0];
  const expectedCustomization = completeCustomization({ [spec.field]: 53 });
  const input = {
    spec,
    observedValue: 53,
    beforeRevision: 4,
    expectedCustomization,
    expectedProjectId: PROJECT_ID,
    durableScene: {
      projectId: PROJECT_ID,
      sceneRevision: 5,
      schemaVersion: 1,
      scene: { customization: clone(expectedCustomization) },
    },
    frameChange: changedFrame(),
    state: drawableState(),
  };
  assert.equal(verifyMaterialAction(input).value, 53);

  const erasedPriorField = clone(input);
  delete erasedPriorField.durableScene.scene.customization.field17;
  assert.throws(() => verifyMaterialAction(erasedPriorField), /field set changed/u);
  const changedPriorField = clone(input);
  changedPriorField.durableScene.scene.customization.field17 = 'lost';
  assert.throws(() => verifyMaterialAction(changedPriorField), /cumulative durable customization diverged/u);
  assert.throws(() => verifyMaterialAction({
    ...input,
    frameChange: { ssim: 1, pixels: { changedPixels: 0, changedRatio: 0 } },
  }), /changed too few pixels/u);
  const wrongProject = clone(input);
  wrongProject.durableScene.projectId = 'project-b';
  assert.throws(() => verifyMaterialAction(wrongProject), /belongs to another project/u);
  const wrongSchema = clone(input);
  wrongSchema.durableScene.schemaVersion = 2;
  assert.throws(() => verifyMaterialAction(wrongSchema), /schema is not v1/u);
});

test('live font/preset transition retains complete old pixels and publishes only complete new frames', () => {
  const valid = liveFontPresetInput();
  const result = verifyLiveFontPresetTransition(valid);
  assert.equal(result.beforePreset, 'default');
  assert.equal(result.afterPreset, 'gaming');
  assert.ok(result.pendingSamples >= 1);
  assert.ok(result.publishedFrames >= 2);
  assert.equal(result.pendingStatusCycles, 1);

  const blankDuringPending = liveFontPresetInput();
  blankDuringPending.samples[3].visual = {
    ...blankDuringPending.samples[3].visual,
    hasVideo: false,
    hasOverlay: false,
    hasGlyphInk: false,
    visible: false,
    blank: true,
    black: true,
  };
  assert.throws(
    () => verifyLiveFontPresetTransition(blankDuringPending),
    /prior pixels during pending: blank frame reached/u,
  );

  const sourceOnlyPublication = liveFontPresetInput();
  sourceOnlyPublication.publications[4].visual = {
    ...sourceOnlyPublication.publications[4].visual,
    hasOverlay: false,
    hasGlyphInk: false,
    sourceOnly: true,
  };
  assert.throws(
    () => verifyLiveFontPresetTransition(sourceOnlyPublication),
    /newly published frame: source-only frame reached/u,
  );

  const sameFont = liveFontPresetInput();
  sameFont.afterFontFamily = sameFont.beforeFontFamily;
  assert.throws(
    () => verifyLiveFontPresetTransition(sameFont),
    /did not exercise a font change/u,
  );

  const unrecoveredPending = liveFontPresetInput();
  unrecoveredPending.transientTransitions.pop();
  assert.throws(
    () => verifyLiveFontPresetTransition(unrecoveredPending),
    /pending state never recovered/u,
  );

  const refusalCode = liveFontPresetInput();
  refusalCode.transientTransitions.push({
    attribute: 'data-osg-preview-code', previous: '', current: 'fontUnavailable', atMs: 140,
  });
  assert.throws(
    () => verifyLiveFontPresetTransition(refusalCode),
    /cue or refusal code changed/u,
  );
});

test('material coverage refuses a skipped action and a divergent final complete scene', () => {
  const observations = materialObservations();
  const expectedCustomization = completeCustomization();
  assert.equal(verifyMaterialCoverage(observations, {
    expectedCustomization,
    durableCustomization: clone(expectedCustomization),
  }).groups, 7);
  assert.throws(() => verifyMaterialCoverage(observations.slice(1), {
    expectedCustomization,
    durableCustomization: clone(expectedCustomization),
  }), /skipped or reordered/u);
  const divergent = clone(expectedCustomization);
  divergent.field2 = -1;
  assert.throws(() => verifyMaterialCoverage(observations, {
    expectedCustomization,
    durableCustomization: divergent,
  }), /cumulative durable customization diverged/u);
});

test('custom-position evidence must keep high-contrast subtitle pixels away from every edge', () => {
  const customPosition = MATERIAL_GROUPS
    .find(group => group.id === 'custom-position')
    .actions.find(action => action.token === 'position-x');
  assert.equal(customPosition.ratio, 0.4, 'the wide reviewed box must use an inside-frame centre');

  const contained = {
    width: 716,
    height: 537,
    changedPixels: 7_400,
    componentCount: 2,
    frameEdgeFringePixels: 3,
    dominantHaloPixels: 32,
    outsideDominantHaloChangedPixels: 0,
    outsideDominantHaloInteriorChangedPixels: 0,
    dominant: {
      changedPixels: 6_400,
      bounds: { x: 35, y: 80, width: 610, height: 360, areaPixels: 219_600 },
    },
  };
  assert.deepEqual(verifySubtitleContainment(contained), {
    minimumInsetPixels: 1,
    componentCount: 2,
    dominantChangedPixels: 6_400,
    otherComponentChangedPixels: 1_000,
    frameEdgeFringePixels: 3,
    dominantHaloPixels: 32,
    outsideDominantHaloChangedPixels: 0,
    left: 35,
    top: 80,
    right: 71,
    bottom: 97,
  });
  assert.throws(() => verifySubtitleContainment({
    ...contained,
    changedPixels: contained.dominant.changedPixels - 1,
  }), /exceeds the complete difference mask/u);

  for (const [edge, bounds] of [
    ['left', { x: 0, y: 40, width: 300, height: 100 }],
    ['top', { x: 40, y: 0, width: 300, height: 100 }],
    ['right', { x: 416, y: 40, width: 300, height: 100 }],
    ['bottom', { x: 40, y: 437, width: 300, height: 100 }],
  ]) {
    assert.throws(() => verifySubtitleContainment({
      width: 716,
      height: 537,
      changedPixels: 6_400,
      componentCount: 1,
      frameEdgeFringePixels: 3,
      dominantHaloPixels: 32,
      outsideDominantHaloChangedPixels: 0,
      outsideDominantHaloInteriorChangedPixels: 0,
      dominant: {
        changedPixels: 6_400,
        bounds: { ...bounds, areaPixels: bounds.width * bounds.height },
      },
    }), new RegExp(`clipped at the ${edge}`, 'u'));
  }
  assert.throws(() => verifySubtitleContainment({
    ...contained,
    outsideDominantHaloChangedPixels: 1,
    outsideDominantHaloInteriorChangedPixels: 1,
  }), /differ outside the material and frame-edge fringe/u);
});

test('dominant component excludes disconnected screenshot-edge noise but keeps real clipping red', () => {
  const width = 20;
  const height = 12;
  const source = new Uint8Array(width * height * 4);
  const candidate = Uint8Array.from(source);
  const change = (target, x, y) => {
    target[((y * width) + x) * 4] = 255;
  };
  // A minimal representative of fractional compositor capture noise: one disconnected edge strip.
  for (let y = 0; y < height; y += 1) change(candidate, 0, y);
  // Reviewed material: one larger continuous box safely inside the frame.
  for (let y = 2; y <= 9; y += 1) {
    for (let x = 4; x <= 15; x += 1) change(candidate, x, y);
  }
  const measured = measureRgbaDominantDifferenceComponent(source, candidate, {
    width,
    height,
    channelDeltaThreshold: 64,
  });
  assert.equal(measured.componentCount, 2);
  assert.equal(measured.otherComponentChangedPixels, 12);
  assert.deepEqual(measured.dominant, {
    changedPixels: 96,
    bounds: { x: 4, y: 2, width: 12, height: 8, areaPixels: 96 },
  });
  assert.deepEqual(verifySubtitleContainment(measured), {
    minimumInsetPixels: 1,
    componentCount: 2,
    dominantChangedPixels: 96,
    otherComponentChangedPixels: 12,
    frameEdgeFringePixels: 3,
    dominantHaloPixels: 0,
    outsideDominantHaloChangedPixels: 12,
    left: 4,
    top: 2,
    right: 4,
    bottom: 2,
  });

  // Move the same dominant material to the edge: the edge strip is no longer what decides the
  // result; the actual material component itself now reaches x=0 and remains a hard failure.
  const clipped = Uint8Array.from(source);
  for (let y = 2; y <= 9; y += 1) {
    for (let x = 0; x <= 11; x += 1) change(clipped, x, y);
  }
  const clippedMeasurement = measureRgbaDominantDifferenceComponent(source, clipped, {
    width,
    height,
    channelDeltaThreshold: 64,
  });
  assert.throws(() => verifySubtitleContainment(clippedMeasurement), /clipped at the left/u);
});

test('RGBA signal and spatial difference measurement reject black and locate changed pixels', () => {
  const black = new Uint8Array([0, 0, 0, 255, 3, 3, 3, 255]);
  assert.equal(measureRgbaPixelSignal(black, { width: 2, height: 1 }).nearBlackRatio, 1);
  const source = new Uint8Array(Array(16).fill(0));
  source[3] = 255; source[7] = 255; source[11] = 255; source[15] = 255;
  const target = Uint8Array.from(source);
  target[4] = 255;
  target[12 + 1] = 255;
  const difference = measureRgbaDifferenceGeometry(source, target, { width: 2, height: 2 });
  assert.equal(difference.changedPixels, 2);
  assert.deepEqual(difference.bounds, { x: 1, y: 0, width: 1, height: 2, areaPixels: 2 });
  assert.equal(difference.centroidXRatio, 0.75);
  assert.equal(difference.centroidYRatio, 0.5);
});

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
  const input = animationObservationInput(overshoot);
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

  const missingInkAfterOpacityBecamePositive = animationObservationInput(overshoot);
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

  const crossedBetweenPublicationAndWitness = animationObservationInput(overshoot);
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

  const missingInkAtPublishedPositiveOpacity = animationObservationInput(overshoot);
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
