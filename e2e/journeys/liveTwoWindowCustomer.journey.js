import { strict as assert } from 'node:assert';
import process from 'node:process';
import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, recordWorkflowDiagnostic } from '../support/workflowEvidence.js';

/* global $, browser, describe, document, it, window */
const WORKFLOW = 'live-two-window-customer';

describe('Customer video with Gemini Transcribe Live', () => {
  it('records two ten-minute windows and actual timeline segments, including failures', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    await openProjectWithMedia();
    await enrollGeminiCredentials({ limit: 1 });
    const duration = await browser.execute(() => document.querySelector('video').duration);
    assert.ok(duration > 1370 && duration < 1385, 'expected the requested 22:58 source');
    await browser.execute(() => {
      window.__CUSTOMER_LIVE_RANGES__ = [];
      window.addEventListener('processing-ranges', (event) => {
        if (event.detail?.ranges?.length) window.__CUSTOMER_LIVE_RANGES__ = event.detail.ranges;
      });
    });
    await clickControl('[data-osg-action="generate-subtitles"]');
    const timeline = await $('.subtitle-timeline');
    await timeline.scrollIntoView({ block: 'center' });
    const { width } = await timeline.getSize();
    // Real pointer selection, within the first twenty minutes. Pixel precision is recorded below,
    // not disguised as an exact 0:00–20:00 range or injected into application state.
    await browser.action('pointer')
      .move({ origin: timeline, x: -Math.floor(width / 2) + 1, y: 0 })
      .down({ button: 0 }).pause(100)
      .move({ origin: timeline, x: Math.floor(1199 / duration * width) - Math.floor(width / 2), y: 0, duration: 450 })
      .up({ button: 0 }).perform();
    if (await $('.range-action-bar .btn-primary').isExisting()) {
      await clickControl('.range-action-bar .btn-primary');
    }
    await clickControl('[data-transcription-method="gemini-transcribe-live"]');
    assert.equal(await $('[data-osg-range-id="transcribe-window"]').getAttribute('aria-valuenow'), '10');
    await captureWorkflowStep({ workflow: WORKFLOW, step: '01-live-two-window-settings',
      description: 'Requested YouTube video; Live selected, ten-minute windows over a pointer-selected first-twenty-minute range.' });
    const started = Date.now();
    await clickControl('[data-osg-action="process-subtitles"]');
    await browser.waitUntil(() => browser.execute(() => window.__CUSTOMER_LIVE_RANGES__.length === 2), {
      timeout: 30000, timeoutMsg: 'the real app did not publish exactly two processing windows',
    });
    // An empty subtitle editor has no lyrics list yet. The timeline exists in both states.
    await browser.execute(() => document.querySelector('.subtitle-timeline').scrollIntoView({ block: 'center' }));
    const observations = [];
    let nextCapture = 0;
    let lastCount = -1;
    let index = 0;
    let terminalJobs = [];
    try {
      await browser.waitUntil(async () => {
        const elapsedMs = Date.now() - started;
        const surface = await browser.execute(() => ({
          segments: Number(document.querySelector('[data-osg-painted-subtitle-count]')?.dataset.osgPaintedSubtitleCount ?? -1),
          draftRows: document.querySelectorAll('[data-osg-live-draft]').length,
        }));
        const jobs = durableState(root).jobs.filter((job) => job.kind === 'transcribe');
        const running = jobs.some((job) => !['succeeded', 'failed', 'cancelled'].includes(job.state));
        observations.push({ elapsedMs, running, ...surface });
        if (elapsedMs >= nextCapture || surface.segments !== lastCount || (!running && jobs.length)) {
          await captureWorkflowStep({ workflow: WORKFLOW, step: `stream-${index++}-at-${Math.floor(elapsedMs / 1000)}s`,
            description: `${surface.segments} timeline subtitle segments; generation running: ${running}; ${elapsedMs}ms since Start.` });
          nextCapture = elapsedMs + 15000;
          lastCount = surface.segments;
        }
        terminalJobs = jobs;
        return jobs.length > 0 && !running;
      }, { timeout: 900000, interval: 500, timeoutMsg: 'generation did not settle in fifteen minutes' });
    } finally {
      const ranges = await browser.execute(() => window.__CUSTOMER_LIVE_RANGES__);
      recordWorkflowDiagnostic({ workflow: WORKFLOW, name: 'timeline-observations', file: 'diagnostics/timeline-observations.json',
        description: 'Actual timeline painter counts, selected source ranges and terminal job states; no draft-text pass criterion.',
        document: { source: 'https://www.youtube.com/watch?v=NmHhXoTckcM', duration, ranges, observations, jobs: terminalJobs } });
      await captureWorkflowStep({ workflow: WORKFLOW, step: '99-final-state', description: 'Final observed editor state, including any refusal.' });
    }
    assert.ok(terminalJobs.every((job) => job.state === 'succeeded'), 'Live-selected customer workflow failed; see screenshots and diagnostics');
    assert.ok(observations.some((sample) => sample.running && sample.segments > 0), 'No timeline segments appeared during generation');
    assert.ok(observations.every((sample) => sample.draftRows === 0), 'Unrequested draft-text UI returned');
  });
});
