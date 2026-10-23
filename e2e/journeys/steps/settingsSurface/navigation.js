// Public Settings navigation for the Settings surface journey: tabs, controls and diagnostics.
/* global $, browser, document, getComputedStyle, MutationObserver, performance, window */

import { strict as assert } from 'node:assert';

import { clickControl } from '../../../support/editor.js';
import { waitForSettingsPaintStable } from './waits.js';

export const assertSettingsArrowIsolation = async (selector) => {
  const before = await browser.execute((target) => {
    const control = document.querySelector(target);
    const video = document.querySelector('.video-preview video.video-player');
    if (control === null || video === null) return null;
    window.__OSG_E2E_SETTINGS_ARROW__ = null;
    control.addEventListener('keydown', (event) => {
      window.__OSG_E2E_SETTINGS_ARROW__ = {
        code: event.code,
        key: event.key,
        ownedByControl: event.target === control || control.contains(event.target),
      };
    }, { once: true });
    control.focus();
    return { currentTime: video.currentTime, focused: document.activeElement === control };
  }, selector);
  assert.equal(before?.focused, true, 'the Settings control could not own keyboard focus');
  await browser.keys('\uE014');
  let after = null;
  await browser.waitUntil(async () => {
    after = await browser.execute((target) => {
      const control = document.querySelector(target);
      const video = document.querySelector('.video-preview video.video-player');
      return {
        event: window.__OSG_E2E_SETTINGS_ARROW__ ?? null,
        currentTime: video?.currentTime ?? null,
        focused: document.activeElement === control,
      };
    }, selector);
    return after.event !== null;
  }, {
    timeout: 5_000,
    interval: 50,
    timeoutMsg: 'ArrowRight never reached the focused Settings control',
  });
  assert.equal(after.event.ownedByControl, true, 'ArrowRight escaped its Settings control');
  assert.equal(after.event.code, 'ArrowRight');
  assert.equal(after.focused, true, 'ArrowRight moved focus out of the Settings control');
  assert.ok(
    Math.abs(after.currentTime - before.currentTime) < 0.001,
    `Settings ArrowRight sought the background video: ${JSON.stringify({ before, after })}`,
  );
};

export const TAB_SURFACES = Object.freeze([
  {
    tab: 'api-keys', step: '01-api-keys', root: '.api-key-section', minimumControls: 3,
    required: ['.gemini-column', '#genius-key-input'],
    claim: 'Credential forms render without exposing or changing a secret.',
  },
  {
    tab: 'video-processing', step: '02-video-processing', root: '.video-processing-section', minimumControls: 8,
    required: [
      '#show-waveform-long-videos',
      '.compact-setting:has(label[for="time-format"]) .custom-dropdown-button',
      '#auto-import-site-subtitles',
    ],
    claim: 'Processing, display, and download preferences are reachable.',
  },
  {
    tab: 'prompts', step: '03-prompts', root: '.prompts-section', minimumControls: 3,
    required: ['#transcription-prompt', '.reset-prompt-btn'],
    claim: 'Prompt presets and the editable transcription prompt are reachable.',
  },
  {
    tab: 'cache', step: '04-cache', root: '.cache-section', minimumControls: 2,
    required: ['.clear-cache-btn', '.refresh-cache-btn'],
    claim: 'The cache surface reports the native rebuildable-only inventory.',
  },
  {
    tab: 'model-management', step: '05-narration-models', root: '.narration-model-panel', minimumControls: 2,
    required: ['[data-model-package-id]', '[data-model-action="install"], .download-model-btn'],
    claim: 'The catalog-managed runtime and language models report explicit states and actions.',
  },
  {
    tab: 'tools', step: '06-tools', root: '.engines-panel', minimumControls: 1,
    required: ['[data-engine-id]', '[data-native-tool-id]'],
    claim: 'Native tools and local engines report their actual installed states.',
  },
  {
    tab: 'about', step: '07-about', root: '.about-section', minimumControls: 1,
    required: ['.version-info', '.replay-onboarding-button'],
    claim: 'Version, update status, and support links render without opening an external target.',
  },
]);

export const settingsDiagnostic = () => browser.execute(() => ({
  modalPresent: document.querySelector('.settings-modal') !== null,
  activeTab: document.querySelector('.settings-tab.active')?.getAttribute('data-settings-tab') ?? null,
  errors: window.__OSG_E2E_SETTINGS_ERRORS__ ?? [],
  lifecycle: (window.__OSG_E2E_SETTINGS_LIFECYCLE__ ?? []).slice(-80),
  settingsResources: performance.getEntriesByType('resource')
    .map((entry) => ({ name: entry.name, duration: entry.duration, transferSize: entry.transferSize }))
    .filter(({ name }) => /SettingsModal|settings/i.test(name))
    .slice(-20),
}));

export const installBrowserDiagnostics = () => browser.execute(() => {
  window.__OSG_E2E_SETTINGS_ERRORS__ = [];
  window.__OSG_E2E_SETTINGS_LIFECYCLE__ = [];
  const record = (kind, detail = '') => {
    window.__OSG_E2E_SETTINGS_LIFECYCLE__.push({ kind, detail, at: performance.now() });
  };
  window.addEventListener('error', (event) => {
    window.__OSG_E2E_SETTINGS_ERRORS__.push(`error:${event.message}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    window.__OSG_E2E_SETTINGS_ERRORS__.push(`rejection:${String(event.reason)}`);
  });
  const observer = new MutationObserver(() => {
    const modal = document.querySelector('.settings-modal');
    const current = modal === null ? 'absent' : `present:${modal.className}`;
    if (window.__OSG_E2E_SETTINGS_LAST__ !== current) {
      window.__OSG_E2E_SETTINGS_LAST__ = current;
      record('modal', current);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  window.__OSG_E2E_SETTINGS_OBSERVER__ = observer;
});

export const openSettings = async () => {
  await clickControl('[data-app-action="open-settings"]');
  const modal = await $('.settings-modal');
  const opened = await modal.waitForDisplayed({ timeout: 30_000 }).catch(() => false);
  assert.equal(opened, true, `Settings did not open: ${JSON.stringify(await settingsDiagnostic())}`);
};

export const activateTab = async (tab) => {
  const selector = `[data-settings-tab="${tab}"]`;
  await clickControl(selector);
  await browser.waitUntil(async () => (await $(selector).getAttribute('class')).includes('active'), {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: `Settings tab did not activate: ${tab}`,
  });
  if (tab === 'cache') {
    await browser.waitUntil(async () => (
      (await $('.cache-section').getAttribute('data-cache-state')) !== 'checking'
    ), {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: 'Cache inventory never settled before its screenshot',
    });
  }
  if (tab === 'model-management') {
    await browser.waitUntil(async () => (
      (await $('.narration-model-panel').getAttribute('data-model-package-state')) !== 'checking'
    ), {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: 'Narration model status never settled before its screenshot',
    });
  }
  if (tab === 'tools') {
    // The first status probe per process deliberately hashes the COMPLETE published engine tree
    // before reporting anything installed (verify-once, then cached) — tens of seconds at the
    // measured disk rate. A ten-minute 'checking' therefore means a stalled probe, not a slow
    // hash; name which inventory is stuck so the failure carries its own diagnosis.
    let asr = null;
    let speech = null;
    try {
      await browser.waitUntil(async () => {
        const panel = await $('.engines-panel');
        asr = await panel.getAttribute('data-asr-package-status');
        speech = await panel.getAttribute('data-speech-package-status');
        return asr !== 'checking' && speech !== 'checking';
      }, {
        timeout: 600_000,
        interval: 250,
        timeoutMsg: 'native tool inventory settle timeout',
      });
    } catch (error) {
      throw new Error(
        `Native tool inventories never settled before their screenshot: asr=${asr} speech=${speech}`,
        { cause: error },
      );
    }
  }
  await waitForSettingsPaintStable();
};

export const activeControlMap = (rootSelector, requiredSelectors) => browser.execute((
  expectedRoot,
  expectedSelectors,
) => {
  const active = document.querySelector('.settings-tab-content.active');
  const root = active?.querySelector(expectedRoot) ?? null;
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
      && rect.width > 0 && rect.height > 0;
  };
  const controls = root === null ? [] : [...root.querySelectorAll(
    'button, input, textarea, select, md-switch, [role="button"], [role="slider"]',
  )].filter(visible);
  return {
    activePanels: document.querySelectorAll('.settings-tab-content.active').length,
    rootPresent: root !== null,
    controls: controls.length,
    buttons: controls.filter((node) => node.matches('button, [role="button"]')).length,
    fields: controls.filter((node) => node.matches('input, textarea, select')).length,
    switches: controls.filter((node) => node.matches('md-switch')).length,
    stableActions: controls.map((node) => (
      node.getAttribute('data-tool-action')
      ?? node.getAttribute('data-cache-category')
      ?? node.id
      ?? null
    )).filter(Boolean).slice(0, 40),
    required: Object.fromEntries(expectedSelectors.map((selector) => [
      selector,
      Boolean(root?.querySelector(selector)),
    ])),
    externalLinks: root === null ? 0 : root.querySelectorAll('a[target="_blank"]').length,
  };
}, rootSelector, requiredSelectors);

export const switchSelected = (selector) => browser.execute(
  (target) => document.querySelector(target)?.selected ?? null,
  selector,
);
