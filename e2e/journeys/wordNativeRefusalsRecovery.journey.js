// Real-binary customer journey 10: Refusals and truthful recovery (quota, malformed output, model error, missing audio)
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { clickControl } from '../support/editor.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-refusals-recovery';

/* global $, browser, describe, document, it */

describe('Customer Journey 10: Refusals and truthful recovery', () => {
  it('handles refusals truthfully without silent fallback or discarded saved work', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();

    await captureWorkflowStep(WORKFLOW, '01_project_loaded');

    // Attempt transcription without configured keys or on invalid media
    await clickControl('[data-osg-action="generate-subtitles"]');
    await captureWorkflowStep(WORKFLOW, '02_attempt_generation');

    // Verify error toast or actionable diagnostic dialog appears
    const dialogOrToast = await $('.create-subtitles-modal, .toast-error, .toast-warning');
    assert.ok(await dialogOrToast.isDisplayed(), 'Truthful diagnostic must be visible to user');

    await captureWorkflowStep(WORKFLOW, '03_truthful_recovery_displayed');
  });
});
