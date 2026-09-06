/* global $, browser, describe, document, it, window, PerformanceObserver */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia, seekPreviewTo, waitForCanvasSubtitleFrame } from '../support/workflow.js';
import { captureWorkflowStep, collectVisibleStateFromPage, copyWorkflowArtifact } from '../support/workflowEvidence.js';
import { scoreSubtitleTiming } from '../support/subtitleTimingQuality.js';
import { actuateNativeRange } from '../support/nativeRange.js';

const workflow = 'gemini-media-benchmark';
describe('real UI media transcription benchmark', () => {
  it('measures the saved customer result against withheld human word boundaries', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root);
    const config = JSON.parse(readFileSync(join(root, 'input', 'benchmark.json'), 'utf8'));
    await openProjectWithMedia();
    assert.equal((await enrollGeminiCredentials({ limit: 20 })).enrolled, 20);
    await clickControl('[data-osg-action="generate-subtitles"]');
    const timeline = await $('.subtitle-timeline');
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);
    await clickControl('[data-transcription-method="new"]');
    await clickControl('#generation-model');
    await clickControl(`[role="option"][data-value="${config.model}"]`);
    await browser.waitUntil(async () =>
      await $('#generation-model').getAttribute('data-value') === config.model
      && await $('#generation-model').getAttribute('aria-expanded') === 'false',
    { timeout: 5000, interval: 50, timeoutMsg: 'Model selection did not commit after the menu closed' });
    assert.equal(await $('#generation-model').getAttribute('data-value'), config.model);
    const choosePreset = async preset => {
      await clickControl('#generation-prompt-preset');
      await clickControl(`[role="option"][data-value="${preset}"]`);
      await browser.waitUntil(async () =>
        await $('#generation-prompt-preset').getAttribute('data-value') === preset
        && await $('#generation-prompt-preset').getAttribute('aria-expanded') === 'false',
      { timeout: 5000, interval: 50, timeoutMsg: 'Prompt selection did not commit after the menu closed' });
    };
    await choosePreset('translate-directly');
    assert.equal(await $('[data-osg-action="process-subtitles"]').isEnabled(), false,
      'Translation must require a target language on a fresh profile');
    await captureWorkflowStep({ workflow, step: '00-translation-preset',
      description: 'Concise preset description and required target language before any request.' });
    await choosePreset('chaptering');
    assert.equal(await browser.execute(() => document.querySelector('#auto-split-subtitles').disabled), true,
      'Chapter boundaries must not be subdivided by the caption splitter');
    await captureWorkflowStep({ workflow, step: '00-chapter-preset',
      description: 'Chapter task visibly disables caption splitting without changing the saved preference.' });
    await choosePreset(config.preset ?? 'general');
    if (config.preset === 'translate-directly') {
      await $('.language-input').setValue('Vietnamese');
    }
    const audioOnly = config.mode === 'audio';
    const selected = () => browser.execute(() => document.querySelector('#generation-audio-only').selected);
    if (await selected() !== audioOnly) await clickControl('#generation-audio-only');
    assert.equal(await selected(), audioOnly);
    if (!audioOnly) await actuateNativeRange({ driver: browser, selector: '#fps-slider',
      value: config.fps ?? 0.25, label: 'Video frame rate' });
    await actuateNativeRange({ driver: browser, selector: '#max-duration-slider',
      value: config.requestMinutes, label: 'Maximum duration of each Gemini request' });
    await captureWorkflowStep({ workflow, step: '01-generation-controls',
      description: 'Actual generation modal, before any provider request.',
      details: { fixture: config.fixture, model: config.model, mode: config.mode,
        preset: config.preset, fps: config.fps } });
    const prior = new Set(durableState(root).jobs.map(job => job.id));
    const started = Date.now();
    const observations = [];
    let partialCaptured = false;
    let finalState;
    let emptyTerminalSince = null;
    let lastMilestone = 0;
    let preparationCaptured = false;
    process.stdout.write('[media-benchmark] controls-ready\n');
    await browser.execute(() => {
      const state = { supported: typeof PerformanceObserver !== 'undefined', count: 0, totalMs: 0, maxMs: 0 };
      window.__OSG_MEDIA_BENCH_PERF__ = state;
      if (state.supported) {
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            state.count++; state.totalMs += entry.duration; state.maxMs = Math.max(state.maxMs, entry.duration);
          }
        });
        try { observer.observe({ type: 'longtask' }); state.observer = observer; }
        catch { state.supported = false; }
      }
    });
    await clickControl('[data-osg-action="process-subtitles"]');
    process.stdout.write('[media-benchmark] generation-clicked\n');
    if (config.exercise === 'missing-audio') {
      await browser.waitUntil(async () => browser.execute(() => {
        const history = JSON.parse(localStorage.getItem('toast_history_v1') || '[]');
        return document.querySelector('[data-osg-action="generate-subtitles"]')?.classList.contains('processing') !== true
          && (document.querySelector('.toast-error') !== null || history.some(item => item.type === 'error'));
      }), { timeout: 120_000, interval: 250, timeoutMsg: 'Missing audio did not settle with an error toast' });
      assert.equal(durableState(root).jobs.filter(job => !prior.has(job.id) && job.kind === 'transcribe').length, 0,
        'Missing audio must not send a video request as a silent fallback');
      assert.equal(durableState(root).counts.cues, 0);
      const expected = 'close Error Error: This media has no audio track to transcribe. Choose a file with audio or turn off audio-only input.';
      // Use the screenshot oracle's text semantics. WebDriver getText joins
      // adjacent icon/title/message nodes differently from DOM innerText.
      const surface = await browser.execute(collectVisibleStateFromPage);
      assert.deepEqual(surface.errorToasts, [expected]);
      await captureWorkflowStep({ workflow, step: '02-missing-audio-refused',
        description: 'Audio-only refuses a video without audio, with no provider job or invented subtitles.',
        allowVisibleProblems: { errorToasts: [{ text: expected,
          reason: 'The specific no-audio refusal is the intended outcome of this negative workflow.' }] } });
      return;
    }
    if (config.exercise === 'cancel-retry') {
      await browser.waitUntil(() => durableState(root).jobs.some(job => !prior.has(job.id)
        && job.kind === 'transcribe' && job.state === 'running'),
      { timeout: 120_000, interval: 100, timeoutMsg: 'No active provider job available to cancel' });
      await clickControl('.force-stop-btn');
      await browser.waitUntil(async () => {
        const jobs = durableState(root).jobs.filter(job => !prior.has(job.id) && job.kind === 'transcribe');
        return jobs.some(job => job.state === 'cancelled')
          && jobs.every(job => ['cancelled', 'succeeded'].includes(job.state))
          && await browser.execute(() => !document.querySelector('[data-osg-action="generate-subtitles"]')?.classList.contains('processing'));
      }, { timeout: 30_000, interval: 100, timeoutMsg: 'Cancellation did not settle native jobs and UI' });
      await captureWorkflowStep({ workflow, step: '02-cancelled', description: 'Real force-stop cancels the native request before retry.' });
      for (const job of durableState(root).jobs) prior.add(job.id);
      await clickControl('[data-osg-action="generate-subtitles"]');
      await timeline.click();
      await browser.keys(['\uE009', 'a', '\uE000']);
      await clickControl('[data-transcription-method="new"]');
      assert.equal(await selected(), audioOnly, 'Retry changed the chosen input mode');
      await clickControl('[data-osg-action="process-subtitles"]');
    }
    let terminalError = null;
    await browser.waitUntil(async () => {
      try {
      const state = durableState(root);
      const jobs = state.jobs.filter(job => !prior.has(job.id) && job.kind === 'transcribe');
      assert.ok(jobs.length <= Math.ceil(config.durationSeconds / (config.requestMinutes * 60)),
        'The modal request limit produced unexpected duplicate jobs');
      const surface = await browser.execute(() => ({
        cues: document.querySelectorAll('.lyric-text').length,
        processing: document.querySelector('[data-osg-action="generate-subtitles"]')?.classList.contains('processing') === true,
        errors: [...document.querySelectorAll('.toast-error')].map(node => node.innerText),
      }));
      const sample = { elapsedMs: Date.now() - started, ...surface,
        durableCues: state.counts.cues, jobs: jobs.map(job => job.state) };
      observations.push(sample);
      if (sample.elapsedMs - lastMilestone >= 15_000) {
        lastMilestone = sample.elapsedMs;
        process.stdout.write(`[media-benchmark] ${JSON.stringify(sample)}\n`);
        const observationPath = join(root, 'benchmark-observations.json');
        writeFileSync(observationPath, JSON.stringify(observations, null, 2));
      }
      if (!preparationCaptured && !jobs.length && sample.elapsedMs >= 30_000) {
        preparationCaptured = true;
        await captureWorkflowStep({ workflow, step: '02-preparation-wait',
          description: 'Actual application while preparation has not admitted a provider job.', details: sample });
      }
      if (observations.length > 1200) throw new Error('Benchmark observation bound exceeded');
      if (surface.cues && surface.processing && !partialCaptured) {
        partialCaptured = true;
        await captureWorkflowStep({ workflow, step: '02-streaming-cues',
          description: 'Visible cues while the actual generation remains in progress.', details: sample,
          focusSelector: '.lyric-text' });
      }
      assert.equal(surface.errors.length, 0, JSON.stringify(sample));
      assert.ok(!jobs.some(job => ['failed', 'cancelled', 'interrupted'].includes(job.state)), JSON.stringify(sample));
      assert.ok(jobs.length > 0 || surface.processing || sample.elapsedMs < 10_000,
        `Generation stopped before admitting a provider job: ${JSON.stringify(sample)}`);
      const emptyTerminal = jobs.length > 0 && jobs.every(job => job.state === 'succeeded')
        && !surface.processing && state.counts.cues === 0;
      emptyTerminalSince = emptyTerminal ? (emptyTerminalSince ?? Date.now()) : null;
      assert.ok(emptyTerminalSince === null || Date.now() - emptyTerminalSince < 10_000,
        `Provider succeeded but no subtitle track was saved: ${JSON.stringify(sample)}`);
      finalState = state;
      return jobs.length > 0 && jobs.every(job => job.state === 'succeeded')
        && !surface.processing && state.counts.cues > 0;
      } catch (error) {
        // WebDriver retries thrown condition errors until timeout. Settle first,
        // then throw outside waitUntil so an already-failed job ends promptly.
        terminalError = error;
        return true;
      }
    }, { timeout: 20 * 60_000, interval: 1000, timeoutMsg: 'Real media generation did not settle successfully' });
    if (terminalError) throw terminalError;
    const report = { fixture: config.fixture, model: config.model, mode: config.mode,
      preset: config.preset ?? 'general', fps: config.fps ?? 0.25,
      providerDiagnostics: existsSync(join(root, 'logs', 'osg.log'))
        ? readFileSync(join(root, 'logs', 'osg.log'), 'utf8').split(/\r?\n/u)
          .filter(line => /gemini\.(completed|termination)/u.test(line)) : [],
      requestMinutes: config.requestMinutes,
      mainThread: await browser.execute(() => {
        const { observer, ...state } = window.__OSG_MEDIA_BENCH_PERF__;
        observer?.disconnect();
        return state;
      }),
      sourceSha256: config.sourceSha256, elapsedMs: Date.now() - started,
      preparedMedia: finalState.media.map(({ kind, extension, size_bytes: sizeBytes }) => ({ kind, extension, sizeBytes })),
      partialCuesObserved: partialCaptured, observations, cues: finalState.cues,
      quality: config.reference.scoreable !== false && (!config.preset || ['general', 'focus-lyrics'].includes(config.preset))
        ? scoreSubtitleTiming(config.reference, finalState.cues) : null };
    assert.ok(finalState.cues.length >= (config.reference.minimumCues ?? 1),
      'The duration stress run completed without a substantial subtitle result');
    assert.ok(report.preparedMedia.some(media => media.kind === 'video'), 'Audio-only must preserve the original video');
    if (audioOnly) assert.ok(report.preparedMedia.some(media => media.kind === 'audio' && media.extension === 'flac'),
      'Audio-only did not materialize the selected audio as a native FLAC asset');
    const resultPath = join(root, 'benchmark-result.json');
    writeFileSync(resultPath, JSON.stringify(report, null, 2));
    copyWorkflowArtifact({ workflow, name: 'quality-and-streaming', source: resultPath,
      description: 'Saved app cues, withheld-reference alignment, and observed streaming; no quality threshold tuned to this fixture.' });
    for (const [index, fraction] of [0, 0.5, 1].entries()) {
      const cue = finalState.cues[Math.floor((finalState.cues.length - 1) * fraction)];
      await seekPreviewTo((Number(cue.start_ms) + Number(cue.end_ms)) / 2000);
      await waitForCanvasSubtitleFrame(180_000);
      await captureWorkflowStep({ workflow, step: `03-result-${index}`,
        description: 'Native subtitle preview at a generated cue for visual inspection.',
        details: { text: cue.text, startMs: cue.start_ms, endMs: cue.end_ms },
        focusSelector: '.video-preview .video-container' });
    }
  });
});
