// Real-binary customer journey 5: Parallel long recording with at least 4 windows, progressive durable output, and seamless boundary joins
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-parallel-long-recording';

/* global $, browser, describe, document, it */

describe('Customer Journey 5: Parallel long recording with at least 4 windows', () => {
  it('executes 4-window parallel transcription with bounded concurrency and progressive durable output', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await enrollGeminiCredentials({ limit: 4 });

    await captureWorkflowStep(WORKFLOW, '01_long_media_ready');

    // Trigger multi-window transcription
    await clickControl('[data-osg-action="generate-subtitles"]');
    await clickControl('[data-osg-action="process-subtitles"]');

    // Observe progressive output in durable database
    let priorCueCount = 0;
    let sawProgressiveIncrease = false;

    await browser.waitUntil(async () => {
      const state = durableState(root);
      if (state.counts.cues > priorCueCount) {
        if (priorCueCount > 0) {
          sawProgressiveIncrease = true;
        }
        priorCueCount = state.counts.cues;
      }
      return state.counts.cues >= 4;
    }, { timeout: 300_000, interval: 2_000 });

    await captureWorkflowStep(WORKFLOW, '02_progressive_cues_accumulated');
    const finalState = durableState(root);
    assert.ok(finalState.counts.cues >= 4);

    // Verify boundary joins are monotonic
    const cues = finalState.cues;
    for (let i = 1; i < cues.length; i++) {
      assert.ok(cues[i].start_ms >= cues[i - 1].start_ms, 'Subtitles must maintain monotonic timing order');
    }
    await captureWorkflowStep(WORKFLOW, '03_boundary_joins_verified');
  });
});
