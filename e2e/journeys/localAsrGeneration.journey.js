// A customer clears an imported track at the media boundary, then local ASR generates fresh,
// durable, drawable subtitles. This journey owns the one full Faster-Whisper install; every other
// local-ASR journey refuses instead of downloading the 4.56 GiB package again.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { ensureEngineReady } from '../support/engines.js';
import {
  importSubtitleDocument,
  openProjectWithMedia,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const ENGINE = 'faster-whisper-turbo';
const WORKFLOW = 'local-asr-generation';
const FIRST_CUE = 'First cue for the preview';
const BOUNDARY_CUE = 'Boundary cue at media end';

/* global $, browser, describe, document, it, performance, window, MutationObserver */

const srtTime = (seconds) => {
  const milliseconds = Math.round(seconds * 1_000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
};

const selectWholeTimeline = async (timeline) => {
  await timeline.click();
  // Ctrl+A is the product's documented full-media shortcut; the WebDriver key sequence exercises
  // the same window keydown handler as a physical keyboard and releases the modifier explicitly.
  await browser.keys(['', 'a', '']);
};

/** The imported track's waveform, Ctrl+A and Delete all stop at playable media time. */
const clearTrackAtMediaBoundary = async () => {
  const duration = await browser.execute(() => {
    const video = document.querySelector('.video-preview video.video-player');
    if (video === null || !Number.isFinite(video.duration)) return null;
    return video.duration;
  });
  assert.ok(duration > 2, `the real video has no usable duration: ${duration}`);
  const cueStart = duration - 1;
  const cueEnd = duration;
  await importSubtitleDocument([
    '1', `${srtTime(0.5)} --> ${srtTime(2)}`, FIRST_CUE, '',
    '2', `${srtTime(cueStart)} --> ${srtTime(cueEnd)}`, BOUNDARY_CUE, '',
  ].join('\n'), 'timeline-boundary.srt', BOUNDARY_CUE);

  let waveformMeasurement = null;
  await waitUntilWithFreshDiagnostic(async () => {
    waveformMeasurement = await browser.execute((mediaEnd, viewEnd) => {
      const host = document.querySelector('[data-osg-waveform-state="ready"]');
      const canvas = host?.querySelector('canvas') ?? null;
      if (canvas === null || canvas.width <= 0 || canvas.height <= 0) return null;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const expectedBoundary = (mediaEnd / viewEnd) * canvas.width;
      const columnHasInk = (x) => {
        for (let y = 0; y < canvas.height; y += 1) {
          if (pixels[((y * canvas.width) + x) * 4 + 3] > 0) return true;
        }
        return false;
      };
      let inkBefore = false;
      let inkAfter = false;
      for (let x = Math.max(0, Math.floor(expectedBoundary) - 12); x < Math.floor(expectedBoundary); x += 1) {
        inkBefore ||= columnHasInk(x);
      }
      for (let x = Math.min(canvas.width, Math.ceil(expectedBoundary) + 3); x < canvas.width; x += 1) {
        inkAfter ||= columnHasInk(x);
      }
      return { width: canvas.width, height: canvas.height, expectedBoundary, inkBefore, inkAfter };
    }, duration, cueEnd);
    return waveformMeasurement?.inkBefore === true && waveformMeasurement.inkAfter === false;
  }, {
    timeout: 180_000,
    interval: 500,
    diagnostic: () => `waveform pixels did not stop at playable media: ${JSON.stringify(waveformMeasurement)}`,
  });
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: '02-reachable-boundary-cue',
    description: 'The waveform and final cue stop at the playable media boundary.',
    details: { duration, cueStart, cueEnd, waveformMeasurement },
    focusSelector: '.timeline-container',
  });

  const timeline = await $('.subtitle-timeline');
  await selectWholeTimeline(timeline);
  const actionBar = await $('.range-action-bar');
  await actionBar.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: 'Ctrl+A did not expose actions for every subtitle',
  });
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: '03-select-all-through-last-cue',
    description: 'Ctrl+A reaches the final subtitle without selecting beyond the video.',
    details: { cueEnd, duration },
    focusSelector: '.timeline-container',
  });

  await browser.keys(['']);
  await browser.waitUntil(async () => {
    const visibleCueCount = await browser.execute(
      () => document.querySelectorAll('.lyric-text').length,
    );
    return visibleCueCount === 0
      && durableState(process.env.OSG_E2E_DATA_ROOT).counts.cues === 0;
  }, {
    timeout: 60_000,
    interval: 500,
    timeoutMsg: 'Delete after Ctrl+A left at least one visible or durable cue behind',
  });
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: '04-all-cues-cleared',
    description: 'Delete after Ctrl+A removes every visible and durable cue, including the boundary cue.',
    focusSelector: '.lyrics-container-wrapper',
  });
  return timeline;
};

/** Record the first moment generated rows appear while the generate control is still busy. */
const installStreamWitness = () => browser.execute(() => {
  window.__OSG_E2E_ASR_STREAM_WITNESS__ = null;
  const observer = new MutationObserver(() => {
    const rows = [...document.querySelectorAll('.lyric-text')]
      .map((node) => (node.innerText || '').trim()).filter(Boolean);
    const generationActive = document.querySelector('[data-osg-action="generate-subtitles"]')
      ?.classList.contains('processing') === true;
    if (generationActive && rows.length > 0) {
      window.__OSG_E2E_ASR_STREAM_WITNESS__ ??= { rows: rows.length, observedAtMs: performance.now() };
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.__OSG_E2E_ASR_STREAM_OBSERVER__ = observer;
});

describe('a customer generates subtitles with local ASR', () => {
  it('clears an imported track at the media boundary, then transcribes fresh durable, streamed, drawable cues', async () => {
    await openProjectWithMedia();
    await ensureEngineReady(ENGINE, {
      onReady: async (state) => captureWorkflowStep({
        workflow: WORKFLOW,
        step: '01-engine-ready',
        description: 'The reviewed local ASR engine is visibly installed and available on demand.',
        details: state,
      }),
    });
    const timeline = await clearTrackAtMediaBoundary();

    await clickControl('[data-osg-action="generate-subtitles"]');
    await timeline.waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'the subtitle timeline never became available for range selection',
    });
    // Semi-automatic generation asks for a range; on the now-empty track Ctrl+A selects it all.
    await selectWholeTimeline(timeline);
    const method = await $(`[data-transcription-method="${ENGINE}"]`);
    await method.waitForDisplayed({ timeout: 60_000, timeoutMsg: 'the ASR method chooser did not open' });
    let methodAvailable = null;
    await waitUntilWithFreshDiagnostic(async () => {
      methodAvailable = await method.getAttribute('data-method-available');
      return methodAvailable === 'true';
    }, {
      timeout: 60_000,
      interval: 500,
      diagnostic: () => `${ENGINE} never became selectable in the chooser: ${methodAvailable}`,
    });
    await method.click();
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-range-and-method',
      description: 'The full timeline range and local transcription method are selected for processing.',
      focusSelector: '.video-processing-modal',
    });

    const existingTranscribeJobIds = new Set(durableState(process.env.OSG_E2E_DATA_ROOT).jobs
      .filter(({ kind }) => kind === 'transcribe').map(({ id }) => id));
    await installStreamWitness();
    await clickControl('[data-osg-action="process-subtitles"]');
    let visibleCues = [];
    let durableCues = 0;
    let lastJob = null;
    let terminalFailure = null;
    let generationActive = null;
    let streamWitness = null;
    await waitUntilWithFreshDiagnostic(async () => {
      const surface = await browser.execute(() => ({
        visibleCues: [...document.querySelectorAll('.lyric-text')]
          .map((node) => (node.innerText || '').trim()).filter(Boolean),
        generationActive: document.querySelector('[data-osg-action="generate-subtitles"]')
          ?.classList.contains('processing') === true,
        streamWitness: window.__OSG_E2E_ASR_STREAM_WITNESS__ ?? null,
      }));
      visibleCues = surface.visibleCues;
      generationActive = surface.generationActive;
      streamWitness ??= surface.streamWitness;
      const durable = durableState(process.env.OSG_E2E_DATA_ROOT);
      durableCues = durable.counts.cues;
      if (visibleCues.includes(FIRST_CUE) || visibleCues.includes(BOUNDARY_CUE)
          || durable.cues.some(({ text }) => text === FIRST_CUE || text === BOUNDARY_CUE)) {
        throw new Error('generation resurrected the deleted subtitle track');
      }
      const newTranscribeJobs = durable.jobs.filter(({ id, kind }) => (
        kind === 'transcribe' && !existingTranscribeJobIds.has(id)
      ));
      assert.ok(
        newTranscribeJobs.length <= 1,
        `one Process click created multiple transcription jobs: ${JSON.stringify(newTranscribeJobs)}`,
      );
      [lastJob = null] = newTranscribeJobs;
      if (lastJob !== null && ['failed', 'cancelled', 'interrupted'].includes(lastJob.state)) {
        const failureSurface = await browser.execute(() => ({
          toasts: [...document.querySelectorAll('.toast')]
            .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(-5),
          previewState: document.querySelector('[data-osg-preview]')?.getAttribute('data-osg-preview') ?? null,
          bodyTail: (document.body?.innerText || '').trim().slice(-4_000),
        }));
        terminalFailure = { lastJob, surface: failureSurface };
        return true;
      }
      return streamWitness !== null
        && lastJob?.state === 'succeeded'
        && generationActive === false
        && visibleCues.length > 0
        && visibleCues.join(' ').length >= 20
        && durableCues > 0;
    }, {
      timeout: 1_800_000,
      interval: 1_000,
      diagnostic: () => `local ASR did not stream and complete durable visible cues: ${JSON.stringify({
        visibleCues, durableCues, lastJob, generationActive, streamWitness,
      })}`,
    });
    await browser.execute(() => {
      window.__OSG_E2E_ASR_STREAM_OBSERVER__?.disconnect();
      delete window.__OSG_E2E_ASR_STREAM_OBSERVER__;
    });
    if (terminalFailure !== null) {
      throw new Error(`local ASR job terminated before producing cues: ${JSON.stringify(terminalFailure)}`);
    }
    const durable = durableState(process.env.OSG_E2E_DATA_ROOT);
    assert.equal(lastJob?.state, 'succeeded', 'ASR cues appeared before their native job succeeded');
    assert.ok(durable.counts.cues > 0, 'ASR cues were visible but not durable');
    assert.ok(durable.cues.every((cue) => (
      cue.start_ms >= 0 && cue.end_ms > cue.start_ms && cue.text.trim().length > 0
    )), `ASR persisted invalid cue timing/text: ${JSON.stringify(durable.cues)}`);
    assert.equal(durable.latestRevision?.cue_count, durable.counts.cues);
    const firstCue = durable.cues[0];
    await seekPreviewTo((Number(firstCue.start_ms) + Number(firstCue.end_ms)) / 2_000);
    await waitForCanvasSubtitleFrame(180_000);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '06-generated-subtitles',
      description: 'Local ASR started from the empty checkpoint, streamed fresh cues before completing, persisted them and drew them in the native preview.',
      details: { cueCount: durable.counts.cues, jobState: lastJob?.state, streamWitness },
      focusSelector: '.lyrics-container-wrapper',
    });
  });
});

async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}
