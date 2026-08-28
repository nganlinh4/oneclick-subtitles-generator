import { strict as assert } from 'node:assert';

import { clickSettingsControl } from './settingsControls.js';

/* global $, $$, browser, document, localStorage */

/**
 * The customer-visible appearance state and the public footer controls that change it.
 *
 * Shared between the Settings surface journey and the appearance relaunch scenario so both drive
 * the exact same shipped controls and read the exact same stores; a drift between what one journey
 * changes and the other verifies would silently weaken both.
 */

export const appearanceSnapshot = () => browser.execute(() => ({
  theme: localStorage.getItem('theme'),
  documentTheme: document.documentElement.getAttribute('data-theme'),
  font: localStorage.getItem('app_font'),
  primaryFont: document.documentElement.style.getPropertyValue('--font-primary'),
  language: localStorage.getItem('preferred_language'),
  fontLabel: document.querySelector(
    '.settings-footer-controls > .app-font-dropdown > .custom-dropdown-button .dropdown-value',
  )?.textContent?.trim() ?? null,
  languageLabel: document.querySelector(
    '.settings-footer-controls > .custom-dropdown:not(.app-font-dropdown)'
      + ' > .custom-dropdown-button .dropdown-value',
  )?.textContent?.trim() ?? null,
}));

/** Open a public dropdown and commit its first non-selected option through real pointer input. */
export const selectAlternateDropdownOption = async (buttonSelector) => {
  const before = await $(`${buttonSelector} .dropdown-value`).getText();
  // clickSettingsControl (not clickControl): every caller of this helper opens a dropdown that lives
  // inside the Settings modal, where a control near the bottom of a scrolled tab can end up under the
  // sticky settings footer (e2e/support/settingsControls.js).
  await clickSettingsControl(buttonSelector);
  const menu = await $('.custom-dropdown-clipper');
  await menu.waitForDisplayed({ timeout: 10_000, timeoutMsg: `${buttonSelector} did not open` });
  const options = await $$('.custom-dropdown-clipper .dropdown-option:not(.disabled)');
  let optionIndex = -1;
  for (let index = 0; index < options.length; index += 1) {
    if (!(await options[index].getAttribute('class')).includes('selected')) {
      optionIndex = index;
      break;
    }
  }
  assert.ok(optionIndex >= 0, `${buttonSelector} has no alternate public option`);
  const choice = options[optionIndex];
  const selected = await choice.getText();
  await browser.action('pointer')
    .move({ origin: choice })
    .down({ button: 0 })
    .pause(100)
    .up({ button: 0 })
    .perform();
  await browser.waitUntil(async () => (
    (await $(`${buttonSelector} .dropdown-value`).getText()) !== before
  ), {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: `${buttonSelector} did not commit its selected option`,
  });
  await menu.waitForExist({
    reverse: true,
    timeout: 10_000,
    timeoutMsg: `${buttonSelector} left its selection portal open`,
  });
  return { before, selected, optionIndex };
};
