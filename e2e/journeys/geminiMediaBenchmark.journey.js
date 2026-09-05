/* global $, browser, describe, document, it */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia, seekPreviewTo, waitForCanvasSubtitleFrame } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';
import { scoreSubtitleTiming } from '../support/subtitleTimingQuality.js';

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
    assert.equal(await $('#generation-model').getAttribute('data-value'), config.model);
    await clickControl('#generation-prompt-preset');
    await clickControl('[role="option"][data-value="general"]');
    const audioOnly = config.mode === 'audio';
    const selected = () => browser.execute(() => document.querySelector('#generation-audio-only').selected);
    if (await selected() !== audioOnly) await clickControl('#generation-audio-only');
    assert.equal(await selected(), audioOnly);
    await captureWorkflowStep({ workflow, step: '01-generation-controls',
      description: 'Actual generation modal, before any provider request.',
      details: { fixture: config.fixture, model: config.model, mode: config.mode } });
    const prior = new Set(durableState(root).jobs.map(job => job.id));
    const started = Date.now();
    const observations = [];
    let partialCaptured = false;
    let finalState;
    await clickControl('[data-osg-action="process-subtitles"]');
    await browser.waitUntil(async () => {
      const state = durableState(root);
      const jobs = state.jobs.filter(job => !prior.has(job.id) && job.kind === 'transcribe');
      const surface = await browser.execute(() => ({
        cues: document.querySelectorAll('.lyric-text').length,
        processing: document.querySelector('[data-osg-action="generate-subtitles"]')?.classList.contains('processing') === true,
        errors: [...document.querySelectorAll('.toast-error')].map(node => node.innerText),
      }));
      const sample = { elapsedMs: Date.now() - started, ...surface,
        durableCues: state.counts.cues, jobs: jobs.map(job => job.state) };
      observations.push(sample);
      if (observations.length > 1200) throw new Error('Benchmark observation bound exceeded');
      if (surface.cues && surface.processing && !partialCaptured) {
        partialCaptured = true;
        await captureWorkflowStep({ workflow, step: '02-streaming-cues',
          description: 'Visible cues while the actual generation remains in progress.', details: sample,
          focusSelector: '.lyric-text' });
      }
      assert.equal(surface.errors.length, 0, JSON.stringify(sample));
      assert.ok(!jobs.some(job => ['failed', 'cancelled', 'interrupted'].includes(job.state)), JSON.stringify(sample));
      finalState = state;
      return jobs.length > 0 && jobs.every(job => job.state === 'succeeded')
        && !surface.processing && state.counts.cues > 0;
    }, { timeout: 20 * 60_000, interval: 1000, timeoutMsg: 'Real media generation did not settle successfully' });
    const report = { fixture: config.fixture, model: config.model, mode: config.mode,
      sourceSha256: config.sourceSha256, elapsedMs: Date.now() - started,
      preparedMedia: finalState.media.map(({ kind, extension, size_bytes: sizeBytes }) => ({ kind, extension, sizeBytes })),
      partialCuesObserved: partialCaptured, observations, cues: finalState.cues,
      quality: scoreSubtitleTiming(config.reference, finalState.cues) };
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
