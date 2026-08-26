// A customer installs a published local ASR engine and generates durable, drawable subtitles.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { ensureEngineReady } from '../support/engines.js';
import {
  openProjectWithMedia,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const ENGINE = 'faster-whisper-turbo';
const WORKFLOW = 'local-asr-generation';

/* global $, browser, describe, document, it */

describe('a customer generates subtitles with local ASR', () => {
  it('installs and starts the real engine, transcribes real media, persists and draws the cues', async () => {
    await openProjectWithMedia();
    await ensureEngineReady(ENGINE, {
      onReady: async (state) => captureWorkflowStep({
        workflow: WORKFLOW,
        step: '01-engine-ready',
        description: 'The reviewed local ASR engine is visibly installed, running, and ready.',
        details: state,
      }),
    });

    await clickControl('[data-osg-action="generate-subtitles"]');
    const timeline = await $('.subtitle-timeline');
    await timeline.waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'the subtitle timeline never became available for range selection',
    });
    await timeline.click();
    // Semi-automatic generation deliberately asks the customer for a range. Ctrl+A is the
    // product's documented full-media shortcut; the WebDriver key sequence exercises the same
    // window keydown handler as a physical keyboard and releases the modifier explicitly.
    await browser.keys(['\uE009', 'a', '\uE000']);

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
      step: '02-range-and-method',
      description: 'The full timeline range and local transcription method are selected for processing.',
      focusSelector: '.video-processing-modal',
    });

    const beforeGeneration = durableState(process.env.OSG_E2E_DATA_ROOT);
    const existingTranscribeJobIds = new Set(
      beforeGeneration.jobs.filter(({ kind }) => kind === 'transcribe').map(({ id }) => id),
    );
    await clickControl('[data-osg-action="process-subtitles"]');
    let visibleCues = [];
    let durableCues = 0;
    let lastJob = null;
    let terminalFailure = null;
    let generationActive = null;
    await waitUntilWithFreshDiagnostic(async () => {
      const surface = await browser.execute(() => ({
        visibleCues: [...document.querySelectorAll('.lyric-text')]
          .map((node) => (node.innerText || '').trim()).filter(Boolean),
        generationActive: document.querySelector('[data-osg-action="generate-subtitles"]')
          ?.classList.contains('processing') === true,
      }));
      visibleCues = surface.visibleCues;
      generationActive = surface.generationActive;
      const durable = durableState(process.env.OSG_E2E_DATA_ROOT);
      durableCues = durable.counts.cues;
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
      return lastJob?.state === 'succeeded'
        && generationActive === false
        && visibleCues.length > 0
        && visibleCues.join(' ').length >= 20
        && durableCues > 0;
    }, {
      timeout: 1_800_000,
      interval: 2_000,
      diagnostic: () => `local ASR did not complete with durable visible cues: ${JSON.stringify({
        visibleCues, durableCues, lastJob, generationActive,
      })}`,
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
      step: '03-generated-subtitles',
      description: 'Local ASR completed, persisted substantial cues, and drew them in the native preview.',
      details: { cueCount: durable.counts.cues, jobState: lastJob?.state },
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
