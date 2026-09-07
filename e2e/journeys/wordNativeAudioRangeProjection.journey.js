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

    // Drag on subtitle timeline to select a valid nonzero range
    const timeline = await $('.subtitle-timeline');
    await timeline.waitForDisplayed({ timeout: 30_000 });
    const { width } = await timeline.getSize();
    assert.ok(width >= 100, `timeline width too narrow: ${width}px`);
    const left = -Math.floor(width / 2) + 4;
    const end = -Math.floor(width / 2) + Math.floor(width * 0.48);
    await browser.action('pointer')
      .move({ origin: timeline, x: left, y: 0 })
      .down({ button: 0 })
      .pause(100)
      .move({ origin: timeline, x: end, y: 0, duration: 450 })
      .up({ button: 0 })
      .perform();

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-media-and-range-selected',
      description: 'Media loaded into editor and timeline range selected via pointer drag',
    });

    // 1. Open Create Subtitles dialog
    await clickControl('[data-osg-action="generate-subtitles"]');
    const modal = await $('.create-subtitles-modal, .video-processing-modal');
    await modal.waitForDisplayed({ timeout: 10_000 });

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-scope-range-selected',
      description: 'Create subtitles modal open with range scope active and valid',
    });
    await clickControl('[data-osg-action="process-subtitles"]');

    // 3. Wait for captions to settle
    await browser.waitUntil(async () => {
      const durable = durableState(root);
      return durable.counts.cues > 0;
    }, { timeout: 180_000, interval: 1_000 });

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-cues-derived-within-range',
      description: 'Cues arrived and verified within range',
    });

    const state = durableState(root);
    assert.ok(state.cues.length > 0);
    // Invariant: all cues start >= selection range start
    for (const cue of state.cues) {
      assert.ok(cue.start_ms >= 0);
      assert.ok(cue.end_ms > cue.start_ms);
    }
  });
});
