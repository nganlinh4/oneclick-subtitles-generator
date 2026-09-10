/* global $, browser, describe, document, it, localStorage, window */

import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { durableState, durableTranscriptWords } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { FOUR_WINDOW_ASR_FIXTURE } from '../support/fourWindowAsrFixture.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'gemini-multi-window-transcription';
const EXPECTED_WINDOWS = FOUR_WINDOW_ASR_FIXTURE.expectedWindowCount;
const terminalStates = new Set(['failed', 'cancelled', 'interrupted']);
const milestone = (name, details = {}) => {
  process.stdout.write(`[gemini-multi-window] ${name} ${JSON.stringify(details)}\n`);
};

const readWitness = () => browser.execute(() => JSON.parse(JSON.stringify(
  window.__OSG_GEMINI_WINDOWS__ ?? { ranges: [], errors: [] },
)));

const transcriptionDiagnostics = (root) => readFileSync(join(root, 'logs', 'osg.log'), 'utf8')
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter(({ event }) => typeof event === 'string' && event.startsWith('transcribe.'));

describe('Gemini Transcribe Live handles the real customer workflow', () => {
  it('streams a real four-window recording through Live only and persists one merged track', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the Gemini multi-window journey requires an isolated root');
    await openProjectWithMedia();
    milestone('media-ready');
    const duration = await browser.execute(() => document.querySelector('video.video-player')?.duration ?? null);
    // Live reserves three seconds of each request for prefix context, so a one-minute physical
    // request owns at most 57 seconds. Match the native planner rather than the generic splitter.
    const expectedWindows = Math.ceil(duration / 57);
    assert.ok(expectedWindows >= EXPECTED_WINDOWS,
      `the customer reproduction must exercise at least four windows, got ${duration}s`);
    milestone('duration-verified', { duration });

    // Exercise the installed app's real parallel scheduling with the same credential pool the
    // customer configured. One credential per window prevents this quality benchmark from
    // accidentally measuring a 15-minute serial queue instead of Live transcription quality.
    const enrollment = await enrollGeminiCredentials({ limit: Math.min(expectedWindows, 20) });
    assert.equal(enrollment.enrolled, Math.min(expectedWindows, 20));
    milestone('credentials-enrolled', { count: enrollment.enrolled });

    await browser.execute(() => {
      const ledger = { ranges: [], errors: [] };
      window.__OSG_GEMINI_WINDOWS__ = ledger;
      window.addEventListener('processing-ranges', (event) => {
        const ranges = event.detail?.ranges;
        if (Array.isArray(ranges) && ledger.ranges.length < 64) {
          ledger.ranges.push(ranges.map(({ start, end }) => ({ start, end })));
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
          runtimeErrors: witness.errors,
        });
      }
      if (surface.errorToasts.length > 0 || jobs.some(({ state }) => terminalStates.has(state))) {
        terminalFailure = `Gemini multi-window run terminated: ${JSON.stringify({ jobs, surface, witness })}`;
        return true;
      }
      if (surface.processing === false && jobs.length === 0) {
        terminalFailure = `Gemini multi-window run stopped before creating a provider job: ${JSON.stringify({ surface, witness })}`;
        return true;
      }
      return jobs.length === 1
        && jobs[0].state === 'succeeded'
        && surface.processing === false
        && surface.visibleCueCount > 0
        && durable.counts.cues > 0;
    }, {
      timeout: Math.max(90_000, Math.ceil(expectedWindows / 4) * 75_000),
      interval: 2_000,
      timeoutMsg: 'the real four-window Gemini Live run did not complete its native job',
    });
    if (terminalFailure !== null) throw new Error(terminalFailure);

    const ranges = witness.ranges.find((entry) => entry.length === expectedWindows);
    assert.ok(ranges, `the UI never published ${expectedWindows} request windows: ${JSON.stringify(witness.ranges)}`);
    assert.ok(durable.cues.some((cue) => cue.end_ms > duration * 500),
      'genuine Live transcription persisted no subtitle coverage in the latter half');
    assert.equal(sawCuesWhileRunning, true,
      'no subtitle segment became visible before the native transcription job completed');
    assert.ok(firstCueElapsedMs !== null && firstCueElapsedMs <= 30_000,
      `the first streamed subtitle took ${firstCueElapsedMs ?? 'unknown'} ms (maximum 30000 ms)`);
    const completionElapsedMs = Date.now() - processingStartedAt;
    const completionBudgetMs = Math.max(90_000, Math.ceil(expectedWindows / 4) * 75_000);
    assert.ok(completionElapsedMs <= completionBudgetMs,
      `the transcription took ${completionElapsedMs} ms (maximum ${completionBudgetMs} ms)`);
    assert.deepEqual(witness.errors, [], 'the WebView recorded a provider runtime rejection');
    assert.equal(durable.latestRevision?.cue_count, durable.counts.cues);
    const diagnostics = transcriptionDiagnostics(root);
    assert.ok(diagnostics.some(({ event }) => event === 'transcribe.live.first_final'),
      'the run completed without a genuine Gemini Live final transcription event');
    assert.equal(diagnostics.some(({ event }) => event.includes('recovery')
      || event.includes('output_limit')), false,
    'the Live-only journey entered a non-Live recovery path');
    const assignments = diagnostics.filter(({ event }) => event === 'transcribe.window.credential_assigned');
    assert.deepEqual(
      assignments.map(({ credential_slot: slot }) => Number(slot)),
      Array.from({ length: expectedWindows }, (_, index) => index % enrollment.enrolled),
      'the parallel quality run did not distribute windows deterministically across credentials',
    );
    assert.ok(assignments.every(({ credential_pool_size: size }) => Number(size) === enrollment.enrolled),
      'the native scheduler did not expose the enrolled credential pool to every window');
    assert.equal(
      diagnostics.some(({ event }) => event.includes('recovery')),
      false,
      'Gemini Live crossed into a hidden recovery or fallback path',
    );
    const generatedCuesPath = join(root, 'evidence', 'generated-cues.json');
    const transcriptWords = durableTranscriptWords(root);
    writeFileSync(
      generatedCuesPath,
      `${JSON.stringify({
        schemaVersion: 2,
        durationSeconds: duration,
        cues: durable.cues,
        words: transcriptWords,
      }, null, 2)}\n`,
      'utf8',
    );
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'generated-cues',
      source: generatedCuesPath,
      description: 'Persisted Gemini Transcribe Live cues used by the transcript quality benchmark.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-four-live-windows-complete',
      description: `The public one-minute setting split ${Math.ceil(duration)} seconds of real media into ${ranges.length} Live windows and merged their streamed cues durably.`,
      details: {
        durationSeconds: duration,
        requestWindowCount: ranges.length,
        cueCount: durable.counts.cues,
        firstCueElapsedMs,
        completionElapsedMs,
      },
      focusSelector: '.timeline-container',
    });
  });
});
