// Opt-in documentation capture, not a claim of end-to-end generation coverage.
// Real Sintel trailer, isolated native app, ordinary SRT import and UI controls.
import { openProjectWithMedia, importSubtitleDocument, waitForCanvasSubtitleFrame } from '../support/workflow.js';
import { clickControl } from '../support/editor.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'readme-screenshots';
const CAPTIONS = `1
00:00:02,000 --> 00:00:06,000
A journey begins.

2
00:00:07,000 --> 00:00:12,000
Across mountains and unfamiliar lands.

3
00:00:13,000 --> 00:00:18,000
An unexpected friendship.

4
00:00:19,000 --> 00:00:24,000
Some bonds are worth fighting for.

5
00:00:25,000 --> 00:00:30,000
The search is far from over.

6
00:00:31,000 --> 00:00:37,000
Every step brings her closer.

7
00:00:38,000 --> 00:00:44,000
Sintel — a Blender Foundation open movie.

8
00:00:45,000 --> 00:00:50,000
Sample captions for the OSG editor.
`;

describe('README photography', () => {
  it('captures the real editor and subtitle styling without submitting cloud requests', async () => {
    await openProjectWithMedia();
    await clickControl('[data-app-action="open-settings"]');
    for (let index = 0; index < 2; index += 1) {
      const before = await $('.app-ui-scale output').getText();
      await clickControl('.settings-footer .app-ui-scale button:first-child');
      await browser.waitUntil(async () => (await $('.app-ui-scale output').getText()) !== before);
    }
    await clickControl('[data-settings-action="close"]');
    await importSubtitleDocument(CAPTIONS, 'sintel-sample-captions.srt', 'A journey begins.');
    await browser.execute(() => {
      const video = document.querySelector('.video-preview video.video-player');
      video.pause();
      video.currentTime = 15;
    });
    await waitForCanvasSubtitleFrame();
    await browser.pause(8_000); // Let normal import notifications expire.
    await captureWorkflowStep({
      workflow: WORKFLOW, step: '01-editor',
      description: 'Sintel trailer in the actual editor, with authored demonstration captions (not model output).',
      focusSelector: '.video-preview',
    });
    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({ timeout: 60_000 });
    await browser.execute(() => {
      const video = document.querySelector('.video-preview-panel video');
      video.pause();
      video.currentTime = 15;
      document.querySelector('.video-rendering-header').scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    await browser.waitUntil(() => browser.execute(() =>
      document.querySelector('.video-preview-panel [data-osg-preview]')?.getAttribute('data-osg-preview') === 'ready'
      && document.querySelector('.video-preview-panel video')?.currentTime === 15
      && document.querySelector('.video-preview-panel video')?.seeking === false), { timeout: 30_000 });
    await browser.pause(3_000);
    await captureWorkflowStep({
      workflow: WORKFLOW, step: '02-subtitle-styling',
      description: 'The real native render preview and subtitle controls.',
    });
  });
});
