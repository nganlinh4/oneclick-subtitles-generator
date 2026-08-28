// A small, reusable toast/inline-error ledger for narration journeys. Mirrors the ledger
// narrationGeneration.journey.js already proved out for gTTS (same selectors, same visibility
// test), factored into its own module here rather than lifted out of that already-green journey,
// so edgeTtsNarrationGeneration.journey.js can reuse it without editing proven, unexecuted-in-this-
// pass code.
/* global browser, document, getComputedStyle, MutationObserver, window */

const FAILURE_SELECTOR = [
  '.toast-item.live .toast-error',
  '.toast-item.live .toast-warning',
  '.narration-section [role="alert"]',
  '.narration-section .error-message',
  '.narration-section .error',
].join(',');

export const dismissToasts = async () => {
  await browser.execute(() => {
    for (const close of document.querySelectorAll('.toast-item.live .close-icon')) close.click();
  });
  await browser.waitUntil(async () => (await browser.execute(
    () => document.querySelectorAll('.toast-item.live .toast').length,
  )) === 0, {
    timeout: 15_000,
    interval: 100,
    timeoutMsg: 'old toast history did not clear before narration admission',
  });
};

export const installFailureLedger = () => browser.execute((selector) => {
  window.__OSG_E2E_NARRATION_FAILURE_LEDGER__?.observer?.disconnect?.();
  const events = [];
  const text = (node) => (node.innerText || node.textContent || '')
    .trim().replace(/\s+/gu, ' ').slice(0, 500);
  const record = (node) => {
    const value = text(node);
    if (value && !events.includes(value)) events.push(value);
  };
  const capture = () => {
    for (const node of document.querySelectorAll(selector)) {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.display !== 'none' && style.visibility !== 'hidden'
          && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0) record(node);
    }
  };
  const observer = new MutationObserver((records) => {
    for (const mutation of records) {
      for (const added of mutation.addedNodes) {
        if (added.nodeType !== 1) continue;
        if (added.matches?.(selector)) record(added);
        for (const node of added.querySelectorAll?.(selector) ?? []) record(node);
      }
    }
    capture();
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  window.__OSG_E2E_NARRATION_FAILURE_LEDGER__ = { events, observer };
  capture();
  return true;
}, FAILURE_SELECTOR);

export const recordedFailures = () => browser.execute(() => (
  [...new Set(window.__OSG_E2E_NARRATION_FAILURE_LEDGER__?.events ?? [])]
));

export const visibleFailures = () => browser.execute((selector) => (
  [...document.querySelectorAll(selector)].filter((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }).map((node) => (node.innerText || node.textContent || '').trim().replace(/\s+/gu, ' '))
    .filter(Boolean)
), FAILURE_SELECTOR);
