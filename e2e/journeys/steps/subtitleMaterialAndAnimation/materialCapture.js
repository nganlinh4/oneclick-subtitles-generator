// Durable render-scene reads, native frame capture and the material/animation control actions
// with their before/after pixel proofs.

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { durableRenderScenes } from '../../../support/database.js';
import { compareFrames, savePreviewElementFrame } from '../../../support/nativeMediaOracle.js';
import {
  describeCustomizationNativeFrame,
  verifyCustomizationTransition,
} from '../../../support/subtitleCustomizationFrameOracle.js';
import {
  ANIMATION_PHASES,
  verifyMaterialAction,
} from '../../../support/subtitleMaterialAnimationOracle.js';
import { copyWorkflowArtifact } from '../../../support/workflowEvidence.js';

import {
  CANVAS,
  WORKFLOW,
  performControl,
  publicSeek,
  usePublicDropdown,
  waitForReady,
  waitUntilWithFreshDiagnostic,
} from './previewControls.js';

export const soleDurableRenderScene = (root, expectedProjectId = null, context = 'render scene') => {
  const scenes = durableRenderScenes(root);
  assert.equal(scenes.length, 1, `${context}: isolated workflow owns ${scenes.length} durable scenes`);
  const scene = scenes[0];
  assert.equal(scene.schemaVersion, 1, `${context}: durable scene schema is not v1`);
  if (expectedProjectId !== null) {
    assert.equal(scene.projectId, expectedProjectId, `${context}: durable scene changed project identity`);
  }
  return scene;
};

const waitForDurableCustomization = async (
  root,
  expectedProjectId,
  expectedCustomization,
  afterRevision,
  context,
) => {
  let scene = null;
  await waitUntilWithFreshDiagnostic(async () => {
    scene = soleDurableRenderScene(root, expectedProjectId, context);
    return scene?.sceneRevision > afterRevision
      && isDeepStrictEqual(scene?.scene?.customization, expectedCustomization);
  }, {
    timeout: 10_000,
    interval: 100,
    diagnostic: () => `${context}: SQLite did not commit the complete expected customization: ${JSON.stringify(scene)}`,
  });
  return scene;
};

export const waitForDurablePreset = async (root, expectedProjectId, preset, afterRevision) => {
  let scene = null;
  await waitUntilWithFreshDiagnostic(async () => {
    scene = soleDurableRenderScene(root, expectedProjectId, `preset ${preset}`);
    return scene?.sceneRevision > afterRevision && scene?.scene?.customization?.preset === preset;
  }, {
    timeout: 10_000,
    interval: 100,
    diagnostic: () => `SQLite did not commit preset ${preset}: ${JSON.stringify(scene)}`,
  });
  return scene;
};

export const captureNativeFrame = async (root, name) => {
  const path = join(root, 'evidence', 'subtitle-material-animation', `${name}.png`);
  const geometry = await savePreviewElementFrame(path, CANVAS);
  assert.ok(Number.isFinite(geometry.capture?.clock?.transportTime), (
    `${name}: captured frame omitted its transport clock`
  ));
  assert.ok(Number.isFinite(geometry.capture?.clock?.sceneTime), (
    `${name}: captured frame omitted its output-scene clock`
  ));
  assert.ok(geometry.capture?.crop?.cropWidth > 0 && geometry.capture?.crop?.cropHeight > 0, (
    `${name}: captured frame omitted its physical WebView crop plan`
  ));
  assert.ok(['rvfc', 'settled-transport', 'transport-only'].includes(
    geometry.capture?.clock?.sourceClockProvenance,
  ), `${name}: captured frame omitted source-clock provenance`);
  assert.equal(
    Number.isFinite(geometry.capture?.clock?.sourceMediaTime),
    geometry.capture?.clock?.sourceClockProvenance === 'rvfc',
    `${name}: decoded-source PTS does not agree with its provenance`,
  );
  const frame = describeCustomizationNativeFrame(path, geometry);
  return Object.freeze({ path, geometry, frame });
};

export const assertComparableCapture = (source, candidate, context) => {
  assert.ok(source !== null && candidate !== null, `${context}: capture telemetry is absent`);
  for (const field of ['width', 'height']) {
    assert.equal(candidate.window?.[field], source.window?.[field], (
      `${context}: WebView ${field} changed between the source and composed captures`
    ));
    assert.equal(candidate.canvas?.[field], source.canvas?.[field], (
      `${context}: Canvas backing ${field} changed between the source and composed captures`
    ));
    assert.equal(candidate.viewport?.[field], source.viewport?.[field], (
      `${context}: renderer viewport ${field} changed between the source and composed captures`
    ));
    assert.equal(candidate.screenshot?.[field], source.screenshot?.[field], (
      `${context}: WebView screenshot ${field} changed between the source and composed captures`
    ));
    const targetField = `target${field[0].toUpperCase()}${field.slice(1)}`;
    assert.equal(candidate.crop?.[targetField], source.crop?.[targetField], (
      `${context}: normalized crop ${field} changed`
    ));
    const boundsDelta = Math.abs(
      Number(candidate.canvas?.bounds?.[field]) - Number(source.canvas?.bounds?.[field]),
    );
    assert.ok(Number.isFinite(boundsDelta) && boundsDelta <= 0.02, (
      `${context}: Canvas CSS ${field} drifted by ${boundsDelta} pixels`
    ));
  }
  for (const field of ['cropWidth', 'cropHeight']) {
    const delta = Math.abs(Number(candidate.crop?.[field]) - Number(source.crop?.[field]));
    assert.ok(Number.isFinite(delta) && delta <= 1, (
      `${context}: physical ${field} drifted by ${delta} pixels`
    ));
  }
  for (const [cropField, boundsField, windowField, screenshotField] of [
    ['cropLeft', 'left', 'width', 'width'],
    ['cropTop', 'top', 'height', 'height'],
  ]) {
    const relativeCrop = capture => Number(capture.crop?.[cropField]) - Math.round(
      Number(capture.canvas?.bounds?.[boundsField])
        * Number(capture.screenshot?.[screenshotField]) / Number(capture.window?.[windowField]),
    );
    const delta = Math.abs(relativeCrop(candidate) - relativeCrop(source));
    assert.ok(Number.isFinite(delta) && delta <= 1, (
      `${context}: Canvas-relative ${cropField} drifted by ${delta} pixels`
    ));
  }
  for (const field of ['transportTime', 'sceneTime']) {
    const delta = Math.abs(Number(candidate.clock?.[field]) - Number(source.clock?.[field]));
    assert.ok(Number.isFinite(delta) && delta <= 0.02, (
      `${context}: ${field} drifted by ${delta} seconds`
    ));
  }
  const sourceHasPts = source.clock?.sourceClockProvenance === 'rvfc';
  const candidateHasPts = candidate.clock?.sourceClockProvenance === 'rvfc';
  if (sourceHasPts && candidateHasPts) {
    const delta = Math.abs(
      Number(candidate.clock.sourceMediaTime) - Number(source.clock.sourceMediaTime),
    );
    assert.ok(Number.isFinite(delta) && delta <= 0.02, (
      `${context}: authoritative decoded-source PTS drifted by ${delta} seconds`
    ));
  }
  return Object.freeze({
    maximumRelativeCropDeltaPixels: 1,
    maximumClockDeltaSeconds: 0.02,
  });
};

/**
 * Capture source-only controls through the exact Canvas presentation path later used for subtitle
 * composition. Hiding Canvas and screenshotting the DOM video crosses two colour/scaling paths;
 * sparse conversion differences then polluted geometry bounds across almost the entire frame.
 */
export const captureSourceCanvasBaselines = async (root) => {
  const baselines = {};
  for (const phase of ANIMATION_PHASES) {
    await publicSeek(phase.seconds, true, { cue: '', status: 'empty' });
    const first = await captureNativeFrame(root, `source-canvas-${phase.name}-first`);
    await publicSeek(phase.seconds + 0.12, true, { cue: '', status: 'empty' });
    await publicSeek(phase.seconds, true, { cue: '', status: 'empty' });
    const repeated = await captureNativeFrame(root, `source-canvas-${phase.name}-repeated`);
    assertComparableCapture(
      first.geometry.capture,
      repeated.geometry.capture,
      `${phase.name} repeated source baseline`,
    );
    assert.equal(repeated.frame.sha256, first.frame.sha256, (
      `${phase.name}: repeated ready-empty Canvas source frame was not deterministic`
    ));
    baselines[phase.name] = first;
  }
  return Object.freeze(baselines);
};

export const publicFrame = frame => Object.freeze({
  sha256: frame.frame.sha256,
  sizeBytes: frame.frame.sizeBytes,
  width: frame.frame.width,
  height: frame.frame.height,
  capture: frame.geometry.capture ?? null,
});

export const applyMaterialAction = async ({
  root,
  projectId,
  spec,
  state,
  beforeFrame,
  ordinal,
  expectedCustomization,
}) => {
  const beforeScene = soleDurableRenderScene(root, projectId, `${spec.token} prior scene`);
  assert.ok(beforeScene?.sceneRevision >= 1, `${spec.token}: prior durable scene is absent`);
  const observedValue = await performControl(spec);
  const nextExpectedCustomization = Object.freeze({
    ...expectedCustomization,
    [spec.field]: observedValue,
    preset: 'custom',
  });
  // `data-osg-overlay-rebuilds` counts rebuilds of the renderer's cached *static* overlay. A cue
  // sampled inside its fade window is intentionally dynamic and paints directly into each frame,
  // so that counter must not advance. Requiring it here made a visibly correct animated frame wait
  // forever. Revision/cue/readiness below and the independently decoded before/after pixels remain
  // mandatory; only the inapplicable static-cache counter is omitted for boundary samples.
  const samplesDynamicAnimationPhase = Number.isFinite(spec.atSeconds);
  const nextState = await waitForReady({
    before: state,
    paused: true,
    overlay: !samplesDynamicAnimationPhase,
    context: spec.token,
  });
  const durableScene = await waitForDurableCustomization(
    root,
    projectId,
    nextExpectedCustomization,
    beforeScene.sceneRevision,
    spec.token,
  );
  const nextFrame = await captureNativeFrame(
    root, `material-${String(ordinal).padStart(2, '0')}-${spec.token}`,
  );
  const frameChange = verifyCustomizationTransition({
    beforePath: beforeFrame.path,
    afterPath: nextFrame.path,
    compare: compareFrames,
    maximumSsim: 0.999_99,
    minimumChangedPixels: 32,
    minimumChangedRatio: 0.000_05,
  });
  const observation = verifyMaterialAction({
    spec,
    observedValue,
    beforeRevision: beforeScene.sceneRevision,
    expectedCustomization: nextExpectedCustomization,
    expectedProjectId: projectId,
    durableScene,
    frameChange,
    state: nextState,
  });
  return Object.freeze({
    state: nextState,
    frame: nextFrame,
    observation,
    expectedCustomization: nextExpectedCustomization,
    durableScene,
  });
};

export const copyGroupEvidence = ({ group, frame, observations }) => {
  const name = `${group.step}-native-frame`;
  const artifact = copyWorkflowArtifact({
    workflow: WORKFLOW,
    name,
    source: frame.path,
    description: `${group.description} Native compositor frame after the complete group.`,
  });
  const copied = describeCustomizationNativeFrame(artifact, frame.geometry);
  assert.equal(copied.sha256, frame.frame.sha256, `${group.id}: copied frame bytes changed`);
  return Object.freeze({
    artifact,
    frame: publicFrame(frame),
    controls: observations.map(item => item.observation),
  });
};

export const applyAnimationDropdown = async ({
  root, projectId, spec, state, expectedCustomization,
}) => {
  const beforeScene = soleDurableRenderScene(root, projectId, `${spec.token} prior scene`);
  assert.ok(beforeScene?.sceneRevision >= 1);
  const value = await usePublicDropdown(spec);
  const nextState = await waitForReady({
    before: state,
    paused: false,
    overlay: true,
    context: spec.token,
  });
  assert.equal(expectedCustomization[spec.field], value, `${spec.token}: intended animation delta is wrong`);
  const durable = await waitForDurableCustomization(
    root,
    projectId,
    expectedCustomization,
    beforeScene.sceneRevision,
    spec.token,
  );
  assert.deepEqual(nextState.currentErrors, []);
  assert.deepEqual(nextState.recordedErrors, []);
  assert.deepEqual(nextState.recordedRefusals, []);
  return Object.freeze({ state: nextState, durable });
};
