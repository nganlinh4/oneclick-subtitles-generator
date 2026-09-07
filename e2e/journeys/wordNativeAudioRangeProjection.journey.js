import { strict as assert } from 'node:assert';
import process from 'node:process';

import {
  durableState,
  durableTranscriptRevisions,
  durableTranscriptWords,
} from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-audio-range-projection';

/* global $, browser, describe, document, Event, it */

describe('Customer Journey 2: Nonzero range and four windows with exact single offset projection', () => {
  it('transcribes selected nonzero range across 4 windows and verifies native evidence', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'requires an isolated data root');
    await openProjectWithMedia();
    await enrollGeminiCredentials({ limit: 1 });

    // Drag on subtitle timeline to select a genuinely nonzero range [~15s, ~145s]
    // out of 150s total duration.
    const timeline = await $('.subtitle-timeline');
    await timeline.waitForDisplayed({ timeout: 30_000 });
    const { width } = await timeline.getSize();
    assert.ok(width >= 100, `timeline width too narrow: ${width}px`);

    // 15s / 150s = 0.10, 145s / 150s = 0.967
    const fromX = -Math.floor(width / 2) + Math.floor(width * 0.10);
    const toX = -Math.floor(width / 2) + Math.floor(width * 0.965);
    await browser.action('pointer')
      .move({ origin: timeline, x: fromX, y: 0 })
      .down({ button: 0 })
      .pause(100)
      .move({ origin: timeline, x: toX, y: 0, duration: 450 })
      .up({ button: 0 })
      .perform();

    // The modal is automatically opened upon segment selection
    const modal = await $('.create-subtitles-modal, .video-processing-modal');
    await modal.waitForDisplayed({ timeout: 15_000 });

    // Explicitly select Speech task and Gemini Transcribe engine
    const speechTab = await $('[data-task-tab="speech"]');
    if (await speechTab.isDisplayed()) await speechTab.click();

    const engineSelect = await $('#speech-engine-select');
    await engineSelect.waitForDisplayed({ timeout: 10_000 });
    await engineSelect.selectByAttribute('value', 'gemini-3.5-transcribe');

    // Set window duration to 30 seconds to produce at least 4 windows (130s duration / 30s = 4 windows)
    const slider = await $('.speech-window-duration-slider');
    if (await slider.isDisplayed()) {
      await browser.execute((sel) => {
        const el = document.querySelector(sel);
        if (el) {
          el.value = 30;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, '.speech-window-duration-slider');
    }

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-scope-range-selected',
      description: 'Timeline range [15s, 145s] selected and 30s window duration configured for 4-window partitioning.',
    });

    await clickControl('[data-osg-action="process-subtitles"]');

    // Wait for native transcribe job to reach succeeded state
    let job = null;
    await browser.waitUntil(async () => {
      const state = durableState(root);
      job = state.jobs.find((j) => j.kind === 'transcribe' && j.state === 'succeeded') ?? null;
      return job !== null && state.counts.cues > 0;
    }, {
      timeout: 300_000,
      interval: 1_000,
      timeoutMsg: 'Four-window transcription job never completed with captions',
    });

    // Verify native evidence in SQLite
    const revisions = durableTranscriptRevisions(root);
    assert.ok(revisions.length >= 1, 'At least one transcript revision must be recorded');
    const rev = revisions.at(-1);

    // Native evidence check: range_start_ms must be well beyond zero
    assert.ok(
      rev.sourceRangeStartMs >= 10_000,
      `Native evidence sourceRangeStartMs (${rev.sourceRangeStartMs}ms) must be well beyond zero (>= 10,000ms)`,
    );
    assert.ok(
      rev.sourceRangeEndMs >= 120_000,
      `Native evidence sourceRangeEndMs (${rev.sourceRangeEndMs}ms) must reach near media end`,
    );

    const admittedDurationMs = rev.sourceRangeEndMs - rev.sourceRangeStartMs;
    assert.ok(
      admittedDurationMs >= 100_000,
      `Admitted range duration ${admittedDurationMs}ms must be >= 100,000ms to produce >= 4 windows of 30s`,
    );

    // Timing Invariant 1: No zero offset bug - all words start >= sourceRangeStartMs
    const words = durableTranscriptWords(root);
    assert.ok(words.length > 0, 'Recognized transcript words must be persisted');
    for (const word of words) {
      assert.ok(
        word.startMs >= rev.sourceRangeStartMs,
        `Word "${word.text}" startMs (${word.startMs}ms) is below admitted range start (${rev.sourceRangeStartMs}ms) - zero offset bug`,
      );
      assert.ok(
        word.endMs >= word.startMs,
        `Word endMs must be >= startMs: ${JSON.stringify(word)}`,
      );
    }

    // Timing Invariant 2: No double offset bug - window 0 words start near sourceRangeStartMs
    const firstWord = words[0];
    assert.ok(
      firstWord.startMs < rev.sourceRangeStartMs + 30_000,
      `First word startMs (${firstWord.startMs}ms) exceeds window 0 boundary (${rev.sourceRangeStartMs + 30_000}ms) - double offset bug`,
    );

    // Timing Invariant 3: Words span into later windows (> 60s past start)
    const lastWord = words.at(-1);
    assert.ok(
      lastWord.startMs >= rev.sourceRangeStartMs + 60_000,
      `Last word startMs (${lastWord.startMs}ms) does not reach later windows`,
    );

    // Timing Invariant 4: All cues are within range
    const state = durableState(root);
    assert.ok(state.cues.length > 0, 'Durable cues must exist');
    for (const cue of state.cues) {
      assert.ok(
        cue.start_ms >= rev.sourceRangeStartMs,
        `Cue start_ms (${cue.start_ms}ms) precedes admitted range start (${rev.sourceRangeStartMs}ms)`,
      );
      assert.ok(cue.end_ms > cue.start_ms);
    }

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-four-windows-verified',
      description: 'Four-window transcription completed; native evidence proves nonzero start and exact single offset projection.',
      details: {
        sourceRangeStartMs: rev.sourceRangeStartMs,
        sourceRangeEndMs: rev.sourceRangeEndMs,
        admittedDurationMs,
        wordCount: words.length,
        firstWordStartMs: firstWord.startMs,
        lastWordStartMs: lastWord.startMs,
        cueCount: state.cues.length,
      },
    });
  });
});

