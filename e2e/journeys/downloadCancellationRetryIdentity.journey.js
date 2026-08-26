// A hidden, dialog-free customer journey for the two failure modes that previously escaped the
// downloader suite: cancellation/retry ownership and URL A -> URL B identity safety.
//
// Both URLs are exact, unguessable capabilities created before the automation binary launches.
// They point at a launcher-owned, range-capable throttled origin bound only to 127.0.0.1. Production
// rejects loopback; only the compile-time E2E graph receives this exact two-URL allow-list. Every
// interaction below is public UI: paste, Generate, Cancel, retry, paste B, Generate. No dialog,
// command invocation, React mutation, or browser storage write is used.

/* global $, browser, describe, document, it, localStorage, process */

import { strict as assert } from 'node:assert';
import { relative, resolve, sep } from 'node:path';

import { clickControl, openEditor } from '../support/editor.js';
import {
  downloadDurabilityState,
  downloadScratchFiles,
  managedArtifactFiles,
  resolveManagedArtifact,
  sha256File,
} from '../support/downloadJourneyOracle.js';
import { readDownloadFixtureEvents } from '../support/downloadFixtureOrigin.js';
import {
  DOWNLOAD_IDENTITY_VIDEO,
  SOURCE_SWITCH_VIDEO,
} from '../support/realMedia.js';
import {
  captureWorkflowStep,
  copyWorkflowArtifact,
} from '../support/workflowEvidence.js';

const WORKFLOW = 'download-cancellation-retry-identity';
const GENERATE = '[data-osg-action="generate-subtitles"]';
const CANCEL = '.cancel-download-btn';
const URL_TAB = '[data-input-tab="unified-url"]';
const RUN_ROOT = process.env.OSG_E2E_DATA_ROOT;
const EVENTS_PATH = process.env.OSG_E2E_DOWNLOAD_FIXTURE_EVENTS;

const parseManifest = () => {
  const raw = process.env.OSG_E2E_DOWNLOAD_FIXTURE_MANIFEST;
  const allowedRaw = process.env.OSG_E2E_EXACT_DOWNLOAD_URLS;
  assert.ok(typeof raw === 'string' && typeof allowedRaw === 'string',
    'the launcher did not provide exact download fixture capabilities');
  const manifest = JSON.parse(raw);
  const allowed = JSON.parse(allowedRaw);
  assert.deepEqual(manifest.map(({ label }) => label), ['a', 'b']);
  assert.deepEqual(manifest.map(({ url }) => url), allowed,
    'the journey manifest differs from the application allow-list');
  for (const entry of manifest) {
    assert.match(entry.url,
      /^http:\/\/127\.0\.0\.1:\d+\/[ab]\.mp4\?token=[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u);
  }
  assert.notEqual(manifest[0].sha256, manifest[1].sha256,
    'A and B must have genuinely different bytes');
  return Object.freeze({ a: manifest[0], b: manifest[1] });
};

const fixture = parseManifest();

const visibleDownloadState = () => browser.execute(() => {
  const video = document.querySelector('.video-preview video.video-player');
  const canvas = document.querySelector(
    '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
  );
  const sessionRaw = localStorage.getItem('current_media_session');
  let session = null;
  if (sessionRaw !== null) {
    try { session = JSON.parse(sessionRaw); } catch { session = { malformed: true }; }
  }
  return {
    sourceUrl: localStorage.getItem('current_video_url'),
    fileUrl: localStorage.getItem('current_file_url'),
    fileName: (document.querySelector('.file-info-card .file-name')?.textContent || '').trim(),
    session,
    selectedUrl: (document.querySelector('.video-url-value')?.textContent || '').trim(),
    cancelVisible: (() => {
      const node = document.querySelector('.cancel-download-btn');
      if (node === null) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !node.disabled;
    })(),
    generateDisabled: document.querySelector('[data-osg-action="generate-subtitles"]')?.disabled ?? null,
    preview: document.querySelector('.video-preview [data-osg-preview]')
      ?.getAttribute('data-osg-preview') ?? null,
    video: video === null ? null : {
      src: video.currentSrc,
      duration: video.duration,
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
    },
    canvasRevision: Number(canvas?.dataset.osgFrameRevision ?? 0),
    errorToasts: [...document.querySelectorAll('.toast-item.live .toast.toast-error')]
      .map((node) => (node.innerText || '').trim()).filter(Boolean),
    inlineErrors: [...document.querySelectorAll('.video-container .error, .native-video-container .error')]
      .map((node) => (node.innerText || '').trim()).filter(Boolean),
  };
});

const openGetRequests = (route) => {
  const requests = new Map();
  for (const event of readDownloadFixtureEvents(EVENTS_PATH)) {
    if (event.route !== route || !Number.isSafeInteger(event.requestId)) continue;
    const current = requests.get(event.requestId) ?? {
      requestId: event.requestId,
      method: null,
      progressBytes: 0,
      terminal: null,
    };
    if (event.event === 'request-start') current.method = event.method;
    if (event.event === 'request-progress') current.progressBytes = event.bytesSent;
    if (event.event === 'request-complete' || event.event === 'request-aborted') {
      current.terminal = event.event;
    }
    requests.set(event.requestId, current);
  }
  return [...requests.values()].filter(({ method, terminal }) => method === 'GET' && terminal === null);
};

const waitForOpenTransfer = async (route, { exclude = new Set() } = {}) => {
  let active = null;
  await browser.waitUntil(async () => {
    active = openGetRequests(route).find(({ requestId }) => !exclude.has(requestId)) ?? null;
    return active !== null;
  }, {
    timeout: 120_000,
    interval: 50,
    timeoutMsg: `the fixture origin never observed an open ${route.toUpperCase()} transfer`,
  });
  return active;
};

const waitForRequestTerminal = async (requestId, terminal) => {
  await browser.waitUntil(async () => readDownloadFixtureEvents(EVENTS_PATH).some((event) => (
    event.requestId === requestId && event.event === terminal
  )), {
    timeout: 60_000,
    interval: 50,
    timeoutMsg: `fixture request ${requestId} never became ${terminal}`,
  });
};

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
      timeoutMsg: 'the exact URL never became the selected public input',
    });
  } catch (error) {
    throw new Error(
      `the exact URL never became the selected public input: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
};

const waitForPlayable = async (url, expected) => {
  let state = null;
  try {
    await browser.waitUntil(async () => {
      state = await visibleDownloadState();
      return state.sourceUrl === url
        && state.session !== null
        && state.session.malformed !== true
        && state.video !== null
        && state.video.readyState >= 2
        && state.video.width === expected.width
        && state.video.height === expected.height
        && Number.isFinite(state.video.duration)
        && Math.abs(state.video.duration - expected.durationSeconds)
          <= expected.durationToleranceSeconds
        && state.canvasRevision > 0;
    }, {
      timeout: 180_000,
      interval: 250,
      timeoutMsg: 'downloaded media never became the exact playable source',
    });
  } catch (error) {
    throw new Error(
      `downloaded media never became the exact playable source: ${JSON.stringify(state)}`,
      { cause: error },
    );
  }
  assert.deepEqual(state.errorToasts, []);
  assert.deepEqual(state.inlineErrors, []);
  return state;
};

const assertNoPublishedCandidate = (state) => {
  assert.equal(state.projects.length, 0, 'a partial download created a subtitle project');
  assert.equal(state.media.length, 0, 'a partial download published a media asset');
  assert.equal(state.links.length, 0, 'a partial download created project ownership');
  assert.equal(state.artifacts.length, 0, 'a partial download published an artifact');
  assert.equal(state.managedArtifacts.length, 0, 'a partial download published a derived artifact');
  assert.equal(state.cacheEntries.length, 0, 'a partial download published a cache entry');
  assert.equal(state.mediaArtifacts.length, 0, 'a partial download created an artifact edge');
  assert.equal(state.jobClaims.length, 0, 'a partial download created a successful-job claim');
  assert.equal(state.alias, null, 'a partial download published a project alias');
};

const managedLedgerMatchesDisk = (state) => {
  const expected = state.managedArtifacts.map(({ relative_path: path }) => path).sort();
  const artifactRoot = resolve(RUN_ROOT, 'data', 'artifacts');
  const actual = managedArtifactFiles(RUN_ROOT)
    .map((path) => relative(artifactRoot, path).split(sep).join('/'))
    .sort();
  return expected.length === actual.length
    && expected.every((path, index) => path === actual[index]);
};

const normalizeUuid = (value) => String(value ?? '').replaceAll('-', '').toLowerCase();

const assertExactArtifact = (state, manifest, expectedJobId) => {
  const artifact = state.artifacts.find(({ size_bytes: bytes }) => bytes === manifest.bytes);
  assert.ok(artifact, `${manifest.label} has no exact-size durable artifact`);
  assert.equal(artifact.state, 'ready');
  assert.equal(artifact.job_id, expectedJobId, `${manifest.label} was claimed by the wrong job`);
  const path = resolveManagedArtifact(RUN_ROOT, artifact.relative_path);
  assert.equal(sha256File(path), manifest.sha256,
    `${manifest.label} durable bytes differ from the exact source`);
  const edge = state.mediaArtifacts.find(({ artifact_id: artifactId }) => artifactId === artifact.id);
  assert.ok(edge, `${manifest.label} artifact is not media-owned`);
  const claim = state.jobClaims.find(({ artifact_id: artifactId, job_id: jobId }) => (
    artifactId === artifact.id && jobId === expectedJobId
  ));
  assert.ok(claim, `${manifest.label} lacks exact successful-job provenance`);
  const media = state.media.find(({ id }) => id === edge.media_id);
  assert.ok(media, `${manifest.label} ownership points to missing media`);
  assert.equal(media.content_hash, artifact.content_hash,
    `${manifest.label} media/artifact content identities disagree`);
  return { artifact, media, path };
};

describe('download cancellation, retry, and A to B identity', () => {
  it('never publishes a cancelled candidate and never reactivates the prior URL', async () => {
    assert.ok(RUN_ROOT, 'the journey has no isolated data root');
    assert.equal(
      resolve(EVENTS_PATH),
      resolve(RUN_ROOT, 'evidence', 'download-fixture-events.jsonl'),
      'the fixture ledger escaped the isolated evidence root',
    );
    await openEditor();

    await setExactUrl(fixture.a.url);
    await clickControl(GENERATE);
    await (await $(CANCEL)).waitForDisplayed({
      timeout: 120_000,
      timeoutMsg: 'source A never exposed its public Cancel control',
    });
    const firstTransfer = await waitForOpenTransfer('a');
    let durable = downloadDurabilityState(RUN_ROOT);
    assert.equal(durable.jobs.length, 1, 'the first transfer registered the wrong job count');
    const cancelledJobId = durable.jobs[0].id;
    assertNoPublishedCandidate(durable);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-a-downloading',
      description: 'Source A is transferring through the real download path and exposes public cancellation.',
      details: { source: 'a', jobCount: 1 },
      focusSelector: CANCEL,
    });

    // Retry as soon as the public control becomes actionable. Waiting for a database terminal here
    // would hide the exact race this journey exists to catch.
    await clickControl(CANCEL);
    await clickControl(GENERATE, { timeout: 30_000 });
    await waitForRequestTerminal(firstTransfer.requestId, 'request-aborted');
    await (await $(CANCEL)).waitForDisplayed({
      timeout: 120_000,
      timeoutMsg: 'the immediate retry reused the cancelling operation or never registered',
    });
    const retryTransfer = await waitForOpenTransfer('a', {
      exclude: new Set([firstTransfer.requestId]),
    });
    assert.notEqual(retryTransfer.requestId, firstTransfer.requestId,
      'retry attached to the cancelled origin request');
    await browser.waitUntil(async () => {
      durable = downloadDurabilityState(RUN_ROOT);
      return durable.jobs.length === 2;
    }, {
      timeout: 120_000,
      interval: 100,
      timeoutMsg: 'the immediate retry did not register a distinct native job',
    });
    assertNoPublishedCandidate(durable);
    const retryJobId = durable.jobs.find(({ id }) => id !== cancelledJobId)?.id;
    assert.ok(retryJobId, 'the retry reused the cancelled durable job id');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-a-cancelled-and-retried',
      description: 'The public retry immediately detached from cancelled A and started a distinct operation.',
      details: { source: 'a', jobCount: 2, publishedCandidates: 0 },
      focusSelector: CANCEL,
    });

    const aVisible = await waitForPlayable(fixture.a.url, SOURCE_SWITCH_VIDEO);
    await browser.waitUntil(async () => {
      durable = downloadDurabilityState(RUN_ROOT);
      return durable.jobs.find(({ id }) => id === cancelledJobId)?.state === 'cancelled'
        && durable.jobs.find(({ id }) => id === retryJobId)?.state === 'succeeded'
        && durable.artifacts.length === 1
        && durable.cacheEntries.length === 1
        && durable.managedArtifacts.length === 2
        && managedLedgerMatchesDisk(durable);
    }, {
      timeout: 180_000,
      interval: 250,
      timeoutMsg: 'source A cancellation/retry never reached durable terminal states',
    });
    assert.deepEqual(downloadScratchFiles(RUN_ROOT), [],
      'cancelled or completed source A left scratch download bytes');
    assert.equal(durable.managedArtifacts.filter(({ kind }) => kind === 'downloadedMedia').length, 1);
    assert.equal(durable.managedArtifacts.filter(({ kind }) => kind === 'waveformCache').length, 1);
    const aOwned = assertExactArtifact(durable, fixture.a, retryJobId);
    assert.equal(durable.projects.length, 1);
    assert.equal(durable.media.length, 1);
    assert.equal(durable.links.length, 1);
    assert.equal(durable.links[0].role, 'primary');
    assert.equal(durable.mediaArtifacts.length, 1);
    assert.equal(durable.jobClaims.length, 1);
    assert.equal(durable.alias.activeCacheId, aVisible.session.cacheId);
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'source-a-durable-media',
      source: aOwned.path,
      description: 'Exact durable bytes published only by source A retry success.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-a-playable',
      description: 'Retried source A is the one durable, playable active media project.',
      details: {
        source: 'a',
        durationSeconds: aVisible.video.duration,
        dimensions: [aVisible.video.width, aVisible.video.height],
      },
      focusSelector: '.video-preview',
    });

    const aSession = aVisible.session;
    const aVideoSrc = aVisible.video.src;
    await setExactUrl(fixture.b.url);
    const bRequestBaseline = new Set(
      readDownloadFixtureEvents(EVENTS_PATH).map(({ requestId }) => requestId).filter(Number.isSafeInteger),
    );
    await clickControl(GENERATE);
    await (await $(CANCEL)).waitForDisplayed({
      timeout: 120_000,
      timeoutMsg: 'source B never exposed its in-progress public state',
    });
    await waitForOpenTransfer('b', { exclude: bRequestBaseline });
    let switching = null;
    try {
      await browser.waitUntil(async () => {
        switching = await visibleDownloadState();
        return switching.sourceUrl === null
          && switching.fileUrl === null
          && switching.session === null
          && (switching.video === null || switching.video.src !== aVideoSrc);
      }, {
        timeout: 30_000,
        interval: 50,
        timeoutMsg: 'source A remained visible while B was transferring',
      });
    } catch (error) {
      throw new Error(
        `source A remained visible while B was transferring: ${JSON.stringify(switching)}`,
        { cause: error },
      );
    }
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-b-withdrew-a',
      description: 'Choosing source B withdraws every visible A identity before fallible network work.',
      details: { source: 'b', priorSourceVisible: false },
      focusSelector: CANCEL,
    });

    const bVisible = await waitForPlayable(fixture.b.url, DOWNLOAD_IDENTITY_VIDEO);
    await browser.waitUntil(async () => {
      durable = downloadDurabilityState(RUN_ROOT);
      return durable.jobs.length === 3
        && durable.jobs.filter(({ state }) => state === 'succeeded').length === 2
        && durable.artifacts.length === 2
        && durable.cacheEntries.length === 2
        && durable.managedArtifacts.length === 4
        && managedLedgerMatchesDisk(durable);
    }, {
      timeout: 180_000,
      interval: 250,
      timeoutMsg: 'source B never reached a distinct durable terminal state',
    });
    const bJob = durable.jobs.find(({ id }) => ![cancelledJobId, retryJobId].includes(id));
    assert.equal(bJob?.state, 'succeeded');
    const bOwned = assertExactArtifact(durable, fixture.b, bJob.id);
    assert.deepEqual(downloadScratchFiles(RUN_ROOT), [],
      'the final A to B flow left partial scratch bytes');
    assert.equal(durable.managedArtifacts.filter(({ kind }) => kind === 'downloadedMedia').length, 2);
    assert.equal(durable.managedArtifacts.filter(({ kind }) => kind === 'waveformCache').length, 2);
    assert.equal(managedLedgerMatchesDisk(durable), true,
      'the final A to B flow left an unowned or missing managed artifact');
    assert.equal(durable.projects.length, 2);
    assert.equal(durable.media.length, 2);
    assert.equal(durable.links.length, 2);
    assert.equal(durable.mediaArtifacts.length, 2);
    assert.equal(durable.jobClaims.length, 2);
    assert.equal(new Set(durable.media.map(({ content_hash: hash }) => hash)).size, 2);
    assert.equal(durable.alias.entries.length, 2);
    assert.equal(durable.alias.activeCacheId, bVisible.session.cacheId);
    assert.notEqual(bVisible.session.cacheId, aSession.cacheId);
    assert.notEqual(normalizeUuid(bVisible.session.assetId), normalizeUuid(aSession.assetId));
    assert.equal(normalizeUuid(bVisible.session.assetId), bOwned.media.id);
    assert.equal(durable.media.some(({ id }) => id === aOwned.media.id), true,
      'source B activation erased durable source A');
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'source-b-durable-media',
      source: bOwned.path,
      description: 'Exact durable bytes of distinct source B after A remains safely historical.',
    });
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'range-origin-ledger',
      source: EVENTS_PATH,
      description: 'Path-free request ledger proving interrupted and completed range transfers.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-b-playable-a-retained',
      description: 'Distinct source B is active and playable while source A remains durable but invisible.',
      details: {
        source: 'b',
        durationSeconds: bVisible.video.duration,
        dimensions: [bVisible.video.width, bVisible.video.height],
        durableProjectCount: durable.projects.length,
      },
      focusSelector: '.video-preview',
    });
  });
});
