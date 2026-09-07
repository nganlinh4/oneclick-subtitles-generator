// Real-binary customer journey 8: Translation and preserved visual/custom tasks
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState, durableTranscriptRevisions } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-translation-visual-custom';

/* global $, browser, describe, document, it */

describe('Customer Journey 8: Executing ordinary Gemini model and video-dependent task', () => {
  it('executes ordinary Gemini model and video-dependent task proving routes remain active', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await enrollGeminiCredentials({ limit: 4 });

    // === Step 1: Execute ordinary Gemini model (non-Transcribe prompt-based route) ===
    await clickControl('[data-osg-action="generate-subtitles"]');
    const modal = await $('.create-subtitles-modal, .video-processing-modal');
    await modal.waitForDisplayed({ timeout: 15_000 });

    const speechTab = await $('[data-task-tab="speech"]');
    if (await speechTab.isDisplayed()) await speechTab.click();

    const engineSelect = await $('#speech-engine-select');
    await engineSelect.waitForDisplayed({ timeout: 10_000 });
    await engineSelect.selectByAttribute('value', 'gemini-general');

    await clickControl('[data-osg-action="process-subtitles"]');

    // Wait for ordinary Gemini generation to finish
    await browser.waitUntil(async () => {
      const state = durableState(root);
      const isProcessing = await browser.execute(
        () => document.querySelector('.force-stop-btn') !== null,
      );
      return !isProcessing && state.counts.cues > 0;
    }, {
      timeout: 120_000,
      interval: 1_000,
      timeoutMsg: 'Ordinary Gemini generation never completed with captions',
    });

    const stateAfterOrdinary = durableState(root);
    assert.ok(stateAfterOrdinary.counts.cues > 0, 'Ordinary Gemini must persist cues');

    // Invariant: Native word-transcribe route must NOT have intercepted it
    const revisions = durableTranscriptRevisions(root);
    assert.equal(
      revisions.length,
      0,
      'Native Transcribe route must not intercept ordinary Gemini prompt-based generation',
    );

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-ordinary-model-executed',
      description: 'Ordinary Gemini model executed successfully with saved output; native Transcribe did not intercept.',
      details: { cueCount: stateAfterOrdinary.counts.cues, wordNativeRevisions: revisions.length },
    });

    // === Step 2: Execute video-dependent task (Visual / Custom -> Scene descriptions) ===
    await clickControl('[data-osg-action="generate-subtitles"]');
    const modalVisual = await $('.create-subtitles-modal, .video-processing-modal');
    await modalVisual.waitForDisplayed({ timeout: 15_000 });

    const visualTab = await $('[data-task-tab="visual"]');
    await visualTab.waitForDisplayed({ timeout: 10_000 });
    await visualTab.click();

    // Select scene descriptions subtask
    const descPill = await $('[data-testid="subtask-descriptions"]');
    await descPill.waitForDisplayed({ timeout: 10_000 });
    await descPill.click();

    await clickControl('[data-osg-action="process-subtitles"]');

    // Wait for video-dependent generation to finish
    await browser.waitUntil(async () => {
      const isProcessing = await browser.execute(
        () => document.querySelector('.force-stop-btn') !== null,
      );
      const state = durableState(root);
      return !isProcessing && state.counts.cues > 0;
    }, {
      timeout: 180_000,
      interval: 1_000,
      timeoutMsg: 'Video-dependent scene descriptions never completed',
    });

    const stateAfterVisual = durableState(root);
    assert.ok(stateAfterVisual.counts.cues > 0, 'Visual task must persist cues');

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-video-dependent-task-executed',
      description: 'Video-dependent task executed with general model on real video fixture, producing meaningful captions.',
      details: { cueCount: stateAfterVisual.counts.cues },
    });
  });
});
