import { strict as assert } from 'node:assert';
import process from 'node:process';

import {
  durableState,
  durableTranscriptRevisions,
  durableTranscriptTurns,
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
    await speechTab.waitForDisplayed({ timeout: 10_000 });
    await speechTab.click();

    const engineSelect = await $('#speech-engine-select');
    await engineSelect.waitForDisplayed({ timeout: 10_000 });
    await engineSelect.selectByAttribute('value', 'gemini-3.5-transcribe');

    // Set window duration to 30 seconds to produce at least 4 windows (130s duration / 30s = 5 windows)
    const accordion = await $('[data-osg-action="speech-advanced-options-toggle"], .creation-accordion-trigger');
    await accordion.waitForDisplayed({ timeout: 10_000 });
    await accordion.click();

    const slider = await $('[data-osg-action="speech-window-duration-slider"], .speech-window-duration-slider');
    await slider.waitForDisplayed({ timeout: 10_000 });
    await browser.execute((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.value = 30;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, '[data-osg-action="speech-window-duration-slider"], .speech-window-duration-slider');

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
      timeoutMsg: 'Multi-window transcription job never completed with captions',
    });

    // 1. Verify native evidence in SQLite: revisions and planned windows
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

    // 2. Unconditional assertion of window planning metadata
    assert.ok(rev.metadata, 'Revision metadata must be present');
    assert.equal(typeof rev.metadata.totalWindows, 'number', 'Metadata totalWindows must be a number');
    assert.ok(
      rev.metadata.totalWindows >= 4,
      `Planned window count (${rev.metadata.totalWindows}) must be >= 4`,
    );
    assert.equal(
      rev.metadata.windowDurationMs,
      30_000,
      `Window duration must be 30,000ms (was ${rev.metadata.windowDurationMs}ms)`,
    );
    assert.ok(
      Array.isArray(rev.metadata.plannedWindows),
      'Planned windows list must be an array',
    );
    assert.equal(
      rev.metadata.plannedWindows.length,
      rev.metadata.totalWindows,
      'Planned windows list length must match totalWindows',
    );

    // 3. Exact planned range verification
    for (let i = 0; i < rev.metadata.plannedWindows.length; i += 1) {
      const win = rev.metadata.plannedWindows[i];
      assert.equal(win.index, i, `Window ${i} index must match ordinal`);
      if (i === 0) {
        assert.equal(
          win.startMs,
          rev.sourceRangeStartMs,
          `Window 0 startMs (${win.startMs}ms) must equal sourceRangeStartMs (${rev.sourceRangeStartMs}ms)`,
        );
      } else {
        assert.equal(
          win.startMs,
          rev.metadata.plannedWindows[i - 1].endMs,
          `Window ${i} startMs (${win.startMs}ms) must equal Window ${i - 1} endMs (${rev.metadata.plannedWindows[i - 1].endMs}ms)`,
        );
      }
      if (i < rev.metadata.plannedWindows.length - 1) {
        assert.equal(
          win.endMs - win.startMs,
          30_000,
          `Full window ${i} duration (${win.endMs - win.startMs}ms) must be exactly 30,000ms`,
        );
      } else {
        assert.equal(
          win.endMs,
          rev.sourceRangeEndMs,
          `Final window ${i} endMs (${win.endMs}ms) must equal sourceRangeEndMs (${rev.sourceRangeEndMs}ms)`,
        );
      }
    }

    // 4. Completed window identities from persisted turns
    const turns = durableTranscriptTurns(root);
    assert.ok(turns.length > 0, 'Recognized transcript turns must be persisted');
    const completedWindowIndices = new Set(
      turns.map((t) => {
        const match = t.speakerId?.match(/^w(\d+):/);
        return match ? Number(match[1]) : null;
      }).filter((idx) => idx !== null),
    );
    assert.ok(
      completedWindowIndices.size >= 4,
      `Completed window count (${completedWindowIndices.size}) must be >= 4`,
    );

    // 5. Word-by-word local-to-source offset oracle
    const words = durableTranscriptWords(root);
    assert.ok(words.length > 0, 'Recognized transcript words must be persisted');

    const testOffsetOracle = (candidateStartMs, rawStartNs, windowStartMs) => {
      const localMs = Math.floor(rawStartNs / 1_000_000);
      return candidateStartMs === windowStartMs + localMs;
    };

    let oracleCheckedCount = 0;
    for (const word of words) {
      assert.ok(
        Number.isSafeInteger(word.rawStartNs) && word.rawStartNs >= 0,
        `Word "${word.text}" must contain valid rawStartNs (${word.rawStartNs})`,
      );
      // Find the planned window containing this word's projected start time
      const win = rev.metadata.plannedWindows.find(
        (w, idx) => (
          idx === rev.metadata.plannedWindows.length - 1
            ? word.startMs >= w.startMs && word.startMs <= w.endMs
            : word.startMs >= w.startMs && word.startMs < w.endMs
        ),
      );
      assert.ok(
        win,
        `Word "${word.text}" startMs (${word.startMs}ms) must fall within a planned window range`,
      );

      // Reconcile provider-local time to stored project time
      const localMs = Math.floor(word.rawStartNs / 1_000_000);
      const expectedStartMs = win.startMs + localMs;
      assert.equal(
        word.startMs,
        expectedStartMs,
        `Word "${word.text}" startMs (${word.startMs}ms) must equal window.startMs (${win.startMs}ms) + localStartMs (${localMs}ms)`,
      );
      assert.ok(
        testOffsetOracle(word.startMs, word.rawStartNs, win.startMs),
        `Word "${word.text}" must satisfy offset oracle`,
      );
      oracleCheckedCount += 1;
    }
    assert.ok(oracleCheckedCount > 0, 'At least one word verified by offset oracle');

    // Oracle negative check 1: Deliberately omitting offset fails oracle on saved evidence
    for (const word of words) {
      const win = rev.metadata.plannedWindows.find(
        (w, idx) => (
          idx === rev.metadata.plannedWindows.length - 1
            ? word.startMs >= w.startMs && word.startMs <= w.endMs
            : word.startMs >= w.startMs && word.startMs < w.endMs
        ),
      );
      const zeroOffsetCandidate = Math.floor(word.rawStartNs / 1_000_000);
      if (win.startMs > 0) {
        assert.equal(
          testOffsetOracle(zeroOffsetCandidate, word.rawStartNs, win.startMs),
          false,
          `Oracle must reject zero-offset candidate (${zeroOffsetCandidate}ms vs ${word.startMs}ms)`,
        );
      }
    }

    // Oracle negative check 2: Deliberately doubling offset fails oracle on saved evidence
    for (const word of words) {
      const win = rev.metadata.plannedWindows.find(
        (w, idx) => (
          idx === rev.metadata.plannedWindows.length - 1
            ? word.startMs >= w.startMs && word.startMs <= w.endMs
            : word.startMs >= w.startMs && word.startMs < w.endMs
        ),
      );
      const doubleOffsetCandidate = 2 * win.startMs + Math.floor(word.rawStartNs / 1_000_000);
      if (win.startMs > 0) {
        assert.equal(
          testOffsetOracle(doubleOffsetCandidate, word.rawStartNs, win.startMs),
          false,
          `Oracle must reject double-offset candidate (${doubleOffsetCandidate}ms vs ${word.startMs}ms)`,
        );
      }
    }

    // 6. Check joins and ordering across windows
    for (let i = 0; i < words.length - 1; i += 1) {
      assert.ok(
        words[i].wordIndex < words[i + 1].wordIndex,
        `Word ordinals must be strictly increasing: ${words[i].wordIndex} >= ${words[i + 1].wordIndex}`,
      );
      assert.ok(
        words[i].startMs <= words[i + 1].startMs,
        `Word startMs must be monotonically non-decreasing: ${words[i].startMs} > ${words[i + 1].startMs}`,
      );
    }

    for (let i = 0; i < rev.metadata.plannedWindows.length - 1; i += 1) {
      const currentWin = rev.metadata.plannedWindows[i];
      const nextWin = rev.metadata.plannedWindows[i + 1];
      const currentWords = words.filter((w) => w.startMs >= currentWin.startMs && w.startMs < currentWin.endMs);
      const nextWords = words.filter((w) => w.startMs >= nextWin.startMs && w.startMs < nextWin.endMs);

      if (currentWords.length > 0 && nextWords.length > 0) {
        const lastCurrent = currentWords.at(-1);
        const firstNext = nextWords[0];
        assert.ok(
          lastCurrent.startMs < firstNext.startMs,
          `Join between window ${i} and ${i + 1}: last word (${lastCurrent.startMs}ms) must precede next window's first word (${firstNext.startMs}ms)`,
        );
      }
    }

    // 7. Check all durable cues within range
    const state = durableState(root);
    assert.ok(state.cues.length > 0, 'Durable cues must exist');
    for (const cue of state.cues) {
      assert.ok(
        cue.start_ms >= rev.sourceRangeStartMs,
        `Cue start_ms (${cue.start_ms}ms) precedes admitted range start (${rev.sourceRangeStartMs}ms)`,
      );
      assert.ok(
        cue.end_ms <= rev.sourceRangeEndMs + 500,
        `Cue end_ms (${cue.end_ms}ms) exceeds admitted range end (${rev.sourceRangeEndMs}ms)`,
      );
      assert.ok(cue.end_ms > cue.start_ms);
    }

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-four-windows-verified',
      description: 'Multi-window transcription completed; native evidence proves planned ranges, completed window identities, and exact offset oracle verification.',
      details: {
        sourceRangeStartMs: rev.sourceRangeStartMs,
        sourceRangeEndMs: rev.sourceRangeEndMs,
        admittedDurationMs,
        plannedWindowCount: rev.metadata.totalWindows,
        plannedWindows: rev.metadata.plannedWindows,
        completedWindowIndices: [...completedWindowIndices].sort((a, b) => a - b),
        wordCount: words.length,
        firstWordStartMs: words[0].startMs,
        lastWordStartMs: words.at(-1).startMs,
        cueCount: state.cues.length,
        oracleCheckedCount,
      },
    });
  });
});

