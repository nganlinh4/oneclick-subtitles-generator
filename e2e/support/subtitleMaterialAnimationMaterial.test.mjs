import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  measureRgbaDominantDifferenceComponent,
  measureRgbaDifferenceGeometry,
  measureRgbaPixelSignal,
} from './nativeMediaOracle.js';
import {
  MATERIAL_GROUPS,
  materialControlTokens,
  verifyLiveFontPresetTransition,
  verifyMaterialAction,
  verifyMaterialCoverage,
  verifySubtitleContainment,
} from './subtitleMaterialAnimationOracle.js';
import {
  PROJECT_ID,
  changedFrame,
  clone,
  completeCustomization,
  drawableState,
  liveFontPresetInput,
  materialObservations,
} from './subtitleMaterialAnimationTestFixtures.js';

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
