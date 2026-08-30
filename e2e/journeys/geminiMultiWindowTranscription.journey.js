/* global $, browser, describe, document, it, window */

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { FOUR_WINDOW_ASR_FIXTURE } from '../support/fourWindowAsrFixture.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'gemini-multi-window-transcription';
const EXPECTED_WINDOWS = FOUR_WINDOW_ASR_FIXTURE.expectedWindowCount;
const terminalStates = new Set(['failed', 'cancelled', 'interrupted']);

const readWitness = () => browser.execute(() => JSON.parse(JSON.stringify(
  window.__OSG_GEMINI_WINDOWS__ ?? { ranges: [], streams: [], errors: [] },
)));

describe('Gemini transcribes a real four-window source', () => {
  it('splits the public one-minute request, streams every window and persists one merged track', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the Gemini multi-window journey requires an isolated root');
    await openProjectWithMedia();
    const enrollment = await enrollGeminiCredentials({ limit: 20 });
    assert.equal(enrollment.enrolled, 20);

    const duration = await browser.execute(() => document.querySelector('video.video-player')?.duration ?? null);
    assert.ok(Math.abs(duration - FOUR_WINDOW_ASR_FIXTURE.durationSeconds)
      <= FOUR_WINDOW_ASR_FIXTURE.durationToleranceSeconds,
    `the staged source has unexpected duration ${duration}`);

    await browser.execute(() => {
      const ledger = { ranges: [], streams: [], errors: [] };
      window.__OSG_GEMINI_WINDOWS__ = ledger;
      window.addEventListener('processing-ranges', (event) => {
        const ranges = event.detail?.ranges;
        if (Array.isArray(ranges) && ledger.ranges.length < 16) {
          ledger.ranges.push(ranges.map(({ start, end }) => ({ start, end })));
        }
      });
      window.addEventListener('streaming-update', (event) => {
        const rows = event.detail?.subtitles;
        if (Array.isArray(rows) && ledger.streams.length < 64) {
          ledger.streams.push({ count: rows.length, segment: event.detail?.segment ?? null });
        }
      });
      window.addEventListener('unhandledrejection', (event) => {
        if (ledger.errors.length < 16) ledger.errors.push(String(event.reason?.message ?? event.reason));
      });
    });

    const baseline = durableState(root);
    const priorJobs = new Set(baseline.jobs.filter(({ kind }) => kind === 'transcribe').map(({ id }) => id));
    await clickControl('[data-osg-action="generate-subtitles"]');
    const timeline = await $('.subtitle-timeline');
    await timeline.waitForDisplayed({ timeout: 60_000 });
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);
    const method = await $('[data-transcription-method="new"]');
    await method.waitForClickable({ timeout: 60_000 });
    await method.click();
    const actuation = await actuateNativeRange({
      driver: browser,
      selector: '#max-duration-slider',
      value: 1,
      label: 'Gemini one-minute maximum request duration',
    });
    assert.equal(actuation.value, 1);
    await clickControl('[data-osg-action="process-subtitles"]');

    let jobs = [];
    let durable = null;
    let surface = null;
    let witness = null;
    await browser.waitUntil(async () => {
      durable = durableState(root);
      jobs = durable.jobs.filter(({ id, kind }) => kind === 'transcribe' && !priorJobs.has(id));
      surface = await browser.execute(() => ({
        processing: document.querySelector('[data-osg-action="generate-subtitles"]')
          ?.classList.contains('processing') === true,
        errorToasts: [...document.querySelectorAll('.toast-error')]
          .map((node) => (node.querySelector('p')?.innerText || node.innerText || '').trim())
          .filter(Boolean),
        visibleCueCount: document.querySelectorAll('.lyric-text').length,
      }));
      witness = await readWitness();
      if (surface.errorToasts.length > 0 || jobs.some(({ state }) => terminalStates.has(state))) {
        throw new Error(`Gemini multi-window run terminated: ${JSON.stringify({ jobs, surface, witness })}`);
      }
      return jobs.length === EXPECTED_WINDOWS
        && jobs.every(({ state }) => state === 'succeeded')
        && surface.processing === false
        && surface.visibleCueCount > 0
        && durable.counts.cues > 0;
    }, {
      timeout: 20 * 60_000,
      interval: 2_000,
      timeoutMsg: 'the four-window Gemini run never completed four succeeded jobs',
    });

    const ranges = witness.ranges.find((entry) => entry.length === EXPECTED_WINDOWS);
    assert.ok(ranges, `the UI never published four request windows: ${JSON.stringify(witness.ranges)}`);
    assert.ok(witness.streams.length >= EXPECTED_WINDOWS,
      `the four windows were not streamed incrementally: ${JSON.stringify(witness.streams)}`);
    assert.deepEqual(witness.errors, [], 'the WebView recorded a provider runtime rejection');
    assert.equal(durable.latestRevision?.cue_count, durable.counts.cues);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-four-live-windows-complete',
      description: 'The public one-minute setting split 204 seconds of real speech into four live Gemini jobs and merged their streamed cues durably.',
      details: {
        durationSeconds: duration,
        requestWindowCount: ranges.length,
        streamPublicationCount: witness.streams.length,
        cueCount: durable.counts.cues,
      },
      focusSelector: '.timeline-container',
    });
  });
});
