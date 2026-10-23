// Public Render customization controls: ranges, dropdowns, text fields and the system font.
/* global $, $$, browser, document */

import { strict as assert } from 'node:assert';

import { clickControl } from '../../../support/editor.js';
import { actuateNativeRange } from '../../../support/nativeRange.js';
import { verifyExactWeightDropdown } from '../../../support/subtitleCustomizationPresetOracle.js';
import { SYSTEM_FONT } from './constants.js';
import { waitForReadyChange, waitUntilWithFreshDiagnostic } from './previewState.js';

export const setPublicRange = async (selector, value) => {
  const input = await $(selector);
  await input.waitForExist({ timeout: 30_000, timeoutMsg: `slider is absent: ${selector}` });
  assert.match(selector, /^#[A-Za-z][\w-]*$/u, `range control needs one stable ID: ${selector}`);
  const track = await $(`//*[@id="${selector.slice(1)}"]/parent::*`
    + '[contains(concat(" ", normalize-space(@class), " "), " standard-slider-track-container ")]');
  await track.waitForExist({ timeout: 30_000, timeoutMsg: `slider track is absent: ${selector}` });
  await track.scrollIntoView({ block: 'center', inline: 'center' });
  const [minimum, maximum, step, current, width] = await Promise.all([
    input.getAttribute('min').then(Number),
    input.getAttribute('max').then(Number),
    input.getAttribute('step').then(Number),
    input.getValue().then(Number),
    track.getSize('width'),
  ]);
  assert.ok([minimum, maximum, step, current, width, value].every(Number.isFinite), (
    `slider geometry is invalid for ${selector}`
  ));
  assert.ok(maximum > minimum && step > 0 && width >= 40, `slider is not actionable: ${selector}`);
  assert.ok(value >= minimum && value <= maximum, `${value} is outside ${selector}'s public range`);
  assert.ok(current >= minimum && current <= maximum, `current value is outside ${selector}'s range`);
  await actuateNativeRange({ driver: browser, selector, value, label: selector });
  let observed = null;
  await waitUntilWithFreshDiagnostic(async () => {
    observed = await input.getValue();
    return String(observed) === String(value);
  }, {
    timeout: 5_000,
    interval: 50,
    diagnostic: () => `${selector} public drag requested ${value} but reached ${observed}`,
  });
};

export const usePublicDropdown = async ({
  selector,
  expectedValues,
  selectValue = null,
  context,
}) => {
  assert.match(selector, /^#[A-Za-z][\w-]*$/u, `dropdown needs one stable ID: ${selector}`);
  assert.ok(Array.isArray(expectedValues) && expectedValues.length > 0, (
    `${context}: exact dropdown values are required`
  ));
  const values = expectedValues.map(String);
  const button = await $(selector);
  await button.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${context}: dropdown is absent` });
  await button.scrollIntoView({ block: 'center', inline: 'center' });
  const beforeValue = await button.getAttribute('data-value');
  const enabled = await button.isEnabled();
  if (values.length === 1) {
    assert.equal(enabled, false, `${context}: a one-choice dropdown should be non-interactive`);
    assert.equal(String(beforeValue), values[0], `${context}: the sole exact value is not selected`);
    assert.equal(await button.getAttribute('aria-expanded'), 'false', (
      `${context}: the one-choice dropdown claimed to be expanded`
    ));
    const exact = verifyExactWeightDropdown({
      expectedValues,
      currentValue: beforeValue,
      options: [{ label: (await button.getText()).trim(), selected: true, disabled: false }],
      context,
    });
    return Object.freeze({ ...exact, afterValue: String(beforeValue), controlDisabled: true });
  }
  assert.equal(enabled, true, `${context}: a multi-choice dropdown is disabled`);
  await button.waitForClickable({ timeout: 30_000, timeoutMsg: `${context}: dropdown is not clickable` });
  await button.click();
  const listbox = await $(`${selector}-listbox`);
  await listbox.waitForDisplayed({ timeout: 5_000, timeoutMsg: `${context}: listbox did not open` });
  const options = await $$(`${selector}-listbox [role="option"]`);
  // WebdriverIO's embedded ElementArray is indexable but its `.map()` is an async collection
  // command, not Array.prototype.map; wrapping that returned promise in Promise.all is invalid.
  // Materialize each public option explicitly so no lazy collection semantics are mistaken for a
  // JavaScript array and every advertised weight is still inspected.
  const observedOptions = [];
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    observedOptions.push({
      label: (await option.getText()).trim(),
      selected: (await option.getAttribute('aria-selected')) === 'true',
      disabled: (await option.getAttribute('disabled')) !== null,
    });
  }
  const exact = verifyExactWeightDropdown({
    expectedValues,
    currentValue: beforeValue,
    options: observedOptions,
    context,
  });

  if (selectValue === null) {
    await button.click();
    await listbox.waitForDisplayed({
      reverse: true,
      timeout: 5_000,
      timeoutMsg: `${context}: listbox did not close`,
    });
    return exact;
  }

  const targetValue = String(selectValue);
  const targetIndex = values.indexOf(targetValue);
  assert.ok(targetIndex >= 0, `${context}: ${targetValue} is not an exact dropdown option`);
  await options[targetIndex].click();
  let afterValue = null;
  await waitUntilWithFreshDiagnostic(async () => {
    afterValue = await button.getAttribute('data-value');
    return String(afterValue) === targetValue
      && (await button.getAttribute('aria-expanded')) === 'false';
  }, {
    timeout: 5_000,
    interval: 50,
    diagnostic: () => `${context}: public option ${targetValue} did not commit; reached ${afterValue}`,
  });
  return Object.freeze({ ...exact, afterValue: String(afterValue) });
};

const setPublicText = async (selector, value) => {
  const input = await $(selector);
  await input.scrollIntoView({ block: 'center', inline: 'center' });
  await input.waitForClickable({ timeout: 30_000, timeoutMsg: `text input is unavailable: ${selector}` });
  // The embedded provider's `setValue` can mutate a controlled input's DOM value without emitting
  // the React input sequence, and its Ctrl+A chord is not reliable inside this scroll container.
  // Clear the focused field, then type through a deliberately invalid `#` draft before completing
  // the value. The aria transition proves React—not merely the DOM property—received the typing.
  await input.click();
  assert.equal(
    await browser.execute(target => document.activeElement === document.querySelector(target), selector),
    true,
    `${selector} did not own keyboard focus`,
  );
  await input.clearValue();
  const typed = String(value);
  assert.ok(typed.startsWith('#') && typed.length > 1, `${selector} needs a complete hex colour`);
  await browser.keys('#');
  await browser.waitUntil(async () => (
    (await input.getValue()) === '#'
      && (await input.getAttribute('aria-invalid')) === 'true'
  ), {
    timeout: 5_000,
    interval: 50,
    timeoutMsg: `${selector} did not publish its invalid intermediate draft to React`,
  });
  await browser.keys(typed.slice(1));
  await browser.waitUntil(async () => (
    (await input.getValue()) === typed
      && (await input.getAttribute('aria-invalid')) === 'false'
  ), {
    timeout: 5_000,
    interval: 50,
    timeoutMsg: `${selector} did not publish its complete draft to React`,
  });
  // The embedded provider suppresses keyboard focus traversal for this non-focusable HWND, and a
  // pointer click on a non-focusable row label is allowed to leave the input focused. Enter is a
  // first-class public commit path of ColorControl: its real key handler blurs, and blur publishes
  // exactly one validated value. This exercises the same React boundary without a DOM shortcut.
  await browser.keys('Enter');
  let observed = null;
  let focused = true;
  await waitUntilWithFreshDiagnostic(async () => {
    ({ observed, focused } = await browser.execute((target) => {
      const node = document.querySelector(target);
      return {
        observed: node?.value ?? null,
        focused: document.activeElement === node,
      };
    }, selector));
    return observed === String(value) && focused === false;
  }, {
    timeout: 5_000,
    interval: 50,
    diagnostic: () => `${selector} public typing requested ${value} but reached ${JSON.stringify({ observed, focused })}`,
  });
};

export const setControlAndWait = async ({
  state,
  selector,
  value,
  read,
  label,
  kind = 'range',
  expectedValues,
}) => {
  if (kind === 'text') await setPublicText(selector, value);
  else if (kind === 'dropdown') {
    await usePublicDropdown({
      selector,
      expectedValues,
      selectValue: value,
      context: label,
    });
  }
  else await setPublicRange(selector, value);
  return waitForReadyChange(state, label, (next) => String(read(next)) === String(value));
};

export const selectSystemFont = async (before) => {
  await clickControl('.font-selector-button');
  const modal = await $('.font-modal');
  await modal.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the public font picker did not open' });
  const search = await $('.font-search-input');
  await search.waitForDisplayed({ timeout: 10_000 });
  await search.setValue(SYSTEM_FONT);
  const card = await $(`//div[contains(@class,"font-card")][.//span[normalize-space()="${SYSTEM_FONT}"]]`);
  await card.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${SYSTEM_FONT} is absent from the font picker` });
  await card.scrollIntoView();
  await card.waitForClickable({ timeout: 30_000, timeoutMsg: `${SYSTEM_FONT} is not selectable` });
  return { card, modal, before };
};
