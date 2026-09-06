// Real-binary customer journey 1: Fresh video -> Speech -> captions arrival and word click-to-seek
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import {
  openProjectWithMedia,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-fresh-video-speech';

/* global $, browser, describe, document, it */

const surfaceState = () => browser.execute(() => ({
  cues: [...document.querySelectorAll('.lyric-text')]
    .map((node) => (node.innerText || '').trim()).filter(Boolean),
  words: [...document.querySelectorAll('.transcript-word')]
    .map((node) => ({
      text: (node.innerText || '').trim(),
      startMs: Number(node.getAttribute('data-word-start') || 0),
    })),
  currentTimeMs: Math.round(Number(document.querySelector('video')?.currentTime || 0) * 1000),
}));

describe('Customer Journey 1: Fresh video -> Speech -> captions arrival and word click-to-seek', () => {
  it('transcribes fresh video, verifies captions and clicks word to seek player', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await enrollGeminiCredentials({ limit: 1 });

    await captureWorkflowStep(WORKFLOW, '01_fresh_video_opened');

    // 1. Open unified Create Subtitles modal
    await clickControl('[data-osg-action="generate-subtitles"]');
    const modal = await $('.create-subtitles-modal, .video-processing-modal');
    await modal.waitForDisplayed({ timeout: 30_000 });

    // 2. Select Speech task with Natural layout
    const speechTab = await $('[data-task-tab="speech"]');
    await speechTab.waitForDisplayed({ timeout: 10_000 });
    await speechTab.click();
    await captureWorkflowStep(WORKFLOW, '02_creation_dialog_speech');

    // 3. Process subtitles
    await clickControl('[data-osg-action="process-subtitles"]');

    // 4. Wait for captions to arrive
    let surface = null;
    let durable = null;
    await browser.waitUntil(async () => {
      surface = await surfaceState();
      durable = durableState(root);
      return surface.cues.length > 0 && durable.counts.cues > 0;
    }, { timeout: 180_000, interval: 1_000 });

    await captureWorkflowStep(WORKFLOW, '03_captions_arrived');
    assert.ok(surface.cues.length > 0, 'Captions must be visible in editing area');

    // 5. Switch to Transcript view
    const transcriptToggle = await $('[data-editor-view="transcript"]');
    await transcriptToggle.waitForDisplayed({ timeout: 10_000 });
    await transcriptToggle.click();
    await browser.pause(500);
    await captureWorkflowStep(WORKFLOW, '04_transcript_view_active');

    // 6. Click on a recognized word and assert video seeks
    const firstWordEl = await $('.transcript-word');
    await firstWordEl.waitForDisplayed({ timeout: 10_000 });
    const expectedStartMs = Number(await firstWordEl.getAttribute('data-word-start') || 0);
    assert.ok(expectedStartMs > 0, `Expected nonzero word start, got ${expectedStartMs}`);
    await firstWordEl.click();
    await browser.pause(500);

    const updatedSurface = await surfaceState();
    assert.ok(Math.abs(updatedSurface.currentTimeMs - expectedStartMs) <= 300,
      `Player time ${updatedSurface.currentTimeMs} must seek close to word start ${expectedStartMs}`);
    await captureWorkflowStep(WORKFLOW, '05_word_seek_verified');
  });
});
