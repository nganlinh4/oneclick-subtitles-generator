/* global $, browser, describe, document, it, process */

import { strict as assert } from 'node:assert';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { confirmDownloadOnly } from '../support/download.js';
import { clickControl, openEditor } from '../support/editor.js';
import { probeMedia } from '../support/nativeMediaOracle.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'alternate-provider-download';
// An official yt-dlp Dailymotion extractor fixture: short, public, and account-free.
const SOURCE = Object.freeze({
  url: 'https://www.dailymotion.com/video/x94cnnk',
  id: 'x94cnnk',
  durationSeconds: 20,
});

const visibleState = () => browser.execute(() => ({
  selectedUrl: document.querySelector('.video-url-value')?.textContent?.trim() ?? '',
  title: document.querySelector('.video-title')?.textContent?.trim() ?? '',
  modal: document.querySelector('.download-only-modal') !== null,
  errors: [...document.querySelectorAll('.toast-error, [role="alert"]')]
    .map((node) => (node.textContent || '').trim()).filter(Boolean),
}));

describe('a customer downloads from a supported provider other than YouTube', () => {
  it('extracts Dailymotion formats and writes only that provider media', async () => {
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(destination, 'the harness omitted the isolated save destination');
    const before = new Set(readdirSync(destination));
    await openEditor();
    const field = await $('.url-field');
    await field.setValue(SOURCE.url);
    await browser.waitUntil(async () => {
      const state = await visibleState();
      return state.selectedUrl === SOURCE.url && /dailymotion\.com/iu.test(state.title);
    }, { timeout: 30_000, interval: 100, timeoutMsg: 'the alternate-provider URL was not selected' });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-dailymotion-selected',
      description: 'The public all-sites input retained the exact Dailymotion identity.',
      details: { provider: 'dailymotion.com', providerId: SOURCE.id },
    });

    await clickControl('.download-only-btn');
    await confirmDownloadOnly({
      afterScan: async ({ qualities }) => captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-provider-formats',
        description: 'The managed yt-dlp runtime exposed real Dailymotion video qualities.',
        details: { provider: 'dailymotion.com', qualities },
      }),
    });

    let written = [];
    await browser.waitUntil(async () => {
      written = readdirSync(destination).filter((name) => !before.has(name));
      return written.length === 1 && statSync(join(destination, written[0])).size > 50_000;
    }, { timeout: 300_000, interval: 1_000, timeoutMsg: 'the Dailymotion file was not published' });
    const output = join(destination, written[0]);
    const probe = probeMedia(output);
    const video = probe.streams.find(({ codec_type: kind }) => kind === 'video');
    const duration = Number(probe.format?.duration);
    assert.ok(video && video.width > 0 && video.height > 0, 'the output has no decodable video');
    assert.ok(Number.isFinite(duration) && Math.abs(duration - SOURCE.durationSeconds) < 4,
      `the output duration ${duration} does not identify the intended provider video`);
    const state = await visibleState();
    assert.equal(state.modal, false, 'the provider download modal remained stranded');
    assert.deepEqual(state.errors, [], 'the provider download left a visible failure');
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'dailymotion-video',
      source: output,
      description: 'The independently decoded file saved through the alternate-provider path.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-provider-file-published',
      description: 'Exactly one Dailymotion file decoded to the expected duration with no stale media.',
      details: { bytes: statSync(output).size, duration, width: video.width, height: video.height },
    });
  });
});
