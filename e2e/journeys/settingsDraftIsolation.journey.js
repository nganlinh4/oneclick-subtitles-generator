import { strict as assert } from 'node:assert';
import process from 'node:process';
import { clickControl, openEditor } from '../support/editor.js';
import { clickSettingsControl, revealSettingsSection } from '../support/settingsControls.js';
import { durableSettings } from '../support/settingsSurfaceOracle.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

/* global $, browser, describe, document, it, localStorage */

const WORKFLOW = 'settings-draft-isolation';
const CARD = '.custom-gemini-models-card';
const MODEL = { id: 'gemini-audit-custom', name: 'Audit custom model', isCustom: true };
const persistedModels = async () => ({
  browser: await browser.execute(() => JSON.parse(localStorage.getItem('custom_gemini_models') || '[]')),
  native: JSON.parse(durableSettings(process.env.OSG_E2E_DATA_ROOT, ['custom_gemini_models'])
    .custom_gemini_models || '[]'),
});

const openModels = async () => {
  await clickControl('[data-app-action="open-settings"]');
  await $('.settings-modal').waitForDisplayed();
  await clickControl('[data-settings-tab="video-processing"]');
  await revealSettingsSection(CARD);
};

const closeSettings = async (save = false) => {
  await clickControl(save ? '.settings-footer .save-btn' : '[data-settings-action="close"]');
  await $('.settings-modal').waitForExist({ reverse: true, timeout: 15_000 });
};

const addDraft = async () => {
  await clickSettingsControl(`${CARD} .add-model-button`);
  await $(`${CARD} #model-id`).setValue(MODEL.id);
  await $(`${CARD} #model-name`).setValue(MODEL.name);
  await clickSettingsControl(`${CARD} .save-model-btn`);
};

const snapshot = async (step, description) => {
  await revealSettingsSection(CARD);
  await captureWorkflowStep({ workflow: WORKFLOW, step, description,
    focusSelector: CARD, details: await persistedModels() });
};

describe('settings edits belong to the form until Save', () => {
  it('discards model additions and renames, and persists only a saved draft', async () => {
    await openEditor();
    const original = await persistedModels();
    await openModels();
    await addDraft();
    assert.equal(await $(`${CARD} .custom-model-name`).getText(), MODEL.name);
    await snapshot('01-unsaved-model', 'An added model is visible in Settings while the saved model catalog remains unchanged.');
    assert.deepEqual(await persistedModels(), original, 'Add Model escaped the unsaved form');
    await closeSettings();

    await openModels();
    assert.equal(await $(`${CARD} .custom-model-item`).isExisting(), false, 'Cancel retained an unsaved model');
    await snapshot('02-discarded-model', 'Reopening Settings after Cancel does not resurrect the unsaved model.');
    await addDraft();
    await closeSettings(true);
    assert.deepEqual(await persistedModels(), { browser: [MODEL], native: [MODEL] });

    await openModels();
    assert.equal(await $(`${CARD} .custom-model-name`).getText(), MODEL.name);
    await snapshot('03-saved-model', 'Save commits the model to the native settings database and it restores on reopening.');
    await clickSettingsControl(`${CARD} .edit-model-btn`);
    await $(`${CARD} #model-name`).setValue('Discard this rename');
    await clickSettingsControl(`${CARD} .save-model-btn`);
    assert.deepEqual(await persistedModels(), { browser: [MODEL], native: [MODEL] });
    await closeSettings();
    await openModels();
    assert.equal(await $(`${CARD} .custom-model-name`).getText(), MODEL.name);
    await snapshot('04-discarded-rename', 'Cancelling a rename preserves the saved model name.');

    // Inspect each current Settings surface without changing its values. These captures support
    // visual review; their existence is not a claim that every control has been exercised.
    for (const tab of ['api-keys', 'prompts', 'model-management', 'tools', 'cache', 'about']) {
      await clickControl(`[data-settings-tab="${tab}"]`);
      await browser.execute(() => {
        const scroller = document.querySelector('.settings-content');
        if (scroller) scroller.scrollTop = 0;
      });
      await captureWorkflowStep({ workflow: WORKFLOW, step: `surface-${tab}`,
        description: `Current ${tab} Settings surface for visual inspection.`,
        focusSelector: `.settings-tab.active`,
      });
      const scrolled = await browser.execute(() => {
        const panel = document.querySelector('.settings-tab-content.active');
        const candidates = [document.querySelector('.settings-content'), panel,
          ...panel.querySelectorAll('*')];
        const scroller = candidates.filter((node) => node
          && /auto|scroll/.test(getComputedStyle(node).overflowY)
          && node.scrollHeight > node.clientHeight + 20)
          .sort((a, b) => b.clientHeight - a.clientHeight)[0];
        if (!scroller) return false;
        scroller.scrollTop = scroller.scrollHeight;
        return scroller.scrollTop > 0;
      });
      if (scrolled) {
        await captureWorkflowStep({ workflow: WORKFLOW, step: `surface-${tab}-lower`,
          description: `Lower ${tab} Settings controls reached by scrolling the visible panel.`,
          focusSelector: '.settings-tab.active',
        });
      }
    }
    await closeSettings();
  });
});
