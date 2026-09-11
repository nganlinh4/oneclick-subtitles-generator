// Enumerate what the real editor exposes, so journeys target ground truth.
//
// Not an assertion of product behaviour and deliberately not part of the default glob: it exists so
// a customer journey can be written against the controls the application really renders rather than
// against names guessed from source. Run it with `npm --prefix e2e run recon` when the UI moves.

import { openProjectWithMedia, importSubtitles, waitForCanvasSubtitleFrame } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'reconnaissance';

const survey = () => browser.execute(() => {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const label = (node) => (
    node.getAttribute('aria-label')
    || node.getAttribute('title')
    || (node.innerText || '').trim().slice(0, 50)
    || node.getAttribute('placeholder')
    || ''
  );
  const describe = (node) => ({
    label: label(node),
    className: (node.getAttribute('class') || '').slice(0, 60),
    disabled: node.disabled === true,
  });

  const firstCueRow = document.querySelector('[class*="lyric-item" i], [class*="lyric-row" i], [class*="lyric" i]');
  return {
    buttons: [...document.querySelectorAll('button')].filter(visible).map(describe),
    inputs: [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')]
      .filter(visible).map(describe),
    // The structure of one cue row, which is what an edit has to drive.
    firstCueRow: firstCueRow === null ? null : {
      className: firstCueRow.getAttribute('class'),
      html: firstCueRow.outerHTML.slice(0, 900),
    },
  };
});

const show = (label, value) => console.log(`=== ${label} ===\n${JSON.stringify(value, null, 2)}`);

describe('the editor surface', () => {
  it('reports the controls reachable once a project has media and subtitles', async () => {
    await openProjectWithMedia();
    await importSubtitles();
    await browser.execute(() => {
      const video = document.querySelector('.video-preview video.video-player');
      if (video !== null) video.currentTime = 1;
    });
    await waitForCanvasSubtitleFrame();
    await browser.pause(3_000);

    const controls = await survey();
    show('with media and subtitles', controls);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-editor-with-media-and-subtitles',
      description: 'Unconstrained release reconnaissance of the current editor after real media and subtitles are active.',
      details: controls,
      focusSelector: '.video-preview',
    });
  });
});
