import { strict as assert } from 'node:assert';

/* global $, $$, browser, document */

/**
 * Drive the public local-ASR "Splitting method" CustomDropdown (AsrProcessingOptions.js) without a
 * stable per-instance id: the panel can also render a forced-language CustomDropdown alongside it,
 * so a bare `.custom-dropdown-button` selector is ambiguous. The dropdown is found by its own
 * `.combined-option-half` label text instead, tagged, then driven through the exact pointer
 * down/up contract CustomDropdown commits on (renderQueue.js's `chooseRenderSetting` proves the
 * same contract for the render-settings dropdowns; the option portal does not respond to a
 * synthetic `change` event).
 */

const STRATEGY_LABELS = Object.freeze({
  sentence: 'Split by sentence',
  word: 'Split by word count',
  char: 'Split by approximate character count',
});

const SPLITTING_METHOD_LABEL = 'Splitting method';
const MARKER = 'data-e2e-asr-strategy-dropdown';

const tagStrategyDropdownButton = () => browser.execute((label, marker) => {
  for (const stale of document.querySelectorAll(`[${marker}]`)) stale.removeAttribute(marker);
  const halves = [...document.querySelectorAll('.asr-options-grid .combined-option-half')];
  const half = halves.find((node) => (node.querySelector('label')?.textContent || '').trim() === label);
  const button = half?.querySelector('.custom-dropdown-button') ?? null;
  if (button === null) return false;
  button.setAttribute(marker, '1');
  return true;
}, SPLITTING_METHOD_LABEL, MARKER);

/** Choose the ASR splitting strategy through the real dropdown and wait for it to commit. */
export const selectAsrStrategy = async (strategy) => {
  const label = STRATEGY_LABELS[strategy];
  assert.ok(label, `unknown ASR strategy: ${strategy}`);
  const tagged = await tagStrategyDropdownButton();
  assert.equal(tagged, true, 'the ASR splitting-method dropdown was not found in the processing options');

  const button = await $(`[${MARKER}]`);
  await button.waitForClickable({
    timeout: 30_000,
    timeoutMsg: 'the ASR splitting-method dropdown never became clickable',
  });
  await button.click();
  const menu = await $('.custom-dropdown-clipper');
  await menu.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: 'the ASR splitting-method dropdown never opened its option list',
  });
  const options = await $$('.custom-dropdown-clipper .dropdown-option');
  let match = null;
  for (const option of options) {
    // eslint-disable-next-line no-await-in-loop -- a bounded, small, ordered menu list.
    const text = (await option.getText()).trim();
    if (text === label) {
      match = option;
      break;
    }
  }
  assert.ok(match, `the ASR splitting-method dropdown never offered "${label}"`);
  await match.waitForClickable({
    timeout: 30_000,
    timeoutMsg: `the "${label}" splitting-method option never became clickable`,
  });
  // CustomDropdown commits on its public pointer down/up contract, not on a synthetic change.
  await browser.action('pointer')
    .move({ origin: match })
    .down({ button: 0 })
    .pause(75)
    .up({ button: 0 })
    .perform();
  const value = await button.$('.dropdown-value');
  await browser.waitUntil(async () => (
    (await value.getText()).trim() === label
  ), {
    timeout: 30_000,
    interval: 50,
    timeoutMsg: `the ASR splitting-method dropdown never selected "${label}"`,
  });
  await menu.waitForExist({
    reverse: true,
    timeout: 30_000,
    interval: 50,
    timeoutMsg: 'the ASR splitting-method dropdown left its old option portal mounted',
  });
  await browser.execute((marker) => {
    document.querySelector(`[${marker}]`)?.removeAttribute(marker);
  }, MARKER);
  return label;
};
