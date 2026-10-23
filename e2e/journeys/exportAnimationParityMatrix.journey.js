// Ten customer-authored subtitle compositions are previewed in both native surfaces, rendered by
// the real Rust pipeline, saved through the fail-closed staged dialog, and independently decoded.
//
// This journey never asks Windows for focus, never enters fullscreen, and never opens a native
// picker. The embedded automation binary remains off-screen/non-focusable/muted; every file is a
// predeclared path beneath its disposable root.

import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { durableCustomerIdentity } from '../support/settingsSurfaceOracle.js';
import { clickControl } from '../support/editor.js';
import {
  EXPORT_ANIMATION_PARITY_CASES,
  EXPORT_PARITY_FPS,
  buildExportAnimationParitySrt,
  exactFrameSeconds,
} from '../support/exportAnimationParityOracle.js';
import {
  compareFramePixels,
  compareFrames,
  extractFrame,
  measureAudioSignal,
  probeMedia,
  savePreviewElementFrame,
  savePreviewSourceFrame,
} from '../support/nativeMediaOracle.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import { revealMainTransportControls } from '../support/previewTransport.js';
import { importSubtitleDocument, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';
import {
  MAIN_CANVAS,
  MAIN_PLAY_PAUSE,
  MAIN_SEEK,
  MAIN_STATE,
  MAIN_VIDEO,
  RENDER_CANVAS,
  RENDER_SEEK,
  RENDER_STATE,
  RENDER_VIDEO,
  WORKFLOW,
  waitUntilWithFreshDiagnostic,
} from './steps/exportAnimationParityMatrix/surfaces.js';
import {
  installProblemLedger,
  pathInside,
  recordedProblems,
  visibleProblems,
} from './steps/exportAnimationParityMatrix/problemLedger.js';
import {
  applyCaseThroughPublicControls,
  setFastExactRenderFormat,
  waitForDurableCues,
} from './steps/exportAnimationParityMatrix/publicControls.js';
import {
  canvasState,
  ensurePausedThroughPublicControl,
  exactFrameKeys,
  pointerSeek,
  waitForExactCanvas,
} from './steps/exportAnimationParityMatrix/previewCanvas.js';
import {
  copyFrameArtifact,
  renderAndDecode,
  sha256File,
} from './steps/exportAnimationParityMatrix/renderExport.js';

/* global $, browser, describe, document, it */
const seekThroughPublicControl = async ({ surface, frame, cueIndex }) => {
  const seconds = exactFrameSeconds(frame);
  const main = surface === 'Main';
  const canvasSelector = main ? MAIN_CANVAS : RENDER_CANVAS;
  const videoSelector = main ? MAIN_VIDEO : RENDER_VIDEO;
  const stateSelector = main ? MAIN_STATE : RENDER_STATE;
  const seekSelector = main ? MAIN_SEEK : RENDER_SEEK;
  const playPauseSelector = main ? MAIN_PLAY_PAUSE : '.video-preview-panel [data-osg-control="play-pause"]';
  if (main) {
    // The Main transport is hover-gated; the pointer-move shortcut does not reliably produce the
    // hover state in the hidden window, so cross the product's real mouseover reveal boundary.
    await revealMainTransportControls();
  }
  const control = await $(seekSelector);
  await control.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${surface}: public seek is absent` });
  await control.scrollIntoView({ block: 'center', inline: 'center' });
  const before = await canvasState(canvasSelector, videoSelector, stateSelector);
  await ensurePausedThroughPublicControl({ state: before, playPauseSelector, label: surface });
  const minimum = Number(await control.getAttribute(main ? 'aria-valuemin' : 'min'));
  const maximum = Number(await control.getAttribute(main ? 'aria-valuemax' : 'max'));
  assert.equal(minimum, 0, `${surface}: public seek no longer starts at zero`);
  assert.ok(Number.isFinite(maximum) && maximum > seconds, `${surface}: sample exceeds seek range`);
  if (!main) {
    const step = Number(await control.getAttribute('step'));
    assert.ok(Math.abs(step - 1 / EXPORT_PARITY_FPS) <= Number.EPSILON, (
      `Render: public seek step is not the exact ${EXPORT_PARITY_FPS}-fps grid: ${step}`
    ));
  }
  // Main seeks through a real pointer press on its slider, which both quantizes near the target
  // and grants genuine keyboard focus for the exact-frame arrow correction. The Render surface's
  // native range cannot rely on keyboard focus in the hidden non-activatable window (neither a JS
  // focus() nor a trusted click reliably delivers later key events there), so it takes the exact
  // rational value through the native value setter instead: the seek lands on the 30-fps grid
  // directly and the 1e-6 transport gate below still pins exactness.
  if (main) {
    await pointerSeek({
      control,
      controlSelector: seekSelector,
      minimum,
      maximum,
      seconds,
      label: `${surface} frame ${frame}`,
    });
  } else {
    const actuated = await actuateNativeRange({
      driver: browser,
      selector: seekSelector,
      value: seconds,
      label: `${surface} frame ${frame}`,
    });
    assert.ok(Math.abs(actuated.value - seconds) <= 0.000_001,
      `${surface} frame ${frame}: the native range did not commit the exact grid value`);
  }
  let pointerState = null;
  await waitUntilWithFreshDiagnostic(async () => {
    pointerState = await canvasState(canvasSelector, videoSelector, stateSelector);
    return pointerState.paused === true
      && pointerState.seeking === false
      && Number.isFinite(pointerState.currentTime)
      && Math.abs(pointerState.currentTime - seconds) <= Math.max(0.1, maximum / 500);
  }, {
    timeout: 30_000,
    interval: 30,
    diagnostic: () => `${surface}: pointer seek did not settle near ${seconds}: `
      + JSON.stringify(pointerState),
  });
  const keySequence = main
    ? await exactFrameKeys({
      canvasSelector,
      videoSelector,
      stateSelector,
      frame,
      label: `${surface} frame ${frame}/${EXPORT_PARITY_FPS}`,
      maximumFrame: Math.floor(maximum * EXPORT_PARITY_FPS),
    })
    : Object.freeze([]);
  const state = await waitForExactCanvas({
    canvasSelector,
    videoSelector,
    stateSelector,
    seconds,
    cueIndex,
    beforeRevision: before.revision,
    label: `${surface} frame ${frame}/${EXPORT_PARITY_FPS}`,
  });
  return Object.freeze({ ...state, keySequence });
};

const capturePhase = async ({ root, selectedSource, definition, cueIndex, phase, frame }) => {
  const directory = join(root, 'evidence', WORKFLOW, definition.id);
  mkdirSync(directory, { recursive: true });
  const mainPath = join(directory, `${phase}-main-preview.png`);
  const mainSourcePath = join(directory, `${phase}-main-source-only.png`);
  const renderPath = join(directory, `${phase}-render-preview.png`);
  const renderSourcePath = join(directory, `${phase}-render-source-only.png`);
  const independentSourcePath = join(directory, `${phase}-independent-source.png`);

  const mainState = await seekThroughPublicControl({ surface: 'Main', frame, cueIndex });
  await savePreviewElementFrame(mainPath, MAIN_CANVAS);
  await savePreviewSourceFrame(mainSourcePath, MAIN_CANVAS);
  const renderState = await seekThroughPublicControl({ surface: 'Render', frame, cueIndex });
  await savePreviewElementFrame(renderPath, RENDER_CANVAS);
  await savePreviewSourceFrame(renderSourcePath, RENDER_CANVAS);
  extractFrame(selectedSource, exactFrameSeconds(frame), independentSourcePath);
  const mainSubtitlePixels = compareFramePixels(
    mainSourcePath, mainPath, { channelDeltaThreshold: 20 },
  );
  const renderSubtitlePixels = compareFramePixels(
    renderSourcePath, renderPath, { channelDeltaThreshold: 20 },
  );
  for (const [surface, subtitlePixels] of Object.entries({
    Main: mainSubtitlePixels, Render: renderSubtitlePixels,
  })) {
    // Presence only, at an absolute floor: a bounce or scale ENTRY is legitimately tiny (a
    // glow cue at 40% eased progress measured 84 real pixels at delta 27), so a frame-relative
    // ratio or a fixed high delta rejects correct animation math. The ROI difference-mask oracle
    // downstream owns the substantive per-surface and export agreement claims.
    assert.ok(
      subtitlePixels.changedPixels >= 32,
      `${definition.id} ${phase}: ${surface} added no subtitle pixels at all: `
        + JSON.stringify(subtitlePixels),
    );
  }
  const mainRender = compareFrames(mainPath, renderPath);

  copyFrameArtifact({
    name: `${definition.id}-${phase}-main-preview`,
    source: mainPath,
    description: `Main native preview at exact frame ${frame}/${EXPORT_PARITY_FPS}.`,
  });
  copyFrameArtifact({
    name: `${definition.id}-${phase}-render-preview`,
    source: renderPath,
    description: `Render native preview at exact frame ${frame}/${EXPORT_PARITY_FPS}.`,
  });
  copyFrameArtifact({
    name: `${definition.id}-${phase}-main-source-only`,
    source: mainSourcePath,
    description: 'Main WebView source frame with only its native subtitle canvas hidden.',
  });
  copyFrameArtifact({
    name: `${definition.id}-${phase}-render-source-only`,
    source: renderSourcePath,
    description: 'Render WebView source frame with only its native subtitle canvas hidden.',
  });
  copyFrameArtifact({
    name: `${definition.id}-${phase}-independent-source`,
    source: independentSourcePath,
    description: `Independent FFmpeg source decode at exact frame ${frame}/${EXPORT_PARITY_FPS}.`,
  });
  return Object.freeze({
    frame,
    seconds: exactFrameSeconds(frame),
    mainPath,
    mainSourcePath,
    renderPath,
    renderSourcePath,
    independentSourcePath,
    mainRender,
    mainSubtitlePixels,
    renderSubtitlePixels,
    mainState,
    renderState,
  });
};

describe('decoded native export animation parity matrix', () => {
  it('keeps all ten public animation/style cases WYSIWYG at entry and exit', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    const selectedSource = process.env.OSG_E2E_MEDIA_SELECTION;
    assert.ok(root && existsSync(root), 'the app must use one disposable data root');
    assert.ok(destination && existsSync(destination), 'the staged save directory must exist');
    assert.ok(selectedSource && existsSync(selectedSource), 'the staged real media selection is missing');
    pathInside(root, destination, 'save destination');
    pathInside(root, selectedSource, 'selected media');

    await installProblemLedger();
    await openProjectWithMedia();
    await importSubtitleDocument(
      buildExportAnimationParitySrt(),
      'export-animation-parity-matrix.srt',
      EXPORT_ANIMATION_PARITY_CASES[0].text,
    );
    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'Render did not expose its native preview and public controls',
    });
    assert.equal(
      await browser.execute(() => document.fullscreenElement === null),
      true,
      'the hidden journey must never enter fullscreen',
    );
    await setFastExactRenderFormat(root);
    const durableCues = await waitForDurableCues(root);
    const sourceProbe = probeMedia(selectedSource);
    const sourceAudioSignal = measureAudioSignal(selectedSource);
    const selectedSourceIdentity = Object.freeze({
      displayName: basename(selectedSource),
      sizeBytes: statSync(selectedSource).size,
      sha256: sha256File(selectedSource),
    });
    const state = durableState(root);
    const customerIdentity = durableCustomerIdentity(root);
    const durableOwnership = Object.freeze({
      projects: state.projects.map(({ id }) => ({ id })),
      media: state.media.map(({
        id, display_name: displayName, size_bytes: sizeBytes, content_hash: contentHash,
      }) => ({ id, display_name: displayName, size_bytes: sizeBytes, content_hash: contentHash })),
      links: state.links.map(({ project_id: projectId, media_id: mediaId, role }) => ({
        project_id: projectId, media_id: mediaId, role,
      })),
      sourceFiles: customerIdentity.sourceFiles.map(({
        mediaId, available, size, sha256,
      }) => ({
        media_id: String(mediaId).toLowerCase(), available, size_bytes: size, sha256,
      })),
    });
    const results = [];

    for (let index = 0; index < EXPORT_ANIMATION_PARITY_CASES.length; index += 1) {
      const definition = EXPORT_ANIMATION_PARITY_CASES[index];
      const durableScene = await applyCaseThroughPublicControls(root, definition);
      const entry = await capturePhase({
        root,
        selectedSource,
        definition,
        cueIndex: index,
        phase: 'entry',
        frame: definition.entryFrame,
      });
      const exit = await capturePhase({
        root,
        selectedSource,
        definition,
        cueIndex: index,
        phase: 'exit',
        frame: definition.exitFrame,
      });
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: `${definition.id}-native-previews`,
        description: `Main and Render both publish ${definition.animationType} at exact entry/exit frame fractions with no source-only substitution.`,
        details: {
          animation: definition.animationType,
          easing: definition.animationEasing,
          borderStyle: definition.borderStyle,
          position: definition.position,
          textAlign: definition.textAlign,
          textTransform: definition.textTransform,
          effects: definition.effects,
          textFeatures: definition.textFeatures,
          entry: {
            frame: `${entry.frame}/${EXPORT_PARITY_FPS}`,
            mainKeySequence: entry.mainState.keySequence,
            renderKeySequence: entry.renderState.keySequence,
            mainRenderSsim: entry.mainRender,
            mainChangedPixelsFromSource: entry.mainSubtitlePixels.changedPixels,
            renderChangedPixelsFromSource: entry.renderSubtitlePixels.changedPixels,
          },
          exit: {
            frame: `${exit.frame}/${EXPORT_PARITY_FPS}`,
            mainKeySequence: exit.mainState.keySequence,
            renderKeySequence: exit.renderState.keySequence,
            mainRenderSsim: exit.mainRender,
            mainChangedPixelsFromSource: exit.mainSubtitlePixels.changedPixels,
            renderChangedPixelsFromSource: exit.renderSubtitlePixels.changedPixels,
          },
        },
        focusSelector: '.preview-customization-row',
      });
      results.push(await renderAndDecode({
        root,
        destination,
        sourceProbe,
        definition,
        durableScene,
        durableCues,
        entry,
        exit,
        durableOwnership,
        selectedSourceIdentity,
        sourceAudioSignal,
      }));
    }

    assert.equal(results.length, 10, 'the decoded export matrix skipped a case');
    assert.deepEqual(
      results.map(result => result.id),
      EXPORT_ANIMATION_PARITY_CASES.map(definition => definition.id),
      'the decoded export matrix changed case order',
    );
    assert.deepEqual(await visibleProblems(), [], 'a visible refusal remains after the matrix');
    assert.deepEqual(await recordedProblems(), [], 'the matrix emitted a transient refusal');
    assert.equal(
      await browser.execute(() => document.fullscreenElement === null),
      true,
      'the hidden journey activated fullscreen',
    );
  });
});
