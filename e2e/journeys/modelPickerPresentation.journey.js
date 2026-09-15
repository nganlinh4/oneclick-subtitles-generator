import { strict as assert } from 'node:assert';
import { clickControl } from '../support/editor.js';
import { clickSettingsControl, revealSettingsSection } from '../support/settingsControls.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

/* global $, browser, describe, document, it */

const EXPECTED = ['Gemini 3.8 Flash', 'Gemini 3.7 Flash', 'Gemini 3.6 Flash',
  'Gemini 3.5 Flash', 'Gemini 3.5 Flash Lite', 'Gemini 3.1 Flash Lite',
  'Gemini 3 Flash Preview', 'Gemini Robotics ER 2 Preview'];

const inspectMenu = async (step, expected = EXPECTED) => {
  await $('.custom-dropdown-clipper.is-open [role="listbox"]').waitForDisplayed();
  await browser.waitUntil(() => browser.execute(() =>
    document.querySelector('.custom-dropdown-clipper').getAnimations({ subtree: true })
      .every(animation => animation.playState !== 'running')));
  const rows = await browser.execute(() => [...document.querySelectorAll('[role="listbox"] [role="option"]')].map(option => {
    const label = option.querySelector('.dropdown-option-label');
    const detail = option.querySelector('.dropdown-option-detail');
    return { label: label?.textContent, quota: detail?.textContent, title: detail?.title,
      clipped: label.scrollWidth > label.clientWidth + 1 || detail.scrollWidth > detail.clientWidth + 1,
      overlaps: label.getBoundingClientRect().right > detail.getBoundingClientRect().left + 1 };
  }));
  assert.deepEqual(rows.map(row => row.label), expected, 'the model names must retain numeric order');
  assert.deepEqual(rows.map(row => row.quota), ['20 requests/day', '20 requests/day', '20 requests/day',
    '20 requests/day', '500 requests/day', '500 requests/day', '20 requests/day', '20 requests/day'].slice(0, expected.length));
  assert.ok(rows.every(row => !row.clipped && !row.overlaps && row.title.includes('Free-tier')),
    `model names and project quota references must fit without overlap: ${JSON.stringify(rows)}`);
  assert.equal(await $('.model-options-dropdown').isExisting(), false, 'the retired menu is still mounted');
  await captureWorkflowStep({ workflow: 'model-picker-presentation', step,
    description: 'Real model menu: sorted names and compact project daily request limits, no descriptions.',
    focusSelector: '.custom-dropdown-clipper', details: { rows } });
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
    // Robotics has no configurable thinking control in the shipping catalog.
    await inspectMenu('03-thinking-models', EXPECTED.slice(0, -1));
    await closeMenu();
    assert.equal(await $('.settings-modal').isDisplayed(), true,
      'dismissing the model menu must not also close Settings');
    await clickControl('[data-settings-action="close"]');

    await clickControl('[data-osg-action="generate-subtitles"]');
    await clickControl('.subtitle-timeline');
    await browser.keys(['\uE009', 'a', '\uE000']);
    await clickControl('.range-action-bar > button:first-child');
    await clickControl('[data-transcription-method="new"]');
    await clickControl('#generation-model');
    await inspectMenu('04-generation-models');
    await closeMenu();
    assert.equal(await $('.video-processing-modal').isDisplayed(), true);
    await browser.keys('Escape');
  });
});
