import { strict as assert } from 'node:assert';
import process from 'node:process';
import test from 'node:test';

import { clickControl, waitForAutomationWindowIsolation } from './editor.js';

const withControlHarness = async ({ inViewport, clippedByScrollContainer = false }, exercise) => {
  const priorBrowser = globalThis.browser;
  const priorDollar = globalThis.$;
  const calls = { clicks: 0, scrolls: [] };
  let scrolled = false;
  const control = {
    waitForExist: async () => {},
    click: async () => { calls.clicks += 1; },
  };
  globalThis.browser = {
    execute: async (operation) => {
      if (operation.toString().includes('node.scrollIntoView')) {
        scrolled = true;
        calls.scrolls.push({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
        return true;
      }
      return {
        present: true,
        inViewport: inViewport || scrolled,
        clippedByScrollContainer: clippedByScrollContainer && !scrolled,
        disabled: false,
        intercepting: null,
      };
    },
    waitUntil: async (predicate) => {
      if (!await predicate()) throw new Error('control remained outside the viewport');
    },
  };
  globalThis.$ = async () => control;
  try {
    await exercise(calls);
  } finally {
    globalThis.browser = priorBrowser;
    globalThis.$ = priorDollar;
  }
};

test('clickControl does not scroll a control already inside the viewport', async () => {
  await withControlHarness({ inViewport: true }, async (calls) => {
    await clickControl('.fixed-modal-button');
    assert.deepEqual(calls.scrolls, []);
    assert.equal(calls.clicks, 1);
  });
});

test('clickControl scrolls an off-screen control only as far as needed', async () => {
  await withControlHarness({ inViewport: false }, async (calls) => {
    await clickControl('.below-the-fold-button');
    assert.deepEqual(calls.scrolls, [{ behavior: 'instant', block: 'nearest', inline: 'nearest' }]);
    assert.equal(calls.clicks, 1);
  });
});

test('clickControl scrolls an option clipped by its menu even inside the page viewport', async () => {
  await withControlHarness({ inViewport: true, clippedByScrollContainer: true }, async (calls) => {
    await clickControl('[role="option"]');
    assert.equal(calls.scrolls.length, 1);
    assert.equal(calls.clicks, 1);
  });
});

test('clickControl rejects XPath before WebDriver or querySelector can produce noisy failures', async () => {
  await assert.rejects(
    clickControl('//*[contains(@class,"button")]'),
    /requires one non-empty CSS selector; XPath is not supported/u,
  );
});

test('automation isolation waits until Windows has moved the compositor-visible window off-screen', async () => {
  const priorBrowser = globalThis.browser;
  const priorSetting = process.env.OSG_E2E_OFFSCREEN_WINDOW;
  const rectangles = [{ x: 130, y: 130, width: 1416, height: 939 }, { x: -10_000, y: 0, width: 1416, height: 939 }];
  let reads = 0;
  process.env.OSG_E2E_OFFSCREEN_WINDOW = '1';
  globalThis.browser = {
    getWindowRect: async () => rectangles[Math.min(reads++, rectangles.length - 1)],
    waitUntil: async (predicate) => {
      for (let attempt = 0; attempt < rectangles.length; attempt += 1) {
        if (await predicate()) return;
      }
      throw new Error('window did not move');
    },
  };
  try {
    assert.deepEqual(await waitForAutomationWindowIsolation(), rectangles[1]);
    assert.equal(reads, 2);
  } finally {
    globalThis.browser = priorBrowser;
    if (priorSetting === undefined) delete process.env.OSG_E2E_OFFSCREEN_WINDOW;
    else process.env.OSG_E2E_OFFSCREEN_WINDOW = priorSetting;
  }
});

test('automation isolation fails inside the journey when placement never becomes safe', async () => {
  const priorBrowser = globalThis.browser;
  const priorSetting = process.env.OSG_E2E_OFFSCREEN_WINDOW;
  process.env.OSG_E2E_OFFSCREEN_WINDOW = '1';
  globalThis.browser = {
    getWindowRect: async () => ({ x: 130, y: 130, width: 1416, height: 939 }),
    waitUntil: async (predicate, options) => {
      assert.equal(await predicate(), false);
      throw new Error(options.timeoutMsg);
    },
  };
  try {
    await assert.rejects(
      waitForAutomationWindowIsolation(),
      /automation window never reached its off-screen position/,
    );
  } finally {
    globalThis.browser = priorBrowser;
    if (priorSetting === undefined) delete process.env.OSG_E2E_OFFSCREEN_WINDOW;
    else process.env.OSG_E2E_OFFSCREEN_WINDOW = priorSetting;
  }
});
