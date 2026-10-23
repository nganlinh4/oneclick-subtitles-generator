// A customer formats subtitles into a translated track, saves it as SRT, JSON and timing-free TXT
// beside the untouched original, selects it for preview, and gets it back after relaunch. Format
// mode is deliberately provider-free; it proves the complete translation ownership, export,
// persistence and presentation path without pretending to prove Gemini translation. Every saved
// document is parsed by the independent Node oracle rather than trusted from the serializer.
/* global browser, describe, it, $, document */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

import { durableRenderScenes, durableTranslations } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { compareFrames, saveNativePreviewFrame } from '../support/nativeMediaOracle.js';
import {
  snapshotOutputDirectory,
  verifySubtitleDocumentExport,
  waitForNewDocumentExport,
} from '../support/subtitleDocumentOracle.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const PREFIX = 'FMT: ';
const PHASE = process.env.OSG_E2E_PERSISTENCE_PHASE;
const WORKFLOW = 'translation-persistence';
const ORIGINAL = Object.freeze([
  Object.freeze({ ordinal: 1, startMs: 500, endMs: 3_000, text: 'First cue for the preview' }),
  Object.freeze({ ordinal: 2, startMs: 3_500, endMs: 7_000, text: 'Second cue, plain text only' }),
  Object.freeze({ ordinal: 3, startMs: 7_500, endMs: 11_000, text: 'Last cue before the end' }),
]);
const TRANSLATED = Object.freeze(ORIGINAL.map((cue) => Object.freeze({
  ...cue,
  text: `${PREFIX}${cue.text}`,
})));
const EXPECTED_FIRST = TRANSLATED[0].text;

const seekToFirstCue = async () => {
  const previous = await browser.execute(
    () => document.querySelector('.video-preview [data-osg-preview-engine="canvas-atlas"]')
      ?.getAttribute('data-osg-frame-revision') ?? null,
  );
  await browser.execute(() => {
    const video = document.querySelector('.video-preview video.video-player');
    if (video === null) throw new Error('the editor video is missing');
    video.pause();
    video.currentTime = 1;
  });
  await browser.waitUntil(async () => {
    const current = await browser.execute(
      () => document.querySelector('.video-preview [data-osg-preview-engine="canvas-atlas"]')
        ?.getAttribute('data-osg-frame-revision') ?? null,
    );
    return current !== null && current !== previous;
  }, {
    timeout: 120_000,
    interval: 1_000,
    timeoutMsg: 'the editor did not publish the first-cue frame',
  });
};

const modalState = () => browser.execute(() => ({
  open: document.querySelector('.download-options-modal') !== null,
  selectedSource: document.querySelector('.download-options-modal input[name="download-subtitle-source"]:checked')?.value ?? null,
  translatedDisabled: document.querySelector('.download-options-modal input[name="download-subtitle-source"][value="translated"]')
    ?.disabled ?? null,
  selectedFormat: document.querySelector('.download-options-modal input[name="file-format"]:checked')?.value ?? null,
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
  if ((name === 'download-subtitle-source' ? state.selectedSource : state.selectedFormat) !== value) {
    await clickControl(`.download-options-modal input[name="${name}"][value="${value}"] + .radio-option-card`);
  }
  await browser.waitUntil(async () => {
    const current = await modalState();
    return (name === 'download-subtitle-source' ? current.selectedSource : current.selectedFormat) === value;
  }, {
    timeout: 10_000,
    interval: 50,
    timeoutMsg: `the Download Center did not select ${describeAs}`,
  });
};

const saveDocument = async ({ output, source, format, expected }) => {
  await openDownloadCenter();
  await selectRadio('download-subtitle-source', source, `the ${source} subtitle source`);
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

const selectTranslatedPreview = async () => {
  await clickControl('.subtitle-settings-toggle');
  await clickControl('.subtitle-language-group .custom-dropdown-button');
  const translated = await $('//button[contains(@class,"dropdown-option")'
    + ' and contains(normalize-space(.),"Translated")]');
  await translated.waitForClickable({ timeout: 30_000 });
  await browser.action('pointer')
    .move({ origin: translated })
    .down({ button: 0 })
    .pause(100)
    .up({ button: 0 })
    .perform();
};

describe('a customer keeps a project-owned formatted translation', () => {
  it('persists, exports, draws, and restores the exact transformed cue list', async function translationJourney() {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run in an isolated root');
    assert.ok(
      PHASE === 'seed' || PHASE === 'verify',
      'run this persistence journey through scenarios/translationPersistence.mjs',
    );

    if (PHASE === 'verify') {
      await openEditor();
      let restoredState = null;
      await browser.waitUntil(async () => {
        restoredState = await browser.execute(() => ({
          hasVideo: Number.isFinite(document.querySelector('.video-preview video')?.duration),
        }));
        restoredState.translated = durableTranslations(root)[0]
          ?.translation?.baseSubtitles?.[0]?.text ?? null;
        restoredState.selectedSubtitles = durableRenderScenes(root).at(-1)
          ?.scene?.selectedSubtitles ?? null;
        return restoredState.translated === EXPECTED_FIRST
          && restoredState.selectedSubtitles === 'translated' && restoredState.hasVideo;
      }, {
        timeout: 180_000,
        interval: 1_000,
        timeoutMsg: 'the new application process did not hydrate the project-owned translation',
      });
      await seekToFirstCue();
      const translatedFrame = join(root, 'evidence', 'translation-selected.png');
      const restoredFrame = join(root, 'evidence', 'translation-restored.png');
      await saveNativePreviewFrame(restoredFrame);
      assert.ok(
        compareFrames(translatedFrame, restoredFrame) >= 0.999,
        'the restored translated preview differs from the prior process pixels',
      );
      assert.equal(durableTranslations(root)[0].translation.revision, 1);
      copyWorkflowArtifact({
        workflow: WORKFLOW,
        name: 'restored-translated-frame',
        source: restoredFrame,
        description: 'Native translated frame rebuilt by a second desktop process.',
      });
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '05-restored-translation',
        description: 'A second desktop process restored the translated selection and identical native pixels.',
        focusSelector: '.video-preview .video-container',
      });
      return;
    }

    await openProjectWithMedia();
    await importSubtitles();
    await seekToFirstCue();

    const originalFrame = join(root, 'evidence', 'translation-original.png');
    await saveNativePreviewFrame(originalFrame);
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'original-preview-frame',
      source: originalFrame,
      description: 'Original subtitle track before formatting or translation selection.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-original-track',
      description: 'The original imported subtitle track is visible and natively composited.',
      focusSelector: '.video-preview .video-container',
    });

    // Before any translation exists, the Download Center must honestly refuse the choice.
    await openDownloadCenter();
    assert.equal((await modalState()).translatedDisabled, true,
      'the Translated source was selectable before any translation existed');
    await browser.keys('Escape');
    await $('.download-options-modal').waitForDisplayed({ reverse: true, timeout: 10_000 });

    await clickControl('.add-chain-item-btn.original');
    await clickControl('.delimiter-display');
    const customDelimiter = await $('.delimiter-custom-input input');
    await customDelimiter.waitForDisplayed({ timeout: 30_000 });
    await customDelimiter.setValue(PREFIX);
    await browser.keys('Escape');
    await clickControl('.translate-button.format-button');

    await browser.waitUntil(async () => browser.execute(
      (text) => [...document.querySelectorAll('.translation-preview .preview-text')]
        .some((node) => (node.innerText || '').includes(text)),
      EXPECTED_FIRST,
    ), {
      timeout: 120_000,
      interval: 500,
      timeoutMsg: 'the formatted translation never appeared in the customer preview',
    });

    const records = durableTranslations(root);
    assert.equal(records.length, 1, 'translation was not stored under exactly one project');
    const record = records[0].translation;
    assert.equal(record?.status, 'complete', 'the durable translation is not complete');
    assert.equal(record?.revision, 1, 'the first durable translation is not revision one');
    assert.equal(record?.sourceEntryCount, 3, 'the durable translation lost its source cardinality');
    assert.equal(record?.baseSubtitles?.[0]?.text, EXPECTED_FIRST, 'durable text differs from the UI');
    assert.match(record?.sourceFingerprint ?? '', /^[a-f0-9]{64}$/);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-translation-created',
      description: 'The transformed translation is visibly complete before selecting it for preview.',
      details: { revision: record.revision, sourceEntryCount: record.sourceEntryCount },
    });

    const output = join(root, 'output');
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
      step: '03-exports-verified',
      description: 'Translated SRT/JSON/TXT and the original SRT each parsed independently.',
      details: {
        translated: Object.fromEntries(Object.entries(saved)
          .map(([format, { sha256, sizeBytes }]) => [format, { sha256, sizeBytes }])),
        original: { sha256: original.sha256, sizeBytes: original.sizeBytes },
      },
    });

    const oldFrameUrl = await browser.execute(
      () => document.querySelector('.video-preview [data-osg-preview-engine="canvas-atlas"]')
        ?.getAttribute('data-osg-frame-revision') ?? null,
    );
    await selectTranslatedPreview();
    let previewSelectionState = null;
    try {
      await browser.waitUntil(async () => {
        previewSelectionState = await browser.execute(() => ({
          url: document.querySelector('.video-preview [data-osg-preview-engine="canvas-atlas"]')
            ?.getAttribute('data-osg-frame-revision') ?? null,
          selectedLabel: document.querySelector(
            '.subtitle-language-group .custom-dropdown-button .dropdown-value',
          )?.textContent?.trim() ?? null,
          menuOpen: document.querySelector('.subtitle-language-group .custom-dropdown.open') !== null,
        }));
        previewSelectionState.translated = durableTranslations(root)[0]
          ?.translation?.baseSubtitles?.[0]?.text ?? null;
        previewSelectionState.selectedSubtitles = durableRenderScenes(root).at(-1)
          ?.scene?.selectedSubtitles ?? null;
        return previewSelectionState.url !== null && previewSelectionState.url !== oldFrameUrl
          && previewSelectionState.translated === EXPECTED_FIRST
          && previewSelectionState.selectedSubtitles === 'translated';
      }, {
        timeout: 120_000,
        interval: 1_000,
        timeoutMsg: 'the native preview never switched to the translated cue list',
      });
    } catch (error) {
      throw new Error(`${error.message}: ${JSON.stringify(previewSelectionState)}`, { cause: error });
    }
    const translatedFrame = join(root, 'evidence', 'translation-selected.png');
    await saveNativePreviewFrame(translatedFrame);
    assert.notDeepEqual(
      readFileSync(translatedFrame),
      readFileSync(originalFrame),
      'selecting translated subtitles did not change the rendered pixels',
    );
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'translated-preview-frame',
      source: translatedFrame,
      description: 'Translated subtitle track selected in the native preview.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-translated-track',
      description: 'Selecting Translated changes both the visible track and native preview pixels.',
      details: previewSelectionState,
      focusSelector: '.video-preview .video-container',
    });
  });
});
