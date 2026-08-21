// A customer installs a published local ASR engine and generates durable, drawable subtitles.

import { strict as assert } from 'node:assert';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { ensureEngineReady } from '../support/engines.js';
import { openProjectWithMedia, waitForNativeFrame } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const ENGINE = 'faster-whisper-turbo';
const WORKFLOW = 'local-asr-generation';

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
    await browser.waitUntil(async () => {
      methodAvailable = await method.getAttribute('data-method-available');
      return methodAvailable === 'true';
    }, {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: () => `${ENGINE} never became selectable in the chooser: ${methodAvailable}`,
    });
    await method.click();
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-range-and-method',
      description: 'The full timeline range and local transcription method are selected for processing.',
      focusSelector: '.video-processing-modal',
    });

    await clickControl('[data-osg-action="process-subtitles"]');
    let visibleCues = [];
    let lastJob = null;
    let terminalFailure = null;
    await browser.waitUntil(async () => {
      visibleCues = await browser.execute(() => [...document.querySelectorAll('.lyric-text')]
        .map((node) => (node.innerText || '').trim()).filter(Boolean));
      const durable = durableState(process.env.OSG_E2E_DATA_ROOT);
      lastJob = [...durable.jobs].reverse().find((job) => job.kind === 'transcribe') ?? null;
      if (lastJob !== null && ['failed', 'cancelled', 'interrupted'].includes(lastJob.state)) {
        const surface = await browser.execute(() => ({
          toasts: [...document.querySelectorAll('.toast')]
            .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(-5),
          previewState: document.querySelector('[data-osg-preview]')?.getAttribute('data-osg-preview') ?? null,
          bodyTail: (document.body?.innerText || '').trim().slice(-4_000),
        }));
        terminalFailure = { lastJob, surface };
        return true;
      }
      return visibleCues.length > 0 && visibleCues.join(' ').length >= 20;
    }, {
      timeout: 1_800_000,
      interval: 2_000,
      timeoutMsg: () => `local ASR produced no substantial visible cues: ${JSON.stringify({ visibleCues, lastJob })}`,
    });
    if (terminalFailure !== null) {
      throw new Error(`local ASR job terminated before producing cues: ${JSON.stringify(terminalFailure)}`);
    }
    await waitForNativeFrame(180_000);

    const durable = durableState(process.env.OSG_E2E_DATA_ROOT);
    assert.ok(durable.counts.cues > 0, 'ASR cues were visible but not durable');
    assert.ok(durable.cues.every((cue) => (
      cue.start_ms >= 0 && cue.end_ms > cue.start_ms && cue.text.trim().length > 0
    )), `ASR persisted invalid cue timing/text: ${JSON.stringify(durable.cues)}`);
    assert.equal(durable.latestRevision?.cue_count, durable.counts.cues);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-generated-subtitles',
      description: 'Local ASR produced substantial visible cues and a native composited subtitle preview.',
      details: { cueCount: durable.counts.cues, jobState: lastJob?.state },
      focusSelector: '.lyrics-container-wrapper',
    });
  });
});
