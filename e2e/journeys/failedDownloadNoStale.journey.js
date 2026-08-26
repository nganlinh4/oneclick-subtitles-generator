// Hidden real-binary proof for the failure shape customers reported: source A is playing, source C
// fails, and the app must not lie by showing A again. C passes yt-dlp's real inspection once and
// then receives HTTP 503 from a launcher-owned exact loopback capability. No command, dialog,
// React state, browser storage, or database state is changed by this journey.

/* global $, $$, browser, describe, document, getComputedStyle, it, localStorage, process */

import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';

import { clickControl, openEditor } from '../support/editor.js';
import {
  assertFailedDownloadLeavesOnlyHistory,
  assertNoVisibleOrPlayableMedia,
  failedDownloadDurabilityState,
  staleMediaViolations,
} from '../support/failedDownloadNoStaleOracle.js';
import { readDownloadFixtureEvents } from '../support/downloadFixtureOrigin.js';
import {
  SOURCE_SWITCH_VIDEO,
} from '../support/realMedia.js';
import {
  captureWorkflowStep,
  copyWorkflowArtifact,
} from '../support/workflowEvidence.js';

const WORKFLOW = 'failed-download-no-stale';
const GENERATE = '[data-osg-action="generate-subtitles"]';
const URL_TAB = '[data-input-tab="unified-url"]';
const RUN_ROOT = process.env.OSG_E2E_DATA_ROOT;
const EVENTS_PATH = process.env.OSG_E2E_DOWNLOAD_FIXTURE_EVENTS;

const parseManifest = () => {
  const raw = process.env.OSG_E2E_DOWNLOAD_FIXTURE_MANIFEST;
  const allowedRaw = process.env.OSG_E2E_EXACT_DOWNLOAD_URLS;
  assert.ok(typeof raw === 'string' && typeof allowedRaw === 'string',
    'the launcher did not provide exact failed-download fixture capabilities');
  const manifest = JSON.parse(raw);
  const allowed = JSON.parse(allowedRaw);
  assert.deepEqual(manifest.map(({ label }) => label), ['a', 'c']);
  assert.deepEqual(manifest.map(({ url }) => url), allowed,
    'the failure manifest differs from the application allow-list');
  for (const entry of manifest) {
    assert.match(entry.url,
      /^http:\/\/127\.0\.0\.1:\d+\/[ac]\.mp4\?token=[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u);
  }
  assert.equal(manifest[0].failure, null);
  assert.deepEqual(manifest[1].failure,
    { kind: 'rejectGetAfter', after: 1, status: 503 });
  return Object.freeze({ a: manifest[0], c: manifest[1] });
};

const fixture = parseManifest();

const visibleDownloadState = () => browser.execute(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
  };
  const text = (node) => (node?.innerText || node?.textContent || '').trim().replace(/\s+/gu, ' ');
  const sessionRaw = localStorage.getItem('current_media_session');
  let session = null;
  if (sessionRaw !== null) {
    try { session = JSON.parse(sessionRaw); } catch { session = { malformed: true }; }
  }
  const mediaElements = [...document.querySelectorAll('video, audio')].map((node) => ({
    currentSrc: node.currentSrc || '',
    src: node.getAttribute('src') || '',
    readyState: node.readyState,
    paused: node.paused,
    duration: node.duration,
    width: node.videoWidth ?? 0,
    height: node.videoHeight ?? 0,
  }));
  return {
    sourceUrl: localStorage.getItem('current_video_url'),
    fileUrl: localStorage.getItem('current_file_url'),
    fileName: text(document.querySelector('.file-info-card .file-name')),
    session,
    selectedUrl: text(document.querySelector('.video-url-value')),
    generateDisabled: document.querySelector('[data-osg-action="generate-subtitles"]')?.disabled ?? null,
    cancelVisible: (() => {
      const node = document.querySelector('.cancel-download-btn');
      return node !== null && visible(node) && !node.disabled;
    })(),
    mediaElements,
    preview: document.querySelector('.video-preview [data-osg-preview]')
      ?.getAttribute('data-osg-preview') ?? null,
    canvasRevision: Number(document.querySelector(
      '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
    )?.dataset.osgFrameRevision ?? 0),
    errorToasts: [...document.querySelectorAll('.toast-item.live .toast.toast-error')]
      .filter(visible).map(text).filter(Boolean),
    inlineErrors: [...document.querySelectorAll(
      '.error, .error-message, [role="alert"], .native-preview-unavailable',
    )].filter((node) => node.closest('.toast-item') === null && visible(node))
      .map(text).filter(Boolean),
  };
});

const setExactUrl = async (url) => {
  await clickControl(URL_TAB);
  const field = await $('.url-field');
  await field.waitForDisplayed({ timeout: 30_000 });
  await field.setValue(url);
  let state = null;
  try {
    await browser.waitUntil(async () => {
      state = await visibleDownloadState();
      return state.selectedUrl === url;
    }, {
      timeout: 30_000,
      interval: 50,
      timeoutMsg: 'the exact URL never became public input',
    });
  } catch (error) {
    throw new Error(
      `the exact URL never became public input: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
};

const waitForPlayableA = async () => {
  let state = null;
  try {
    await browser.waitUntil(async () => {
      state = await visibleDownloadState();
      const video = state.mediaElements.find(({ readyState }) => readyState >= 2);
      return state.sourceUrl === fixture.a.url
        && state.session !== null
        && state.session.malformed !== true
        && video !== undefined
        && video.width === SOURCE_SWITCH_VIDEO.width
        && video.height === SOURCE_SWITCH_VIDEO.height
        && Number.isFinite(video.duration)
        && Math.abs(video.duration - SOURCE_SWITCH_VIDEO.durationSeconds)
          <= SOURCE_SWITCH_VIDEO.durationToleranceSeconds
        && state.canvasRevision > 0;
    }, {
      timeout: 180_000,
      interval: 250,
      timeoutMsg: 'source A never became playable',
    });
  } catch (error) {
    throw new Error(
      `source A never became playable: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
  assert.deepEqual(state.errorToasts, []);
  assert.deepEqual(state.inlineErrors, []);
  return Object.freeze({
    ...state,
    videoSrc: state.mediaElements.find(({ readyState }) => readyState >= 2).currentSrc,
  });
};

const closeLiveToasts = async () => {
  for (const close of await $$('.toast-item.live .close-icon')) await close.click();
  await browser.waitUntil(
    async () => await browser.execute(() => document.querySelectorAll('.toast-item.live').length) === 0,
    { timeout: 10_000, interval: 50, timeoutMsg: 'source A toasts did not dismiss before C' },
  );
};

const cEvents = () => readDownloadFixtureEvents(EVENTS_PATH).filter(({ route }) => route === 'c');

describe('failed URL download never reactivates stale media', () => {
  it('withdraws A before C network work and leaves only A history after C fails', async () => {
    assert.ok(RUN_ROOT, 'the journey has no isolated data root');
    assert.equal(
      resolve(EVENTS_PATH),
      resolve(RUN_ROOT, 'evidence', 'download-fixture-events.jsonl'),
      'the failure ledger escaped the isolated evidence root',
    );
    await openEditor();

    await setExactUrl(fixture.a.url);
    await clickControl(GENERATE);
    const prior = await waitForPlayableA();
    let before = null;
    await browser.waitUntil(async () => {
      before = failedDownloadDurabilityState(RUN_ROOT);
      return before.jobs.length === 1
        && before.jobs[0].state === 'succeeded'
        && before.projects.length === 1
        && before.media.length === 1
        && before.artifacts.length === 1
        && before.managedArtifacts.length === 2
        && before.cacheEntries.length === 1
        && before.managedDisk.length === 2
        && before.workspace.current !== null
        && before.scratch.length === 0;
    }, {
      timeout: 180_000,
      interval: 250,
      timeoutMsg: 'source A did not reach one exact durable success baseline',
    });
    assert.equal(prior.mediaElements.some(({ currentSrc }) => currentSrc === prior.videoSrc), true);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-source-a-playable',
      description: 'Source A is the sole durable and playable media before the failed replacement.',
      details: {
        projects: before.projects.length,
        media: before.media.length,
        downloadJobs: before.jobs.length,
        expectedDimensions: [SOURCE_SWITCH_VIDEO.width, SOURCE_SWITCH_VIDEO.height],
      },
      focusSelector: '.video-preview',
    });
    await closeLiveToasts();

    await setExactUrl(fixture.c.url);
    await clickControl(GENERATE);
    let switching = null;
    const networkWhileStale = [];
    try {
      await browser.waitUntil(async () => {
        switching = await visibleDownloadState();
        const violations = staleMediaViolations(switching, prior);
        if (cEvents().some(({ event }) => event === 'request-start') && violations.length > 0) {
          networkWhileStale.push(...violations);
        }
        return violations.length === 0;
      }, {
        timeout: 30_000,
        interval: 20,
        timeoutMsg: 'source A was not withdrawn for C',
      });
    } catch (error) {
      throw new Error(
        `source A was not withdrawn for C: ${JSON.stringify(switching)}`,
        { cause: error },
      );
    }
    assert.deepEqual(networkWhileStale, [],
      'source C network work began while source A was still customer-visible');
    assertNoVisibleOrPlayableMedia(switching, prior);

    await browser.waitUntil(async () => {
      const state = await visibleDownloadState();
      assertNoVisibleOrPlayableMedia(state, prior);
      return cEvents().some(({ event }) => event === 'request-start');
    }, {
      timeout: 120_000,
      interval: 50,
      timeoutMsg: 'source C never reached the deterministic origin',
    });
    const transient = await visibleDownloadState();
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-source-c-withdrew-a',
      description: 'Source C owns the new intent while every visible and playable A surface is empty.',
      details: { staleMediaViolations: 0, cOriginReached: true },
      focusSelector: '.selected-video-preview',
      ...(transient.errorToasts.length === 0 ? {} : {
        allowVisibleProblems: {
          errorToasts: transient.errorToasts.map((toast) => ({
            text: toast,
            reason: 'The deterministic source-C failure is the customer state under test.',
          })),
        },
      }),
    });

    let failedSurface = null;
    try {
      await browser.waitUntil(async () => {
        failedSurface = await visibleDownloadState();
        assertNoVisibleOrPlayableMedia(failedSurface, prior);
        return failedSurface.errorToasts.length === 1
          && failedSurface.cancelVisible === false
          && failedSurface.generateDisabled === false;
      }, {
        timeout: 180_000,
        interval: 100,
        timeoutMsg: 'source C never settled as one toast-only failure',
      });
    } catch (error) {
      throw new Error(
        `source C never settled as one toast-only failure: ${JSON.stringify(failedSurface)}`,
        { cause: error },
      );
    }
    assert.equal(failedSurface.selectedUrl, fixture.c.url);
    assert.deepEqual(failedSurface.inlineErrors, []);
    const failureToast = failedSurface.errorToasts[0];
    assert.ok(failureToast.length > 0 && failureToast.length <= 500,
      'the failure toast is empty or unbounded');
    for (const privateValue of [fixture.a.url, fixture.c.url, RUN_ROOT]) {
      assert.equal(failureToast.includes(privateValue), false,
        'the failure toast leaked a URL capability or private path');
    }
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-source-c-toast-only-failure',
      description: 'Source C fails through one toast while the video surface stays empty and A stays withdrawn.',
      details: { errorToastCount: 1, inlineErrorCount: 0, staleMediaViolations: 0 },
      focusSelector: '.toast-item.live .toast-error',
      allowVisibleProblems: {
        errorToasts: [{
          text: failureToast,
          reason: 'This exact deterministic download failure is the behavior this checkpoint proves.',
        }],
      },
    });

    let after = null;
    await browser.waitUntil(async () => {
      after = failedDownloadDurabilityState(RUN_ROOT);
      return after.jobs.length === before.jobs.length + 1
        && after.jobs.at(-1)?.state === 'failed'
        && after.scratch.length === 0;
    }, {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: 'source C did not reach terminal failed cleanup in SQLite',
    });
    const failedJob = assertFailedDownloadLeavesOnlyHistory(before, after);

    const events = cEvents();
    assert.ok(events.some(({ event }) => event === 'request-complete'
      || event === 'request-aborted'), 'source C never completed its one allowed inspection read');
    assert.ok(events.some(({ event, status }) => event === 'request-rejected' && status === 503),
      'source C did not receive the deterministic transfer refusal');
    assert.equal(JSON.stringify(events).includes('token='), false,
      'the origin ledger leaked an exact URL capability');

    // A terminal callback used to restore the previous media. Poll beyond the callback and toast
    // publication rather than checking only the instant at which failure first appeared.
    for (let sample = 0; sample < 20; sample += 1) {
      const state = await visibleDownloadState();
      assertNoVisibleOrPlayableMedia(state, prior);
      await browser.pause(100);
    }

    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'failure-origin-ledger',
      source: EVENTS_PATH,
      description: 'Path-free ledger proving one inspection read followed by HTTP 503 transfer refusal.',
    });
    const historicalArtifact = before.managedDisk.find(({ path }) => (
      before.artifacts.some(({ relative_path: artifactPath }) => artifactPath === path)
    ));
    assert.ok(historicalArtifact, 'source A historical artifact disappeared from the managed ledger');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-source-a-history-only',
      description: 'After the toast settles, the editor remains empty and A exists only in isolated durable history.',
      details: {
        failedJobId: failedJob.id,
        historicalProjects: after.projects.length,
        historicalMedia: after.media.length,
        activeWorkspace: null,
        scratchFiles: after.scratch.length,
      },
      focusSelector: '.selected-video-preview',
      ...(failedSurface.errorToasts.length === 0 ? {} : {
        allowVisibleProblems: {
          errorToasts: [{
            text: failureToast,
            reason: 'The exact source-C failure may still be within its bounded toast lifetime.',
          }],
        },
      }),
    });
  });
});
