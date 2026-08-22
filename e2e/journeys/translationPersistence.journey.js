// A customer formats subtitles, selects that project-owned result for preview, and gets it back
// after relaunch. Format mode is deliberately provider-free; it proves the complete translation
// ownership/persistence/presentation path without pretending to prove Gemini translation.
/* global browser, describe, it, $, document, localStorage, window */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { durableTranslations } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { compareFrames, saveNativePreviewFrame } from '../support/nativeMediaOracle.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const PREFIX = 'FMT: ';
const EXPECTED_FIRST = `${PREFIX}First cue for the preview`;
const PHASE = process.env.OSG_E2E_PERSISTENCE_PHASE;
const WORKFLOW = 'translation-persistence';

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
  it('persists, draws, and restores the exact transformed cue list', async function translationJourney() {
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
          translated: window.translatedSubtitles?.[0]?.text ?? null,
          language: localStorage.getItem('subtitle_language'),
          hasVideo: Number.isFinite(document.querySelector('.video-preview video')?.duration),
        }));
        return restoredState.translated === EXPECTED_FIRST
          && restoredState.language === 'translated' && restoredState.hasVideo;
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
        step: '04-restored-translation',
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
          translated: window.translatedSubtitles?.[0]?.text ?? null,
          language: localStorage.getItem('subtitle_language'),
          selectedLabel: document.querySelector(
            '.subtitle-language-group .custom-dropdown-button .dropdown-value',
          )?.textContent?.trim() ?? null,
          menuOpen: document.querySelector('.subtitle-language-group .custom-dropdown.open') !== null,
        }));
        return previewSelectionState.url !== null && previewSelectionState.url !== oldFrameUrl
          && previewSelectionState.translated === EXPECTED_FIRST
          && previewSelectionState.language === 'translated';
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
      step: '03-translated-track',
      description: 'Selecting Translated changes both the visible track and native preview pixels.',
      details: previewSelectionState,
      focusSelector: '.video-preview .video-container',
    });
  });
});
