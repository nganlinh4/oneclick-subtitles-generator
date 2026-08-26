// One public one-minute setting must split a long real-speech video into four sequential native
// jobs, stream each result into the real timeline, persist the exact merge, and restore it in a
// second desktop process. Run through scenarios/multiWindowAsrPersistence.mjs; both windows remain
// non-focusable and permanently off-screen under the compile-time E2E guard.

import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { ensureEngineReady } from '../support/engines.js';
import { FOUR_WINDOW_ASR_FIXTURE } from '../support/fourWindowAsrFixture.js';
import { assertMultiWindowAsrResult } from '../support/multiWindowAsrOracle.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import {
  importSubtitleDocument,
  openProjectWithMedia,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const ENGINE = 'faster-whisper-turbo';
const EXPECTED_WINDOWS = FOUR_WINDOW_ASR_FIXTURE.expectedWindowCount;
const MAX_REQUEST_MINUTES = 1;
const MAX_WITNESS_ITEMS = 512;
const PHASE = process.env.OSG_E2E_PERSISTENCE_PHASE;
const WORKFLOW = 'multi-window-asr-persistence';
const WITNESS_FILE = 'multi-window-asr-seed.json';
const DELETED_CUES = Object.freeze([
  'OSG deleted sentinel window one',
  'OSG deleted sentinel window two',
  'OSG deleted sentinel window three',
  'OSG deleted sentinel window four',
]);

/* global $, browser, describe, document, it, MutationObserver, performance, window */

const srtTime = (seconds) => {
  const milliseconds = Math.round(seconds * 1_000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
};

const deletedFixture = () => DELETED_CUES.flatMap((text, index) => {
  const start = 5 + index * 55;
  return [String(index + 1), `${srtTime(start)} --> ${srtTime(start + 2)}`, text, ''];
}).join('\n');

const witnessPath = (root) => join(root, 'evidence', WITNESS_FILE);

const visibleProblemSurfacesInPage = () => {
  const visible = (node) => {
    const style = window.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  };
  const surfaces = [
    ...document.querySelectorAll([
      '[role="alert"]',
      '.engine-card__error',
      '.tools-ledger__status--error',
      '.preview-error',
      '.error-message',
      '[data-osg-preview="error"]',
      '[data-osg-preview="refused"]',
    ].join(',')),
  ].filter((node) => !node.closest('.toast-panel') && visible(node));
  return surfaces.map((node) => ({
    selector: node.matches('[data-osg-preview]') ? '[data-osg-preview]' : node.className,
    code: node.getAttribute('data-osg-preview-code') || null,
    text: (node.innerText || '').trim().slice(0, 500),
  })).filter(({ code, text }) => code || text);
};

const installStreamingWitness = () => browser.execute((limit) => {
  window.__OSG_E2E_MULTI_ASR__?.cleanup?.();
  const ledger = {
    rangePublications: [],
    streamPublications: [],
    visibleMilestones: [],
    inlineErrors: [],
    runtimeErrors: [],
    overflow: false,
  };
  const generationActive = () => document.querySelector('[data-osg-action="generate-subtitles"]')
    ?.classList.contains('processing') === true;
  const rows = () => [...document.querySelectorAll('.lyric-text')]
    .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, limit);
  const boundedPush = (target, value) => {
    if (target.length >= limit) {
      ledger.overflow = true;
      return;
    }
    target.push(value);
  };
  const recordInlineProblems = () => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
    };
    const found = [...document.querySelectorAll([
      '[role="alert"]', '.engine-card__error', '.tools-ledger__status--error',
      '.preview-error', '.error-message', '[data-osg-preview="error"]',
      '[data-osg-preview="refused"]',
    ].join(','))]
      .filter((node) => !node.closest('.toast-panel') && visible(node))
      .map((node) => ({
        code: node.getAttribute('data-osg-preview-code') || null,
        text: (node.innerText || '').trim().slice(0, 500),
      }))
      .filter(({ code, text }) => code || text);
    for (const problem of found) {
      if (!ledger.inlineErrors.some((existing) => JSON.stringify(existing) === JSON.stringify(problem))) {
        boundedPush(ledger.inlineErrors, problem);
      }
    }
  };
  const onRanges = (event) => {
    const ranges = event.detail?.ranges;
    if (Array.isArray(ranges) && ranges.length > 0) {
      boundedPush(ledger.rangePublications, ranges.map(({ start, end }) => ({ start, end })));
    }
  };
  const onStream = (event) => {
    const subtitles = Array.isArray(event.detail?.subtitles) ? event.detail.subtitles : [];
    const segment = event.detail?.segment;
    boundedPush(ledger.streamPublications, {
      generationActive: generationActive(),
      segment: segment === undefined ? null : { start: segment.start, end: segment.end },
      subtitles: subtitles.slice(0, limit).map(({ start, end, text }) => ({ start, end, text })),
      observedAtMs: performance.now(),
    });
  };
  const observer = new MutationObserver(() => {
    recordInlineProblems();
    const currentRows = rows();
    const previousCount = ledger.visibleMilestones.at(-1)?.rows.length ?? 0;
    if (generationActive()
        && ledger.streamPublications.length > 0
        && currentRows.length > previousCount) {
      boundedPush(ledger.visibleMilestones, {
        generationActive: true,
        streamCount: ledger.streamPublications.length,
        rows: currentRows,
        observedAtMs: performance.now(),
      });
    }
  });
  const onError = (event) => boundedPush(ledger.runtimeErrors, `error:${event.message}`);
  const onRejection = (event) => boundedPush(
    ledger.runtimeErrors,
    `rejection:${String(event.reason?.message ?? event.reason)}`,
  );
  window.addEventListener('processing-ranges', onRanges);
  window.addEventListener('streaming-update', onStream);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.__OSG_E2E_MULTI_ASR__ = {
    ledger,
    cleanup: () => {
      observer.disconnect();
      window.removeEventListener('processing-ranges', onRanges);
      window.removeEventListener('streaming-update', onStream);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    },
  };
}, MAX_WITNESS_ITEMS);

const readStreamingWitness = () => browser.execute(() => {
  const ledger = window.__OSG_E2E_MULTI_ASR__?.ledger;
  if (ledger === undefined) return null;
  return JSON.parse(JSON.stringify(ledger));
});

const cleanupStreamingWitness = () => browser.execute(() => {
  window.__OSG_E2E_MULTI_ASR__?.cleanup?.();
  delete window.__OSG_E2E_MULTI_ASR__;
});

const currentSurface = () => browser.execute(() => ({
  rows: [...document.querySelectorAll('.lyric-text')]
    .map((node) => (node.innerText || '').trim()).filter(Boolean),
  generationActive: document.querySelector('[data-osg-action="generate-subtitles"]')
    ?.classList.contains('processing') === true,
  previewState: document.querySelector('.video-preview [data-osg-preview]')
    ?.getAttribute('data-osg-preview') ?? null,
  previewCode: document.querySelector('.video-preview [data-osg-preview]')
    ?.getAttribute('data-osg-preview-code') ?? null,
  duration: (() => {
    const video = document.querySelector('.video-preview video.video-player');
    return Number.isFinite(video?.duration) ? video.duration : null;
  })(),
}));

const newTranscribeJobs = (root, baselineIds) => durableState(root).jobs.filter(({ id, kind }) => (
  kind === 'transcribe' && !baselineIds.has(id)
));

const assertNoDeletedCue = (surface, durable) => {
  for (const deleted of DELETED_CUES) {
    assert.ok(!surface.rows.includes(deleted), `visible generation resurrected ${JSON.stringify(deleted)}`);
    assert.ok(!durable.cues.some(({ text }) => text === deleted),
      `durable generation resurrected ${JSON.stringify(deleted)}`);
  }
};

const verifyRestoredProcess = async (root) => {
  const witness = JSON.parse(readFileSync(witnessPath(root), 'utf8'));
  const beforeUi = durableState(root);
  assert.deepEqual(
    beforeUi.cues.map(({ start_ms: startMs, end_ms: endMs, text }) => ({ startMs, endMs, text })),
    witness.durableCueSignatures,
    'the second process opened a different durable subtitle track',
  );
  assert.deepEqual(
    beforeUi.jobs.filter(({ kind }) => kind === 'transcribe').map(({ id, state }) => ({ id, state })),
    witness.jobs,
    'the four native job identities changed across relaunch',
  );

  await openEditor();
  let surface = null;
  await waitUntilWithFreshDiagnostic(async () => {
    surface = await currentSurface();
    return surface.rows.length === witness.durableCueSignatures.length
      && surface.duration !== null;
  }, {
    timeout: 180_000,
    interval: 1_000,
    diagnostic: () => `the second process did not restore the long ASR project: ${JSON.stringify(surface)}`,
  });
  assert.ok(
    Math.abs(surface.duration - FOUR_WINDOW_ASR_FIXTURE.durationSeconds)
      <= FOUR_WINDOW_ASR_FIXTURE.durationToleranceSeconds,
    `the restored source duration changed to ${surface.duration}`,
  );
  assert.deepEqual(await browser.execute(visibleProblemSurfacesInPage), [],
    'the restored project rendered an inline error');
  const cue = witness.durableCueSignatures[Math.floor(witness.durableCueSignatures.length / 2)];
  await seekPreviewTo((cue.startMs + cue.endMs) / 2_000);
  await waitForCanvasSubtitleFrame(180_000);
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: '06-restored-four-window-result',
    description: 'A second hidden desktop process restored the same long media, exact merged cues, and drawable native preview.',
    details: {
      cueCount: witness.durableCueSignatures.length,
      jobIds: witness.jobs.map(({ id }) => id),
      durationSeconds: surface.duration,
    },
    focusSelector: '.lyrics-container-wrapper',
  });
};

describe('maximum-duration local ASR across a real process restart', () => {
  it('splits into four owned jobs, streams monotonically, and restores the exact merge', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the hidden harness must provide an isolated data root');
    assert.ok(PHASE === 'seed' || PHASE === 'verify',
      'run this journey through scenarios/multiWindowAsrPersistence.mjs');
    if (PHASE === 'verify') {
      await verifyRestoredProcess(root);
      return;
    }

    await openProjectWithMedia();
    await ensureEngineReady(ENGINE, { allowInstall: false });
    let surface = await currentSurface();
    assert.ok(
      Math.abs(surface.duration - FOUR_WINDOW_ASR_FIXTURE.durationSeconds)
        <= FOUR_WINDOW_ASR_FIXTURE.durationToleranceSeconds,
      `the staged long real-speech fixture has duration ${surface.duration}`,
    );
    await importSubtitleDocument(deletedFixture(), 'deleted-four-window-cues.srt', DELETED_CUES[0]);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-long-speech-and-old-cues',
      description: 'A 204-second real-speech video is playable with four old cues that must be deleted durably.',
      details: { durationSeconds: surface.duration, deletedCueCount: DELETED_CUES.length },
      focusSelector: '.timeline-container',
    });

    const timeline = await $('.subtitle-timeline');
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);
    await browser.keys(['\uE017']);
    await browser.waitUntil(async () => {
      surface = await currentSurface();
      return surface.rows.length === 0 && durableState(root).counts.cues === 0;
    }, {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: 'Ctrl+A/Delete did not clear the old visible and durable track',
    });

    await clickControl('[data-osg-action="generate-subtitles"]');
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);
    const method = await $(`[data-transcription-method="${ENGINE}"]`);
    await method.waitForDisplayed({ timeout: 60_000, timeoutMsg: 'the ASR chooser did not open' });
    await browser.waitUntil(async () => (await method.getAttribute('data-method-available')) === 'true', {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: `${ENGINE} never became selectable`,
    });
    await method.click();
    const actuation = await actuateNativeRange({
      driver: browser,
      selector: '#asr-max-duration-slider',
      value: MAX_REQUEST_MINUTES,
      label: 'public ASR maximum-duration slider',
    });
    let splitLabel = null;
    await waitUntilWithFreshDiagnostic(async () => {
      splitLabel = await browser.execute(() => ({
        value: document.querySelector('#asr-max-duration-slider')?.value ?? null,
        text: (document.querySelector('#asr-max-duration-slider')
          ?.closest('.slider-with-value')?.innerText || '').trim(),
        parallel: (document.querySelector('#asr-max-duration-slider')
          ?.closest('.slider-with-value')?.querySelector('.parallel-info')?.innerText || '').trim(),
      }));
      return splitLabel.value === '1' && /4/u.test(splitLabel.parallel);
    }, {
      timeout: 30_000,
      interval: 100,
      diagnostic: () => `the public one-minute setting did not promise four parts: ${JSON.stringify(splitLabel)}`,
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-public-four-part-setting',
      description: 'The customer-facing maximum-duration slider is set to one minute and visibly predicts four parts.',
      details: { actuation, splitLabel },
      focusSelector: '.video-processing-modal',
    });

    const before = durableState(root);
    const baselineJobIds = new Set(before.jobs.map(({ id }) => id));
    await installStreamingWitness();
    await clickControl('[data-osg-action="process-subtitles"]');

    let ledger = null;
    let ownedJobs = [];
    await waitUntilWithFreshDiagnostic(async () => {
      ledger = await readStreamingWitness();
      surface = await currentSurface();
      const durable = durableState(root);
      assertNoDeletedCue(surface, durable);
      ownedJobs = newTranscribeJobs(root, baselineJobIds);
      const terminal = ownedJobs.find(({ state }) => ['failed', 'cancelled', 'interrupted'].includes(state));
      if (terminal) throw new Error(`one of the four ASR jobs terminated early: ${JSON.stringify(terminal)}`);
      return ledger?.streamPublications.length >= 1
        && ledger.visibleMilestones.some(({ streamCount }) => streamCount === 1)
        && surface.generationActive;
    }, {
      timeout: 1_800_000,
      interval: 500,
      diagnostic: () => `window one never streamed into the active timeline: ${JSON.stringify({ ledger, ownedJobs, surface })}`,
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-first-window-streaming',
      description: 'The first native window has published fresh visible rows while aggregate generation is still active.',
      details: { jobCount: ownedJobs.length, visibleCueCount: surface.rows.length },
      focusSelector: '.lyrics-container-wrapper',
    });

    await waitUntilWithFreshDiagnostic(async () => {
      ledger = await readStreamingWitness();
      surface = await currentSurface();
      const durable = durableState(root);
      assertNoDeletedCue(surface, durable);
      ownedJobs = newTranscribeJobs(root, baselineJobIds);
      const terminal = ownedJobs.find(({ state }) => ['failed', 'cancelled', 'interrupted'].includes(state));
      if (terminal) throw new Error(`one of the four ASR jobs terminated early: ${JSON.stringify(terminal)}`);
      return ledger?.streamPublications.length >= 3
        && ledger.visibleMilestones.some(({ streamCount }) => streamCount === 3)
        && surface.generationActive;
    }, {
      timeout: 1_800_000,
      interval: 500,
      diagnostic: () => `window three never streamed before aggregate completion: ${JSON.stringify({ ledger, ownedJobs, surface })}`,
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-third-window-streaming',
      description: 'Three distinct native windows have grown the visible timeline monotonically and processing remains active.',
      details: { jobCount: ownedJobs.length, visibleCueCount: surface.rows.length },
      focusSelector: '.lyrics-container-wrapper',
    });

    let final = null;
    await waitUntilWithFreshDiagnostic(async () => {
      ledger = await readStreamingWitness();
      surface = await currentSurface();
      final = durableState(root);
      assertNoDeletedCue(surface, final);
      ownedJobs = newTranscribeJobs(root, baselineJobIds);
      const terminal = ownedJobs.find(({ state }) => ['failed', 'cancelled', 'interrupted'].includes(state));
      if (terminal) throw new Error(`one of the four ASR jobs terminated early: ${JSON.stringify(terminal)}`);
      return ownedJobs.length === EXPECTED_WINDOWS
        && ownedJobs.every(({ state }) => state === 'succeeded')
        && ledger?.streamPublications.length === EXPECTED_WINDOWS
        && ledger.visibleMilestones.some(({ streamCount }) => streamCount === EXPECTED_WINDOWS)
        && final.counts.cues > 0
        && surface.generationActive === false;
    }, {
      timeout: 1_800_000,
      interval: 1_000,
      diagnostic: () => `the four-window generation did not settle durably: ${JSON.stringify({ ledger, ownedJobs, surface, counts: final?.counts })}`,
    });
    assert.equal(ledger.overflow, false, 'the bounded streaming witness overflowed');
    assert.deepEqual(ledger.runtimeErrors, [], 'the WebView raised an error during four-window ASR');
    const inlineErrors = [
      ...ledger.inlineErrors.map((value) => JSON.stringify(value)),
      ...(await browser.execute(visibleProblemSurfacesInPage)).map((value) => JSON.stringify(value)),
    ];
    const oracle = assertMultiWindowAsrResult({
      durationSeconds: surface.duration,
      maxRequestSeconds: FOUR_WINDOW_ASR_FIXTURE.maxRequestSeconds,
      expectedCount: EXPECTED_WINDOWS,
      forbiddenTexts: DELETED_CUES,
      jobs: ownedJobs,
      rangePublications: ledger.rangePublications,
      streamPublications: ledger.streamPublications,
      visibleMilestones: ledger.visibleMilestones,
      durableCues: final.cues,
      inlineErrors,
    });
    await cleanupStreamingWitness();

    const firstCue = final.cues[0];
    await seekPreviewTo((Number(firstCue.start_ms) + Number(firstCue.end_ms)) / 2_000);
    await waitForCanvasSubtitleFrame(180_000);
    const durableCueSignatures = final.cues.map(({ start_ms: startMs, end_ms: endMs, text }) => ({
      startMs, endMs, text,
    }));
    writeFileSync(witnessPath(root), JSON.stringify({
      schemaVersion: 1,
      durationSeconds: surface.duration,
      ranges: oracle.ranges,
      jobs: ownedJobs.map(({ id, state }) => ({ id, state })),
      durableCueSignatures,
    }, null, 2), { encoding: 'utf8', flag: 'wx' });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-four-window-merge-saved',
      description: 'Four distinct native jobs succeeded; their exact streamed union is ordered, durable, old-cue-free, and natively drawable.',
      details: { cueCount: oracle.cueCount, jobIds: oracle.jobIds, ranges: oracle.ranges },
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
