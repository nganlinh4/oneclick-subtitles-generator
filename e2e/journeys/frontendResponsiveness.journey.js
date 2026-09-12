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
  await captureWorkflowStep({ workflow: WORKFLOW, step, description: step, details: result,
    focusSelector: step === '04-settings-open' ? '.settings-modal' : '.lyrics-display' });
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
    assert.equal(paused.progressWrites, 0, 'a paused row must not keep writing its progress bar');

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
    assert.ok(playing.progressWrites > 30 && playing.progressWrites <= playing.frames + 50,
      `progress must advance without multiplying animation loops: ${JSON.stringify(playing)}`);
    assert.equal(playing.resizeObservations['timeline-container'] ?? 0, 0);
    assert.equal(playing.resizeObservations['volume-visualizer'] ?? 0, 0);
    assert.ok(playing.timelinePaints <= 40, 'playback ticks must not each cause several full redraws');
    await browser.pause(500);
    const afterPause = await recordSample('03-paused-after-playback', () => browser.pause(2_000));
    assert.equal(afterPause.progressWrites, 0, 'pausing must cancel the animation owner');
    await recordSample('04-settings-open', async () => {
      await clickControl('[data-app-action="open-settings"]');
      await $('.settings-modal').waitForDisplayed({ timeout: 10_000 });
      await browser.pause(1_000);
    });
    await clickControl('[data-settings-action="close"]');
    await browser.pause(300);
    const repeated = await recordSample('05-repeated-settings', async () => {
      for (let count = 0; count < 6; count++) {
        await clickControl('[data-app-action="open-settings"]');
        await $('.settings-modal').waitForDisplayed();
        await clickControl('[data-settings-tab="video-processing"]');
        await browser.pause(200);
        await clickControl('[data-settings-action="close"]');
        await $('.settings-modal').waitForExist({ reverse: true });
      }
      await browser.pause(500);
    });
    assert.equal(repeated.detachedResizeObservations, 0, 'closed settings must not retain resize targets');
    assert.equal(repeated.retainedDocumentListeners.mouseup ?? 0, 0, 'closed sliders must release document listeners');
    assert.equal(repeated.retainedDocumentListeners.touchend ?? 0, 0);

    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed();
    await $('#subtitle-animation-type').scrollIntoView({ block: 'center' });
    await browser.pause(500);
    const menus = await recordSample('06-repeated-overflow-menus', async () => {
      for (let count = 0; count < 6; count++) {
        await clickControl('#subtitle-animation-type');
        await $('[role="listbox"]').waitForDisplayed();
        await browser.pause(350);
        const overflow = await browser.execute(() => {
          const list = document.querySelector('[role="listbox"]');
          list.scrollTop = list.scrollHeight;
          return { scrollHeight: list.scrollHeight, height: list.clientHeight };
        });
        assert.ok(overflow.scrollHeight > overflow.height, 'this must exercise a genuinely scrolling menu');
        if (count === 0) await captureWorkflowStep({ workflow: WORKFLOW, step: '06a-overflow-menu-open',
          description: 'The existing animation menu retains its styling and scrollbar after scrolling.',
          focusSelector: '.custom-dropdown-clipper', details: overflow });
        await browser.keys('Escape');
        await $('[role="listbox"]').waitForExist({ reverse: true });
      }
      await browser.pause(300);
    });
    assert.equal(menus.detachedResizeObservations, 0);
    assert.equal(menus.retainedDocumentListeners.mousemove ?? 0, 0);
    assert.equal(menus.retainedDocumentListeners.mouseup ?? 0, 0);
  });
});
