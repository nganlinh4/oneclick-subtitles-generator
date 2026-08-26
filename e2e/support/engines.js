import { clickControl } from './editor.js';

/* global $, browser, CSS, document, window */

const ENGINE_TIMEOUT_MS = 7_200_000;

const engineState = async (id) => browser.execute((engineId) => {
  const card = document.querySelector(`[data-engine-id="${CSS.escape(engineId)}"]`);
  if (card === null) return null;
  return {
    state: card.getAttribute('data-engine-state'),
    text: (card.innerText || '').trim().slice(0, 2_000),
  };
}, id);

const waitForEngineState = async (id, predicate, {
  timeout,
  interval,
  timeoutMessage,
}) => {
  let state = null;
  try {
    await browser.waitUntil(async () => {
      state = await engineState(id);
      return predicate(state);
    }, {
      timeout,
      interval,
      // WebdriverIO 9.20 requires a string here. The catch below reads the state again so the
      // thrown diagnostic is still fresh rather than freezing the first/previous observation.
      timeoutMsg: `${id} engine state did not settle`,
    });
  } catch (error) {
    state = await engineState(id);
    throw new Error(timeoutMessage(state), { cause: error });
  }
  return state;
};

/**
 * Reach the real Tools screen and make one published engine runnable.
 *
 * Installation, digest verification, extraction and process warm-up are all product operations.
 * Only the persistent package directory is shared between disposable profiles, matching a customer
 * who installs the multi-gigabyte engine once and then creates many projects.
 */
export const ensureEngineReady = async (id, {
  allowInstall = true,
  onReady = async () => {},
} = {}) => {
  await browser.execute(() => {
    window.__OSG_E2E_SETTINGS_ERRORS__ = [];
    window.addEventListener('error', (event) => {
      window.__OSG_E2E_SETTINGS_ERRORS__.push(`error:${event.message}`);
    }, { once: true });
    window.addEventListener('unhandledrejection', (event) => {
      window.__OSG_E2E_SETTINGS_ERRORS__.push(`rejection:${String(event.reason)}`);
    }, { once: true });
  });
  await clickControl('[data-app-action="open-settings"]');
  const toolsTab = await $('[data-settings-tab="tools"]');
  if (!(await toolsTab.waitForExist({ timeout: 5_000 }).catch(() => false))) {
    // WebDriver's synthesized click is occasionally acknowledged without dispatching through the
    // WebView. Engine preparation is setup for the journey, so retry once through the DOM's real
    // click method; the product handler, lazy settings chunk and all native commands remain real.
    const dispatched = await browser.execute(() => {
      const control = document.querySelector('[data-app-action="open-settings"]');
      if (control === null) return false;
      control.click();
      return true;
    });
    if (!dispatched) throw new Error('the Settings control disappeared during engine preparation');
  }
  const opened = await toolsTab.waitForExist({ timeout: 20_000 }).catch(() => false);
  if (!opened) {
    const state = await browser.execute(() => ({
      errors: window.__OSG_E2E_SETTINGS_ERRORS__,
      modalPresent: document.querySelector('.settings-modal') !== null,
      bodyTail: (document.body?.innerText || '').trim().slice(-2_000),
    }));
    throw new Error(`Settings handler did not produce its modal: ${JSON.stringify(state)}`);
  }
  await clickControl('[data-settings-tab="tools"]');

  const selector = `[data-engine-id="${id}"]`;
  const card = await $(selector);
  await card.waitForDisplayed({ timeout: 60_000, timeoutMsg: `${id} never appeared in Tools` });

  let last = await waitForEngineState(id, state => (
    state !== null && !['checking', 'status-error'].includes(state.state)
  ), {
    // A first status probe intentionally verifies every byte of an existing managed package.
    // The shared Faster Whisper install is about 7.2 GB, so slow disks can legitimately take
    // several minutes. This remains bounded and the screenshot/log evidence names the state.
    timeout: 1_200_000,
    interval: 1_000,
    timeoutMessage: state => `${id} package status never settled: ${JSON.stringify(state)}`,
  });

  if (['not-installed', 'update-available', 'corrupt'].includes(last.state)) {
    if (!allowInstall) {
      throw new Error(
        `${id} is not already installed (${last.state}); this journey forbids network installation. `
        + 'Run the independently owned native-engine installation coverage first.',
      );
    }
    await clickControl(`${selector} .engine-card__btn`);
    last = await waitForEngineState(id, state => (
      state?.state === 'installed-stopped' || state?.state === 'ready'
    ), {
      timeout: ENGINE_TIMEOUT_MS,
      interval: 2_000,
      timeoutMessage: state => `${id} did not install: ${JSON.stringify(state)}`,
    });
  }

  if (last.state === 'installed-stopped') {
    await clickControl(`${selector} .engine-card__btn`);
    last = await waitForEngineState(id, state => state?.state === 'ready', {
      timeout: 600_000,
      interval: 1_000,
      timeoutMessage: state => `${id} did not start: ${JSON.stringify(state)}`,
    });
  }

  if (last.state !== 'ready') {
    throw new Error(`${id} is not runnable: ${JSON.stringify(last)}`);
  }
  await onReady(last);
  await clickControl('.settings-modal .cancel-btn');
};
