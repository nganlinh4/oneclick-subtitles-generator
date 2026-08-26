// The editor preview and Render preview are two views of one durable project scene, not two style stores.

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { durableRenderScenes } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { compareFrames, savePreviewElementFrame } from '../support/nativeMediaOracle.js';
import {
  importSubtitles,
  openProjectWithMedia,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'main-preview-render-handoff';
const COMPARE_AT_SECONDS = 1;
const EXPECTED_STYLE = Object.freeze({
  fontSize: 96,
  backgroundColor: '#6a004f',
  backgroundOpacity: 100,
  textColor: '#00ffff',
  textAlign: 'right',
  position: 'custom',
  customPositionY: 20,
  maxWidth: 100,
  borderRadius: 20,
  backgroundPaddingX: 24,
  backgroundPaddingY: 24,
});

/* global $, HTMLInputElement, browser, describe, document, Event, it */

const setNativeInput = async (selector, value) => {
  const changed = await browser.execute((target, next) => {
    const input = document.querySelector(target);
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (typeof setter !== 'function') return false;
    setter.call(input, String(next));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, value);
  assert.equal(changed, true, `the customer setting control is missing: ${selector}`);
};

describe('main preview to Render handoff', () => {
  it('uses one project-owned subtitle style on both native preview surfaces', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run in an isolated root');
    await openProjectWithMedia();
    await importSubtitles();
    await seekPreviewTo(COMPARE_AT_SECONDS);
    await waitForCanvasSubtitleFrame(120_000);

    const mainRevision = () => browser.execute(() => Number(
      document.querySelector('.video-preview canvas[data-osg-preview-engine="canvas-atlas"]')
        ?.dataset.osgFrameRevision ?? 0,
    ));
    const initialRevision = await mainRevision();
    await clickControl('.subtitle-settings-toggle');
    await $('.subtitle-settings-panel').waitForDisplayed({
      timeout: 30_000,
      timeoutMsg: 'the editor subtitle settings did not open',
    });
    await setNativeInput('#font-size', EXPECTED_STYLE.fontSize);
    await setNativeInput('#position', EXPECTED_STYLE.customPositionY);
    await setNativeInput('#box-width', EXPECTED_STYLE.maxWidth);
    await setNativeInput('#background-radius', EXPECTED_STYLE.borderRadius);
    await setNativeInput('#background-padding', EXPECTED_STYLE.backgroundPaddingY);
    await setNativeInput('#opacity', EXPECTED_STYLE.backgroundOpacity / 100);
    await setNativeInput('#background-color', EXPECTED_STYLE.backgroundColor);
    await setNativeInput('#text-color', EXPECTED_STYLE.textColor);
    const rightAlign = await $('.subtitle-settings-panel .button-toggle[title="Right"]');
    await rightAlign.waitForClickable({ timeout: 30_000 });
    await rightAlign.click();

    await browser.waitUntil(async () => (await mainRevision()) > initialRevision, {
      timeout: 120_000,
      interval: 100,
      timeoutMsg: 'the edited subtitle style never reached main-preview pixels',
    });

    let durableStyle = null;
    await waitUntilWithFreshDiagnostic(() => {
      durableStyle = durableRenderScenes(root).at(-1)?.scene?.customization ?? null;
      return durableStyle !== null
        && Object.entries(EXPECTED_STYLE).every(([key, value]) => durableStyle[key] === value);
    }, {
      timeout: 15_000,
      interval: 250,
      diagnostic: () => `main-preview settings did not enter the project render scene: ${JSON.stringify(durableStyle)}`,
    });

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-main-preview-style-edited',
      description: 'Customer edits are visible in the main preview and durable in the project scene.',
      details: { style: EXPECTED_STYLE, sceneRevision: durableRenderScenes(root).at(-1).sceneRevision },
      focusSelector: '.video-preview .video-container',
    });

    await clickControl('.subtitle-settings-backdrop');
    await $('.subtitle-settings-panel').waitForDisplayed({
      reverse: true,
      timeout: 10_000,
      timeoutMsg: 'the subtitle settings panel did not close before opening Render',
    });
    const mainFrame = join(root, 'evidence', 'main-preview-shared-style.png');
    await savePreviewElementFrame(
      mainFrame,
      '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
    );
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'main-preview-frame',
      source: mainFrame,
      description: 'The unobscured editor preview at one second after changing the shared project style.',
    });
    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'Render did not open its native preview',
    });
    const renderFrameState = () => browser.execute(() => {
      const canvas = document.querySelector(
        '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]',
      );
      return {
        revision: Number(canvas?.dataset.osgFrameRevision ?? 0),
        cue: canvas?.dataset.osgCueIndex ?? null,
      };
    });
    const beforeRender = await renderFrameState();
    await browser.execute((seconds) => {
      const video = document.querySelector('.video-preview-panel video');
      if (video === null) throw new Error('the Render preview video is missing');
      video.pause();
      video.currentTime = seconds;
    }, COMPARE_AT_SECONDS);
    await browser.waitUntil(async () => {
      const frame = await renderFrameState();
      return frame.revision > beforeRender.revision && frame.cue !== '';
    }, {
      timeout: 120_000,
      interval: 100,
      timeoutMsg: 'the Render preview did not publish the shared-style frame',
    });

    const renderFrame = join(root, 'evidence', 'render-preview-shared-style.png');
    await savePreviewElementFrame(
      renderFrame,
      '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]',
    );
    const ssim = compareFrames(mainFrame, renderFrame);
    assert.ok(ssim >= 0.98, `main and Render previews disagree at the same instant: SSIM ${ssim}`);
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'render-preview-frame',
      source: renderFrame,
      description: 'The Render preview at the same instant, from the same project style.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-render-preview-same-scene',
      description: 'Opening Render preserves the exact edited project style and same-time pixels.',
      details: { ssim, style: EXPECTED_STYLE },
      focusSelector: '.video-preview-panel',
    });
  });
});

async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}
