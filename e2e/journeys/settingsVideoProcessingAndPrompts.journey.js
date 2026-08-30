// settingsSurface.journey.js already proves theme/font/language, time_format, the waveform switch
// and the transcription prompt persist to SQLite and restore in-process. This journey owns the
// SETTINGS it does not touch (auto-split, favorite max length, Gemini effects, auto-import,
// YouTube search, download cookies) and, for every setting here, goes one step further: it proves
// the durable value is the EXACT input the real request-building pipeline reads, not only that
// Settings remembers it.
//
// The consumption proof is deliberately layered, because no honest credential-free proof can reach
// all the way into a live Gemini request:
//   1. E2E boundary (this file): a real Settings Save commits the edited value to SQLite AND
//      mirrors it into the exact `localStorage` key the production pipeline reads
//      (src/components/settings/hooks/useSettingsPersistence.js:150-155).
//   2. Cited production code (not re-implemented here): a pure, synchronous function reads that
//      exact key and turns it into the real request/options object — no credential, no network:
//        - src/components/app/hooks/autoGenerateOptions.js:60-65,105-108 (`buildAutoGenerateOptions`)
//          reads `video_processing_max_words` / `show_favorite_max_length` into
//          `maxWordsPerSubtitle` / `autoSplitSubtitles`, the exact fields the Gemini processing
//          options modal and the native transcription request both consume.
//        - src/services/gemini/promptManagement.js:165-176 (`getTranscriptionPromptImpl`) and
//          src/services/gemini/core.js:120,147 (`callGeminiApi`) read `transcription_prompt` and
//          hand it to `runNativeGeminiTranscription`, the exact call `geminiCredentialBoundary`
//          proves is refused before any provider byte leaves and before any durable side effect.
//        - src/platform/downloadCookiePreference.js:40-54 (`readDownloadCookiePreference`) reads
//          `use_cookies_for_download` / `download_cookie_source` into the download job's cookie
//          source.
//        - src/components/app/AppState.js:62 reads `enable_youtube_search` into the input-method
//          tab list.
//      These are exercised independently by src/components/app/hooks/autoGenerateOptions.test.js.
//   3. One setting is walked all the way to a live, in-browser side effect instead of a storage
//      citation: `enable_gemini_effects` is applied SYNCHRONOUSLY by the Video Processing tab's own
//      effect (src/components/settings/tabs/VideoProcessingTab.js:71-78) and by Save itself
//      (src/components/settings/hooks/useSettingsPersistence.js:158-163), both calling
//      src/utils/geminiEffects/index.js:30,141 directly — this journey observes the real
//      `window.geminiAnimationFrameId` / DOM particle-container side effect, not a storage mirror.
//   4. `transcription_prompt` is additionally walked through the real generate-subtitles flow up to
//      the same missing-credential refusal `geminiCredentialBoundary` proves is side-effect-free,
//      confirming the exact edited text is still what the request builder would have read at the
//      moment the pipeline had to stop.
/* global $, browser, describe, document, it, localStorage, window */

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { clickControl } from '../support/editor.js';
import { durableState } from '../support/database.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import { selectAlternateDropdownOption } from '../support/settingsAppearance.js';
import { clickSettingsControl, revealSettingsSection } from '../support/settingsControls.js';
import { durableSettings } from '../support/settingsSurfaceOracle.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'settings-video-processing-and-prompts';
const PROMPT_MARKER = 'OSG real-binary video-processing consumption journey.';

// Keys settingsSurface.journey.js does not assert on. transcription_prompt is included because this
// journey's claim about it (request-builder consumption) is new even though its persistence is not.
const EXTENDED_KEYS = Object.freeze([
  'show_favorite_max_length',
  'video_processing_max_words',
  'enable_gemini_effects',
  'auto_import_site_subtitles',
  'enable_youtube_search',
  'use_cookies_for_download',
  'download_cookie_source',
  'transcription_prompt',
]);

// The visible track (StandardSlider.js:367) carries aria-valuenow for reading back the settled
// value; the real <input type="range"> (StandardSlider.js:409) shares the same id and is what
// actuateNativeRange must target.
const MAX_WORDS_SLIDER = '[data-osg-range-id="favorite-max-subtitle-length"]';
const MAX_WORDS_INPUT = '#favorite-max-subtitle-length';
const COOKIE_DROPDOWN = '.download-cookie-browser-setting .custom-dropdown-button';
// One compact row, not the whole tab section: the evidence publisher requires the entire focus
// target inside the window and a section is taller than the viewport.
const COOKIES_SETTING_ROW = '.compact-setting:has(#use-cookies-download)';

const openSettings = async () => {
  await clickControl('[data-app-action="open-settings"]');
  const modal = await $('.settings-modal');
  await modal.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'Settings did not open' });
};

const activateTab = async (tab) => {
  const selector = `[data-settings-tab="${tab}"]`;
  await clickControl(selector);
  await browser.waitUntil(async () => (await $(selector).getAttribute('class')).includes('active'), {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: `Settings tab did not activate: ${tab}`,
  });
};

const switchSelected = (selector) => browser.execute(
  (target) => document.querySelector(target)?.selected ?? null, selector,
);

const toggleSwitch = async (selector) => {
  const before = await switchSelected(selector);
  assert.equal(typeof before, 'boolean', `${selector} switch is unavailable`);
  const desired = !before;
  // One click can land during a settings-panel re-render and be dropped; a customer clicks again
  // when a switch visibly did not take. Re-click only while the state is still wrong, and let the
  // final assertion own the verdict (idiom: exportAnimationParityMatrix.journey.js's setSwitch).
  // clickSettingsControl additionally tolerates the sticky settings footer landing on top of a
  // control near the bottom of a scrolled tab (e2e/support/settingsControls.js).
  for (let attempt = 0; attempt < 3 && (await switchSelected(selector)) !== desired; attempt += 1) {
    await clickSettingsControl(selector);
    try {
      await browser.waitUntil(async () => (await switchSelected(selector)) === desired, {
        timeout: 2_500,
        interval: 50,
      });
    } catch { /* the bounded re-click and final assertion own the outcome */ }
  }
  const after = await switchSelected(selector);
  assert.equal(after, desired, `${selector} did not toggle`);
  return { before, after };
};

/** The live, credential-free, in-browser side effect Save (and the tab itself) applies immediately. */
const geminiEffectsRuntimeState = () => browser.execute(() => ({
  animating: typeof window.geminiAnimationFrameId === 'number',
  containers: document.querySelectorAll('.gemini-icon-container').length,
  buttons: document.querySelectorAll('.generate-btn:not(.translate-button):not(.download-btn)').length,
}));

/**
 * Move the shipped native range input by `steps` (negative decreases) and read its settled value.
 *
 * This suite runs the app window hidden and non-activatable, so a JS `focus()` call never yields
 * genuine keyboard focus and key-based slider control cannot work here -- it silently landed on
 * `document.body`, so `document.activeElement === node` never held. actuateNativeRange (from
 * e2e/support/nativeRange.js) is the idiom exportAnimationParityMatrix.journey.js and
 * multiWindowAsrPersistence.journey.js already use for every native range in this harness.
 */
const adjustSlider = async (inputSelector, trackSelector, steps) => {
  const input = await $(inputSelector);
  await input.waitForExist({ timeout: 30_000, timeoutMsg: `${inputSelector} never appeared` });
  const [minimum, maximum, step, current] = await Promise.all([
    input.getAttribute('min').then(Number),
    input.getAttribute('max').then(Number),
    input.getAttribute('step').then(Number),
    input.getValue().then(Number),
  ]);
  assert.ok(
    [minimum, maximum, step, current].every(Number.isFinite),
    `${inputSelector}: range geometry is invalid`,
  );
  const targetValue = Math.min(maximum, Math.max(minimum, current + steps * step));
  await actuateNativeRange({
    driver: browser, selector: inputSelector, value: targetValue, label: inputSelector,
  });
  return browser.execute(
    (target) => Number(document.querySelector(target)?.getAttribute('aria-valuenow')), trackSelector,
  );
};

/** The exact real generate flow, cut short at the same safe refusal geminiCredentialBoundary proves. */
const attemptCredentialFreeGeneration = async () => {
  await clickControl('[data-osg-action="generate-subtitles"]');
  const timeline = await $('.subtitle-timeline');
  await timeline.waitForDisplayed({ timeout: 60_000, timeoutMsg: 'the Gemini range selector never appeared' });
  await timeline.click();
  await browser.keys(['', 'a', '']); // select-all range, matching geminiCredentialBoundary
  const method = await $('[data-transcription-method="new"]');
  await method.waitForClickable({ timeout: 60_000 });
  await method.click();
  await clickControl('[data-osg-action="process-subtitles"]');
  let surface = null;
  await browser.waitUntil(async () => {
    surface = await browser.execute(() => ({
      errorToasts: [...document.querySelectorAll('.toast-error')]
        .map((node) => (node.innerText || '').trim()).filter(Boolean),
      forceStopPresent: document.querySelector('.force-stop-btn') !== null,
      generateDisabled: document.querySelector('[data-osg-action="generate-subtitles"]')?.disabled ?? null,
    }));
    return surface.errorToasts.some((message) => /API/i.test(message))
      && surface.forceStopPresent === false
      && surface.generateDisabled === false;
    // A template literal in `timeoutMsg` is evaluated when waitUntil is CALLED, so it would have
    // reported the pre-poll null forever. Read the state again on failure instead.
  }, { timeout: 30_000, interval: 250, timeoutMsg: 'missing-credential refusal did not settle' })
    .catch(async (error) => {
      const settled = await browser.execute(() => ({
        errorToasts: [...document.querySelectorAll('.toast-error')]
          .map((node) => (node.innerText || '').trim()).filter(Boolean),
        forceStopPresent: document.querySelector('.force-stop-btn') !== null,
        generateDisabled: document.querySelector('[data-osg-action="generate-subtitles"]')?.disabled ?? null,
      }));
      throw new Error(
        `missing-credential refusal did not settle: ${JSON.stringify(settled)}`,
        { cause: error },
      );
    });
  return surface;
};

describe('a customer\'s video-processing and prompt choices reach the pipelines they configure', () => {
  it('persists every option to SQLite and proves each one reaches its real consumer', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'this journey requires an isolated application root');
    assert.deepEqual(
      durableSettings(root, EXTENDED_KEYS),
      Object.fromEntries(EXTENDED_KEYS.map((key) => [key, null])),
      'clean-install fallbacks were persisted without a user action',
    );

    await openProjectWithMedia();
    await openSettings();
    await activateTab('video-processing');

    // enable_gemini_effects: consumed immediately by the tab's own effect, before any Save.
    const effectsBefore = await geminiEffectsRuntimeState();
    const { after: effectsSwitchAfter } = await toggleSwitch('#enable-gemini-effects');
    await browser.waitUntil(async () => {
      const state = await geminiEffectsRuntimeState();
      return state.animating === effectsSwitchAfter;
    }, {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'toggling Gemini effects did not change the live animation/particle runtime',
    });
    const effectsAfter = await geminiEffectsRuntimeState();
    if (!effectsSwitchAfter) {
      assert.equal(effectsAfter.containers, 0, 'disabling Gemini effects left particle containers in the DOM');
    }
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-gemini-effects-live',
      description: 'Toggling "Show Gemini star effects" immediately starts or stops the real animation runtime.',
      details: { effectsBefore, effectsSwitchAfter, effectsAfter },
      focusSelector: '#enable-gemini-effects',
    });

    const autoSplit = await toggleSwitch('#auto-split-subtitles');
    const maxWords = await adjustSlider(MAX_WORDS_INPUT, MAX_WORDS_SLIDER, -3);
    const autoImport = await toggleSwitch('#auto-import-site-subtitles');
    const youtubeSearch = await toggleSwitch('#enable-youtube-search');
    const cookies = await toggleSwitch('#use-cookies-download');
    let cookieBrowser = null;
    if (cookies.after) cookieBrowser = await selectAlternateDropdownOption(COOKIE_DROPDOWN);
    // Every control above scrolled the settings pane to wherever it lived, so the section this
    // step is about can now sit outside the modal's visible area even though each interaction
    // succeeded. Bring it back before the evidence publisher checks the focus target.
    // The evidence publisher requires the WHOLE focus target inside the window, and a tab section
    // is taller than the viewport, so focusing one can never succeed however it is scrolled. Focus
    // a single compact setting row instead, exactly as the green settings journey does.
    await revealSettingsSection(COOKIES_SETTING_ROW);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-processing-options-edited',
      description: 'Auto-split, favorite max length, auto-import, YouTube search and download cookies change through real controls.',
      details: {
        autoSplit, maxWords, autoImport, youtubeSearch, cookies, cookieBrowser,
      },
      focusSelector: COOKIES_SETTING_ROW,
    });

    await activateTab('prompts');
    const prompt = await $('#transcription-prompt');
    const originalPrompt = await prompt.getValue();
    const changedPrompt = originalPrompt.includes(PROMPT_MARKER)
      ? originalPrompt
      : `${originalPrompt.trimEnd()}\n\n${PROMPT_MARKER}`;
    await prompt.setValue(changedPrompt);
    assert.equal(await prompt.getValue(), changedPrompt, 'the prompt field did not accept the edit');

    const save = await $('.save-btn');
    await browser.waitUntil(async () => !(await save.getAttribute('disabled')), {
      timeout: 10_000, interval: 100, timeoutMsg: 'Settings never marked the public edits as saveable',
    });
    await clickControl('.save-btn');
    await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });

    const expected = {
      show_favorite_max_length: String(autoSplit.after),
      video_processing_max_words: String(maxWords),
      enable_gemini_effects: String(effectsSwitchAfter),
      auto_import_site_subtitles: String(autoImport.after),
      enable_youtube_search: String(youtubeSearch.after),
      use_cookies_for_download: String(cookies.after),
      transcription_prompt: changedPrompt,
    };
    const durable = durableSettings(root, EXTENDED_KEYS);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(durable[key], value, `${key} did not commit the exact edited value to SQLite`);
    }
    // The dropdown stores the machine id, not the display label selectAlternateDropdownOption read;
    // only its shape (a plain lowercase browser id) is independently checkable here.
    if (cookies.after) {
      assert.match(durable.download_cookie_source, /^[a-z]+$/u, 'download_cookie_source is not a plain browser id');
      assert.notEqual(durable.download_cookie_source, 'chrome', 'the cookie browser dropdown did not commit a changed selection');
    }

    // Consumption boundary: the exact key every cited production reader consumes, mirrored by the
    // real Save (useSettingsPersistence.js:150-155) into the SAME localStorage a fresh pipeline call
    // reads through window.localStorage -- not a test double.
    const mirrored = await browser.execute(
      (keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])), EXTENDED_KEYS,
    );
    assert.deepEqual(mirrored, durable, 'Save committed to SQLite without mirroring the same values into localStorage');

    // transcription_prompt: walk the real pipeline up to the same safe, side-effect-free refusal
    // geminiCredentialBoundary proves, and confirm the value at that boundary is still the edit.
    const beforeAttempt = durableState(root);
    const refusal = await attemptCredentialFreeGeneration();
    const promptAtRefusal = await browser.execute(() => localStorage.getItem('transcription_prompt'));
    assert.equal(promptAtRefusal, changedPrompt, 'the edited prompt was not the value present at the refusal boundary');
    const afterAttempt = durableState(root);
    const providerKinds = new Set(['transcribe', 'translate', 'analyzeSubtitles']);
    assert.deepEqual(
      afterAttempt.jobs.filter(({ kind }) => providerKinds.has(kind)),
      beforeAttempt.jobs.filter(({ kind }) => providerKinds.has(kind)),
      'the credential-free attempt started a durable provider job',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-prompt-reaches-refusal-boundary',
      description: 'The edited transcription prompt is still the exact value at the request builder when the missing-credential refusal stops the pipeline.',
      details: { changedCharacters: changedPrompt.length, refusal },
      allowVisibleProblems: {
        errorToasts: refusal.errorToasts.map((toast) => ({
          text: toast.replace(/\s+/g, ' ').trim(),
          reason: 'The visible missing-credential refusal is the customer state under test.',
        })),
      },
    });
    for (const close of await $$('.toast-item.live .close-icon')) await close.click();
    await browser.waitUntil(async () => browser.execute(() => (
      document.querySelectorAll('.toast-item.live .toast-error').length === 0
    )), {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'the acknowledged missing-key toast did not dismiss',
    });

    await openSettings();
    await activateTab('video-processing');
    assert.equal(await switchSelected('#enable-gemini-effects'), effectsSwitchAfter);
    assert.equal(await switchSelected('#auto-split-subtitles'), autoSplit.after);
    assert.equal(await switchSelected('#auto-import-site-subtitles'), autoImport.after);
    assert.equal(await switchSelected('#enable-youtube-search'), youtubeSearch.after);
    assert.equal(await switchSelected('#use-cookies-download'), cookies.after);
    const restoredMaxWords = await browser.execute(
      (target) => Number(document.querySelector(target)?.getAttribute('aria-valuenow')), MAX_WORDS_SLIDER,
    );
    assert.equal(restoredMaxWords, maxWords, 'favorite max subtitle length did not restore in the UI');
    await activateTab('prompts');
    assert.equal(await $('#transcription-prompt').getValue(), changedPrompt, 'prompt did not restore');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-persisted-processing-options',
      description: 'Every edited processing option and the prompt restore from the durable preference snapshot.',
      details: { expected, restoredMaxWords },
      focusSelector: '.settings-modal',
    });
    await clickControl('[data-settings-action="close"]');
    await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });
  });
});
