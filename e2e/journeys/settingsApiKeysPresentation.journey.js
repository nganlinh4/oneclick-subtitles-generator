import { strict as assert } from 'node:assert';

import { clickControl, openEditor } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

/* global $, $$, browser, describe, document, it */

const openKeys = async () => {
  await clickControl('[data-app-action="open-settings"]');
  await clickControl('[data-settings-tab="api-keys"]');
  await $('.gemini-key-header').waitForDisplayed({ timeout: 15_000 });
};

const closeSettings = async () => {
  await clickControl('[data-settings-action="close"]');
  await $('.settings-modal').waitForExist({ reverse: true, timeout: 15_000 });
};

const inspectHeader = async (step, expectedKeys) => {
  const state = await browser.execute(() => {
    const header = document.querySelector('.gemini-key-header');
    const label = header.querySelector('label');
    const usage = header.querySelector('.gemini-usage-link');
    const box = (element) => {
      const { x, y, width, height, right } = element.getBoundingClientRect();
      return { x, y, width, height, right };
    };
    return {
      label: label.textContent.trim(), usage: usage.textContent.trim(),
      href: usage.getAttribute('href'),
      headingBox: box(label), usageBox: box(usage),
      keyCount: document.querySelectorAll('.gemini-key-item').length,
      inputEmpty: document.querySelector('#new-gemini-key-input').value === '',
      announcement: Boolean(document.querySelector(
        '.gemini-paused-message, .notification-messages-container, .notification-placeholder',
      )),
    };
  });
  assert.equal(state.keyCount, expectedKeys);
  assert.equal(state.inputEmpty, true, 'never capture an entered secret');
  assert.equal(state.announcement, false);
  assert.equal(state.href, 'https://aistudio.google.com/usage?timeRange=last-1-day&tab=rate-limit');
  assert.ok(state.usageBox.x >= state.headingBox.right, 'usage must sit right of the heading');
  assert.ok(Math.abs((state.headingBox.y + state.headingBox.height / 2)
    - (state.usageBox.y + state.usageBox.height / 2)) < 2, 'header items must share a row');
  assert.ok(state.usageBox.height <= 36, 'usage must remain a compact action');
  await captureWorkflowStep({
    workflow: 'settings-api-keys-presentation', step,
    description: 'Compact usage action beside the API-key heading; no announcement area.',
    focusSelector: '.gemini-key-header', details: state,
  });
};

describe('API key header presentation', () => {
  it('keeps usage beside the heading with empty and populated keys, including Vietnamese', async () => {
    await openEditor();
    await openKeys();
    await inspectHeader('01-empty-header', 0);
    await closeSettings();
    await enrollGeminiCredentials({ limit: 1 });
    await openKeys();
    await inspectHeader('02-one-key-header', 1);

    await clickControl('.settings-footer-controls > .custom-dropdown:not(.app-font-dropdown)'
      + ' > .custom-dropdown-button');
    await $('.custom-dropdown-clipper').waitForDisplayed({ timeout: 10_000 });
    const options = await $$('.custom-dropdown-clipper .dropdown-option');
    let vietnamese = null;
    for (const option of options) {
      if ((await option.getText()).includes('Tiếng Việt')) vietnamese = option;
    }
    assert.ok(vietnamese, 'Vietnamese is offered by the public language control');
    await vietnamese.click();
    await browser.waitUntil(async () => (await $('.gemini-usage-link').getText())
      .includes('Mức dùng API Gemini'), { timeout: 10_000 });
    await inspectHeader('03-vietnamese-one-key', 1);
    await closeSettings();
  });
});
