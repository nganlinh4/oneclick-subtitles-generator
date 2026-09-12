import { strict as assert } from 'node:assert';
import { clickControl } from '../support/editor.js';
import {
  importSubtitleDocument, openProjectWithMedia, seekPreviewTo, waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { startFrontendSample, finishFrontendSample } from '../support/frontendPerformance.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

/* global $, browser, describe, document, it */

const WORKFLOW = 'frontend-responsiveness';
const LONG_CUE = 'A continuous subtitle for measuring playback and paused editor work';

const recordSample = async (step, action) => {
  await startFrontendSample();
  let result;
  try {
    await action();
  } finally {
    result = await finishFrontendSample();
  }
  await captureWorkflowStep({ workflow: WORKFLOW, step, description: step, details: result });
  return result;
};

describe('frontend work under real interactions', () => {
  it('measures paused, playing and modal-open editor work without changing its behavior', async () => {
    await openProjectWithMedia();
    await importSubtitleDocument(`1\n00:00:00,000 --> 00:00:17,000\n${LONG_CUE}\n`, 'continuous.srt', LONG_CUE);
    await seekPreviewTo(1);
    await waitForCanvasSubtitleFrame();
    await $('.lyrics-container').scrollIntoView({ block: 'center' });
    await browser.pause(1_000);
    const paused = await recordSample('01-paused-editor', () => browser.pause(2_000));
    assert.ok(paused.frames > 30, 'the hidden WebView must actually be painting');

    const playing = await recordSample('02-playing-editor', async () => {
      await browser.execute(async () => {
        const video = document.querySelector('.video-preview video.video-player');
        video.muted = true;
        await video.play();
      });
      await browser.pause(6_000);
      await browser.execute(() => document.querySelector('.video-preview video.video-player').pause());
    });
    assert.ok(playing.frames > 100);
    await browser.pause(500);
    await recordSample('03-paused-after-playback', () => browser.pause(2_000));
    await recordSample('04-settings-open', async () => {
      await clickControl('[data-app-action="open-settings"]');
      await $('.settings-modal').waitForDisplayed({ timeout: 10_000 });
      await browser.pause(1_000);
    });
    await clickControl('[data-settings-action="close"]');
  });
});
