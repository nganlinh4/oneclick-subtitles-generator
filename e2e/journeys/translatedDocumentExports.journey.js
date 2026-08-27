// A customer saves their TRANSLATED track as SRT, JSON and timing-free TXT. The document
// round-trip journey owns the original-track exports; this one owns the other half of the export
// capability: the Download Center's Subtitle Source selector must save the translated cues — and
// only them — in every format. The translation is the provider-free public Format mode, so no
// credential or network is involved, and every saved file is parsed by the independent Node
// oracle rather than trusted from the product's serializer.

import { strict as assert } from 'node:assert';
import { basename, join } from 'node:path';
import process from 'node:process';

import { durableTranslations } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import {
  snapshotOutputDirectory,
  verifySubtitleDocumentExport,
  waitForNewDocumentExport,
} from '../support/subtitleDocumentOracle.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'translated-document-exports';
const PREFIX = 'TX: ';
const ORIGINAL = Object.freeze([
  Object.freeze({ ordinal: 1, startMs: 500, endMs: 3_000, text: 'First cue for the preview' }),
  Object.freeze({ ordinal: 2, startMs: 3_500, endMs: 7_000, text: 'Second cue, plain text only' }),
  Object.freeze({ ordinal: 3, startMs: 7_500, endMs: 11_000, text: 'Last cue before the end' }),
]);
const TRANSLATED = Object.freeze(ORIGINAL.map(cue => Object.freeze({
  ...cue,
  text: `${PREFIX}${cue.text}`,
})));

/* global $, browser, describe, document, it */

const modalState = () => browser.execute(() => ({
  open: document.querySelector('.download-options-modal') !== null,
  selectedSource: document.querySelector('input[name="subtitle-source"]:checked')?.value ?? null,
  translatedDisabled: document.querySelector('input[name="subtitle-source"][value="translated"]')
    ?.disabled ?? null,
  selectedFormat: document.querySelector('input[name="file-format"]:checked')?.value ?? null,
}));

const openDownloadCenter = async () => {
  await clickControl('.download-btn-primary');
  const modal = await $('.download-options-modal');
  await modal.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: 'the public Download Center did not open',
  });
};

const selectRadio = async (name, value, describeAs) => {
  const state = await modalState();
  if ((name === 'subtitle-source' ? state.selectedSource : state.selectedFormat) !== value) {
    await clickControl(`input[name="${name}"][value="${value}"] + .radio-option-card`);
  }
  await browser.waitUntil(async () => {
    const current = await modalState();
    return (name === 'subtitle-source' ? current.selectedSource : current.selectedFormat) === value;
  }, {
    timeout: 10_000,
    interval: 50,
    timeoutMsg: `the Download Center did not select ${describeAs}`,
  });
};

const saveDocument = async ({ output, source, format, expected }) => {
  await openDownloadCenter();
  await selectRadio('subtitle-source', source, `the ${source} subtitle source`);
  await selectRadio('file-format', format, `the ${format.toUpperCase()} format`);
  const before = snapshotOutputDirectory(output);
  await clickControl('.download-options-modal .download-button');
  const path = await waitForNewDocumentExport({ directory: output, before, format });
  await $('.download-options-modal').waitForDisplayed({
    reverse: true,
    timeout: 30_000,
    timeoutMsg: `the Download Center did not close after saving ${source} ${format.toUpperCase()}`,
  });
  const result = verifySubtitleDocumentExport({ path, format, expected });
  copyWorkflowArtifact({
    workflow: WORKFLOW,
    name: `${source}-${format}-export`,
    source: path,
    description: `${source} ${format.toUpperCase()} saved through the Subtitle Source selector`
      + ' and independently parsed.',
  });
  return result;
};

describe('translated subtitle document exports', () => {
  it('saves the formatted translation as valid SRT, JSON and TXT without touching the original', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the harness must have an isolated data root');
    const output = join(root, 'output');

    await openProjectWithMedia();
    await importSubtitles();

    // Before any translation exists, the public selector must honestly refuse the choice.
    await openDownloadCenter();
    let state = await modalState();
    assert.equal(state.translatedDisabled, true,
      'the Translated source was selectable before any translation existed');
    await browser.keys('Escape');
    await $('.download-options-modal').waitForDisplayed({ reverse: true, timeout: 10_000 });

    // The provider-free public Format mode produces the translated track.
    await clickControl('.add-chain-item-btn.original');
    await clickControl('.delimiter-display');
    const customDelimiter = await $('.delimiter-custom-input input');
    await customDelimiter.waitForDisplayed({ timeout: 30_000 });
    await customDelimiter.setValue(PREFIX);
    await browser.keys('Escape');
    await clickControl('.translate-button.format-button');
    await browser.waitUntil(async () => browser.execute(
      text => [...document.querySelectorAll('.translation-preview .preview-text')]
        .some(node => (node.innerText || '').includes(text)),
      TRANSLATED[0].text,
    ), {
      timeout: 120_000,
      interval: 500,
      timeoutMsg: 'the formatted translation never appeared in the customer preview',
    });
    const record = durableTranslations(root)[0]?.translation;
    assert.equal(record?.status, 'complete', 'the durable translation is not complete');
    assert.equal(record?.baseSubtitles?.[0]?.text, TRANSLATED[0].text,
      'the durable translation differs from the expected formatted text');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-translation-ready',
      description: 'A provider-free formatted translation is complete and durable before export.',
      details: { firstText: TRANSLATED[0].text },
    });

    const saved = {};
    for (const format of ['srt', 'json', 'txt']) {
      saved[format] = await saveDocument({
        output, source: 'translated', format, expected: TRANSLATED,
      });
      // A language-free Format translation must still propose a name distinct from the original
      // track, or saving both as the same format collides on one filename.
      assert.equal(basename(saved[format].path), `cues-ascii_translated.${format}`,
        `the translated ${format.toUpperCase()} did not carry the proposed distinguishing name`);
    }
    // The selector must still save the untouched original: source honesty, not a global switch.
    const original = await saveDocument({
      output, source: 'original', format: 'srt', expected: ORIGINAL,
    });
    assert.equal(basename(original.path), 'cues-ascii.srt',
      'the original SRT did not carry the proposed customer name');
    assert.notEqual(saved.srt.sha256, original.sha256,
      'translated and original SRT exports are byte-identical');

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-exports-verified',
      description: 'Translated SRT/JSON/TXT and the original SRT each parsed independently.',
      details: {
        translated: Object.fromEntries(Object.entries(saved)
          .map(([format, { sha256, sizeBytes }]) => [format, { sha256, sizeBytes }])),
        original: { sha256: original.sha256, sizeBytes: original.sizeBytes },
      },
    });
  });
});
