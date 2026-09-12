import { strict as assert } from 'node:assert';
import { clickControl } from '../support/editor.js';
import { clickSettingsControl, revealSettingsSection } from '../support/settingsControls.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

/* global $, $$, browser, describe, document, it */

const EXPECTED = ['Gemini 3.8 Flash', 'Gemini 3.7 Flash', 'Gemini 3.6 Flash',
  'Gemini 3.5 Flash', 'Gemini 3.5 Flash Lite', 'Gemini 3.1 Flash Lite'];

const inspectMenu = async (step) => {
  await $('.custom-dropdown-clipper.is-open [role="listbox"]').waitForDisplayed();
  const labels = await $$('[role="listbox"] [role="option"]').map(option => option.getText());
  assert.deepEqual(labels, EXPECTED, 'the visible model rows must contain only names in numeric order');
  assert.equal(await $('.model-options-dropdown').isExisting(), false, 'the retired menu is still mounted');
  await captureWorkflowStep({ workflow: 'model-picker-presentation', step,
    description: 'Real model menu: shared dropdown, numeric order, names only.',
    focusSelector: '.custom-dropdown-clipper', details: { labels } });
};

const closeMenu = async () => {
  await browser.keys('Escape');
  await $('[role="listbox"]').waitForExist({ reverse: true });
};

describe('consistent model pickers in the real editor', () => {
  it('shows sorted names and commits a translation choice using the shared dropdown', async () => {
    await openProjectWithMedia();
    await importSubtitles();
    const translation = '.translate-model-dropdown .custom-dropdown-button';
    const original = await $(translation).getAttribute('data-value');
    await clickControl(translation);
    await inspectMenu('01-translation-models');
    await clickControl('[role="option"][data-value="gemini-3.8-flash"]');
    await browser.waitUntil(async () => (await $(translation).getAttribute('data-value')) === 'gemini-3.8-flash');
    await $('[role="listbox"]').waitForExist({ reverse: true });
    await clickControl(translation);
    await clickControl(`[role="option"][data-value="${original}"]`);
    await $('[role="listbox"]').waitForExist({ reverse: true });

    await clickControl('.download-btn-primary');
    await $('.download-options-modal').waitForDisplayed();
    const processTab = await $$('.download-tabs .tab-btn').find(async button =>
      (await button.getText()).includes('Process Text'));
    assert.ok(processTab, 'the real Process Text tab must exist');
    await processTab.click();
    await clickControl('.modal-model-dropdown .custom-dropdown-button');
    await inspectMenu('02-document-models');
    await closeMenu();
    await browser.keys('Escape');
    await $('.download-options-modal').waitForExist({ reverse: true });

    await clickControl('[data-app-action="open-settings"]');
    await clickControl('[data-settings-tab="video-processing"]');
    await revealSettingsSection('.thinking-card');
    await clickSettingsControl('.thinking-card .custom-dropdown-button');
    await inspectMenu('03-thinking-models');
    await closeMenu();
    assert.equal(await $('.settings-modal').isDisplayed(), true,
      'dismissing the model menu must not also close Settings');
    await clickControl('[data-settings-action="close"]');
  });
});
