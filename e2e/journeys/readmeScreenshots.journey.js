// Opt-in real YouTube -> supplied captions -> editor photography, not generation coverage.
import process from 'node:process';
import { strict as assert } from 'node:assert';
import { seekPreviewTo, waitForCanvasSubtitleFrame } from '../support/workflow.js';
import { clickControl, openEditor } from '../support/editor.js';
import { durableState } from '../support/database.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'readme-screenshots';
const SOURCE_URL = 'https://www.youtube.com/watch?v=2eFHWuNuDSA';

describe('README photography', () => {
  it('downloads a real narrated video and photographs its actual supplied captions', async () => {
    await openEditor();
    await clickControl('[data-app-action="open-settings"]');
    for (let index = 0; index < 2; index += 1) {
      const before = await $('.app-ui-scale output').getText();
      await clickControl('.settings-footer .app-ui-scale button:first-child');
      await browser.waitUntil(async () => (await $('.app-ui-scale output').getText()) !== before);
    }
    await clickControl('[data-settings-action="close"]');
    await $('.url-field').setValue(SOURCE_URL);
    await clickControl('[data-osg-action="generate-subtitles"]');
    await $('.subtitle-timeline').waitForDisplayed({ timeout: 600_000 });
    await browser.waitUntil(() => browser.execute(() => {
      const video = document.querySelector('.video-preview video.video-player');
      return video?.readyState >= 2 && video.duration > 600;
    }), { timeout: 120_000 });

    // Photograph the supplied YouTube captions, explicitly not claimed as model output.
    if (await $('.video-processing-modal').isExisting()) await browser.keys('Escape');
    const root = process.env.OSG_E2E_DATA_ROOT;
    let result;
    await browser.waitUntil(() => {
      result = durableState(root);
      return result.jobs.some(job => job.kind === 'downloadMedia' && job.state === 'succeeded')
        && result.cues.length > 15;
    }, { timeout: 60_000, interval: 1000 });
    assert.ok(result.cues.every(cue => cue.end_ms > cue.start_ms));
    // Inspected the raw 8:15 interview shot: no burned-in subtitles or lower-third name banner.
    const cue = result.cues.find(cue => cue.start_ms <= 495000 && cue.end_ms > 495000);
    assert.ok(cue, 'the inspected interview moment must contain a supplied subtitle');
    const seconds = (cue.start_ms + cue.end_ms) / 2000;
    await seekPreviewTo(seconds);
    await waitForCanvasSubtitleFrame();
    await browser.pause(8000);
    await browser.execute(() => document.querySelector('.video-preview')
      .scrollIntoView({ block: 'start', behavior: 'instant' }));
    const details = { sourceUrl: SOURCE_URL, cueCount: result.cues.length, displayedCue: cue.text, seconds };
    await captureWorkflowStep({
      workflow: WORKFLOW, step: '01-editor',
      description: 'NASA Goddard YouTube video and its supplied captions downloaded by OSG, not model output.',
      details,
    });
    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({ timeout: 60_000 });
    await browser.execute((time) => {
      const video = document.querySelector('.video-preview-panel video');
      video.pause();
      video.currentTime = time;
      document.querySelector('.video-rendering-header').scrollIntoView({ block: 'start', behavior: 'instant' });
    }, seconds);
    await browser.waitUntil(() => browser.execute(() =>
      document.querySelector('.video-preview-panel [data-osg-preview]')?.getAttribute('data-osg-preview') === 'ready'
      && document.querySelector('.video-preview-panel video')?.seeking === false), { timeout: 30_000 });
    await browser.pause(3000);
    await captureWorkflowStep({
      workflow: WORKFLOW, step: '02-subtitle-styling',
      description: 'Actual supplied YouTube captions in the native render preview and styling controls.',
      details,
    });
  });
});
