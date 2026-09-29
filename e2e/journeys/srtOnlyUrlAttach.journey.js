/* global $, browser, describe, document, it */
import { strict as assert } from 'node:assert';
import process from 'node:process';
import { durableState } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { importSubtitles } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

describe('a standalone subtitle document receives its first URL video', () => {
  it('keeps the same project and cues while downloading real YouTube media', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    await openEditor();
    await importSubtitles();
    const before = durableState(root);
    assert.equal(before.counts.projects, 1);
    await (await $('.url-field')).setValue('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    // Selecting a URL makes the ordinary preparation action available.
    await clickControl('[data-osg-action="generate-subtitles"]');
    await browser.waitUntil(async () => browser.execute(() => {
      const video = document.querySelector('.video-preview video');
      return video !== null && video.readyState >= 2 && Number.isFinite(video.duration);
    }), { timeout: 300000, interval: 500 });
    if (await (await $('.video-processing-modal')).isExisting()) await browser.keys('Escape');
    const after = durableState(root);
    assert.equal(after.counts.projects, 1);
    assert.equal(after.counts.media, 1);
    assert.deepEqual(after.projects.map(row => row.id), before.projects.map(row => row.id));
    assert.deepEqual(after.cues.map(row => row.text), before.cues.map(row => row.text));
    await (await $('.video-preview')).scrollIntoView({ block: 'start' });
    await browser.pause(5000);
    await captureWorkflowStep({ workflow: 'srt-only-url-attach', step: '01-url-attached', description: 'Real YouTube media attached to the original standalone subtitle project without replacing its cues.' });
  });
});
