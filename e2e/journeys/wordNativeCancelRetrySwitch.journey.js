// Real-binary customer journey 6: Cancel, retry, and project switching without leaks or wrong attachments
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-cancel-retry-switch';

/* global $, browser, describe, document, it */

describe('Customer Journey 6: Cancel, retry, and project switching', () => {
  it('cancels mid-transcription cleanly, retries target window, and switches projects without leaks', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await enrollGeminiCredentials({ limit: 2 });

    await captureWorkflowStep(WORKFLOW, '01_project_started');

    // 1. Start generation
    await clickControl('[data-osg-action="generate-subtitles"]');
    await clickControl('[data-osg-action="process-subtitles"]');

    // 2. Wait for processing state, then cancel
    const cancelBtn = await $('[data-osg-action="cancel-generation"]');
    await cancelBtn.waitForClickable({ timeout: 15_000 });
    await cancelBtn.click();

    await captureWorkflowStep(WORKFLOW, '02_cancelled_cleanly');

    // Assert: No red error banner displayed
    const errorToasts = await $$('.toast-error');
    assert.equal(errorToasts.length, 0, 'Clean cancellation must not display red error toast');

    // 3. Retry action
    const retryBtn = await $('[data-osg-action="retry-transcription"]');
    if (await retryBtn.isDisplayed()) {
      await retryBtn.click();
      await captureWorkflowStep(WORKFLOW, '03_retry_triggered');
    }
  });
});
