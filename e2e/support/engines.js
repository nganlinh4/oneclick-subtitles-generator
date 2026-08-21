import { clickControl } from './editor.js';

const ENGINE_TIMEOUT_MS = 7_200_000;

const engineState = async (id) => browser.execute((engineId) => {
  const card = document.querySelector(`[data-engine-id="${CSS.escape(engineId)}"]`);
  if (card === null) return null;
  return {
    state: card.getAttribute('data-engine-state'),
    text: (card.innerText || '').trim().slice(0, 2_000),
  };
}, id);

/**
 * Reach the real Tools screen and make one published engine runnable.
 *
 * Installation, digest verification, extraction and process warm-up are all product operations.
 * Only the persistent package directory is shared between disposable profiles, matching a customer
 * who installs the multi-gigabyte engine once and then creates many projects.
 */
export const ensureEngineReady = async (id, { onReady = async () => {} } = {}) => {
  await clickControl('[data-app-action="open-settings"]');
  await clickControl('[data-settings-tab="tools"]');

  const selector = `[data-engine-id="${id}"]`;
  const card = await $(selector);
  await card.waitForDisplayed({ timeout: 60_000, timeoutMsg: `${id} never appeared in Tools` });

  let last = null;
  await browser.waitUntil(async () => {
    last = await engineState(id);
    return last !== null && !['checking', 'status-error'].includes(last.state);
  }, {
    // A first status probe intentionally verifies every byte of an existing managed package.
    // The shared Faster Whisper install is about 7.2 GB, so slow disks can legitimately take
    // several minutes. This remains bounded and the screenshot/log evidence names the state.
    timeout: 1_200_000,
    interval: 1_000,
    timeoutMsg: () => `${id} package status never settled: ${JSON.stringify(last)}`,
  });

  if (['not-installed', 'update-available', 'corrupt'].includes(last.state)) {
    await clickControl(`${selector} .engine-card__btn`);
    await browser.waitUntil(async () => {
      last = await engineState(id);
      return last?.state === 'installed-stopped' || last?.state === 'ready';
    }, {
      timeout: ENGINE_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: () => `${id} did not install: ${JSON.stringify(last)}`,
    });
  }

  if (last.state === 'installed-stopped') {
    await clickControl(`${selector} .engine-card__btn`);
    await browser.waitUntil(async () => {
      last = await engineState(id);
      return last?.state === 'ready';
    }, {
      timeout: 600_000,
      interval: 1_000,
      timeoutMsg: () => `${id} did not start: ${JSON.stringify(last)}`,
    });
  }

  if (last.state !== 'ready') {
    throw new Error(`${id} is not runnable: ${JSON.stringify(last)}`);
  }
  await onReady(last);
  await clickControl('.settings-modal .cancel-btn');
};
