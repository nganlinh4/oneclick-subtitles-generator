// Per-cue narration result rows: their observable surface and their public per-row controls.
/* global browser, document, window */

import { strict as assert } from 'node:assert';

import { clickControl } from '../../../support/editor.js';

/** Tag exactly one result row's control button so clickControl can press it without a stable id. */
const tagResultControlButton = (cueText, iconName) => browser.execute((text, icon) => {
  const marker = 'data-e2e-narration-control';
  for (const stale of document.querySelectorAll(`[${marker}]`)) stale.removeAttribute(marker);
  const rows = [...document.querySelectorAll('.result-item[data-narration-result-state="succeeded"]')];
  const row = rows.find((node) => (node.querySelector('.result-text')?.textContent || '').includes(text));
  if (row === undefined) return { found: false, reason: 'noMatchingRow', rowCount: rows.length };
  const buttons = [...row.querySelectorAll('.result-controls button')];
  const button = icon === 'refresh'
    ? row.querySelector('[data-osg-action="regenerate-narration-cue"]')
    : buttons.find((node) => (
      (node.querySelector('.material-symbols-rounded')?.textContent || '').trim() === icon
    ));
  if (button === undefined) {
    return {
      found: false,
      reason: 'noMatchingButton',
      buttonIcons: buttons.map((node) => (node.querySelector('.material-symbols-rounded')?.textContent || '').trim()),
    };
  }
  button.setAttribute(marker, '1');
  return { found: true };
}, cueText, iconName);

export const clickResultControlButton = async (cueText, iconName, label) => {
  const tagged = await tagResultControlButton(cueText, iconName);
  assert.equal(tagged.found, true, `${label}: ${JSON.stringify(tagged)}`);
  await browser.execute(() => {
    const node = document.querySelector('[data-e2e-narration-control="1"]');
    window.__OSG_E2E_NARRATION_CLICK__ = {
      delivered: false,
      disabledBefore: node?.disabled ?? null,
      subtitleId: node?.getAttribute('data-subtitle-id') ?? null,
    };
    node?.addEventListener('click', () => {
      window.__OSG_E2E_NARRATION_CLICK__.delivered = true;
    }, { once: true });
  });
  await clickControl('[data-e2e-narration-control="1"]');
  const delivery = await browser.execute(() => window.__OSG_E2E_NARRATION_CLICK__ ?? null);
  assert.equal(delivery?.delivered, true, `${label} never received a DOM click: ${JSON.stringify(delivery)}`);
  await browser.execute(() => {
    document.querySelector('[data-e2e-narration-control]')?.removeAttribute('data-e2e-narration-control');
  });
  return delivery;
};

export const resultRowSurface = (cueText) => browser.execute((text) => {
  const rows = [...document.querySelectorAll('.result-item[data-narration-result-state="succeeded"]')];
  const row = rows.find((node) => (node.querySelector('.result-text')?.textContent || '').includes(text));
  const audio = document.querySelector('.gtts-content audio');
  return {
    rowFound: row !== undefined,
    playing: row?.classList.contains('playing') ?? null,
    retrying: row?.classList.contains('retrying') ?? null,
    audioSrc: audio?.currentSrc || audio?.getAttribute('src') || null,
    audioPaused: audio ? audio.paused : null,
  };
}, cueText);

export const anyRetryingRow = () => browser.execute(() => (
  document.querySelector('.result-item.retrying') !== null
));
