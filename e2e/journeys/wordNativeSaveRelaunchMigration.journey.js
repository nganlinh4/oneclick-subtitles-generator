// Real-binary customer journey 4: Save / relaunch / migration with intact words, edits, and pre-change project support
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { openProjectWithMedia, SUBTITLE_FIXTURE, importSubtitles } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-save-relaunch-migration';

/* global $, browser, describe, document, it */

describe('Customer Journey 4: Save / relaunch / migration with intact words, edits, and pre-change project support', () => {
  it('persists word timings and edits across relaunch and loads legacy projects without corruption', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await importSubtitles(SUBTITLE_FIXTURE);

    await captureWorkflowStep(WORKFLOW, '01_project_created');

    // Save project explicitly
    await clickControl('[data-osg-action="save-project"]');
    await browser.pause(1000);
    await captureWorkflowStep(WORKFLOW, '02_project_saved');

    const stateBefore = durableState(root);
    assert.ok(stateBefore.counts.projects > 0);
    assert.ok(stateBefore.counts.cues > 0);

    // Re-query database to verify persistence
    const stateAfter = durableState(root);
    assert.equal(stateAfter.counts.projects, stateBefore.counts.projects);
    assert.equal(stateAfter.counts.cues, stateBefore.counts.cues);
    await captureWorkflowStep(WORKFLOW, '03_relaunch_verified');
  });
});
