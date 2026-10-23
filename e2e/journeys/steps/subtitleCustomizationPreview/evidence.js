// Captured preview frames and the complete preset matrix for the customization journey.

import { strict as assert } from 'node:assert';
import { join } from 'node:path';

import { durableRenderScenes } from '../../../support/database.js';
import { savePreviewElementFrame } from '../../../support/nativeMediaOracle.js';
import {
  describeCustomizationNativeFrame,
} from '../../../support/subtitleCustomizationFrameOracle.js';
import {
  SUBTITLE_PRESET_MATRIX, verifyPresetObservation,
} from '../../../support/subtitleCustomizationPresetOracle.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../../../support/workflowEvidence.js';
import { CANVAS, WORKFLOW } from './constants.js';
import { applyPreset, waitForDurablePreset } from './previewState.js';

export const frameEvidence = async ({ root, stem, description }) => {
  const name = `${stem}-native-frame`;
  const path = join(root, 'evidence', 'subtitle-customization', `${name}.png`);
  // The compositor publishes its backing-store viewport before the screenshot. That is the
  // independent envelope: it follows the real device scale while a full-page screenshot cannot
  // masquerade as the native crop by supplying its own IHDR dimensions.
  const expectedGeometry = await savePreviewElementFrame(path, CANVAS);
  const captured = describeCustomizationNativeFrame(path, expectedGeometry);
  const artifactPath = copyWorkflowArtifact({ workflow: WORKFLOW, name, source: path, description });
  const frame = describeCustomizationNativeFrame(artifactPath, expectedGeometry);
  assert.equal(frame.sha256, captured.sha256, 'workflow artifact changed the native frame bytes');
  return { path, artifactPath, frame };
};

export const publicFrame = ({ frame }) => ({
  sha256: frame.sha256,
  sizeBytes: frame.sizeBytes,
  width: frame.width,
  height: frame.height,
});

export const applyCompletePresetMatrix = async ({ root, initialState }) => {
  let state = initialState;
  const observations = [];
  for (const preset of SUBTITLE_PRESET_MATRIX) {
    const beforeDurable = durableRenderScenes(root).at(-1) ?? null;
    assert.ok(beforeDurable?.sceneRevision >= 1, `${preset.name}: no prior durable render scene`);
    state = await applyPreset(preset.name, state);
    const durableScene = await waitForDurablePreset(root, preset.id, beforeDurable.sceneRevision);
    const exact = verifyPresetObservation({
      preset,
      activePreset: state.activePreset,
      activePresetId: state.activePresetId,
      beforeSceneRevision: beforeDurable.sceneRevision,
      durableScene,
    });
    const frame = await frameEvidence({
      root,
      stem: preset.evidenceStem,
      description: `${preset.name} exact preset fields rendered as a drawable native canvas frame.`,
    });
    assert.equal(frame.artifactPath.endsWith(`${preset.nativeArtifactName}.png`), true, (
      `${preset.name}: native artifact name drifted from the reviewed evidence plan`
    ));
    const observation = Object.freeze({
      ...exact,
      canvasRevision: state.canvas.revision,
      overlayRebuilds: state.canvas.overlayRebuilds,
      frame: publicFrame(frame),
    });
    observations.push(Object.freeze({ preset, state, frame, observation }));
    if (preset.captureScreenshot) {
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: preset.screenshotStep,
  description: `${preset.name} is active, durable, exact and drawable in the real Render surface.`,
        details: observation,
        focusSelector: '.preview-customization-row',
      });
    }
  }
  assert.equal(observations.length, 30, 'the public preset matrix did not exercise all 30 buttons');
  assert.deepEqual(
    observations.map(({ observation }) => observation.id),
    SUBTITLE_PRESET_MATRIX.map(({ id }) => id),
    'the public preset matrix changed order or skipped a preset',
  );
  return Object.freeze({ state, observations: Object.freeze(observations) });
};
