// Transient-problem ledger for the export parity journey (refusals, toasts, preview status codes),
// plus the guard that keeps every staged path under the disposable run root.

import { strict as assert } from 'node:assert';
import { relative, resolve, sep } from 'node:path';


/* global $$, Element, MutationObserver, browser, document, getComputedStyle, window */
export const pathInside = (root, path, label) => {
  const inside = relative(resolve(root), resolve(path));
  assert.ok(
    inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`),
    `${label} escaped the disposable run root`,
  );
  return path;
};

export const installProblemLedger = () => browser.execute(() => {
  window.__OSG_E2E_EXPORT_PARITY_LEDGER__?.observer?.disconnect?.();
  const events = [];
  const previewRefusals = [];
  const selector = [
    '.toast-item.live .toast-error',
    '.toast-item.live .toast-warning',
    '.video-rendering-section.expanded [role="alert"]',
    '.video-rendering-section.expanded .error',
    '.video-rendering-section.expanded .error-message',
    '.video-rendering-section.expanded .video-error',
  ].join(',');
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const record = (node, requireVisible) => {
    if (requireVisible && !visible(node)) return;
    const text = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    if (text && !events.includes(text)) events.push(text);
  };
  const capture = () => {
    for (const node of document.querySelectorAll(selector)) record(node, true);
  };
  const recordPreview = (node, previous = null) => {
    if (!(node instanceof Element)) return;
    const status = previous?.status ?? node.getAttribute('data-osg-preview') ?? '';
    const code = previous?.code ?? node.getAttribute('data-osg-preview-code') ?? '';
    if (code === '' && !/(?:error|refused|unavailable|blocked)/iu.test(status)) return;
    const scope = node.closest('.video-preview-panel') !== null ? 'Render' : 'Main';
    const finding = `${scope}:${status || 'none'}:${code || 'none'}`;
    if (!previewRefusals.includes(finding)) previewRefusals.push(finding);
  };
  const capturePreviews = (scope = document) => {
    if (scope.matches?.('[data-osg-preview]')) recordPreview(scope);
    for (const node of scope.querySelectorAll?.('[data-osg-preview]') ?? []) recordPreview(node);
  };
  const observer = new MutationObserver((records) => {
    for (const mutation of records) {
      if (mutation.type === 'attributes') {
        recordPreview(mutation.target);
        if (mutation.attributeName === 'data-osg-preview-code' && mutation.oldValue) {
          recordPreview(mutation.target, { code: mutation.oldValue });
        } else if (mutation.attributeName === 'data-osg-preview' && mutation.oldValue) {
          recordPreview(mutation.target, { status: mutation.oldValue });
        }
      }
      for (const added of mutation.addedNodes) {
        if (added.nodeType !== 1) continue;
        if (added.matches?.(selector)) record(added, false);
        for (const node of added.querySelectorAll?.(selector) ?? []) record(node, false);
        capturePreviews(added);
      }
    }
    capture();
  });
  observer.observe(document.body, {
    attributes: true,
    attributeOldValue: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  window.__OSG_E2E_EXPORT_PARITY_LEDGER__ = { events, previewRefusals, observer };
  capture();
  capturePreviews();
  return true;
});

export const visibleProblems = () => browser.execute(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const text = node => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
  const selectors = [
    '.toast-item.live .toast-error',
    '.toast-item.live .toast-warning',
    '.video-rendering-section.expanded [role="alert"]',
    '.video-rendering-section.expanded .error',
    '.video-rendering-section.expanded .error-message',
    '.video-rendering-section.expanded .video-error',
  ].join(',');
  const problems = [...document.querySelectorAll(selectors)].filter(visible).map(text).filter(Boolean);
  for (const scope of ['.video-preview', '.video-preview-panel']) {
    const state = document.querySelector(`${scope} [data-osg-preview]`);
    const status = state?.getAttribute('data-osg-preview') ?? null;
    const code = state?.getAttribute('data-osg-preview-code') || null;
    if (status !== null && status !== 'ready') problems.push(`${scope}:${status}:${code ?? 'none'}`);
    if (code !== null) problems.push(`${scope}:code:${code}`);
  }
  if (document.fullscreenElement !== null) problems.push('fullscreen unexpectedly active');
  return [...new Set(problems)];
});

export const recordedProblems = () => browser.execute(() => {
  const ledger = window.__OSG_E2E_EXPORT_PARITY_LEDGER__;
  return [...new Set([...(ledger?.events ?? []), ...(ledger?.previewRefusals ?? [])])];
});

export const dismissToasts = async () => {
  for (const close of await $$('.toast-item.live .close-icon')) {
    if (await close.isDisplayed()) await close.click();
  }
  await browser.waitUntil(async () => (
    await browser.execute(() => document.querySelectorAll('.toast-item.live .toast').length)
  ) === 0, {
    timeout: 15_000,
    interval: 100,
    timeoutMsg: 'toast history did not clear before the next matrix case',
  });
};
