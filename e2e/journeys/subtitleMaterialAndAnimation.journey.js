// A non-Cartesian real-customer sweep of subtitle material, placement and animation. The guarded
// binary stays off-screen/non-focusable/muted; every action goes through a shipped WebView control.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { clickControl } from '../support/editor.js';
import {
  compareFrameDominantDifferenceComponent,
  compareFrames,
} from '../support/nativeMediaOracle.js';
import {
  describeCustomizationNativeFrame,
  verifyCustomizationTransition,
} from '../support/subtitleCustomizationFrameOracle.js';
import {
  ANIMATION_CASES,
  ANIMATION_CUE,
  ANIMATION_PHASES,
  MATERIAL_GROUPS,
  verifyAnimationCoverage,
  verifyAnimationObservation,
  verifyLiveFontPresetTransition,
  verifyMaterialCoverage,
  verifySubtitleContainment,
} from '../support/subtitleMaterialAnimationOracle.js';
import { importSubtitleDocument, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

import {
  CUE_END,
  CUE_START,
  CUE_TEXT,
  MATERIAL_SRT,
  MATERIAL_TIME,
  WORKFLOW,
  installVisibleErrorLedger,
  previewState,
  publicSeek,
  setPlaying,
  waitForReady,
} from './steps/subtitleMaterialAndAnimation/previewControls.js';
import {
  applyAnimationDropdown,
  applyMaterialAction,
  assertComparableCapture,
  captureNativeFrame,
  captureSourceCanvasBaselines,
  copyGroupEvidence,
  publicFrame,
  soleDurableRenderScene,
  waitForDurablePreset,
} from './steps/subtitleMaterialAndAnimation/materialCapture.js';
import {
  cleanupAnimationWitness,
  markAnimationWitnessTransition,
  startAnimationWitness,
  stopAnimationWitness,
  witnessThroughCue,
} from './steps/subtitleMaterialAndAnimation/animationWitness.js';
import {
  animationEasingSpec,
  animationTypeSpec,
  captureAnimationPhaseProofs,
  stageAnimationWitnessLedger,
  temporalPhaseTransitions,
} from './steps/subtitleMaterialAndAnimation/animationPhaseProofs.js';

/* global $, browser, describe, it, window */

describe('subtitle material and animation real preview', () => {
  it('persists every material control and keeps every animation drawable through playback', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run against an isolated data root');
    await installVisibleErrorLedger();
    await openProjectWithMedia();
    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'Render did not expose its native controls',
    });
    let state = await waitForReady({
      paused: true,
      cue: '',
      status: 'empty',
      requireOverlay: false,
      context: 'ready-empty source Canvas',
    });
    const sourceBaselines = await captureSourceCanvasBaselines(root);
    await importSubtitleDocument(MATERIAL_SRT, 'material-animation-unicode.srt', CUE_TEXT);
    state = await publicSeek(MATERIAL_TIME, true);

    const beforeGamingScene = soleDurableRenderScene(root, null, 'Gaming baseline');
    assert.ok(beforeGamingScene?.sceneRevision >= 1, 'Gaming baseline has no durable prior scene');
    const projectId = beforeGamingScene.projectId;
    const gaming = await $('[data-osg-preset="gaming"]');
    await gaming.waitForClickable({ timeout: 30_000, timeoutMsg: 'Gaming public preset is absent' });
    state = await setPlaying(true);
    await startAnimationWitness();
    let gamingWitness = null;
    let gamingTransition = null;
    try {
      // The pre-change marker demands classified pixels, and a publication that consumed
      // pre-attach sources stays honestly unclassifiable until the first post-attach capture
      // publishes. That first capture needs a presented frame; under load the decoder's first
      // presentation can lag far past a fixed pause, so wait for classification itself.
      await browser.waitUntil(async () => browser.execute(() => {
        const witness = window.__OSG_E2E_ANIMATION_WITNESS__;
        const latest = witness?.samples?.at(-1);
        return witness?.active === true && latest?.visual?.classified === true;
      }), {
        timeout: 15_000,
        interval: 100,
        timeoutMsg: 'no classified post-attach publication before the preset transition',
      });
      gamingTransition = await markAnimationWitnessTransition();
      await gaming.click();
      state = await waitForReady({
        before: state,
        paused: false,
        overlay: true,
        context: 'Gaming live font/preset baseline',
      });
      await browser.pause(360);
      gamingWitness = await stopAnimationWitness();
    } finally {
      await cleanupAnimationWitness();
    }
    state = await setPlaying(false);
    const gamingScene = await waitForDurablePreset(
      root,
      projectId,
      'gaming',
      beforeGamingScene.sceneRevision,
    );
    assert.ok(gamingScene.scene.customization.borderWidth > 0);
    assert.notEqual(gamingScene.scene.customization.borderStyle, 'none');
    assert.equal(gamingScene.scene.customization.glowEnabled, true);
    assert.equal(gamingScene.scene.customization.strokeEnabled, true);
    const gamingTransitionProof = verifyLiveFontPresetTransition({
      samples: gamingWitness.samples,
      publications: gamingWitness.publications,
      mediaEvents: gamingWitness.mediaEvents,
      transientTransitions: gamingWitness.transientTransitions,
      transition: gamingTransition,
      beforePreset: beforeGamingScene.scene.customization.preset,
      afterPreset: gamingScene.scene.customization.preset,
      beforeFontFamily: beforeGamingScene.scene.customization.fontFamily,
      afterFontFamily: gamingScene.scene.customization.fontFamily,
    });
    assert.ok(gamingTransitionProof.publishedFrames >= 2);
    // The live-preset witness intentionally advances playback. Every following material frame is
    // compared with the independently captured 8s source baseline, so restore that exact public
    // instant before establishing the composed baseline. Without this seek the old oracle compared
    // video pixels from ~8.7s with source pixels from 8.0s and mislabeled the full-frame delta as
    // subtitle clipping.
    state = await publicSeek(MATERIAL_TIME, true);
    let frame = await captureNativeFrame(root, '00-gaming-active-material-baseline');
    let expectedCustomization = Object.freeze({ ...gamingScene.scene.customization });

    const materialObservations = [];
    let ordinal = 0;
    for (const group of MATERIAL_GROUPS) {
      const groupResults = [];
      for (const spec of group.actions) {
        if (Number.isFinite(spec.atSeconds)) {
          state = await publicSeek(spec.atSeconds, true);
          frame = await captureNativeFrame(root, `material-${spec.token}-same-instant-baseline`);
        }
        ordinal += 1;
        const result = await applyMaterialAction({
          root,
          projectId,
          spec,
          state,
          beforeFrame: frame,
          ordinal,
          expectedCustomization,
        });
        state = result.state;
        frame = result.frame;
        expectedCustomization = result.expectedCustomization;
        groupResults.push(result);
        materialObservations.push(result.observation);
      }
      let containment = null;
      if (group.id === 'custom-position') {
        const captureCompatibility = assertComparableCapture(
          sourceBaselines.steady.geometry.capture,
          frame.geometry.capture,
          'custom-position containment',
        );
        containment = verifySubtitleContainment(compareFrameDominantDifferenceComponent(
          sourceBaselines.steady.path,
          frame.path,
          // The high threshold and dominant continuous component keep this contract about the
          // authored double-border material, not disconnected WebView crop/colour noise.
          {
            channelDeltaThreshold: 64,
            frameEdgeFringePixels: 3,
            dominantHaloPixels: 32,
          },
        ));
        containment = Object.freeze({ ...containment, captureCompatibility });
      }
      const evidence = copyGroupEvidence({ group, frame, observations: groupResults });
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: group.step,
        description: group.description,
        details: containment === null ? evidence : {
          ...evidence,
          containment,
          containmentSourceCapture: sourceBaselines.steady.geometry.capture ?? null,
        },
        focusSelector: '.preview-customization-row',
      });
    }
    const finalMaterialScene = soleDurableRenderScene(root, projectId, 'final material scene');
    const materialCoverage = verifyMaterialCoverage(materialObservations, {
      expectedCustomization,
      durableCustomization: finalMaterialScene?.scene?.customization,
    });

    const animationObservations = [];
    let previousEntry = null;
    for (const animation of ANIMATION_CASES) {
      state = await publicSeek(ANIMATION_CUE.witnessStart, true);
      state = await setPlaying(true);
      const caseBeforeScene = soleDurableRenderScene(root, projectId, `${animation.id} prior scene`);
      assert.ok(caseBeforeScene?.sceneRevision >= 1, `${animation.type}: prior durable scene is absent`);
      const expectedTypeCustomization = Object.freeze({
        ...expectedCustomization,
        ...(animation.editType ? { animationType: animation.type, preset: 'custom' } : {}),
      });
      let typeScene = caseBeforeScene;
      if (animation.editType) {
        const result = await applyAnimationDropdown({
          root,
          projectId,
          spec: animationTypeSpec(animation),
          state,
          expectedCustomization: expectedTypeCustomization,
        });
        state = result.state;
        typeScene = result.durable;
      } else {
        assert.equal(typeScene.scene.customization.animationType, animation.type);
      }
      const expectedFinalCustomization = Object.freeze({
        ...expectedTypeCustomization,
        ...(animation.editEasing ? { animationEasing: animation.easing, preset: 'custom' } : {}),
      });
      let easingScene = typeScene;
      if (animation.editEasing) {
        const result = await applyAnimationDropdown({
          root,
          projectId,
          spec: animationEasingSpec(animation),
          state,
          expectedCustomization: expectedFinalCustomization,
        });
        state = result.state;
        easingScene = result.durable;
      } else {
        assert.equal(easingScene.scene.customization.animationEasing, animation.easing);
      }
      expectedCustomization = expectedFinalCustomization;
      state = await publicSeek(ANIMATION_CUE.witnessStart, false);
      const temporal = await witnessThroughCue();
      state = await setPlaying(false);
      const frameProofs = await captureAnimationPhaseProofs(root, animation, sourceBaselines);
      const phaseTransitions = temporalPhaseTransitions(frameProofs);
      const entryChange = previousEntry === null ? null : verifyCustomizationTransition({
        beforePath: previousEntry.path,
        afterPath: frameProofs.entry.composed.path,
        compare: compareFrames,
        maximumSsim: 0.999_99,
        minimumChangedPixels: 64,
        minimumChangedRatio: 0.000_1,
      });
      let observation;
      try {
        observation = verifyAnimationObservation({
          animation,
          beforeRevision: caseBeforeScene.sceneRevision,
          expectedProjectId: projectId,
          expectedTypeCustomization,
          expectedFinalCustomization,
          typeScene,
          easingScene,
          continuitySamples: temporal.continuitySamples,
          samplesByPhase: temporal.samplesByPhase,
          frameProofs,
          phaseTransitions,
          entryChange,
          transientTransitions: temporal.transientTransitions,
          mediaEvents: temporal.mediaEvents,
        });
      } catch (error) {
        // The oracle's continuity/completeness assertions otherwise take the witness's full sample
        // series and media-event ledger down with the failing process, leaving only the single
        // failing sample in the thrown message. The journey is the only place that still holds the
        // full witness at this instant.
        stageAnimationWitnessLedger({ animation, temporal });
        throw error;
      }
      animationObservations.push(observation);
      previousEntry = frameProofs.entry.composed;

      if (animation.captureEvidence) {
        const representativePhase = animation.type === 'bounce' ? 'steady' : 'entry';
        const representative = frameProofs[representativePhase].composed;
        const name = `animation-${animation.id}-${representativePhase}-native-frame`;
        const artifact = copyWorkflowArtifact({
          workflow: WORKFLOW,
          name,
          source: representative.path,
          description: `${animation.type}/${animation.easing} at the ${representativePhase} phase.`,
        });
        const copied = describeCustomizationNativeFrame(artifact, representative.geometry);
        assert.equal(copied.sha256, representative.frame.sha256);
        state = await publicSeek(
          ANIMATION_PHASES.find(phase => phase.name === representativePhase).seconds,
          true,
        );
        await captureWorkflowStep({
          workflow: WORKFLOW,
          step: `animation-${animation.id}-${representativePhase}`,
          description: `${animation.type} stays drawable during real playback and differs from the same-instant source-only frame.`,
          details: {
            ...observation,
            representativePhase,
            frame: publicFrame(representative),
            sourceDelta: frameProofs[representativePhase].subtitlePixels,
            sourceCapture: frameProofs[representativePhase].sourceCapture,
          },
          focusSelector: '.preview-customization-row',
        });
      }
    }

    const animationCoverage = verifyAnimationCoverage(animationObservations);
    const finalState = await previewState();
    assert.equal(finalState.video.paused, true);
    assert.equal(finalState.preview.status, 'ready');
    assert.equal(finalState.canvas.cue, '0');
    assert.deepEqual(finalState.currentErrors, []);
    assert.deepEqual(finalState.recordedErrors, []);
    assert.deepEqual(finalState.recordedRefusals, []);
    assert.deepEqual(materialCoverage, { actions: materialObservations.length, groups: 7 });
    assert.deepEqual(animationCoverage, { cases: 16, types: 10, easings: 7 });
    assert.ok(
      finalState.video.currentTime > CUE_START - ANIMATION_CUE.fadeIn
        && finalState.video.currentTime < CUE_END + ANIMATION_CUE.fadeOut,
    );
  });
});

