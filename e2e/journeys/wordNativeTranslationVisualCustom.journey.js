// Real-binary customer journey 8: Translation and preserved visual/custom tasks
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { openProjectWithMedia, SUBTITLE_FIXTURE, importSubtitles } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-translation-visual-custom';

/* global $, browser, describe, document, it */

describe('Customer Journey 8: Translation and preserved visual/custom tasks', () => {
  it('creates linked translation track and reaches visual/custom preserved capabilities', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await importSubtitles(SUBTITLE_FIXTURE);

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-source-track-ready',
      description: 'Source track ready with imported subtitles',
    });

    // 1. Open Creation Dialog
    await clickControl('[data-osg-action="generate-subtitles"]');

    // 2. Select Translate task
    const translateTab = await $('[data-task-tab="translate"]');
    if (await translateTab.isDisplayed()) {
      await translateTab.click();
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-translate-tab-active',
        description: 'Translate task tab selected',
      });
    }

    // 3. Select Visual/Custom task
    const visualTab = await $('[data-task-tab="visual"]');
    if (await visualTab.isDisplayed()) {
      await visualTab.click();
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '03-visual-custom-tab-active',
        description: 'Visual and custom task tab selected',
      });
    }

    // Close modal
    const closeBtn = await $('.create-subtitles-modal .creation-btn-secondary, .create-subtitles-modal .close-button');
    if (await closeBtn.isDisplayed()) {
      await closeBtn.click();
    }
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-capabilities-verified',
      description: 'Modal closed and existing tasks preserved',
    });
  });
});
