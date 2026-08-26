// A customer uses the editor as a subtitle document tool without a provider or a video: import
// JSON through the public drop target, enter the product's explicit SRT-only mode, then save SRT,
// JSON and timing-free TXT through the public Download Center. Every saved file is parsed by an
// independent Node oracle; accepting the product's own serializer output is never proof by itself.

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { clickControl, openEditor } from '../support/editor.js';
import {
  snapshotOutputDirectory,
  verifySubtitleDocumentExport,
  waitForNewDocumentExport,
} from '../support/subtitleDocumentOracle.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'subtitle-document-round-trip';
const IMPORT_NAME = 'customer-document-roundtrip.json';
const EXPECTED = Object.freeze([
  Object.freeze({ ordinal: 1, startMs: 125, endMs: 1_875, text: 'Customer cue alpha\nSecond visual line' }),
  Object.freeze({ ordinal: 2, startMs: 2_500, endMs: 4_004, text: 'Unicode Việt 한글 🙂' }),
  Object.freeze({ ordinal: 3, startMs: 65_432, endMs: 67_890, text: 'Final document cue' }),
]);
const IMPORT_DOCUMENT = JSON.stringify(EXPECTED.map(({ startMs, endMs, text }) => ({
  start: startMs / 1_000,
  end: endMs / 1_000,
  text,
})), null, 2);

/* global $, browser, DataTransfer, describe, document, DragEvent, File, getComputedStyle, it */

const customerSurface = () => browser.execute(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
  };
  const text = (node) => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
  return {
    generationMode: document.querySelector('[data-osg-action="generate-subtitles"]')
      ?.getAttribute('data-generation-mode') ?? null,
    cueTexts: [...document.querySelectorAll('.lyric-item[data-lyric-index] .lyric-text')]
      .map((node) => (node.innerText || '').trim()),
    videos: document.querySelectorAll('.video-preview video.video-player').length,
    modalOpen: document.querySelector('.download-options-modal') !== null,
    selectedFormat: document.querySelector('input[name="file-format"]:checked')?.value ?? null,
    formats: [...document.querySelectorAll('input[name="file-format"]')]
      .map((node) => node.value),
    inlineErrors: [...document.querySelectorAll('.error, [role="alert"], .consolidation-status')]
      .filter((node) => node.closest('.toast-item') === null && visible(node)).map(text).filter(Boolean),
    toasts: [...document.querySelectorAll('.toast-item.live .toast')]
      .filter(visible).map(text).filter(Boolean),
  };
});

const waitForQuietCustomerSurface = async () => {
  let state = null;
  await waitUntilWithFreshDiagnostic(async () => {
    state = await customerSurface();
    return state.inlineErrors.length === 0 && state.toasts.length === 0;
  }, {
    timeout: 15_000,
    interval: 100,
    diagnostic: () => `the document workflow did not settle without inline messages: ${JSON.stringify(state)}`,
  });
  assert.deepEqual(state.inlineErrors, [], 'the document workflow shows an inline error');
  assert.deepEqual(state.toasts, [], 'the document workflow left a toast over the customer surface');
  return state;
};

const dropCustomerJsonDocument = async () => {
  const result = await browser.execute((content, name) => {
    const target = document.querySelector('.srt-upload-button-container');
    if (target === null) return 'missing-drop-target';
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], name, { type: 'application/json' }));
    for (const type of ['dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: transfer,
      }));
    }
    return 'dropped';
  }, IMPORT_DOCUMENT, IMPORT_NAME);
  assert.equal(result, 'dropped', 'the public JSON subtitle drop target is absent');
};

const openExportFormat = async (format) => {
  await clickControl('.download-btn-primary');
  const modal = await $('.download-options-modal');
  await modal.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: 'the public Download Center did not open',
  });
  if (format !== 'srt') {
    await clickControl(`input[name="file-format"][value="${format}"] + .radio-option-card`);
  }
  await browser.waitUntil(async () => (await customerSurface()).selectedFormat === format, {
    timeout: 10_000,
    interval: 50,
    timeoutMsg: `the Download Center did not select ${format.toUpperCase()}`,
  });
  const state = await waitForQuietCustomerSurface();
  assert.deepEqual(state.formats, ['srt', 'json', 'txt'], 'the public export formats changed');
  return state;
};

const saveSelectedFormat = async ({ output, format }) => {
  const before = snapshotOutputDirectory(output);
  await clickControl('.download-options-modal .download-button');
  const path = await waitForNewDocumentExport({ directory: output, before, format });
  await $('.download-options-modal').waitForDisplayed({
    reverse: true,
    timeout: 30_000,
    timeoutMsg: `the Download Center did not close after saving ${format.toUpperCase()}`,
  });
  const result = verifySubtitleDocumentExport({ path, format, expected: EXPECTED });
  copyWorkflowArtifact({
    workflow: WORKFLOW,
    name: `customer-${format}-export`,
    source: path,
    description: `${format.toUpperCase()} saved by the native customer document-export command and independently parsed.`,
  });
  await waitForQuietCustomerSurface();
  return result;
};

describe('customer subtitle document round trip', () => {
  it('imports JSON without media and independently verifies SRT, JSON, and TXT saves', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run against an isolated data root');
    const output = join(root, 'output');

    await openEditor();
    await dropCustomerJsonDocument();
    let state = null;
    await waitUntilWithFreshDiagnostic(async () => {
      state = await customerSurface();
      return state.generationMode === 'srt-only'
        && EXPECTED.every(({ text }) => state.cueTexts.includes(text));
    }, {
      timeout: 60_000,
      interval: 250,
      diagnostic: () => `JSON import never reached SRT-only mode: ${JSON.stringify(state)}`,
    });
    state = await waitForQuietCustomerSurface();
    assert.equal(state.videos, 0, 'media-free document mode unexpectedly activated a video');
    assert.equal(state.generationMode, 'srt-only', 'the public SRT-only state is absent');
    assert.deepEqual(state.cueTexts, EXPECTED.map(({ text }) => text));
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-json-imported-without-media',
      description: 'A customer JSON document becomes a complete editable cue list in explicit SRT-only mode.',
      details: { importedName: IMPORT_NAME, cueCount: EXPECTED.length, mediaCount: state.videos },
      focusSelector: '.output-container',
    });

    await openExportFormat('srt');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-public-document-formats',
      description: 'Download Center publicly exposes SRT, JSON and timing-free TXT with SRT selected.',
      details: { formats: ['srt', 'json', 'txt'], selected: 'srt' },
      focusSelector: '.download-options-modal',
    });
    const srt = await saveSelectedFormat({ output, format: 'srt' });

    await openExportFormat('json');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-json-round-trip-selected',
      description: 'The same imported document can be selected for a structured JSON round trip.',
      details: { priorSrtSha256: srt.sha256, selected: 'json' },
      focusSelector: '.download-options-modal',
    });
    const json = await saveSelectedFormat({ output, format: 'json' });

    await openExportFormat('txt');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-timing-free-text-selected',
      description: 'The customer-visible TXT option explicitly selects the timing-free document form.',
      details: { priorJsonSha256: json.sha256, selected: 'txt' },
      focusSelector: '.download-options-modal',
    });
    const txt = await saveSelectedFormat({ output, format: 'txt' });

    state = await waitForQuietCustomerSurface();
    assert.equal(state.generationMode, 'srt-only', 'saving documents exited SRT-only mode');
    assert.deepEqual(state.cueTexts, EXPECTED.map(({ text }) => text), (
      'saving documents changed the customer cue list'
    ));
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-three-native-saves-complete',
      description: 'All three native saves completed without changing cues, opening media, or leaving an error/toast.',
      details: {
        outputs: [srt, json, txt].map(({ format, sha256, sizeBytes }) => ({
          format, sha256, sizeBytes,
        })),
      },
      focusSelector: '.lyrics-display',
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
