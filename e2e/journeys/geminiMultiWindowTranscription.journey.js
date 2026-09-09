/* global $, browser, describe, document, it, localStorage, window */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
const milestone = (name, details = {}) => {
  process.stdout.write(`[gemini-multi-window] ${name} ${JSON.stringify(details)}\n`);
};

const readWitness = () => browser.execute(() => JSON.parse(JSON.stringify(
  window.__OSG_GEMINI_WINDOWS__ ?? { ranges: [], streams: [], errors: [] },
)));

const transcriptionDiagnostics = (root) => readFileSync(join(root, 'logs', 'osg.log'), 'utf8')
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter(({ event }) => typeof event === 'string' && event.startsWith('transcribe.'));

describe('Gemini transcribes a real four-window source', () => {
  it('splits the public one-minute request, streams every window and persists one merged track', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the Gemini multi-window journey requires an isolated root');
    await openProjectWithMedia();
    milestone('media-ready');
    // Match the customer's normal configuration: one enrolled key serving every
    // parallel window. A large synthetic key pool can hide permit starvation and
    // retry serialization that the installed product actually experiences.
    const enrollment = await enrollGeminiCredentials({ limit: 1 });
    assert.equal(enrollment.enrolled, 1);
    milestone('credentials-enrolled', { count: enrollment.enrolled });

    const duration = await browser.execute(() => document.querySelector('video.video-player')?.duration ?? null);
    const customMedia = Math.abs(duration - FOUR_WINDOW_ASR_FIXTURE.durationSeconds)
      > FOUR_WINDOW_ASR_FIXTURE.durationToleranceSeconds;
    assert.equal(Math.ceil(duration / 60), EXPECTED_WINDOWS,
      `the customer reproduction must exercise four windows, got ${duration}s`);
    milestone('duration-verified', { duration });

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
    milestone('generation-opened');
    const timeline = await $('.subtitle-timeline');
    await timeline.waitForDisplayed({ timeout: 60_000 });
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);
    const method = await $('[data-transcription-method="gemini-transcribe-live"]');
    await method.waitForClickable({ timeout: 60_000 });
    await method.click();
    milestone('method-selected');
    const actuation = await actuateNativeRange({
      driver: browser,
      selector: '#transcribe-window',
      value: 1,
      label: 'Gemini one-minute maximum request duration',
    });
    assert.equal(actuation.value, 1);
    milestone('request-window-selected', { minutes: actuation.value });
    milestone('before-process', await browser.execute(() => ({
      actionDisabled: document.querySelector('[data-osg-action="process-subtitles"]')?.disabled ?? null,
      selectedRange: document.querySelector('#transcribe-window')?.value ?? null,
      modalText: (document.querySelector('.video-processing-modal')?.innerText || '').slice(0, 500),
    })));
    await clickControl('[data-osg-action="process-subtitles"]');
    const processingStartedAt = Date.now();
    milestone('process-clicked');

    let jobs = [];
    let durable = null;
    let surface = null;
    let witness = null;
    let lastProgressTrace = 0;
    let terminalFailure = null;
    let sawCuesWhileRunning = false;
    let firstCueElapsedMs = null;
    await browser.waitUntil(async () => {
      durable = durableState(root);
      jobs = durable.jobs.filter(({ id, kind }) => kind === 'transcribe' && !priorJobs.has(id));
      surface = await browser.execute(() => ({
        processing: document.querySelector('[data-osg-action="generate-subtitles"]')
          ?.classList.contains('processing') === true,
        toasts: [...document.querySelectorAll('.toast')].map((node) => ({
          kind: [...node.classList].find((name) => name.startsWith('toast-')) ?? null,
          text: (node.innerText || '').trim(),
        })),
        toastHistory: (() => {
          try {
            const rows = JSON.parse(localStorage.getItem('toast_history_v1') || '[]');
            return Array.isArray(rows)
              ? rows.slice(0, 8).map(({ type, message }) => ({ type, message }))
              : [];
          } catch { return []; }
        })(),
        errorToasts: [...document.querySelectorAll('.toast-error')]
          .map((node) => (node.querySelector('p')?.innerText || node.innerText || '').trim())
          .filter(Boolean),
        visibleCueCount: document.querySelectorAll('.lyric-text').length,
      }));
      witness = await readWitness();
      if (jobs.some(({ state }) => state === 'running') && surface.visibleCueCount > 0) {
        sawCuesWhileRunning = true;
        firstCueElapsedMs ??= Date.now() - processingStartedAt;
      }
      if (Date.now() - lastProgressTrace >= 10_000) {
        lastProgressTrace = Date.now();
        milestone('processing-observation', {
          jobs: jobs.map(({ kind, state, progress_basis_points: progress }) => ({
            kind, state, progress,
          })),
          processing: surface.processing,
          toasts: surface.toasts,
          toastHistory: surface.toastHistory,
          errorToasts: surface.errorToasts,
          visibleCueCount: surface.visibleCueCount,
          publishedRangeShapes: witness.ranges.map((ranges) => ranges.length),
          streamPublications: witness.streams.length,
          runtimeErrors: witness.errors,
        });
      }
      if (surface.errorToasts.length > 0 || jobs.some(({ state }) => terminalStates.has(state))) {
        terminalFailure = `Gemini multi-window run terminated: ${JSON.stringify({ jobs, surface, witness })}`;
        return true;
      }
      if (surface.processing === false && jobs.length === 0 && witness.streams.length === 0) {
        terminalFailure = `Gemini multi-window run stopped before creating a provider job: ${JSON.stringify({ surface, witness })}`;
        return true;
      }
      return jobs.length === 1
        && jobs[0].state === 'succeeded'
        && surface.processing === false
        && surface.visibleCueCount > 0
        && durable.counts.cues > 0;
    }, {
      timeout: 90_000,
      interval: 2_000,
      timeoutMsg: 'the four-window Gemini run never completed four succeeded jobs',
    });
    if (terminalFailure !== null) throw new Error(terminalFailure);

    const ranges = witness.ranges.find((entry) => entry.length === EXPECTED_WINDOWS);
    assert.ok(ranges, `the UI never published four request windows: ${JSON.stringify(witness.ranges)}`);
    assert.equal(sawCuesWhileRunning, true,
      'no subtitle segment became visible before the native transcription job completed');
    assert.ok(firstCueElapsedMs !== null && firstCueElapsedMs <= 30_000,
      `the first streamed subtitle took ${firstCueElapsedMs ?? 'unknown'} ms (maximum 30000 ms)`);
    const completionElapsedMs = Date.now() - processingStartedAt;
    assert.ok(completionElapsedMs <= 90_000,
      `the four-window transcription took ${completionElapsedMs} ms (maximum 90000 ms)`);
    assert.deepEqual(witness.errors, [], 'the WebView recorded a provider runtime rejection');
    assert.equal(durable.latestRevision?.cue_count, durable.counts.cues);
    const diagnostics = transcriptionDiagnostics(root);
    const assignments = diagnostics.filter(({ event }) => event === 'transcribe.window.credential_assigned');
    assert.deepEqual(
      assignments.map(({ credential_slot: slot }) => Number(slot)),
      [0, 0, 0, 0],
      'the customer reproduction did not run all four windows through its one enrolled credential',
    );
    assert.ok(assignments.every(({ credential_pool_size: size }) => Number(size) === 1),
      'the customer reproduction unexpectedly used a synthetic multi-key credential pool');
    if (customMedia) {
      assert.equal(
        diagnostics.filter(({ event }) => event === 'transcribe.live.inactive_recovery_finished').length,
        EXPECTED_WINDOWS,
        'the singing-video reproduction did not recover every silent Live window',
      );
    }
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-four-live-windows-complete',
      description: 'The public one-minute setting split 204 seconds of real speech into four live Gemini jobs and merged their streamed cues durably.',
      details: {
        durationSeconds: duration,
        requestWindowCount: ranges.length,
        streamPublicationCount: witness.streams.length,
        cueCount: durable.counts.cues,
        firstCueElapsedMs,
        completionElapsedMs,
      },
      focusSelector: '.timeline-container',
    });
  });
});
