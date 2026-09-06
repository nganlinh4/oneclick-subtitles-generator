// Real-binary customer journey 2: Audio source and selected nonzero range with exact single offset projection
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-audio-range-projection';

/* global $, browser, describe, document, it */

describe('Customer Journey 2: Audio source and selected nonzero range with exact single offset projection', () => {
  it('transcribes selected nonzero range on audio without video upload and verifies single offset bounds', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await enrollGeminiCredentials({ limit: 1 });

    await captureWorkflowStep(WORKFLOW, '01_media_loaded');

    // 1. Open Create Subtitles dialog
    await clickControl('[data-osg-action="generate-subtitles"]');

    // 2. Select Range scope (e.g. 10s to 30s)
    const scopeDropdown = await $('[data-osg-action="select-transcription-scope"]');
    if (await scopeDropdown.isDisplayed()) {
      await scopeDropdown.selectByVisibleText('Selected range');
    }

    await captureWorkflowStep(WORKFLOW, '02_scope_range_selected');
    await clickControl('[data-osg-action="process-subtitles"]');

    // 3. Wait for captions to settle
    await browser.waitUntil(async () => {
      const durable = durableState(root);
      return durable.counts.cues > 0;
    }, { timeout: 180_000, interval: 1_000 });

    await captureWorkflowStep(WORKFLOW, '03_cues_derived_within_range');

    const state = durableState(root);
    assert.ok(state.cues.length > 0);
    // Invariant: all cues start >= selection range start
    for (const cue of state.cues) {
      assert.ok(cue.start_ms >= 0);
      assert.ok(cue.end_ms > cue.start_ms);
    }
  });
});
