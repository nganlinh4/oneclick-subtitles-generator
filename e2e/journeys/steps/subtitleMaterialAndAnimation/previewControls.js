// Preview fixture constants, the visible-error ledger, preview state reads and the public seek,
// play/pause and customization-control drivers.

/* global $, $$, MutationObserver, browser, document, getComputedStyle, window */

import { strict as assert } from 'node:assert';

import { actuateNativeRange } from '../../../support/nativeRange.js';
import { ANIMATION_CUE } from '../../../support/subtitleMaterialAnimationOracle.js';

export const WORKFLOW = 'subtitle-material-and-animation';
export const CANVAS = '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]';
const SEEK = '.video-preview-panel [data-osg-control="seek"]';
const PLAY_PAUSE = '.video-preview-panel [data-osg-control="play-pause"]';
export const CUE_START = ANIMATION_CUE.start;
export const CUE_END = ANIMATION_CUE.end;
export const MATERIAL_TIME = 8;
export const CUE_TEXT = 'Mixed Case café é — Tiếng Việt rõ ràng — 한국어 자막 😀';
export const MATERIAL_SRT = `1
00:00:02,000 --> 00:00:14,000
${CUE_TEXT}
Arabic العربية مرحبا 123 — emoji 👨‍👩‍👧‍👦 — combining é
Long wrapping line proves alignment, line height, margins, width, transforms and typewriter clusters.
`;

export const errorSelector = [
  '.video-rendering-section.expanded [role="alert"]',
  '.video-rendering-section.expanded .error',
  '.video-rendering-section.expanded .error-message',
  '.video-rendering-section.expanded .video-error',
  '.toast-item.live .toast-error',
  '.toast-item.live .toast-warning',
].join(',');

export const installVisibleErrorLedger = () => browser.execute((selector) => {
  window.__OSG_E2E_MATERIAL_ERROR_LEDGER__?.observer?.disconnect?.();
  const events = [];
  const refusals = [];
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
  const recordRefusal = (node, previous = null) => {
    if (!node.matches?.('[data-osg-preview]')) return;
    const status = previous?.status ?? node.getAttribute?.('data-osg-preview') ?? '';
    const code = previous?.code ?? node.getAttribute?.('data-osg-preview-code') ?? '';
    if (code === '' && !/(?:error|refused|unavailable|blocked)/iu.test(status)) return;
    const entry = `${status || 'unknown'}:${code || 'no-code'}`;
    if (!refusals.includes(entry)) refusals.push(entry);
  };
  const captureRefusals = () => {
    for (const node of document.querySelectorAll('[data-osg-preview]')) recordRefusal(node);
  };
  const observer = new MutationObserver((records) => {
    for (const mutation of records) {
      if (mutation.type === 'attributes') {
        recordRefusal(mutation.target);
        // MutationObserver runs after the current JavaScript turn. Reading only the final DOM misses
        // code/status set and removed in that same turn, so retain the old side of each transition.
        if (mutation.attributeName === 'data-osg-preview-code' && mutation.oldValue) {
          recordRefusal(mutation.target, { code: mutation.oldValue });
        } else if (mutation.attributeName === 'data-osg-preview' && mutation.oldValue) {
          recordRefusal(mutation.target, { status: mutation.oldValue });
        }
      }
      for (const added of mutation.addedNodes) {
        if (added.nodeType !== 1) continue;
        if (added.matches?.(selector)) record(added, false);
        for (const node of added.querySelectorAll?.(selector) ?? []) record(node, false);
        if (added.matches?.('[data-osg-preview]')) recordRefusal(added);
        for (const node of added.querySelectorAll?.('[data-osg-preview]') ?? []) recordRefusal(node);
      }
    }
    capture();
    captureRefusals();
  });
  observer.observe(document.body, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['data-osg-preview', 'data-osg-preview-code'],
    childList: true,
    characterData: true,
    subtree: true,
  });
  window.__OSG_E2E_MATERIAL_ERROR_LEDGER__ = { events, refusals, observer };
  capture();
  captureRefusals();
  return true;
}, errorSelector);

export const previewState = () => browser.execute((selector) => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const text = node => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
  const canvas = document.querySelector(
    '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]',
  );
  const video = document.querySelector('.video-preview-panel video');
  const preview = document.querySelector('.video-preview-panel [data-osg-preview]');
  const finiteDatasetNumber = (element, key) => {
    const raw = element?.dataset?.[key];
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return {
    canvas: canvas === null ? null : {
      revision: Number(canvas.dataset.osgFrameRevision ?? 0),
      sourceMediaTime: finiteDatasetNumber(canvas, 'osgSourceMediaTime'),
      transportTime: finiteDatasetNumber(canvas, 'osgTransportTime'),
      sourceClockProvenance: canvas.dataset.osgSourceClockProvenance || null,
      sceneTime: finiteDatasetNumber(canvas, 'osgSceneTime'),
      overlayRebuilds: Number(canvas.dataset.osgOverlayRebuilds ?? 0),
      cue: canvas.dataset.osgCueIndex ?? '',
      width: canvas.width,
      height: canvas.height,
    },
    video: video === null ? null : {
      currentTime: video.currentTime,
      duration: video.duration,
      paused: video.paused,
      ended: video.ended,
      seeking: video.seeking,
      readyState: video.readyState,
      error: video.error === null ? null : { code: video.error.code, message: video.error.message },
    },
    preview: preview === null ? null : {
      status: preview.getAttribute('data-osg-preview'),
      code: preview.getAttribute('data-osg-preview-code') || null,
    },
    currentErrors: [...document.querySelectorAll(selector)].filter(visible).map(text).filter(Boolean),
    recordedErrors: [...(window.__OSG_E2E_MATERIAL_ERROR_LEDGER__?.events ?? [])],
    recordedRefusals: [...(window.__OSG_E2E_MATERIAL_ERROR_LEDGER__?.refusals ?? [])],
  };
}, errorSelector);

export const waitForReady = async ({
  before = null,
  paused,
  overlay = false,
  requireOverlay = true,
  cue = '0',
  status = 'ready',
  context,
}) => {
  let state = null;
  const priorRevision = before?.canvas?.revision ?? 0;
  const priorOverlay = before?.canvas?.overlayRebuilds ?? 0;
  try {
    await browser.waitUntil(async () => {
      state = await previewState();
      return state.canvas?.revision > priorRevision
        && (requireOverlay
          ? state.canvas.overlayRebuilds > 0
          : state.canvas.overlayRebuilds === 0)
        && (!overlay || state.canvas.overlayRebuilds > priorOverlay)
        && (cue === null || state.canvas.cue === cue)
        && state.preview?.status === status
        && state.preview?.code === null
        && state.video?.readyState >= 2
        && state.video.error === null
        && state.video.paused === paused
        && state.currentErrors.length === 0;
    }, {
      timeout: 120_000,
      interval: 75,
      timeoutMsg: `${context} did not publish a ready native frame`,
    });
  } catch (error) {
    state = await previewState();
    throw new Error(`${context} did not publish a ready native frame: ${JSON.stringify(state)}`, {
      cause: error,
    });
  }
  return state;
};

export const publicSeek = async (seconds, paused, { cue = '0', status = 'ready' } = {}) => {
  const before = await previewState();
  const input = await $(SEEK);
  await input.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the public Render seek control is absent' });
  await input.scrollIntoView({ block: 'center', inline: 'center' });
  const [minimum, maximum, step, width] = await Promise.all([
    input.getAttribute('min').then(Number),
    input.getAttribute('max').then(Number),
    input.getAttribute('step').then(Number),
    input.getSize('width'),
  ]);
  assert.ok([minimum, maximum, step, width, seconds].every(Number.isFinite));
  assert.ok(maximum > minimum && step > 0 && width >= 100 && seconds > minimum && seconds < maximum, (
    `seek target ${seconds} is outside ${minimum}..${maximum}`
  ));
  const reachableSeconds = minimum + (Math.round((seconds - minimum) / step) * step);
  assert.ok(Math.abs(reachableSeconds - seconds) <= step / 2 + Number.EPSILON, (
    `seek target ${seconds} cannot be represented by public step ${step}`
  ));
  // A seek issued while PLAYING can only be verified as a jump, never as a settled instant: the
  // playhead moves on immediately, so demanding exact equality is a poll race the journey loses
  // whenever the sampling interval misses the one matching frame. Every playing seek here jumps
  // BACKWARDS to a witness start, so the window below is reachable only through the actual jump —
  // ordinary monotonic playback from the pre-seek position can never re-enter it.
  if (!paused) {
    assert.ok(before.video !== null && seconds < before.video.currentTime - 0.1,
      `a playing public seek must jump backwards to its witness start (${seconds}s from ${before.video?.currentTime}s)`);
  }
  const playingWindowEnd = paused
    ? Number.NaN
    : Math.min(seconds + 1.5, before.video.currentTime - 0.05);
  await actuateNativeRange({
    driver: browser,
    selector: SEEK,
    value: reachableSeconds,
    label: 'Render preview seek',
  });
  let state = null;
  try {
    await browser.waitUntil(async () => {
      state = await previewState();
      if (state.video === null || state.video.paused !== paused || state.video.seeking) return false;
      const shared = state.canvas?.revision > before.canvas.revision
        && Number.isFinite(state.canvas.transportTime)
        && Number.isFinite(state.canvas.sceneTime)
        && state.canvas.sceneTime <= state.canvas.transportTime + 0.000_001
        && (state.canvas.sourceClockProvenance === 'rvfc'
          ? Number.isFinite(state.canvas.sourceMediaTime)
          : state.canvas.sourceMediaTime === null)
        && state.canvas.cue === cue
        && state.preview?.status === status;
      if (!shared) return false;
      if (paused) {
        return Math.abs(state.video.currentTime - seconds) <= 0.05
          && Math.abs(state.canvas.sceneTime - seconds) <= 0.05
          && Math.abs(state.canvas.transportTime - reachableSeconds) <= 0.000_001
          && state.canvas.transportTime - state.canvas.sceneTime <= step + 0.000_001;
      }
      return state.video.currentTime >= seconds - 0.05
        && state.video.currentTime <= playingWindowEnd
        && state.canvas.transportTime >= seconds - 0.05
        && state.canvas.transportTime <= playingWindowEnd + 0.1;
    }, {
      timeout: 30_000,
      interval: 50,
      timeoutMsg: `public seek did not reach ${seconds}s`,
    });
  } catch (error) {
    state = await previewState();
    throw new Error(
      `public seek did not reach ${seconds}s; before=${JSON.stringify(before)}; final=${JSON.stringify(state)}`,
      { cause: error },
    );
  }
  return state;
};

export const setPlaying = async (playing) => {
  const state = await previewState();
  if (state.video?.paused === !playing) return state;
  const control = await $(PLAY_PAUSE);
  await control.waitForClickable({ timeout: 30_000 });
  await control.scrollIntoView({ block: 'center', inline: 'center' });
  await control.click();
  let observed = null;
  await waitUntilWithFreshDiagnostic(async () => {
    observed = await previewState();
    return observed.video?.paused === !playing;
  }, {
    timeout: 5_000,
    interval: 40,
    diagnostic: () => `public ${playing ? 'Play' : 'Pause'} did not settle: ${JSON.stringify(observed)}`,
  });
  return observed;
};

const setPublicRange = async (spec) => {
  const input = await $(spec.selector);
  await input.waitForExist({ timeout: 30_000, timeoutMsg: `${spec.token}: slider is absent` });
  // Structural XPath starts from the stable input ID; it contains no locale-dependent text.
  const track = await $(`//*[@id="${spec.selector.slice(1)}"]/parent::*`
    + '[contains(concat(" ", normalize-space(@class), " "), " standard-slider-track-container ")]');
  await track.waitForExist({ timeout: 30_000, timeoutMsg: `${spec.token}: slider track is absent` });
  await track.scrollIntoView({ block: 'center', inline: 'center' });
  const [minimum, maximum, step, current, width] = await Promise.all([
    input.getAttribute('min').then(Number),
    input.getAttribute('max').then(Number),
    input.getAttribute('step').then(Number),
    input.getValue().then(Number),
    track.getSize('width'),
  ]);
  assert.equal(minimum, spec.minimum, `${spec.token}: public minimum changed`);
  assert.equal(maximum, spec.maximum, `${spec.token}: public maximum changed`);
  assert.ok(Number.isFinite(step) && step > 0, `${spec.token}: public step is invalid`);
  assert.ok(width >= 40 && spec.ratio >= 0 && spec.ratio <= 1);
  const half = width / 2;
  const offset = value => Math.round(Math.max(
    -half + 2,
    Math.min(half - 2, (((value - minimum) / (maximum - minimum)) - 0.5) * width),
  ));
  const intended = minimum + (spec.ratio * (maximum - minimum));
  const target = Math.max(minimum, Math.min(
    maximum,
    minimum + (Math.round((intended - minimum) / step) * step),
  ));
  assert.ok(Number.isFinite(offset(current)) && Number.isFinite(offset(target)), (
    `${spec.token}: visible slider geometry cannot represent the requested move`
  ));
  await actuateNativeRange({
    driver: browser,
    selector: spec.selector,
    value: target,
    label: spec.token,
  });
  let observed = Number(await input.getValue());
  await waitUntilWithFreshDiagnostic(async () => {
    observed = Number(await input.getValue());
    const pointerTolerance = ((maximum - minimum) / width) * 2;
    return Number.isFinite(observed)
      && observed !== current
      && Math.abs(observed - target) <= Math.max(step, pointerTolerance);
  }, {
    timeout: 5_000,
    interval: 50,
    diagnostic: () => `${spec.token}: public drag missed ${target} and settled at ${observed}`,
  });
  return observed;
};

export const usePublicDropdown = async (spec) => {
  const button = await $(spec.selector);
  await button.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${spec.token}: dropdown is absent` });
  await button.scrollIntoView({ block: 'center', inline: 'center' });
  await button.waitForClickable({ timeout: 30_000 });
  const before = await button.getAttribute('data-value');
  assert.notEqual(String(before), String(spec.value), `${spec.token}: dropdown already has target value`);
  await button.click();
  const listbox = await $(`${spec.selector}-listbox`);
  await listbox.waitForDisplayed({ timeout: 5_000, timeoutMsg: `${spec.token}: listbox did not open` });
  const options = await $$(`${spec.selector}-listbox [role="option"]`);
  assert.equal(options.length, spec.values.length, `${spec.token}: dropdown vocabulary changed`);
  const targetIndex = spec.values.map(String).indexOf(String(spec.value));
  assert.ok(targetIndex >= 0, `${spec.token}: target is outside the frozen vocabulary`);
  await options[targetIndex].click();
  await browser.waitUntil(async () => (
    (await button.getAttribute('data-value')) === String(spec.value)
      && (await button.getAttribute('aria-expanded')) === 'false'
  ), {
    timeout: 5_000,
    interval: 50,
    timeoutMsg: `${spec.token}: public dropdown did not commit ${spec.value}`,
  });
  return spec.value;
};

const setPublicColour = async (spec) => {
  const input = await $(spec.selector);
  await input.scrollIntoView({ block: 'center', inline: 'center' });
  await input.waitForClickable({ timeout: 30_000, timeoutMsg: `${spec.token}: colour field is absent` });
  await input.click();
  await input.clearValue();
  await browser.keys('#');
  await browser.waitUntil(async () => (
    (await input.getValue()) === '#' && (await input.getAttribute('aria-invalid')) === 'true'
  ), { timeout: 5_000, interval: 50, timeoutMsg: `${spec.token}: invalid draft never reached React` });
  await browser.keys(spec.value.slice(1));
  await browser.waitUntil(async () => (
    (await input.getValue()) === spec.value && (await input.getAttribute('aria-invalid')) === 'false'
  ), { timeout: 5_000, interval: 50, timeoutMsg: `${spec.token}: complete colour draft was rejected` });
  await browser.keys('Enter');
  await browser.waitUntil(async () => (
    (await input.getValue()) === spec.value
      && await browser.execute(selector => document.activeElement !== document.querySelector(selector), spec.selector)
  ), { timeout: 5_000, interval: 50, timeoutMsg: `${spec.token}: colour did not commit on Enter` });
  return spec.value;
};

const setPublicToggle = async (spec) => {
  const control = await $(spec.selector);
  await control.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${spec.token}: switch is absent` });
  await control.scrollIntoView({ block: 'center', inline: 'center' });
  const before = await control.getProperty('selected');
  assert.notEqual(before, spec.value, `${spec.token}: switch already has target value`);
  await control.click();
  await browser.waitUntil(async () => (await control.getProperty('selected')) === spec.value, {
    timeout: 5_000,
    interval: 50,
    timeoutMsg: `${spec.token}: switch did not commit ${spec.value}`,
  });
  return spec.value;
};

export const performControl = (spec) => {
  if (spec.kind === 'range') return setPublicRange(spec);
  if (spec.kind === 'dropdown') return usePublicDropdown(spec);
  if (spec.kind === 'colour') return setPublicColour(spec);
  if (spec.kind === 'toggle') return setPublicToggle(spec);
  throw new Error(`unsupported public control kind: ${spec.kind}`);
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
