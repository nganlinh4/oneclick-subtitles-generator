// A customer changes subtitle appearance through the shipped Render controls. Every claimed style
// change must advance the native canvas, change independently captured pixels, stay drawable, and
// finally return to the known Default preset's pixels.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableRenderScenes } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { compareFrames } from '../support/nativeMediaOracle.js';
import {
  verifyCustomizationRestoration, verifyCustomizationTransition,
} from '../support/subtitleCustomizationFrameOracle.js';
import {
  importSubtitleDocument,
  openProjectWithMedia,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';
import {
  COMPARE_AT_SECONDS, CUSTOMIZATION_CUE, CUSTOMIZATION_SRT, SYSTEM_FONT, SYSTEM_FONT_CSS,
  SYSTEM_FONT_WEIGHT, WORKFLOW,
} from './steps/subtitleCustomizationPreview/constants.js';
import {
  applyPreset, assertReady, installVisibleErrorLedger, previewState, waitForDurableCustomization,
  waitForReadyChange,
} from './steps/subtitleCustomizationPreview/previewState.js';
import { applyPresetDuringPlayback } from './steps/subtitleCustomizationPreview/playback.js';
import {
  selectSystemFont, setControlAndWait, usePublicDropdown,
} from './steps/subtitleCustomizationPreview/controls.js';
import {
  applyCompletePresetMatrix, frameEvidence, publicFrame,
} from './steps/subtitleCustomizationPreview/evidence.js';

/* global $, browser, describe, document, it */

const applyControlWithEvidence = async ({
  root,
  state,
  beforeFrame,
  selector,
  value,
  read,
  label,
  kind,
  expectedValues,
  evidenceStem,
  description,
}) => {
  const nextState = await setControlAndWait({
    state,
    selector,
    value,
    read,
    label,
    kind,
    expectedValues,
  });
  const nextFrame = await frameEvidence({ root, stem: evidenceStem, description });
  const change = verifyCustomizationTransition({
    beforePath: beforeFrame.path,
    afterPath: nextFrame.path,
    compare: compareFrames,
    maximumSsim: 0.999_9,
  });
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: `${evidenceStem}-control-applied`,
    description,
    details: {
      control: selector,
      value,
      revision: nextState.canvas.revision,
      ssimFromPrevious: change.ssim,
      changedPixels: change.pixels.changedPixels,
      changedPixelRatio: change.pixels.changedRatio,
      frame: publicFrame(nextFrame),
    },
    focusSelector: selector,
  });
  return { state: nextState, frame: nextFrame, change };
};

describe('subtitle customization native preview', () => {
  it('renders distinct presets and controls, resolves a Windows system font, and restores Default', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run against an isolated data root');
    await openProjectWithMedia();
    await importSubtitleDocument(CUSTOMIZATION_SRT, 'customization-long-cue.srt', CUSTOMIZATION_CUE);
    await installVisibleErrorLedger();
    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'Render did not expose the native subtitle preview',
    });

    const beforeSeek = await previewState();
    await browser.execute((seconds) => {
      const video = document.querySelector('.video-preview-panel video');
      if (video === null) throw new Error('the Render preview video is missing');
      video.pause();
      video.currentTime = seconds;
    }, COMPARE_AT_SECONDS);
    let state = await waitForReadyChange(
      beforeSeek,
      'initial Render preview',
      () => true,
      { requireOverlayChange: false },
    );
    if (state.activePreset !== 'Default') state = await applyPreset('Default', state);
    const baseline = await frameEvidence({
      root,
      stem: '01-default',
      description: 'Known Default preset at the fixed one-second native comparison frame.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-default-preset-ready',
      description: 'Default starts with a ready native subtitle frame and no error surface.',
      details: {
        preset: state.activePreset,
        font: state.selectedFont,
        revision: state.canvas.revision,
        overlayRebuilds: state.canvas.overlayRebuilds,
        frame: publicFrame(baseline),
      },
      focusSelector: '.preview-customization-row',
    });

    state = await applyPresetDuringPlayback({ before: state, name: 'Classic' });
    const matrix = await applyCompletePresetMatrix({ root, initialState: state });
    state = matrix.state;
    const matrixById = new Map(
      matrix.observations.map(observation => [observation.preset.id, observation]),
    );
    const classic = matrixById.get('classic')?.frame;
    const neon = matrixById.get('neon')?.frame;
    assert.ok(classic && neon, 'the complete matrix did not retain Classic and Neon native frames');
    verifyCustomizationTransition({
      beforePath: baseline.path,
      afterPath: classic.path,
      compare: compareFrames,
    });
    verifyCustomizationTransition({
      beforePath: classic.path,
      afterPath: neon.path,
      compare: compareFrames,
    });

    // The exhaustive matrix ends at Forest. Return through its public button to Neon so the
    // following exact Arial-weight proof starts from the shipped 700-weight Neon face.
    state = await applyPreset('Neon', state);

    const arialWeight = await applyControlWithEvidence({
      root,
      state,
      beforeFrame: neon,
      selector: '#font-weight-slider',
      value: SYSTEM_FONT_WEIGHT,
      read: (next) => next.controls.fontWeight,
      label: 'Arial exact 400 weight dropdown',
      kind: 'dropdown',
      expectedValues: [400, 700],
      evidenceStem: '04-arial-400-weight',
      description: 'The public exact-weight dropdown changes Neon Arial from 700 to its reviewed 400 face.',
    });
    state = arialWeight.state;

    const fontSelection = await selectSystemFont(state);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-system-font-picker',
      description: 'The public picker offers the exact reviewed Windows system face before selection.',
      details: { requestedFont: SYSTEM_FONT },
      focusSelector: '.font-modal',
    });
    await fontSelection.card.click();
    await fontSelection.modal.waitForDisplayed({
      reverse: true,
      timeout: 30_000,
      timeoutMsg: 'the font picker did not close after choosing the system face',
    });
    state = await waitForReadyChange(
      fontSelection.before,
      `${SYSTEM_FONT} system font`,
      (next) => next.selectedFont === SYSTEM_FONT
        && next.selectedFontCss?.includes(SYSTEM_FONT)
        && Number(next.controls.fontWeight) === SYSTEM_FONT_WEIGHT,
    );
    const impactWeightContract = await usePublicDropdown({
      selector: '#font-weight-slider',
      expectedValues: [SYSTEM_FONT_WEIGHT],
      context: 'Impact exact weight contract',
    });
    const systemFaceReady = await browser.execute((family, weight) => (
      document.fonts?.check(`${weight} 16px "${family}"`) ?? false
    ), SYSTEM_FONT, SYSTEM_FONT_WEIGHT);
    assert.equal(systemFaceReady, true, `${SYSTEM_FONT} was selected without an installed face`);
    assert.match(state.selectedFontCss, /Impact/u, 'the font picker label did not bind Impact CSS');
    const systemFont = await frameEvidence({
      root,
      stem: '06-impact-system-font',
      description: 'The selected Impact system face remains native-preview ready.',
    });
    const systemFontChange = verifyCustomizationTransition({
      beforePath: arialWeight.frame.path,
      afterPath: systemFont.path,
      compare: compareFrames,
    });
    assert.equal(state.activePreset, null, 'manual system font selection did not enter Custom state');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '06-system-font-applied',
      description: 'At the same 400 weight, selecting Impact rebuilds the atlas and changes actual pixels from Arial.',
      details: {
        font: state.selectedFont,
        requestedCss: SYSTEM_FONT_CSS,
        exactWeightOptions: impactWeightContract.values,
        revision: state.canvas.revision,
        ssimFromArial400: systemFontChange.ssim,
        frame: publicFrame(systemFont),
      },
      focusSelector: '.preview-customization-row',
    });

    const fontSize = await applyControlWithEvidence({
      root,
      state,
      beforeFrame: systemFont,
      selector: '#font-size-slider',
      value: 96,
      read: (next) => next.controls.fontSize,
      label: '96px font-size control',
      evidenceStem: '07-font-size',
      description: 'The visible font-size slider independently enlarges native subtitle pixels.',
    });
    const sceneBeforeBackground = durableRenderScenes(root).at(-1);
    assert.ok(sceneBeforeBackground?.sceneRevision >= 1, 'the customization scene is not durable');
    const backgroundColor = await applyControlWithEvidence({
      root,
      state: fontSize.state,
      beforeFrame: fontSize.frame,
      selector: '#subtitle-background-color',
      value: '#7a003c',
      read: (next) => next.controls.backgroundColor,
      label: 'background-colour control',
      kind: 'text',
      evidenceStem: '08-background-colour',
      description: 'The visible background colour field independently changes native pixels.',
    });
    const durableBackground = await waitForDurableCustomization(
      root,
      'backgroundColor',
      '#7a003c',
      sceneBeforeBackground.sceneRevision,
    );
    assert.equal(
      durableBackground.scene.customization.backgroundColor,
      '#7a003c',
      'the public color field changed without changing the project-owned render scene',
    );
    const backgroundOpacity = await applyControlWithEvidence({
      root,
      state: backgroundColor.state,
      beforeFrame: backgroundColor.frame,
      selector: '#background-opacity-slider',
      value: 95,
      read: (next) => next.controls.backgroundOpacity,
      label: 'background-opacity control',
      evidenceStem: '09-background-opacity',
      description: 'The visible opacity slider independently raises the native subtitle background to 95% opacity.',
    });
    const borderRadius = await applyControlWithEvidence({
      root,
      state: backgroundOpacity.state,
      beforeFrame: backgroundOpacity.frame,
      selector: '#border-radius-slider',
      value: 36,
      read: (next) => next.controls.borderRadius,
      label: 'border-radius control',
      evidenceStem: '10-border-radius',
      description: 'The visible radius slider independently rounds the native subtitle background.',
    });
    const maxWidth = await applyControlWithEvidence({
      root,
      state: borderRadius.state,
      beforeFrame: borderRadius.frame,
      selector: '#max-width-slider',
      value: 35,
      read: (next) => next.controls.maxWidth,
      label: 'maximum-width control',
      evidenceStem: '11-maximum-width',
      description: 'The visible width slider independently wraps the long cue in native pixels.',
    });
    state = maxWidth.state;

    state = await applyPreset('Default', state);
    const restored = await frameEvidence({
      root,
      stem: '12-default-restored',
      description: 'Default selected again after every preset and manual control change.',
    });
    const restoration = verifyCustomizationRestoration({
      baselinePath: baseline.path,
      restoredPath: restored.path,
      divergentPaths: [
        classic.path,
        neon.path,
        arialWeight.frame.path,
        systemFont.path,
        fontSize.frame.path,
        backgroundColor.frame.path,
        backgroundOpacity.frame.path,
        borderRadius.frame.path,
        maxWidth.frame.path,
      ],
      compare: compareFrames,
    });
    assert.equal(state.activePreset, 'Default');
    assert.equal(state.selectedFont, 'Google Sans');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '12-default-pixels-restored',
      description: 'Default restores its original native pixels, not only the selected button label.',
      details: {
        preset: state.activePreset,
        font: state.selectedFont,
        revision: state.canvas.revision,
        restoredSsim: restoration.restoredSsim,
        closestChangedSsim: restoration.closestDivergent,
        frame: publicFrame(restored),
      },
      focusSelector: '.preview-customization-row',
    });
    const finalState = assertReady(await previewState(), 'final restored Default evidence');
    assert.equal(finalState.activePreset, 'Default');
    assert.equal(finalState.selectedFont, 'Google Sans');
  });
});

