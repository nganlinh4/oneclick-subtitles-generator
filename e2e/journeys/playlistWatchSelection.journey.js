/* global $, browser, describe, document, it, process */

import { strict as assert } from 'node:assert';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { confirmDownloadOnly } from '../support/download.js';
import { clickControl, openEditor } from '../support/editor.js';
import { probeMedia } from '../support/nativeMediaOracle.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'playlist-watch-selection';
// yt-dlp's maintained four-item YouTube playlist fixture, addressed at its shortest item.
const SOURCE = Object.freeze({
  url: 'https://www.youtube.com/watch?v=DpNKHkMbULM&list=PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu&index=4',
  id: 'DpNKHkMbULM',
  title: 'JOD4',
  playlistId: 'PL6IaIsEjSbf96XFRuNccS_RuEXwNdsoEu',
  playlistItems: 4,
  durationSeconds: 154,
});

const visibleState = () => browser.execute(() => ({
  selectedUrl: document.querySelector('.video-url-value')?.textContent?.trim() ?? '',
  title: document.querySelector('.video-title')?.textContent?.trim() ?? '',
  modal: document.querySelector('.download-only-modal') !== null,
  errors: [...document.querySelectorAll('.toast-error, [role="alert"]')]
    .map((node) => (node.textContent || '').trim()).filter(Boolean),
}));

describe('a customer downloads one selected video from a playlist watch URL', () => {
  it('publishes only the selected item and never expands adjacent playlist entries', async () => {
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(destination, 'the harness omitted the isolated save destination');
    const before = new Set(readdirSync(destination));

    await openEditor();
    const field = await $('.url-field');
    await field.setValue(SOURCE.url);
    await browser.waitUntil(async () => {
      const state = await visibleState();
      return state.selectedUrl === SOURCE.url && state.title.includes(SOURCE.title);
    }, {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: 'the playlist watch URL did not resolve to its selected item',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-selected-item-resolved',
      description: 'The playlist-bearing watch URL resolved to its selected item before download.',
      details: {
        selectedId: SOURCE.id,
        playlistId: SOURCE.playlistId,
        playlistItems: SOURCE.playlistItems,
      },
    });

    await clickControl('.download-only-btn');
    await confirmDownloadOnly({
      afterScan: async ({ qualities }) => captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-selected-item-formats',
        description: 'The quality modal describes formats for the selected item, not a playlist batch.',
        details: { selectedId: SOURCE.id, qualities },
      }),
    });

    let written = [];
    await browser.waitUntil(async () => {
      written = readdirSync(destination).filter((name) => !before.has(name));
      return written.length === 1 && statSync(join(destination, written[0])).size > 50_000;
    }, {
      timeout: 300_000,
      interval: 1_000,
      timeoutMsg: 'the selected playlist item was not published as exactly one file',
    });

    const output = join(destination, written[0]);
    assert.match(basename(output), /JOD4/iu, 'the customer filename does not identify the selected item');
    const probe = probeMedia(output);
    const video = probe.streams.find(({ codec_type: kind }) => kind === 'video');
    const duration = Number(probe.format?.duration);
    assert.ok(video && video.width > 0 && video.height > 0, 'the selected output has no decodable video');
    assert.ok(Number.isFinite(duration) && Math.abs(duration - SOURCE.durationSeconds) < 3,
      `duration ${duration} does not identify playlist item ${SOURCE.id}`);
    const state = await visibleState();
    assert.equal(state.modal, false, 'the playlist download modal remained stranded');
    assert.deepEqual(state.errors, [], 'the playlist download left a visible failure');

    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'selected-playlist-item',
      source: output,
      description: 'The one independently decoded item selected from the playlist watch URL.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-one-item-published',
      description: 'Exactly the selected playlist item was decoded; no adjacent item was published.',
      details: {
        selectedId: SOURCE.id,
        outputFiles: written,
        bytes: statSync(output).size,
        duration,
        width: video.width,
        height: video.height,
      },
    });
  });
});
