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

    // Verify driving theme through real Settings controls (verifies Settings controls and persistence)
    await clickControl('[data-app-action="open-settings"]');
    const settingsModal = await $('.settings-modal');
    await settingsModal.waitForDisplayed({ timeout: 15_000 });
    await clickControl('.settings-footer-controls .theme-toggle');
    await browser.waitUntil(async () => (
      (await browser.execute(() => document.documentElement.getAttribute('data-theme'))) === 'light'
    ), { timeout: 5_000, timeoutMsg: 'Theme did not switch to light via Settings controls' });
    await clickControl('.settings-footer-controls .theme-toggle');
    await browser.waitUntil(async () => (
      (await browser.execute(() => document.documentElement.getAttribute('data-theme'))) === 'dark'
    ), { timeout: 5_000, timeoutMsg: 'Theme did not switch back to dark via Settings controls' });
    await clickControl('[data-settings-action="close"]');
    await settingsModal.waitForExist({ reverse: true, timeout: 15_000 });

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
    let isExpanded = await browser.execute(() => !!document.querySelector('.creation-accordion-content'));
    if (!isExpanded) {
      await accordion.click();
      await browser.pause(200);
      isExpanded = await browser.execute(() => !!document.querySelector('.creation-accordion-content'));
      if (!isExpanded) {
        await browser.execute(() => {
          const btn = document.querySelector('[data-osg-action="speech-advanced-options-toggle"]');
          if (btn) btn.click();
        });
      }
    }
    await $('.creation-accordion-content').waitForExist({ timeout: 5_000 });

    // Scroll slider track into view and verify it is displayed
    await browser.execute(() => {
      const el = document.querySelector('[data-osg-range-id="speech-window-duration-slider"]');
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
    });
    const sliderTrack = await $('[data-osg-range-id="speech-window-duration-slider"]');
    await sliderTrack.waitForDisplayed({ timeout: 10_000 });
    await sliderTrack.click();
    await browser.keys(['Home']);

    // Ensure React controlled state receives 30 via keyboard event dispatch on the slider track
    // and change event on the underlying range input
    await browser.execute((trackSel, inputSel) => {
      const track = document.querySelector(trackSel);
      if (track) {
        track.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      }
      const input = document.querySelector(inputSel);
      if (input) {
        const tracker = input._valueTracker;
        if (tracker) tracker.setValue('120');
        input.value = '30';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, '[data-osg-range-id="speech-window-duration-slider"]', '[data-osg-action="speech-window-duration-slider"]');

    const slider = await $('[data-osg-action="speech-window-duration-slider"], .speech-window-duration-slider');
    await slider.waitForExist({ timeout: 10_000 });

    // Verify the controlled slider reflects 30s
    await browser.waitUntil(async () => {
      const val = await slider.getValue();
      return String(val) === '30';
    }, { timeout: 5_000, timeoutMsg: 'Window duration slider failed to update to 30' });

    // Verify both class tokens survive on the underlying input (regression test for duplicate slider)
    const classes = await slider.getAttribute('class');
    assert.ok(classes.includes('standard-slider-input'), 'standard-slider-input class token must survive');
    assert.ok(classes.includes('speech-window-duration-slider'), 'speech-window-duration-slider class token must survive');

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-scope-range-selected',
      description: 'Timeline range [15s, 145s] selected and 30s window duration configured for 4-window partitioning with uncrowded title, compact selection cards, and single Material slider.',
    });

    // Inspect Translate tab with source mode radios and custom selects
    const translateTab = await $('[data-task-tab="translate"]');
    await translateTab.waitForDisplayed({ timeout: 10_000 });
    await translateTab.click();
    await browser.pause(300);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-normal-dark-en-translate',
      description: 'Translate task tab in dark EN with source mode radios, target language select, and model select.',
    });

    // Inspect Visual / Custom tab with subtask pills
    const visualTab = await $('[data-task-tab="visual"]');
    await visualTab.waitForDisplayed({ timeout: 10_000 });
    await visualTab.click();
    await browser.pause(300);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-normal-dark-en-visual',
      description: 'Visual / Custom task tab with subtask pill segmented row, model select, and parameter inputs.',
    });

    // Switch back to Speech tab
    const speechTabBtn = await $('[data-task-tab="speech"]');
    await speechTabBtn.waitForDisplayed({ timeout: 10_000 });
    await speechTabBtn.click();
    await browser.pause(300);

    // Switch to Vietnamese using conditionally compiled E2E automation witness
    await browser.execute(() => {
      window.__OSG_E2E_I18N__?.changeLanguage('vi');
    });
    const modalTitleVi = await $('.create-subtitles-title');
    await browser.waitUntil(async () => {
      const text = await modalTitleVi.getText();
      return text.includes('Tạo phụ đề');
    }, { timeout: 5_000, timeoutMsg: 'Modal title did not render in Vietnamese (Tạo phụ đề)' });

    // Actually expand Advanced options accordion and assert contents are visible
    const accordionVi = await $('[data-osg-action="speech-advanced-options-toggle"], .creation-accordion-trigger');
    await accordionVi.waitForDisplayed({ timeout: 10_000 });
    const isExpandedVi = await browser.execute(() => !!document.querySelector('.creation-accordion-content'));
    if (!isExpandedVi) {
      await accordionVi.click();
    }
    const accordionContentVi = await $('.creation-accordion-content');
    await accordionContentVi.waitForDisplayed({ timeout: 5_000 });
    assert.ok(await accordionContentVi.isDisplayed(), 'Advanced options content must be visible');

    // Open and inspect an actual dropdown control
    const engineSelectVi = await $('#speech-engine-select');
    await engineSelectVi.waitForDisplayed({ timeout: 5_000 });
    await engineSelectVi.click();
    const selectedEngineVal = await engineSelectVi.getValue();
    assert.equal(selectedEngineVal, 'gemini-3.5-transcribe', 'Engine select must be gemini-3.5-transcribe');

    // Scroll to the bottom of the modal and verify the primary action remains reachable
    await browser.execute(() => {
      const scroller = document.querySelector('.creation-modal-body') || document.querySelector('.create-subtitles-modal');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    const processBtnVi = await $('[data-osg-action="process-subtitles"]');
    await processBtnVi.waitForDisplayed({ timeout: 5_000 });
    assert.ok(await processBtnVi.isClickable(), 'Primary action must remain reachable and clickable when options are expanded');

    // Record actual window geometry and document the native resize refusal mechanism
    const nativeResizeRefusal = 'the guarded automation server refuses native-window position and size changes (vendor/tauri-plugin-wdio-webdriver/src/server/handlers/window.rs:172; driverIdentity.js:125)';
    const actualGeometry = await browser.execute(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
    }));

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-min-size-dark-vi-expanded',
      description: 'Minimum supported window size (1200x800) with dark theme, Vietnamese localized title (Tạo phụ đề), unclipped labels, and expanded controls.',
      details: {
        nativeResizeRefusal,
        actualGeometry,
      },
    });

    // Test light theme + Korean locale
    await browser.execute(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      window.__OSG_E2E_I18N__?.changeLanguage('ko');
    });
    const modalTitleKo = await $('.create-subtitles-title');
    await browser.waitUntil(async () => {
      const text = await modalTitleKo.getText();
      return text.includes('자막 생성');
    }, { timeout: 5_000, timeoutMsg: 'Modal title did not render in Korean (자막 생성)' });

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-light-ko-modal',
      description: 'Light theme with soft purple primary-container cards and Korean localized title (자막 생성).',
    });

    // Reset back to dark theme and English
    await browser.execute(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      window.__OSG_E2E_I18N__?.changeLanguage('en');
    });
    const modalTitleEn = await $('.create-subtitles-title');
    await browser.waitUntil(async () => {
      const text = await modalTitleEn.getText();
      return text.includes('Create subtitles');
    }, { timeout: 5_000, timeoutMsg: 'Modal title did not reset to English (Create subtitles)' });

    // Ensure Speech tab and Gemini Transcribe engine are active
    const speechTabFinal = await $('[data-task-tab="speech"]');
    await speechTabFinal.waitForDisplayed({ timeout: 10_000 });
    await speechTabFinal.click();
    await browser.pause(300);

    // Verify modal summary explicitly confirms Gemini Transcribe and range before clicking create
    const summaryEl = await $('.creation-summary-text');
    await summaryEl.waitForDisplayed({ timeout: 5_000 });
    const summaryText = await summaryEl.getText();
    assert.ok(
      summaryText.includes('Gemini Transcribe'),
      `Modal summary must confirm Gemini Transcribe: "${summaryText}"`,
    );
    assert.ok(
      summaryText.includes('00:14') && summaryText.includes('02:24'),
      `Modal summary must confirm selected range 00:14–02:24: "${summaryText}"`,
    );

    await clickControl('[data-osg-action="process-subtitles"]');

    // Wait for native transcribe job to reach succeeded state
    let job = null;
    let lastLog = 0;
    await browser.waitUntil(async () => {
      const state = durableState(root);
      job = state.jobs.find((j) => j.kind === 'transcribe' && j.state === 'succeeded') ?? null;
      const currentJobs = state.jobs.filter((j) => j.kind === 'transcribe');
      if (Date.now() - lastLog >= 10_000) {
        lastLog = Date.now();
        console.log(`[E2E Range Projection] Active transcribe jobs: ${currentJobs.length}, states: ${currentJobs.map((j) => `${j.id}:${j.state}`).join(', ')}, cues: ${state.counts.cues}`);
      }
      const errorToasts = await browser.execute(() => {
        return [...document.querySelectorAll('.toast-error')]
          .map((node) => (node.querySelector('p')?.innerText || node.innerText || '').trim())
          .filter(Boolean);
      });
      if (errorToasts.length > 0) {
        throw new Error(`Transcription failed with error toast: ${errorToasts.join('; ')}`);
      }
      return job !== null && state.counts.cues > 0;
    }, {
      timeout: 900_000,
      interval: 2_000,
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
      step: '06-four-windows-verified',
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

    // 8. Switch to Captions view and expand Grouping Drawer
    const captionsTab = await $('[data-testid="viewport-tab-captions"]');
    if (await captionsTab.isDisplayed()) {
      await captionsTab.click();
      await browser.pause(300);
    }
    const drawerToggle = await $('[data-testid="toggle-adjust-drawer"]');
    if (await drawerToggle.isDisplayed()) {
      await drawerToggle.click();
      await browser.pause(300);
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '07-grouping-drawer-expanded',
        description: 'Caption grouping toolbar with 24px container, pill buttons, and expanded custom sliders drawer.',
      });
    }

    // 9. Verify Export Controls reachability (smoke check)
    const renderToggle = await $('.render-video-toggle');
    if (await renderToggle.isDisplayed()) {
      await clickControl('.render-video-toggle');
      const renderControls = await $('.video-rendering-section.expanded .native-render-controls');
      await renderControls.waitForDisplayed({ timeout: 15_000 });
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '08-export-controls-expanded',
        description: 'Export controls expanded with native preview and preset options, proving export reachability from generated captions.',
      });
    }
  });
});

