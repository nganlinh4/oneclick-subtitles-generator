// Theme, application font and language survive a real process restart.
//
// The green Settings surface journey proves the footer controls change these preferences, Save
// commits them to SQLite, and reopening the modal restores them inside ONE process. This scenario
// owns the missing half of the capability: a second desktop process, sharing only the durable
// profile, must repaint the changed appearance without any user action. The verify phase derives
// every expectation from the application's own database read read-only — nothing is passed between
// the two processes by the harness.

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
const FONT_DROPDOWN = '.settings-footer-controls > .app-font-dropdown > .custom-dropdown-button';
const LANGUAGE_DROPDOWN = '.settings-footer-controls > .custom-dropdown:not(.app-font-dropdown)'
  + ' > .custom-dropdown-button';

/* global $, browser, describe, document, it */

const openSettings = async () => {
  await clickControl('[data-app-action="open-settings"]');
  const modal = await $('.settings-modal');
  await modal.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'Settings did not open' });
};

const paintedTheme = () => browser.execute(
  () => document.documentElement.getAttribute('data-theme'),
);

describe('appearance preferences across a process restart', () => {
  it('repaints the saved theme, font and language in a fresh desktop process', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the harness must have an isolated data root');
    assert.ok(
      PHASE === 'seed' || PHASE === 'verify',
      'run this persistence journey through scenarios/settingsAppearancePersistence.mjs',
    );

    if (PHASE === 'verify') {
      const durable = durableSettings(root, APPEARANCE_KEYS);
      for (const key of APPEARANCE_KEYS) {
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
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '03-restored-appearance',
        description: 'A fresh desktop process repaints the saved theme, font and language.',
        details: { durable, restored },
        focusSelector: '.settings-modal',
      });
      return;
    }

    assert.deepEqual(
      durableSettings(root, APPEARANCE_KEYS),
      Object.fromEntries(APPEARANCE_KEYS.map(key => [key, null])),
      'clean-install appearance fallbacks were persisted without a user action',
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
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-appearance-changed',
      description: 'Theme, application font and language change through the real footer controls.',
      details: { initial, changed, font, language },
      focusSelector: '.settings-modal',
    });

    const save = await $('.save-btn');
    await browser.waitUntil(async () => !(await save.getAttribute('disabled')), {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'Settings never marked the appearance edits as saveable',
    });
    await clickControl('.save-btn');
    await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });

    assert.deepEqual(
      durableSettings(root, APPEARANCE_KEYS),
      {
        theme: changed.theme,
        app_font: changed.font,
        preferred_language: changed.language,
      },
      'Save did not commit the exact appearance preferences to SQLite',
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
