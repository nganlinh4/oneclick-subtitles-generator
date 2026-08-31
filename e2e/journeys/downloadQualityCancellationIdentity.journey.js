/* global $, browser, describe, document, it, process */

import { strict as assert } from 'node:assert';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { clickControl, openEditor } from '../support/editor.js';
import { readDownloadFixtureEvents } from '../support/downloadFixtureOrigin.js';
import {
  downloadDurabilityState, downloadScratchFiles, managedArtifactFiles,
} from '../support/downloadJourneyOracle.js';
import { parseQualityHeight } from '../support/downloadQualityVariantsOracle.js';
import { probeMedia } from '../support/nativeMediaOracle.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'download-quality-cancellation-identity';
const URL = process.env.OSG_E2E_MULTI_FORMAT_URL;
const EVENTS = process.env.OSG_E2E_DOWNLOAD_FIXTURE_EVENTS;
const DESTINATION = process.env.OSG_E2E_MEDIA_DESTINATION;

const qualityState = () => browser.execute(() => ({
  qualities: [...document.querySelectorAll('.download-only-modal input[name="quality"]')]
    .map((input) => ({
      id: input.id,
      checked: input.checked,
      label: document.querySelector(`label[for="${input.id}"]`)?.textContent?.trim() ?? '',
    })),
  downloading: document.querySelector('.download-only-modal .confirm-button')?.disabled === true
    && document.querySelector('.download-only-modal .processing-text') !== null,
  modal: document.querySelector('.download-only-modal') !== null,
  errors: [...document.querySelectorAll('.toast-error, [role="alert"]')]
    .map((node) => (node.textContent || '').trim()).filter(Boolean),
}));

const openQualityModal = async () => {
  await clickControl('.download-only-btn');
  await clickControl('.download-only-modal input[name="download-type"][value="video"]');
  let state = null;
  await browser.waitUntil(async () => {
    state = await qualityState();
    return state.qualities.length >= 2;
  }, {
    timeout: 180_000,
    interval: 500,
    timeoutMsg: 'the deterministic multi-format page did not expose two video qualities',
  });
  return state.qualities;
};

const chooseQuality = async (qualities, index) => {
  assert.ok(index >= 0 && index < qualities.length);
  await clickControl(`#${qualities[index].id}`);
  const selected = await qualityState();
  assert.equal(selected.qualities[index].checked, true);
  const height = parseQualityHeight(selected.qualities[index].label);
  assert.ok(Number.isSafeInteger(height) && height > 0, 'selected quality has no parseable height');
  return { ...selected.qualities[index], height };
};

const openTransfers = () => {
  const requests = new Map();
  for (const event of readDownloadFixtureEvents(EVENTS)) {
    if (!['a', 'b'].includes(event.route) || !Number.isSafeInteger(event.requestId)) continue;
    const current = requests.get(event.requestId) ?? {
      id: event.requestId, route: event.route, method: null, progress: 0, terminal: null,
    };
    if (event.event === 'request-start') current.method = event.method;
    if (event.event === 'request-progress') current.progress = event.bytesSent;
    if (['request-complete', 'request-aborted', 'request-rejected'].includes(event.event)) {
      current.terminal = event.event;
    }
    requests.set(event.requestId, current);
  }
  return [...requests.values()].filter(({ method, terminal }) => method === 'GET' && terminal === null);
};

const waitForNewOpenTransfer = async (seenIds) => {
  let transfer = null;
  await browser.waitUntil(async () => {
    transfer = openTransfers().find(({ id, progress }) => !seenIds.has(id) && progress > 0) ?? null;
    return transfer !== null;
  }, {
    timeout: 120_000,
    interval: 50,
    timeoutMsg: 'the selected quality never began a throttled media transfer',
  });
  return transfer;
};

describe('quality changes cannot resurrect a cancelled download', () => {
  it('cancels one non-default quality, retries another, and publishes only the requested result', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root && URL && EVENTS && DESTINATION, 'the exact multi-format capability is missing');
    await openEditor();
    const field = await $('.url-field');
    await field.setValue(URL);
    await browser.waitUntil(async () => browser.execute((url) => (
      document.querySelector('.video-url-value')?.textContent?.trim() === url
    ), URL), { timeout: 30_000, interval: 100, timeoutMsg: 'multi-format URL was not selected' });

    const qualities = await openQualityModal();
    const defaultIndex = qualities.findIndex(({ checked }) => checked);
    assert.notEqual(defaultIndex, -1, 'the modal did not select a default quality');
    const cancelIndex = defaultIndex === 0 ? 1 : 0;
    const cancelledQuality = await chooseQuality(qualities, cancelIndex);
    const beforeCancel = downloadDurabilityState(root);
    const seenIds = new Set(readDownloadFixtureEvents(EVENTS).map(({ requestId }) => requestId));
    await clickControl('.download-only-modal .confirm-button');
    const transfer = await waitForNewOpenTransfer(seenIds);
    await clickControl('.download-only-modal .cancel-button');
    await $('.download-only-modal').waitForExist({ reverse: true, timeout: 30_000 });
    await browser.waitUntil(async () => readDownloadFixtureEvents(EVENTS).some((event) => (
      event.requestId === transfer.id && event.event === 'request-aborted'
    )), { timeout: 30_000, interval: 50, timeoutMsg: 'cancel did not abort the selected transfer' });
    assert.deepEqual(downloadScratchFiles(root), []);
    assert.deepEqual(managedArtifactFiles(root), []);
    assert.equal(downloadDurabilityState(root).media.length, beforeCancel.media.length);
    assert.deepEqual(readdirSync(DESTINATION), []);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-non-default-quality-cancelled',
      description: 'Cancelling the changed quality aborts its real transfer and leaves no file, media row, artifact or scratch byte.',
      details: { cancelledQuality, transfer: { route: transfer.route, progress: transfer.progress } },
    });

    const retryQualities = await openQualityModal();
    const retryIndex = retryQualities.findIndex(({ label }) => label !== cancelledQuality.label);
    assert.notEqual(retryIndex, -1, 'the retry offered no different quality');
    const completedQuality = await chooseQuality(retryQualities, retryIndex);
    const beforeFiles = new Set(readdirSync(DESTINATION));
    await clickControl('.download-only-modal .confirm-button');
    await $('.download-only-modal').waitForExist({ reverse: true, timeout: 180_000 });
    const written = readdirSync(DESTINATION).filter((name) => !beforeFiles.has(name));
    assert.equal(written.length, 1, 'retry did not publish exactly one customer file');
    const output = join(DESTINATION, written[0]);
    assert.ok(statSync(output).size > 10_000);
    const probe = probeMedia(output);
    const video = probe.streams.find(({ codec_type: type }) => type === 'video');
    assert.equal(video?.height, completedQuality.height,
      'retry published the cancelled quality instead of the newly selected quality');
    assert.notEqual(completedQuality.height, cancelledQuality.height);
    assert.deepEqual(downloadScratchFiles(root), []);
    assert.deepEqual(managedArtifactFiles(root), []);
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'quality-retry-output',
      source: output,
      description: 'The one file published after changing quality and retrying.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-different-quality-published',
      description: 'Retrying with another quality publishes exactly that decoded height, never the cancelled result.',
      details: {
        cancelledHeight: cancelledQuality.height,
        completedHeight: completedQuality.height,
        bytes: statSync(output).size,
      },
    });
  });
});
