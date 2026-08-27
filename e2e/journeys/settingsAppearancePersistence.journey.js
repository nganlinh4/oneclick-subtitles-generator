// Customer Settings survive a real process restart: theme, application font and language repaint
// the complete UI, and the Video Processing and Prompts choices hydrate their controls again.
//
// The green Settings surface journey proves these controls change, Save commits them to SQLite,
// and reopening the modal restores them inside ONE process. This scenario owns the missing half of
// both capabilities: a second desktop process, sharing only the durable profile, must restore all
// of it without any user action. The verify phase derives every expectation from the application's
// own database read read-only — nothing is passed between the two processes by the harness.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { clickControl, openEditor } from '../support/editor.js';
import {
  appearanceSnapshot,
  selectAlternateDropdownOption,
} from '../support/settingsAppearance.js';
import { durableSettings } from '../support/settingsSurfaceOracle.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'settings-appearance-persistence';
const PHASE = process.env.OSG_E2E_PERSISTENCE_PHASE;
const APPEARANCE_KEYS = Object.freeze(['theme', 'app_font', 'preferred_language']);
const PROCESSING_KEYS = Object.freeze(['time_format', 'show_waveform_long_videos', 'transcription_prompt']);
const ALL_KEYS = Object.freeze([...APPEARANCE_KEYS, ...PROCESSING_KEYS]);
const FONT_DROPDOWN = '.settings-footer-controls > .app-font-dropdown > .custom-dropdown-button';
const LANGUAGE_DROPDOWN = '.settings-footer-controls > .custom-dropdown:not(.app-font-dropdown)'
  + ' > .custom-dropdown-button';
const TIME_FORMAT_DROPDOWN = '.video-processing-section .compact-setting:has(label[for="time-format"])'
  + ' .custom-dropdown-button';
const PROMPT_MARKER = 'OSG relaunch-persistence marker.';
// The public option order the surface journey verified: option 0 persists 'seconds', option 1 'hms'.
const TIME_FORMAT_BY_OPTION = Object.freeze(['seconds', 'hms']);

/* global $, browser, describe, document, it */

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

const paintedTheme = () => browser.execute(
  () => document.documentElement.getAttribute('data-theme'),
);

const waveformSwitchSelected = () => browser.execute(
  () => document.querySelector('#show-waveform-long-videos')?.selected ?? null,
);

/** The zero-based index of the option the open dropdown would show as selected, then close it. */
const selectedDropdownIndex = async (buttonSelector) => {
  await clickControl(buttonSelector);
  const menu = await $('.custom-dropdown-clipper');
  await menu.waitForDisplayed({ timeout: 10_000, timeoutMsg: `${buttonSelector} did not open` });
  const index = await browser.execute(() => [...document.querySelectorAll(
    '.custom-dropdown-clipper .dropdown-option',
  )].findIndex(option => option.classList.contains('selected')));
  assert.ok(index >= 0, `${buttonSelector} shows no selected option to inspect`);
  // Close by re-committing the already-selected option — a customer no-op that leaves the value
  // untouched. Escape would also dismiss the Settings modal, and the open menu morphs over the
  // button itself, so neither of those can close it here.
  const selected = await $('.custom-dropdown-clipper .dropdown-option.selected');
  await browser.action('pointer')
    .move({ origin: selected })
    .down({ button: 0 })
    .pause(75)
    .up({ button: 0 })
    .perform();
  await menu.waitForExist({
    reverse: true,
    timeout: 10_000,
    timeoutMsg: `${buttonSelector} did not close after inspection`,
  });
  return index;
};

describe('customer settings across a process restart', () => {
  it('restores the saved theme, font, language, processing and prompt choices in a fresh desktop process', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the harness must have an isolated data root');
    assert.ok(
      PHASE === 'seed' || PHASE === 'verify',
      'run this persistence journey through scenarios/settingsAppearancePersistence.mjs',
    );

    if (PHASE === 'verify') {
      const durable = durableSettings(root, ALL_KEYS);
      for (const key of ALL_KEYS) {
        assert.ok(typeof durable[key] === 'string' && durable[key].length > 0,
          `the seed process left no durable ${key}`);
      }
      await openEditor();
      await browser.waitUntil(
        async () => (await paintedTheme()) === durable.theme,
        {
          timeout: 60_000,
          interval: 500,
          timeoutMsg: 'a fresh process never painted the durable theme',
        },
      );
      await openSettings();
      const restored = await appearanceSnapshot();
      assert.deepEqual(
        {
          theme: restored.theme,
          documentTheme: restored.documentTheme,
          font: restored.font,
          language: restored.language,
        },
        {
          theme: durable.theme,
          documentTheme: durable.theme,
          font: durable.app_font,
          language: durable.preferred_language,
        },
        'the restored appearance differs from the durable preferences',
      );
      assert.ok(restored.fontLabel !== null && restored.languageLabel !== null,
        'the footer controls did not restore their visible selections');
      assert.ok(restored.primaryFont.trim().length > 0,
        'the application font variable was not applied in the fresh process');

      await activateTab('video-processing');
      assert.equal(await waveformSwitchSelected(), durable.show_waveform_long_videos === 'true',
        'the waveform preference switch did not hydrate from the durable value');
      const timeFormatIndex = await selectedDropdownIndex(TIME_FORMAT_DROPDOWN);
      assert.equal(TIME_FORMAT_BY_OPTION[timeFormatIndex], durable.time_format,
        `the time-format control restored option ${timeFormatIndex} instead of ${durable.time_format}`);
      await activateTab('prompts');
      const restoredPrompt = await $('#transcription-prompt').getValue();
      assert.equal(restoredPrompt, durable.transcription_prompt,
        'the transcription prompt did not hydrate from the durable value');
      assert.ok(restoredPrompt.includes(PROMPT_MARKER),
        'the relaunch marker vanished from the restored prompt');
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '03-restored-appearance',
        description: 'A fresh desktop process repaints the saved theme, font, language, processing and prompt choices.',
        details: { durable: { ...durable, transcription_prompt: durable.transcription_prompt.length }, restored },
        focusSelector: '.settings-modal',
      });
      return;
    }

    assert.deepEqual(
      durableSettings(root, ALL_KEYS),
      Object.fromEntries(ALL_KEYS.map(key => [key, null])),
      'clean-install display fallbacks were persisted without a user action',
    );
    await openEditor();
    await openSettings();
    const initial = await appearanceSnapshot();
    await clickControl('.settings-footer-controls .theme-toggle');
    const font = await selectAlternateDropdownOption(FONT_DROPDOWN);
    const language = await selectAlternateDropdownOption(LANGUAGE_DROPDOWN);
    const changed = await appearanceSnapshot();
    assert.notEqual(changed.theme, initial.theme, 'the theme toggle changed nothing');
    assert.equal(changed.documentTheme, changed.theme, 'the changed theme was not painted');
    assert.notEqual(changed.font, initial.font, 'the font dropdown changed nothing');
    assert.notEqual(changed.language, initial.language, 'the language dropdown changed nothing');

    await activateTab('video-processing');
    const waveformBefore = await waveformSwitchSelected();
    assert.equal(typeof waveformBefore, 'boolean', 'the waveform preference switch is unavailable');
    await clickControl('#show-waveform-long-videos');
    assert.equal(await waveformSwitchSelected(), !waveformBefore,
      'the waveform preference did not toggle');
    const timeFormat = await selectAlternateDropdownOption(TIME_FORMAT_DROPDOWN);
    const expectedTimeFormat = TIME_FORMAT_BY_OPTION[timeFormat.optionIndex];
    assert.ok(expectedTimeFormat, 'the time format exposed an undocumented option');
    await activateTab('prompts');
    const prompt = await $('#transcription-prompt');
    const originalPrompt = await prompt.getValue();
    assert.match(originalPrompt, /\{contentType\}/u, 'the required prompt placeholder is absent');
    const changedPrompt = `${originalPrompt.trimEnd()}\n\n${PROMPT_MARKER}`;
    await prompt.setValue(changedPrompt);
    assert.equal(await prompt.getValue(), changedPrompt, 'the prompt field did not accept the edit');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-settings-changed',
      description: 'Theme, font, language, waveform, time format and prompt change through real controls.',
      details: {
        initial, changed, font, language, waveform: { before: waveformBefore }, timeFormat,
      },
      focusSelector: '.settings-modal',
    });

    const save = await $('.save-btn');
    await browser.waitUntil(async () => !(await save.getAttribute('disabled')), {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'Settings never marked the public edits as saveable',
    });
    await clickControl('.save-btn');
    await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });

    assert.deepEqual(
      durableSettings(root, ALL_KEYS),
      {
        theme: changed.theme,
        app_font: changed.font,
        preferred_language: changed.language,
        time_format: expectedTimeFormat,
        show_waveform_long_videos: String(!waveformBefore),
        transcription_prompt: changedPrompt,
      },
      'Save did not commit the exact settings to SQLite',
    );
    assert.equal(await paintedTheme(), changed.theme,
      'the editor lost the changed theme after Save');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-saved-and-painted',
      description: 'The saved appearance stays painted in the editor after Settings closes.',
      details: { changed },
    });
  });
});
