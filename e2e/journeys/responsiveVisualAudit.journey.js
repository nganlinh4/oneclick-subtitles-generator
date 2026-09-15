import { strict as assert } from 'node:assert';
import { clickControl } from '../support/editor.js';
import { openProjectWithMedia, importSubtitles } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';
import { selectAlternateDropdownOption } from '../support/settingsAppearance.js';

/* global $, $$, browser, describe, it, document, window, getComputedStyle */

const WORKFLOW = 'responsive-visual-audit';
const languageButton = '.settings-footer-controls > .custom-dropdown:not(.app-font-dropdown) > .custom-dropdown-button';

async function capture(step, focusSelector) {
  await browser.pause(500);
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

describe('visual survey across real appearance settings', () => {
  it('keeps Settings and generation usable in Vietnamese at enlarged scale', async () => {
    await openProjectWithMedia();
    await importSubtitles();
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
    await browser.pause(1500);
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
    assert.equal(await $('.video-processing-modal').isDisplayed(), true);
    await browser.keys('Escape');
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
    await clickControl('[data-settings-action="close"]');
    await $('.settings-modal').waitForExist({ reverse: true });
    await capture('vi-small-editor', '.video-preview');
  });
});
