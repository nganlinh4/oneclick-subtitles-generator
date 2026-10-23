// Native preview readiness, visible-error ledger and durable customization waits.
/* global $, MutationObserver, browser, document, getComputedStyle, window */

import { strict as assert } from 'node:assert';

import { durableRenderScenes } from '../../../support/database.js';
import { COMPARE_AT_SECONDS } from './constants.js';

export const installVisibleErrorLedger = () => browser.execute(() => {
  window.__OSG_E2E_CUSTOMIZATION_ERROR_LEDGER__?.observer?.disconnect?.();
  const events = [];
  const selector = [
    '.video-rendering-section.expanded [role="alert"]',
    '.video-rendering-section.expanded .error',
    '.video-rendering-section.expanded .error-message',
    '.video-rendering-section.expanded .video-error',
    '.toast-item.live .toast-error',
    '.toast-item.live .toast-warning',
  ].join(',');
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const record = (node, requireVisible) => {
    if (requireVisible && !visible(node)) return;
      const text = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 400);
      if (text && !events.includes(text)) events.push(text);
  };
  const capture = () => {
    for (const node of document.querySelectorAll(selector)) record(node, true);
  };
  const observer = new MutationObserver((records) => {
    // Inspect added nodes as well as the settled DOM. A short-lived error can otherwise be inserted
    // and removed within one observer delivery before a document-wide query sees it.
    for (const mutation of records) {
      for (const added of mutation.addedNodes) {
        if (added.nodeType !== 1) continue;
        if (added.matches?.(selector)) record(added, false);
        for (const node of added.querySelectorAll?.(selector) ?? []) record(node, false);
      }
    }
    capture();
  });
  observer.observe(document.body, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  window.__OSG_E2E_CUSTOMIZATION_ERROR_LEDGER__ = { events, observer };
  capture();
  return true;
});

export const previewState = () => browser.execute(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const text = (node) => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
  const canvas = document.querySelector(
    '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]',
  );
  const preview = document.querySelector('.video-preview-panel [data-osg-preview]');
  const video = document.querySelector('.video-preview-panel video');
  const preset = [...document.querySelectorAll('.preset-buttons > .pill-button')]
    .find((button) => button.classList.contains('primary')
      && !button.classList.contains('save-preset-button'));
  const currentErrors = [...document.querySelectorAll([
    '.video-rendering-section.expanded [role="alert"]',
    '.video-rendering-section.expanded .error',
    '.video-rendering-section.expanded .error-message',
    '.video-rendering-section.expanded .video-error',
    '.toast-item.live .toast-error',
    '.toast-item.live .toast-warning',
  ].join(','))].filter(visible).map(text).filter(Boolean);
  return {
    canvas: canvas === null ? null : {
      revision: Number(canvas.dataset.osgFrameRevision ?? 0),
      overlayRebuilds: Number(canvas.dataset.osgOverlayRebuilds ?? 0),
      cue: canvas.dataset.osgCueIndex ?? '',
      width: canvas.width,
      height: canvas.height,
    },
    video: video === null ? null : {
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      readyState: video.readyState,
      error: video.error === null ? null : { code: video.error.code, message: video.error.message },
    },
    preview: preview === null ? null : {
      status: preview.getAttribute('data-osg-preview'),
      code: preview.getAttribute('data-osg-preview-code') || null,
    },
    // `innerText` applies each button's decorative CSS text-transform (for example Retro is
    // rendered as RETRO), so it is presentation evidence, not preset identity. Keep the authored
    // label and the stable product ID separately.
    activePreset: preset?.textContent?.trim().replace(/\s+/g, ' ') ?? null,
    activePresetId: preset?.getAttribute('data-osg-preset') ?? null,
    selectedFont: document.querySelector('.font-selector-button .font-name')?.textContent?.trim() ?? null,
    selectedFontCss: document.querySelector('.font-selector-button .font-name')?.style?.fontFamily ?? null,
    controls: {
      fontSize: document.querySelector('#font-size-slider')?.value ?? null,
      fontWeight: document.querySelector('#font-weight-slider')?.dataset?.value ?? null,
      backgroundOpacity: document.querySelector('#background-opacity-slider')?.value ?? null,
      borderRadius: document.querySelector('#border-radius-slider')?.value ?? null,
      maxWidth: document.querySelector('#max-width-slider')?.value ?? null,
      backgroundColor: document.querySelector('#subtitle-background-color')?.value ?? null,
    },
    currentErrors,
    recordedErrors: [...(window.__OSG_E2E_CUSTOMIZATION_ERROR_LEDGER__?.events ?? [])],
  };
});

export const assertReady = (state, context) => {
  assert.ok(state.canvas?.revision > 0, `${context}: native canvas has no revision`);
  assert.ok(state.canvas?.overlayRebuilds > 0, `${context}: subtitle overlay was never built`);
  assert.notEqual(state.canvas?.cue, '', `${context}: native canvas has no active subtitle cue`);
  assert.ok(state.canvas?.width > 0 && state.canvas?.height > 0, `${context}: canvas has no pixels`);
  assert.ok(state.video?.readyState >= 2 && state.video.error === null, (
    `${context}: source video is not readable: ${JSON.stringify(state.video)}`
  ));
  assert.equal(state.video.paused, true, `${context}: comparison video is not paused`);
  assert.ok(Math.abs(state.video.currentTime - COMPARE_AT_SECONDS) <= 1 / 15, (
    `${context}: comparison playhead drifted: ${state.video.currentTime}`
  ));
  assert.equal(state.preview?.status, 'ready', `${context}: native preview is not ready`);
  assert.equal(state.preview?.code, null, `${context}: native preview published ${state.preview?.code}`);
  assert.deepEqual(state.currentErrors, [], `${context}: visible error surface remains`);
  assert.deepEqual(state.recordedErrors, [], `${context}: a transient visible error was recorded`);
  return state;
};

export const waitForReadyChange = async (
  before,
  context,
  predicate = () => true,
  { requireOverlayChange = true } = {},
) => {
  let state = null;
  const beforeRevision = before.canvas?.revision ?? 0;
  const beforeOverlayRebuilds = before.canvas?.overlayRebuilds ?? 0;
  try {
    await browser.waitUntil(async () => {
      state = await previewState();
      return state.canvas?.revision > beforeRevision
        && state.canvas?.overlayRebuilds > 0
        && (!requireOverlayChange || state.canvas?.overlayRebuilds > beforeOverlayRebuilds)
        && state.canvas.cue !== ''
        && state.preview?.status === 'ready'
        && state.preview?.code === null
        && predicate(state);
    }, {
      timeout: 120_000,
      interval: 100,
    });
  } catch (cause) {
    throw new Error(
      `${context} never reached new native pixels: ${JSON.stringify({
        beforeRevision,
        beforeOverlayRebuilds,
        state,
      })}`,
      { cause },
    );
  }
  return assertReady(state, context);
};

export const applyPreset = async (name, before) => {
  const button = await $(`//div[contains(@class,"preset-buttons")]//button[normalize-space()="${name}"]`);
  await button.scrollIntoView();
  await button.waitForClickable({ timeout: 30_000, timeoutMsg: `${name} preset is not clickable` });
  await button.click();
  return waitForReadyChange(
    before,
    `${name} preset`,
    (state) => state.activePreset === name,
  );
};

export const waitForDurableCustomization = async (root, key, value, afterRevision) => {
  let observed = null;
  await browser.waitUntil(async () => {
    observed = durableRenderScenes(root).at(-1) ?? null;
    return observed?.sceneRevision > afterRevision
      && observed?.scene?.customization?.[key] === value;
  }, {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: `the project scene did not durably commit customization.${key}=${value}`,
  });
  return observed;
};

export const waitForDurablePreset = async (root, presetId, afterRevision) => {
  let durableScene = null;
  await browser.waitUntil(async () => {
    durableScene = durableRenderScenes(root).at(-1) ?? null;
    return durableScene?.sceneRevision > afterRevision
      && durableScene?.scene?.customization?.preset === presetId;
  }, {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: `the ${presetId} public preset did not reach the project-owned render scene`,
  });
  return durableScene;
};

export async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}
