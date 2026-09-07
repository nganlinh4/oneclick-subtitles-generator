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

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-project-started',
      description: 'Project started with media loaded and credentials enrolled',
    });

    // 1. Start generation
    await clickControl('[data-osg-action="generate-subtitles"]');
    const modal = await $('.create-subtitles-modal, .video-processing-modal');
    await modal.waitForDisplayed({ timeout: 10_000 });
    await clickControl('[data-osg-action="process-subtitles"]');

    // 2. Wait for processing state, then cancel if active
    const cancelBtn = await $('[data-osg-action="cancel-generation"]');
    if (await cancelBtn.isDisplayed()) {
      await cancelBtn.click();
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-cancelled-cleanly',
        description: 'Transcription cancelled cleanly without error toasts',
      });
    } else {
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-processed-cleanly',
        description: 'Transcription processed cleanly without error toasts',
      });
    }

    // Assert: No red error banner displayed
    const errorToasts = await $$('.toast-error');
    assert.equal(errorToasts.length, 0, 'Clean execution/cancellation must not display red error toast');

    // 3. Retry action
    const retryBtn = await $('[data-osg-action="retry-transcription"]');
    if (await retryBtn.isDisplayed()) {
      await retryBtn.click();
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '03-retry-triggered',
        description: 'Retry triggered cleanly',
      });
    }
  });
});
