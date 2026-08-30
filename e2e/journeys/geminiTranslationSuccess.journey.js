/* global $, browser, describe, document, it */

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState, durableTranslations } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { collectTopDocumentToasts } from '../support/providerRefusalOracle.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'gemini-translation-success';
const TARGET_LANGUAGE = 'Vietnamese';

describe('a customer translates a real subtitle track through Gemini', () => {
  it('enrols the ignored live-test pool through Settings and persists provider output', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the Gemini success journey requires an isolated root');

    await openProjectWithMedia();
    await importSubtitles();
    const enrollment = await enrollGeminiCredentials({ limit: 20 });
    assert.equal(enrollment.enrolled, 20, 'the complete reviewed Gemini pool was not enrolled');

    await clickControl('.add-chain-item-btn:not(.delimiter):not(.original)');
    const language = await $('.language-chain .chain-item:last-child input');
    await language.waitForDisplayed({ timeout: 15_000 });
    await language.setValue(TARGET_LANGUAGE);
    await clickControl('.translate-button');

    let record = null;
    let toasts = null;
    await browser.waitUntil(async () => {
      record = durableTranslations(root)[0]?.translation ?? null;
      toasts = await browser.execute(collectTopDocumentToasts);
      const processing = await browser.execute(
        () => document.querySelector('.translate-button.processing') !== null,
      );
      return !processing && record?.status === 'complete' && record?.baseSubtitles?.length === 3;
    }, {
      timeout: 10 * 60 * 1_000,
      interval: 1_000,
      timeoutMsg: 'Gemini translation never produced a complete durable three-cue result',
    });

    assert.deepEqual(toasts?.errorToasts ?? [], [], 'Gemini translation completed with an error toast');
    assert.deepEqual(toasts?.inlineErrors ?? [], [], 'Gemini translation painted an inline error');
    assert.equal(record.sourceEntryCount, 3, 'the provider result lost source cardinality');
    assert.equal(record.baseSubtitles.length, 3, 'the provider result lost translated rows');
    assert.ok(
      record.baseSubtitles.every(({ text }) => typeof text === 'string' && text.trim() !== ''),
      'the provider returned a blank translated cue',
    );
    assert.ok(
      record.baseSubtitles.some(({ text }) => !/First cue for the preview|Second cue|Third cue/u.test(text)),
      'the provider result is indistinguishable from the English source track',
    );

    const state = durableState(root);
    const translationJobs = state.jobs.filter(({ kind }) => kind === 'translate');
    assert.ok(translationJobs.length >= 1, 'the real provider path registered no translation job');
    assert.equal(translationJobs.at(-1).state, 'succeeded', 'the latest translation job did not succeed');

    await browser.waitUntil(async () => browser.execute(
      () => [...document.querySelectorAll('.translation-preview .preview-text')]
        .filter((node) => node.getBoundingClientRect().height > 0)
        .length >= 3,
    ), {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: 'the durable provider translation never reached the visible result list',
    });

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-provider-translation-complete',
      description: 'A real Gemini request translated all three cues, published the visible result and persisted one project-owned complete record.',
      details: {
        enrolledCredentialCount: enrollment.enrolled,
        sourceEntryCount: record.sourceEntryCount,
        translatedEntryCount: record.baseSubtitles.length,
        translationJobCount: translationJobs.length,
      },
      focusSelector: '.translation-section',
    });
  });
});

