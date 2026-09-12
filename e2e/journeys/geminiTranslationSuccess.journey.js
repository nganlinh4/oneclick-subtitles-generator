/* global $, browser, describe, document, it, MutationObserver, window */

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
const SOURCE_FIXTURE = 'cues-translation-multichunk.srt';
const SOURCE_TIMINGS = Object.freeze(Array.from({ length: 12 }, (_, index) => Object.freeze({
  start: index * 15 + 0.5,
  end: index * 15 + 10,
})));

describe('a customer translates a real subtitle track through Gemini', () => {
  it('enrols the ignored live-test pool through Settings and persists provider output', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the Gemini success journey requires an isolated root');

    await openProjectWithMedia();
    await importSubtitles(SOURCE_FIXTURE);
    const enrollment = await enrollGeminiCredentials({ limit: 20 });
    assert.equal(enrollment.enrolled, 20, 'the complete reviewed Gemini pool was not enrolled');

    const splitDuration = await $('#split-duration-slider');
    await splitDuration.waitForDisplayed({ timeout: 15_000 });
    await splitDuration.setValue(1);
    await browser.waitUntil(async () => browser.execute(() => (
      document.querySelectorAll('.segment-preview-compact .segment-pill').length === 3
      && window.localStorage.getItem('translation_split_duration') === '1'
    )), {
      timeout: 15_000,
      interval: 100,
      timeoutMsg: 'the real one-minute split control did not produce three visible request windows',
    });

    await clickControl('.add-chain-item-btn:not(.delimiter):not(.original)');
    const language = await $('.language-chain .chain-item:last-child input');
    await language.waitForDisplayed({ timeout: 15_000 });
    await language.setValue(TARGET_LANGUAGE);
    await browser.execute(() => {
      const observed = [];
      const sample = () => {
        const count = [...document.querySelectorAll('.translation-preview .preview-text')]
          .filter((node) => node.getBoundingClientRect().height > 0)
          .length;
        if (observed.at(-1) !== count) observed.push(count);
      };
      sample();
      window.__OSG_TRANSLATION_VISIBLE_COUNTS__ = observed;
      window.__OSG_TRANSLATION_OBSERVER__?.disconnect();
      window.__OSG_TRANSLATION_OBSERVER__ = new MutationObserver(sample);
      window.__OSG_TRANSLATION_OBSERVER__.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    await clickControl('.translate-button');

    let record = null;
    let toasts = null;
    await browser.waitUntil(async () => {
      record = durableTranslations(root)[0]?.translation ?? null;
      toasts = await browser.execute(collectTopDocumentToasts);
      const processing = await browser.execute(
        () => document.querySelector('.translate-button.processing') !== null,
      );
      return !processing && record?.status === 'complete' && record?.baseSubtitles?.length === 12;
    }, {
      timeout: 10 * 60 * 1_000,
      interval: 1_000,
      timeoutMsg: 'Gemini translation never produced a complete durable twelve-cue result',
    });

    assert.deepEqual(toasts?.errorToasts ?? [], [], 'Gemini translation completed with an error toast');
    assert.deepEqual(toasts?.inlineErrors ?? [], [], 'Gemini translation painted an inline error');
    assert.equal(record.sourceEntryCount, 12, 'the provider result lost source cardinality');
    assert.equal(record.baseSubtitles.length, 12, 'the provider result lost translated rows');
    assert.ok(
      record.baseSubtitles.every(({ text }) => typeof text === 'string' && text.trim() !== ''),
      'the provider returned a blank translated cue',
    );
    assert.ok(
      record.baseSubtitles.some(({ text }) => !/Welcome to this practical review|We will compare several choices/u.test(text)),
      'the provider result is indistinguishable from the English source track',
    );
    assert.deepEqual(
      record.baseSubtitles.map(({ start, end }) => ({ start, end })),
      SOURCE_TIMINGS,
      'translation changed source cue timing',
    );

    const state = durableState(root);
    const translationJobs = state.jobs.filter(({ kind }) => kind === 'translate');
    const succeededJobs = translationJobs.filter(({ state }) => state === 'succeeded');
    assert.ok(succeededJobs.length >= 3, 'three requested windows did not produce three successful jobs');
    const firstThree = [...translationJobs]
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .slice(0, 3);
    assert.ok(
      Math.max(...firstThree.map(({ createdAtMs }) => createdAtMs))
        < Math.min(...firstThree.map(({ updatedAtMs }) => updatedAtMs)),
      'the three requested translation windows did not overlap in the native job ledger',
    );

    await browser.waitUntil(async () => browser.execute(
      () => [...document.querySelectorAll('.translation-preview .preview-text')]
        .filter((node) => node.getBoundingClientRect().height > 0)
        .length >= 12,
    ), {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: 'the durable provider translation never reached the visible result list',
    });
    const visibleCounts = await browser.execute(() => {
      window.__OSG_TRANSLATION_OBSERVER__?.disconnect();
      return window.__OSG_TRANSLATION_VISIBLE_COUNTS__ ?? [];
    });
    assert.ok(
      visibleCounts.some((count) => count > 0 && count < 12),
      `translated rows never became visible incrementally: ${JSON.stringify(visibleCounts)}`,
    );

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-provider-translation-complete',
      description: 'Three overlapping real Gemini requests translated twelve timed cues, streamed visible rows and persisted one source-ordered project-owned record.',
      details: {
        enrolledCredentialCount: enrollment.enrolled,
        sourceEntryCount: record.sourceEntryCount,
        translatedEntryCount: record.baseSubtitles.length,
        translationJobCount: translationJobs.length,
        visibleCounts,
      },
      focusSelector: '.translation-section',
    });
  });
});
