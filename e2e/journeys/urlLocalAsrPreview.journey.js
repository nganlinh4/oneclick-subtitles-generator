// The acquisition-to-editor chain that was missing from the real suite:
// real URL -> native download -> durable project activation -> local transcription -> native preview.

import { strict as assert } from 'node:assert';

import { durableState } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { ensureEngineReady } from '../support/engines.js';
import { REAL_VIDEO } from '../support/realMedia.js';
import { seekPreviewTo, waitForCanvasSubtitleFrame } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const ENGINE = 'faster-whisper-turbo';
const WORKFLOW = 'url-local-asr-preview';

const visibleState = () => browser.execute(() => ({
  preview: document.querySelector('[data-osg-preview]')?.getAttribute('data-osg-preview') ?? null,
  inlineErrors: [...document.querySelectorAll('.video-container .error')]
    .map((node) => (node.innerText || '').trim()).filter(Boolean),
  errorToasts: [...document.querySelectorAll('.toast-error')]
    .map((node) => (node.innerText || '').trim()).filter(Boolean),
  cueCount: document.querySelectorAll('.lyric-text').length,
  frame: document.querySelector('.video-preview [data-osg-preview-engine="canvas-atlas"]')
    ?.getAttribute('data-osg-frame-revision') ?? null,
  // Native media publishes its identity through the owned session record; the flat cache-id key
  // is written only for browser-mode file hashing and stays absent for a native download.
  projectCacheId: (() => {
    try {
      const session = JSON.parse(localStorage.getItem('current_media_session') ?? 'null');
      if (session !== null && typeof session.cacheId === 'string' && session.cacheId !== '') {
        return session.cacheId;
      }
    } catch { /* fall through to the browser-mode key */ }
    return localStorage.getItem('current_file_cache_id');
  })(),
  sourceUrl: localStorage.getItem('current_video_url'),
}));

describe('a customer turns a real URL into visible subtitles', () => {
  it('downloads, activates, obtains subtitles and draws without changing project ownership', async () => {
    await openEditor();
    await ensureEngineReady(ENGINE);

    const field = await $('.url-field');
    await field.waitForDisplayed({ timeout: 30_000 });
    await field.setValue(REAL_VIDEO.url);
    await browser.waitUntil(async () => (await browser.execute(
      (id) => [...document.querySelectorAll('.video-id-value')]
        .some((node) => (node.innerText || '').trim() === id),
      REAL_VIDEO.id,
    )), {
      timeout: 120_000,
      interval: 2_000,
      timeoutMsg: 'the real URL never resolved before generation',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-url-ready',
      description: 'The real URL is resolved and ready to enter the subtitle workflow.',
      details: { videoId: REAL_VIDEO.id },
    });

    // A late ownership refusal has twice surfaced only as its customer toast, after the product
    // logged the underlying error object to the console where nothing recorded it. Ledger every
    // console.error so a recurrence names its own code and stack in the failure evidence.
    await browser.execute(() => {
      const ledger = [];
      const original = console.error.bind(console);
      window.__OSG_E2E_CONSOLE_ERRORS__ = ledger;
      console.error = (...parts) => {
        if (ledger.length < 32) {
          ledger.push(parts.map((part) => {
            if (part instanceof Error) {
              return `${part.name}[${part.code ?? ''}]: ${part.message}\n${(part.stack ?? '').slice(0, 1_500)}`;
            }
            try {
              return typeof part === 'string' ? part.slice(0, 500) : JSON.stringify(part).slice(0, 500);
            } catch {
              return String(part).slice(0, 500);
            }
          }).join(' | '));
        }
        original(...parts);
      };
    });

    await clickControl('[data-osg-action="generate-subtitles"]');
    const timeline = await $('.subtitle-timeline');
    await timeline.waitForDisplayed({
      timeout: 600_000,
      timeoutMsg: 'the downloaded URL never became an active playable editor project',
    });

    // A real provider may supply site subtitles with the download. That is already a successful
    // customer path, and opening the ASR chooser on top of it only obscures the preview we are
    // supposed to inspect. Fall back to local ASR only when the product obtained no cues.
    let durable = durableState(process.env.OSG_E2E_DATA_ROOT);
    let usedLocalAsr = false;
    if (durable.counts.cues === 0) {
      usedLocalAsr = true;
      await timeline.click();
      await browser.keys(['\uE009', 'a', '\uE000']);

      const method = await $(`[data-transcription-method="${ENGINE}"]`);
      await method.waitForDisplayed({ timeout: 60_000 });
      await browser.waitUntil(async () => (await method.getAttribute('data-method-available')) === 'true', {
        timeout: 60_000,
        interval: 500,
        timeoutMsg: `${ENGINE} never became selectable`,
      });
      await method.click();
      await clickControl('[data-osg-action="process-subtitles"]');
    }

    let state = null;
    let lastJob = null;
    await waitUntilWithFreshDiagnostic(async () => {
      state = await visibleState();
      durable = durableState(process.env.OSG_E2E_DATA_ROOT);
      lastJob = [...durable.jobs].reverse().find((job) => job.kind === 'transcribe') ?? null;
      if (lastJob && ['failed', 'cancelled', 'interrupted'].includes(lastJob.state)) return true;
      return durable.counts.cues > 0;
    }, {
      timeout: 1_800_000,
      interval: 2_000,
      diagnostic: () => `the URL workflow never produced subtitles: ${JSON.stringify({ state, lastJob })}`,
    });

    assert.ok(!lastJob || !['failed', 'cancelled', 'interrupted'].includes(lastJob.state),
      `the URL transcription job failed: ${JSON.stringify(lastJob)}`);

    // Put the real player inside a durable cue. A cue row is parse proof; canvas pixels at that
    // cue's midpoint independently prove that the subtitle reached the video.
    durable = durableState(process.env.OSG_E2E_DATA_ROOT);
    const firstCue = durable.cues[0];
    assert.ok(firstCue, 'the durable subtitle track is empty');
    await seekPreviewTo((Number(firstCue.start_ms) + Number(firstCue.end_ms)) / 2_000);
    await waitForCanvasSubtitleFrame(180_000);
    await browser.waitUntil(async () => (await visibleState()).preview === 'ready', {
      timeout: 180_000,
      interval: 1_000,
      timeoutMsg: 'subtitles existed but the native preview never became ready inside a cue',
    });
    state = await visibleState();
    assert.equal(state.sourceUrl, REAL_VIDEO.url, 'the active URL changed during media preparation');
    assert.ok(state.projectCacheId, 'the downloaded media has no active asset identity');
    assert.deepEqual(state.inlineErrors, [], 'an error was painted inside the video surface');
    assert.deepEqual(state.errorToasts, [], 'the customer workflow exposed a failure toast');

    durable = durableState(process.env.OSG_E2E_DATA_ROOT);
    assert.equal(durable.counts.projects, 1, 'one URL workflow created more than one subtitle project');
    assert.ok(durable.counts.cues > 0, 'visible URL-generated cues were not durable');
    try {
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-subtitles-on-video',
        description: 'The downloaded URL owns one durable project and its generated subtitles are drawn on video.',
        details: {
          cueCount: durable.counts.cues,
          projectCount: durable.counts.projects,
          subtitleSource: usedLocalAsr ? 'local-asr' : 'provider-track',
        },
        focusSelector: '.video-preview .video-container',
      });
    } catch (error) {
      const consoleErrors = await browser.execute(() => window.__OSG_E2E_CONSOLE_ERRORS__ ?? []);
      throw new Error(
        `${error.message}\nledgered console errors: ${JSON.stringify(consoleErrors, null, 1)}`,
        { cause: error },
      );
    }
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
