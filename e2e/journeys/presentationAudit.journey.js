// The editor's presentation surfaces in one launch: every model menu shows the same sorted names
// and quotas, and Settings plus generation stay usable after theme, font and language changes,
// in Vietnamese at enlarged and reduced interface scale.

import { strict as assert } from 'node:assert';

import { clickControl } from '../support/editor.js';
import { selectAlternateDropdownOption } from '../support/settingsAppearance.js';
import { clickSettingsControl, revealSettingsSection } from '../support/settingsControls.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

/* global $, $$, browser, describe, it, document, window, getComputedStyle */

const WORKFLOW = 'presentation-audit';
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
  await captureWorkflowStep({ workflow: WORKFLOW, step,
    description: 'Real model menu: sorted names and compact project daily request limits, no descriptions.',
    focusSelector: '.custom-dropdown-clipper', details: { rows } });
};

const closeMenu = async () => {
  await browser.keys('Escape');
  await $('[role="listbox"]').waitForExist({ reverse: true });
};

const languageButton = '.settings-footer-controls > .custom-dropdown:not(.app-font-dropdown) > .custom-dropdown-button';

/**
 * Let finite CSS animations and transitions finish before a screenshot (spinners never finish).
 * The capture is evidence, not a claim, so a slow animation delays it by at most five seconds.
 */
const settleAnimations = () => browser.waitUntil(() => browser.execute(() => document.getAnimations()
  .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
  .every((animation) => animation.playState !== 'running')), {
  timeout: 5_000, interval: 100, timeoutMsg: 'animations still running at capture time',
}).catch(() => false);

async function capture(step, focusSelector) {
  await settleAnimations();
  const geometry = await browser.execute((selector) => {
    const root = document.querySelector(selector);
    const rect = root.getBoundingClientRect();
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    return {
      viewport,
      zoom: getComputedStyle(document.documentElement).zoom,
      paint: ['.settings-modal', '.settings-content', '.settings-tab-content.active', '.about-section', '.app-description'].map(target => {
        const node = document.querySelector(target);
        if (!node) return { target, absent: true };
        const style = getComputedStyle(node);
        return { target, background: style.backgroundColor, color: style.color, fontFamily: style.fontFamily,
          surface: style.getPropertyValue('--md-surface'), mask: style.maskImage,
          animations: node.getAnimations().map(animation => ({ state: animation.playState, frames: animation.effect.getKeyframes() })) };
      }),
      root: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      horizontalOverflow: document.documentElement.scrollWidth - viewport.width,
      overflowingNodes: [...document.querySelectorAll('body *')].map(node => {
        const box = node.getBoundingClientRect();
        return { tag: node.tagName, class: String(node.className).slice(0, 180),
          left: box.left, right: box.right, width: box.width,
          layoutWidth: node.offsetWidth, position: getComputedStyle(node).position };
      }).filter(node => node.right > window.innerWidth + 2 && node.width > 0).slice(0, 30),
      controls: [...root.querySelectorAll('button, input, textarea')].filter(node => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }).map(node => {
        const box = node.getBoundingClientRect();
        return { label: node.getAttribute('aria-label') || node.textContent.trim().slice(0, 70),
          left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }),
      errors: [...document.querySelectorAll('.error-boundary')].map(node => node.textContent),
    };
  }, focusSelector);
  await captureWorkflowStep({ workflow: WORKFLOW, step, focusSelector,
    description: 'Fresh visual audit through real controls at the selected language and interface scale.',
    details: geometry });
  assert.deepEqual(geometry.errors, [], 'the editor crashed during the visual survey');
  return geometry;
}

describe('model pickers and appearance settings in the real editor', () => {
  it('shows sorted model menus, then keeps Settings and generation usable in Vietnamese at any scale', async () => {
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
    await $('.video-processing-modal').waitForExist({ reverse: true });

    await clickControl('[data-app-action="open-settings"]');
    // Repeat the combined theme/font/language transition that looked wrong in
    // the first visual pass, not merely the easier theme-only transition.
    await clickControl('[data-settings-tab="about"]');
    await clickControl('.settings-footer-controls .theme-toggle');
    await selectAlternateDropdownOption('.settings-footer-controls > .app-font-dropdown > .custom-dropdown-button');
    await selectAlternateDropdownOption(languageButton);
    await capture('light-about-after-font-and-language-change', '.settings-modal');
    await clickControl('.settings-footer-controls .theme-toggle');
    await clickControl('.settings-footer-controls > .app-font-dropdown > .custom-dropdown-button');
    await clickControl('[role="option"][data-value="google-sans"]');
    await browser.waitUntil(async () =>
      (await $('.settings-footer-controls > .app-font-dropdown > .custom-dropdown-button').getAttribute('data-value')) === 'google-sans');
    await clickControl(languageButton);
    const options = await $$('[role="option"]');
    for (const option of options) {
      if ((await option.getText()).includes('Tiếng Việt')) { await option.click(); break; }
    }
    await browser.waitUntil(async () => (await $(languageButton).getText()).includes('Tiếng Việt'));
    for (let index = 0; index < 2; index += 1) {
      const before = await $('.app-ui-scale output').getText();
      await clickControl('.settings-footer .app-ui-scale button:last-child');
      await browser.waitUntil(async () => (await $('.app-ui-scale output').getText()) !== before);
    }
    for (const tab of ['api-keys', 'video-processing', 'prompts', 'cache', 'model-management', 'tools', 'about']) {
      await clickControl(`[data-settings-tab="${tab}"]`);
      await browser.waitUntil(() => browser.execute(() => {
        const tab = document.querySelector('.settings-tab.active').getBoundingClientRect();
        const pill = document.querySelector('.settings-tabs .goo-blob').getBoundingClientRect();
        return Math.abs((tab.left + tab.right - pill.left - pill.right) / 2) < 3;
      }), { timeout: 5000, timeoutMsg: 'the selected tab highlight is not centered at enlarged UI scale' });
      await capture(`vi-enlarged-${tab}`, '.settings-modal');
    }
    await clickControl('.settings-footer-controls .theme-toggle');
    await capture('vi-light-about', '.settings-modal');
    await clickControl('[data-settings-action="close"]');
    await $('.settings-modal').waitForExist({ reverse: true });
    await capture('vi-enlarged-editor', '.video-preview');
    await clickControl('[data-osg-action="generate-subtitles"]');
    await clickControl('.subtitle-timeline');
    await browser.keys(['\uE009', 'a', '\uE000']);
    await clickControl('.range-action-bar > button:first-child');
    await clickControl('[data-transcription-method="new"]');
    await capture('vi-enlarged-generation', '.video-processing-modal');
    await clickControl('#generation-model');
    await capture('vi-enlarged-model-menu', '.custom-dropdown-clipper');
    const anchor = await browser.execute(() => {
      const button = document.querySelector('#generation-model').getBoundingClientRect();
      const menu = document.querySelector('.custom-dropdown-clipper').getBoundingClientRect();
      return { buttonLeft: button.left, menuLeft: menu.left, menuRight: menu.right, viewport: window.innerWidth };
    });
    assert.ok(anchor.menuLeft <= anchor.buttonLeft + 3 && anchor.menuRight <= anchor.viewport,
      `enlarged model menu drifted away from its control: ${JSON.stringify(anchor)}`);
    await clickControl('[role="option"][data-value="gemini-3.8-flash"]');
    await browser.waitUntil(async () => (await $('#generation-model').getAttribute('data-value')) === 'gemini-3.8-flash');
    await $('[role="listbox"]').waitForExist({ reverse: true });
    await capture('vi-enlarged-model-selected', '.video-processing-modal');
    await clickControl('#generation-model');
    await browser.keys('Escape');
    await $('[role="listbox"]').waitForExist({ reverse: true });
    assert.equal(await $('.video-processing-modal').isDisplayed(), true);
    await browser.keys('Escape');
    await $('.video-processing-modal').waitForExist({ reverse: true });
    await clickControl('[data-app-action="open-settings"]');
    for (let index = 0; index < 4; index += 1) {
      const before = await $('.app-ui-scale output').getText();
      await clickControl('.settings-footer .app-ui-scale button:first-child');
      await browser.waitUntil(async () => (await $('.app-ui-scale output').getText()) !== before);
    }
    assert.match(await $('.app-ui-scale output').getText(), /80%/);
    await capture('vi-small-settings', '.settings-modal');
    await clickControl('.settings-footer-controls > .app-font-dropdown > .custom-dropdown-button');
    await capture('vi-small-footer-menu', '.custom-dropdown-clipper');
    await browser.keys('Escape');
    await $('[role="listbox"]').waitForExist({ reverse: true });
    await clickControl('[data-settings-action="close"]');
    await $('.settings-modal').waitForExist({ reverse: true });
    await capture('vi-small-editor', '.video-preview');
  });
});
