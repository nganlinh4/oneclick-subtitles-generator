// Material-control oracle: durable customization authority, drawable state and containment.

import { strict as assert } from 'node:assert';

import {
  CUSTOMIZATION_FIELD_COUNT,
  MATERIAL_GROUPS,
  materialControlTokens,
} from './subtitleMaterialAnimationCases.js';

const assertDrawableState = (state, context, paused) => {
  assert.ok(state?.canvas?.revision > 0, `${context}: compositor published no revision`);
  assert.ok(state.canvas.overlayRebuilds > 0, `${context}: subtitle overlay was never built`);
  assert.equal(state.canvas.cue, '0', `${context}: the authored cue is absent`);
  assert.ok(state.canvas.width > 0 && state.canvas.height > 0, `${context}: canvas has no pixels`);
  assert.equal(state.preview?.status, 'ready', `${context}: preview is not ready`);
  assert.equal(state.preview?.code, null, `${context}: preview refused with ${state.preview?.code}`);
  assert.ok(state.video?.readyState >= 2 && state.video.error === null, `${context}: video is unreadable`);
  if (typeof paused === 'boolean') assert.equal(state.video.paused, paused, `${context}: wrong playback state`);
  assert.deepEqual(state.currentErrors, [], `${context}: a visible error remains`);
  assert.deepEqual(state.recordedErrors, [], `${context}: a transient error was recorded`);
  assert.deepEqual(state.recordedRefusals, [], `${context}: a transient preview refusal was recorded`);
};

export const assertCompleteCustomization = (actual, expected, context) => {
  assert.ok(actual !== null && typeof actual === 'object' && !Array.isArray(actual), (
    `${context}: durable customization is absent`
  ));
  assert.equal(Object.keys(expected).length, CUSTOMIZATION_FIELD_COUNT, (
    `${context}: expected customization does not cover all ${CUSTOMIZATION_FIELD_COUNT} fields`
  ));
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), (
    `${context}: durable customization field set changed`
  ));
  assert.deepEqual(actual, expected, `${context}: cumulative durable customization diverged`);
};

export const assertSceneAuthority = (scene, expectedProjectId, context) => {
  assert.equal(typeof expectedProjectId, 'string', `${context}: expected project identity is absent`);
  assert.ok(expectedProjectId.length > 0, `${context}: expected project identity is blank`);
  assert.equal(scene?.projectId, expectedProjectId, `${context}: durable scene belongs to another project`);
  assert.equal(scene?.schemaVersion, 1, `${context}: durable scene schema is not v1`);
};

export const verifyMaterialAction = ({
  spec,
  observedValue,
  beforeRevision,
  expectedCustomization,
  expectedProjectId,
  durableScene,
  frameChange,
  state,
}) => {
  assert.ok(materialControlTokens().includes(spec?.token), 'material action is outside the frozen matrix');
  assert.ok(Number.isSafeInteger(beforeRevision) && beforeRevision >= 0, `${spec.token}: bad prior revision`);
  assert.ok(durableScene?.sceneRevision > beforeRevision, `${spec.token}: durable scene did not advance`);
  assertSceneAuthority(durableScene, expectedProjectId, spec.token);
  assertCompleteCustomization(
    durableScene.scene?.customization,
    expectedCustomization,
    spec.token,
  );
  const durableValue = durableScene.scene.customization[spec.field];
  assert.deepEqual(durableValue, observedValue, `${spec.token}: public control and SQLite disagree`);
  if (spec.kind !== 'range') assert.deepEqual(observedValue, spec.value, `${spec.token}: wrong public value`);
  else {
    assert.ok(typeof observedValue === 'number' && Number.isFinite(observedValue), `${spec.token}: range is not numeric`);
    assert.ok(observedValue >= spec.minimum && observedValue <= spec.maximum, `${spec.token}: range escaped bounds`);
  }
  assert.equal(expectedCustomization[spec.field], observedValue, `${spec.token}: intended delta is wrong`);
  assert.equal(expectedCustomization.preset, 'custom', `${spec.token}: intended scene kept a preset identity`);
  assertDrawableState(state, spec.token, true);
  assert.ok(frameChange?.pixels?.changedPixels >= 32, `${spec.token}: changed too few pixels`);
  assert.ok(frameChange.pixels.changedRatio >= 0.000_05, `${spec.token}: pixel change is not meaningful`);
  assert.ok(frameChange.ssim < 0.999_99, `${spec.token}: rendered frame did not materially change`);
  return Object.freeze({
    token: spec.token,
    field: spec.field,
    selector: spec.selector,
    value: observedValue,
    sceneRevision: durableScene.sceneRevision,
    canvasRevision: state.canvas.revision,
    overlayRebuilds: state.canvas.overlayRebuilds,
    ssim: frameChange.ssim,
    changedPixels: frameChange.pixels.changedPixels,
    changedRatio: frameChange.pixels.changedRatio,
    customizationFields: Object.keys(expectedCustomization).length,
  });
};

export const verifyMaterialCoverage = (
  observations,
  { expectedCustomization, durableCustomization } = {},
) => {
  assert.ok(Array.isArray(observations), 'material observations must be an array');
  const expected = materialControlTokens();
  assert.deepEqual(observations.map(item => item.token), expected, 'material controls were skipped or reordered');
  for (let index = 1; index < observations.length; index += 1) {
    assert.ok(observations[index].sceneRevision > observations[index - 1].sceneRevision, (
      `material scene revision did not increase at ${observations[index].token}`
    ));
  }
  assertCompleteCustomization(
    durableCustomization,
    expectedCustomization,
    'final material scene',
  );
  return Object.freeze({ actions: observations.length, groups: MATERIAL_GROUPS.length });
};

/**
 * Prove the high-contrast subtitle material remains inside the visible composition.
 *
 * The source/composed screenshots can differ by low-energy WebView colour conversion and by a
 * disconnected narrow crop fringe at a fractional CSS edge. The fixture's high-contrast double
 * border is one continuous component, so the journey supplies the dominant thresholded component;
 * this oracle refuses that actual material box when it touches any frame edge.
 */
export const verifySubtitleContainment = (geometry, { minimumInsetPixels = 1 } = {}) => {
  assert.ok(geometry !== null && typeof geometry === 'object', 'subtitle containment geometry is absent');
  assert.ok(Number.isSafeInteger(geometry.width) && geometry.width > 0, 'subtitle containment width is invalid');
  assert.ok(Number.isSafeInteger(geometry.height) && geometry.height > 0, 'subtitle containment height is invalid');
  assert.ok(Number.isSafeInteger(minimumInsetPixels) && minimumInsetPixels >= 1, (
    'subtitle containment inset must be a positive integer'
  ));
  assert.ok(Number.isSafeInteger(geometry.changedPixels) && geometry.changedPixels > 0, (
    'subtitle containment has no changed pixels'
  ));
  assert.ok(Number.isSafeInteger(geometry.componentCount) && geometry.componentCount >= 1, (
    'subtitle containment has no measured components'
  ));
  const dominant = geometry.dominant;
  assert.ok(dominant !== null && typeof dominant === 'object', (
    'subtitle containment has no dominant material component'
  ));
  assert.ok(Number.isSafeInteger(dominant.changedPixels) && dominant.changedPixels >= 64, (
    'subtitle containment dominant material component is too small'
  ));
  assert.ok(geometry.changedPixels >= dominant.changedPixels, (
    'subtitle containment dominant material exceeds the complete difference mask'
  ));
  assert.ok(Number.isSafeInteger(geometry.outsideDominantHaloChangedPixels)
    && geometry.outsideDominantHaloChangedPixels >= 0, (
    'subtitle containment did not measure differences outside the material halo'
  ));
  assert.ok(Number.isSafeInteger(geometry.outsideDominantHaloInteriorChangedPixels)
    && geometry.outsideDominantHaloInteriorChangedPixels >= 0
    && geometry.outsideDominantHaloInteriorChangedPixels
      <= geometry.outsideDominantHaloChangedPixels, (
    'subtitle containment has invalid interior contamination measurements'
  ));
  assert.equal(geometry.outsideDominantHaloInteriorChangedPixels, 0, (
    'subtitle containment source and candidate differ outside the material and frame-edge fringe'
  ));
  const bounds = dominant.bounds;
  assert.ok(bounds !== null && typeof bounds === 'object', 'subtitle containment has no dominant bounds');
  for (const field of ['x', 'y', 'width', 'height']) {
    assert.ok(Number.isSafeInteger(bounds[field]), `subtitle containment ${field} is invalid`);
  }
  assert.ok(bounds.width > 0 && bounds.height > 0, 'subtitle containment bounds are empty');
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  assert.ok(bounds.x >= minimumInsetPixels, 'subtitle material is clipped at the left composition edge');
  assert.ok(bounds.y >= minimumInsetPixels, 'subtitle material is clipped at the top composition edge');
  assert.ok(right <= geometry.width - minimumInsetPixels, (
    'subtitle material is clipped at the right composition edge'
  ));
  assert.ok(bottom <= geometry.height - minimumInsetPixels, (
    'subtitle material is clipped at the bottom composition edge'
  ));
  return Object.freeze({
    minimumInsetPixels,
    componentCount: geometry.componentCount,
    dominantChangedPixels: dominant.changedPixels,
    otherComponentChangedPixels: geometry.changedPixels - dominant.changedPixels,
    frameEdgeFringePixels: geometry.frameEdgeFringePixels,
    dominantHaloPixels: geometry.dominantHaloPixels,
    outsideDominantHaloChangedPixels: geometry.outsideDominantHaloChangedPixels,
    left: bounds.x,
    top: bounds.y,
    right: geometry.width - right,
    bottom: geometry.height - bottom,
  });
};
