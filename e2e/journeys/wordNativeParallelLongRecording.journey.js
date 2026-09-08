import { strict as assert } from 'node:assert';
import process from 'node:process';
import { durableState, withDatabase } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import { openProjectWithMedia, importSubtitles, seekPreviewTo } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

/* global $, browser, describe, document, it, window, MutationObserver */
const WORKFLOW = 'word-native-parallel-long-recording';

describe('Live transcription uses the ordinary parallel subtitle editor', () => {
  it('streams all four windows into the existing list while pre-existing subtitles are loaded', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    await openProjectWithMedia();
    await importSubtitles();
    await seekPreviewTo(120);
    await enrollGeminiCredentials({ limit: 1 });
    const duration = await browser.execute(() => document.querySelector('video').duration);
    assert.ok(duration > 180 && duration < 240, 'run with the four-window scenario fixture');
    await browser.execute(() => {
      const ledger = { ranges: [], windows: {}, rowsOutsideEditor: false };
      window.__LIVE_WINDOWS__ = ledger;
      window.addEventListener('processing-ranges', (event) => {
        if (event.detail?.ranges?.length) ledger.ranges = event.detail.ranges;
      });
      new MutationObserver(() => {
        for (const row of document.querySelectorAll('[data-osg-live-draft]')) {
          const index = row.dataset.osgLiveWindow;
          const revisions = ledger.windows[index] ??= [];
          const revision = Number(row.dataset.osgLiveUpdate);
          if (!revisions.includes(revision)) revisions.push(revision);
          if (!row.closest('.lyrics-container')) ledger.rowsOutsideEditor = true;
        }
      }).observe(document.body, { attributes: true, childList: true, characterData: true, subtree: true });
    });
    await clickControl('[data-osg-action="generate-subtitles"]');
    await clickControl('.subtitle-timeline');
    await browser.keys(['\uE009', 'a', '\uE000']);
    if (await (await $('.range-action-bar .btn-primary')).isExisting()) {
      await clickControl('.range-action-bar .btn-primary');
    }
    await clickControl('[data-transcription-method="new"]');
    await clickControl('.header-switch-group .custom-dropdown-button');
    await clickControl('[role="option"][data-value="gemini-transcribe-live"]');
    await actuateNativeRange({ driver: browser, selector: '#transcribe-window', value: 1 });
    await captureWorkflowStep({ workflow: WORKFLOW, step: '01-four-window-controls', description: 'Live selected with a one-minute maximum over a 204-second recording.' });
    await clickControl('[data-osg-action="process-subtitles"]');
    await browser.waitUntil(() => browser.execute(() => window.__LIVE_WINDOWS__.ranges.length === 4), {
      timeout: 15000, timeoutMsg: 'the existing timeline never received four processing ranges',
    });
    await browser.waitUntil(() => browser.execute(() => Object.values(window.__LIVE_WINDOWS__.windows)
      .filter((revisions) => revisions.length >= 3).length === 4), {
      timeout: 90000, interval: 100, timeoutMsg: 'not every window streamed repeated text revisions into the ordinary editor',
    });
    const ledger = await browser.execute(() => window.__LIVE_WINDOWS__);
    assert.equal(ledger.rowsOutsideEditor, false);
    assert.equal(await browser.execute(() => !!document.querySelector('.live-transcription-drafts-panel, .live-transcription-window-pending')), false);
    process.stdout.write(`Live per-window DOM revisions: ${JSON.stringify(ledger)}\n`);
    await captureWorkflowStep({ workflow: WORKFLOW, step: '02-four-windows-streaming', focusSelector: '.lyrics-container', description: 'Each of four windows has delivered multiple revisions into the original subtitle list.' });
    await browser.waitUntil(() => {
      const jobs = durableState(root).jobs.filter((job) => job.kind === 'transcribe');
      return jobs.length > 0 && jobs.every((job) => job.state === 'succeeded');
    }, { timeout: 180000, interval: 500, timeoutMsg: 'four-window transcription did not complete' });
    await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-osg-live-draft]')), {
      timeout: 15000, timeoutMsg: 'Live rows did not reconcile into timed captions',
    });
    const metadata = withDatabase(root, (db) => JSON.parse(db.prepare('SELECT metadata_json FROM transcript_revisions ORDER BY rowid DESC LIMIT 1').get().metadata_json));
    assert.equal(metadata.totalWindows, 4);
    assert.ok(durableState(root).counts.cues > 3);
    await captureWorkflowStep({ workflow: WORKFLOW, step: '03-timed-captions', description: 'Live rows reconciled to final durable timed captions.' });
  });
});
