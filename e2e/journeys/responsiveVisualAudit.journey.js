import { strict as assert } from 'node:assert';
import { clickControl } from '../support/editor.js';
import { openProjectWithMedia, importSubtitles } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

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
      root: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      horizontalOverflow: document.documentElement.scrollWidth - viewport.width,
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
    await clickControl(languageButton);
    const options = await $$('[role="option"]');
    for (const option of options) {
      if ((await option.getText()).includes('Tiếng Việt')) { await option.click(); break; }
    }
    await browser.waitUntil(async () => (await $(languageButton).getText()).includes('Tiếng Việt'));
    for (let index = 0; index < 3; index += 1) {
      const before = await $('.app-ui-scale output').getText();
      await clickControl('.settings-footer .app-ui-scale button:last-child');
      await browser.waitUntil(async () => (await $('.app-ui-scale output').getText()) !== before);
    }
    for (const tab of ['api-keys', 'video-processing', 'prompts', 'cache', 'model-management', 'tools', 'about']) {
      await clickControl(`[data-settings-tab="${tab}"]`);
      await capture(`vi-enlarged-${tab}`, '.settings-modal');
    }
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
    await browser.keys('Escape');
    assert.equal(await $('.video-processing-modal').isDisplayed(), true);
    await browser.keys('Escape');
  });
});
