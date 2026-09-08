import { strict as assert } from 'node:assert';
import process from 'node:process';
import { durableState, withDatabase } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia, importSubtitles, seekPreviewTo } from '../support/workflow.js';
import { captureWorkflowStep, recordWorkflowDiagnostic } from '../support/workflowEvidence.js';

/* global $, browser, describe, document, it, window, innerHeight, MutationObserver, KeyboardEvent */
const WORKFLOW = 'word-native-parallel-long-recording';

describe('Live transcription uses the ordinary parallel subtitle editor', () => {
  it('shows changing visible text before completion across a four-window request', async () => {
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
    await clickControl('[data-osg-range-id="transcribe-window"]');
    // The off-screen, non-activating WebView cannot reliably receive OS key focus.
    // Exercise the real control's key handler, without setting React or input state.
    await browser.execute(() => {
      document.querySelector('[data-osg-range-id="transcribe-window"]')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    await browser.waitUntil(async () => (await $('[data-osg-range-id="transcribe-window"]').getAttribute('aria-valuenow')) === '1', {
      timeout: 5000, timeoutMsg: 'the one-minute request control did not accept its Home key',
    });
    await captureWorkflowStep({ workflow: WORKFLOW, step: '01-four-window-controls', description: 'Live selected with a one-minute maximum over a 204-second recording.' });
    await clickControl('[data-osg-action="process-subtitles"]');
    await browser.waitUntil(() => browser.execute(() => window.__LIVE_WINDOWS__.ranges.length === 4), {
      timeout: 15000, timeoutMsg: 'the existing timeline never received four processing ranges',
    });
    await browser.execute(() => document.querySelector('.lyrics-container').scrollIntoView({ block: 'center' }));
    const started = Date.now();
    const observations = [];
    let nextScreenshot = 0;
    // Observe painted row TEXT over wall-clock time, not our own revision attributes.
    // Finish the recording even when streaming is absent, so a final burst is preserved as evidence.
    await browser.waitUntil(async () => {
      const elapsedMs = Date.now() - started;
      const visible = await browser.execute(() => {
        const list = document.querySelector('.lyrics-container');
        const bounds = list.getBoundingClientRect();
        return [...list.querySelectorAll('.lyric-item')].filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > Math.max(0, bounds.top) && rect.top < Math.min(innerHeight, bounds.bottom);
        }).map((row) => ({
          text: row.querySelector('.lyric-text')?.textContent?.trim() ?? '',
          draft: row.hasAttribute('data-osg-live-draft'),
          window: row.getAttribute('data-osg-live-window'),
        }));
      });
      const jobs = durableState(root).jobs.filter((job) => job.kind === 'transcribe');
      const running = jobs.some((job) => !['succeeded', 'failed', 'cancelled'].includes(job.state));
      observations.push({ elapsedMs, running, visible });
      if (elapsedMs >= nextScreenshot) {
        await captureWorkflowStep({ workflow: WORKFLOW, step: `stream-at-${Math.floor(elapsedMs / 1000)}s`,
          description: `Unassisted visible editor at ${elapsedMs}ms; native job running: ${running}.` });
        nextScreenshot = elapsedMs + 15000;
      }
      return jobs.length > 0 && !running;
    }, { timeout: 180000, interval: 500, timeoutMsg: 'transcription never settled during the observation recording' });
    recordWorkflowDiagnostic({ workflow: WORKFLOW, name: 'visible-streaming', file: 'diagnostics/visible-streaming.json',
      description: 'Wall-clock samples of viewport-visible row text and native job state; attributes are not the pass oracle.',
      document: { mediaDurationSeconds: duration, observations } });
    const ledger = await browser.execute(() => window.__LIVE_WINDOWS__);
    assert.deepEqual(ledger.ranges.slice(0, 3).map(({ start, end }) => [start, end]), [[0, 60], [60, 120], [120, 180]]);
    assert.ok(Math.abs(ledger.ranges[3].end - duration) < 0.1);
    assert.equal(ledger.rowsOutsideEditor, false);
    assert.equal(await browser.execute(() => !!document.querySelector('.live-transcription-drafts-panel, .live-transcription-window-pending')), false);
    process.stdout.write(`Live per-window DOM revisions: ${JSON.stringify(ledger)}\n`);
    await captureWorkflowStep({ workflow: WORKFLOW, step: '02-observed-editor', description: 'Editor after the timed observation; this screenshot alone is not streaming proof.' });
    await browser.waitUntil(() => {
      const jobs = durableState(root).jobs.filter((job) => job.kind === 'transcribe');
      return jobs.length > 0 && jobs.every((job) => job.state === 'succeeded');
    }, { timeout: 180000, interval: 500, timeoutMsg: 'four-window transcription did not complete' });
    await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-osg-live-draft]')), {
      timeout: 15000, timeoutMsg: 'Live rows did not reconcile into timed captions',
    });
    const metadata = withDatabase(root, (db) => JSON.parse(db.prepare('SELECT metadata_json FROM transcript_revisions ORDER BY rowid DESC LIMIT 1').get().metadata_json));
    assert.equal(metadata.totalWindows, 4);
    // Job completion precedes frontend reconciliation and its durable checkpoint.
    await browser.waitUntil(() => durableState(root).counts.cues > 3, {
      timeout: 15000, interval: 250, timeoutMsg: 'generated captions never reached the subtitle checkpoint',
    });
    await captureWorkflowStep({ workflow: WORKFLOW, step: '03-timed-captions', description: 'Live rows reconciled to final durable timed captions.' });
    const terminalMs = observations.at(-1).elapsedMs;
    const earlyTextStates = new Set(observations.filter((sample) => sample.running && sample.elapsedMs < terminalMs - 5000)
      .map((sample) => sample.visible.filter((row) => row.draft && row.text).map((row) => row.text).join('\n'))
      .filter(Boolean));
    assert.ok(earlyTextStates.size >= 3,
      `No real early streaming: only ${earlyTextStates.size} distinct visible Live text states before the last five seconds. Final captions do not count.`);
  });
});
