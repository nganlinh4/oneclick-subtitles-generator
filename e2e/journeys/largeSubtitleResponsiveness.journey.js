import { strict as assert } from 'node:assert';
import { openEditor } from '../support/editor.js';
import { importSubtitleDocument } from '../support/workflow.js';
import { startFrontendSample, finishFrontendSample } from '../support/frontendPerformance.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

/* global $, browser, describe, document, it */
const WORKFLOW = 'large-subtitle-responsiveness';
const COUNT = 2000;
const timestamp = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},000`;
const documentText = Array.from({ length: COUNT }, (_, index) =>
  `${index + 1}\n${timestamp(index * 4)} --> ${timestamp(index * 4 + 3)}\nLong document cue ${index + 1}\n`).join('\n');

describe('a multi-hour subtitle document remains responsive', () => {
  it('imports 2000 real cues, scrolls to the last row and releases recycled controls', async () => {
    await openEditor();
    await importSubtitleDocument(documentText, 'multi-hour.srt', 'Long document cue 1');
    await $('.lyrics-container').waitForDisplayed();
    await browser.waitUntil(() => browser.execute(() =>
      Number(document.querySelector('.subtitle-timeline')?.dataset.osgPaintedSubtitleCount) === 2000),
    { timeout: 30_000, timeoutMsg: 'all 2000 imported cues must be painted on the timeline' });
    await captureWorkflowStep({ workflow: WORKFLOW, step: '01-imported',
      description: 'A real 2,000-cue SRT document spanning over two hours, imported through the public drop target.',
      focusSelector: '.lyrics-display', details: { cueCount: COUNT } });
    await startFrontendSample();
    let result;
    try {
      for (let index = 0; index < 12; index++) {
        await browser.execute(fraction => {
          const list = document.querySelector('.lyrics-container');
          list.scrollTop = (list.scrollHeight - list.clientHeight) * fraction;
        }, (index % 4) / 3);
        await browser.pause(200);
      }
      await $('.lyric-item[data-lyric-index="1999"]').waitForDisplayed();
      await browser.pause(300);
    } finally { result = await finishFrontendSample(); }
    assert.ok(result.visibleRows > 0 && result.visibleRows < 30, 'the real list must remain virtualized');
    assert.equal(result.detachedResizeObservations, 0, 'scrolled-out rows must not retain resize observers');
    assert.ok(result.maxLongTaskMs < 250, `large-document scrolling stalled: ${JSON.stringify(result)}`);
    assert.equal(await $('.lyric-item[data-lyric-index="1999"] .lyric-text').getText(), 'Long document cue 2000');
    await captureWorkflowStep({ workflow: WORKFLOW, step: '02-last-cue-after-repeated-scrolling',
      description: 'The last cue is reachable after repeated long scrolls; mounted rows and retained observers remain bounded.',
      focusSelector: '.lyrics-display', details: result });
  });
});
