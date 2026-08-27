// Ten customer-authored subtitle compositions are previewed in both native surfaces, rendered by
// the real Rust pipeline, saved through the fail-closed staged dialog, and independently decoded.
//
// This journey never asks Windows for focus, never enters fullscreen, and never opens a native
// picker. The embedded automation binary remains off-screen/non-focusable/muted; every file is a
// predeclared path beneath its disposable root.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { durableRenderScenes, durableState } from '../support/database.js';
import { durableCustomerIdentity } from '../support/settingsSurfaceOracle.js';
import { clickControl } from '../support/editor.js';
import { resolveManagedArtifact } from '../support/downloadJourneyOracle.js';
import {
  EXPORT_ANIMATION_PARITY_CASES,
  EXPORT_PARITY_FPS,
  EXPORT_PARITY_RESOLUTION,
  analyzeSubtitleParityRgba,
  buildExportAnimationParitySrt,
  exactFrameSeconds,
  verifyExportAnimationParityObservation,
} from '../support/exportAnimationParityOracle.js';
import {
  compareFramePixels,
  compareFrames,
  decodeFrameRgba,
  extractFrame,
  listMediaFiles,
  measureAudioSignal,
  newestMediaFile,
  probeMedia,
  savePreviewElementFrame,
  savePreviewSourceFrame,
} from '../support/nativeMediaOracle.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import { revealMainTransportControls } from '../support/previewTransport.js';
import {
  importSubtitleDocument,
  openProjectWithMedia,
} from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'export-animation-parity-matrix';
const MAIN_CANVAS = '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]';
const MAIN_VIDEO = '.video-preview video.video-player';
const MAIN_STATE = '.video-preview [data-osg-preview]';
const MAIN_SEEK = '.video-preview [data-osg-control="seek"]';
const MAIN_PLAY_PAUSE = '.video-preview [data-osg-control="play-pause"]';
const RENDER_CANVAS = '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]';
const RENDER_VIDEO = '.video-preview-panel video';
const RENDER_STATE = '.video-preview-panel [data-osg-preview]';
const RENDER_SEEK = '.video-preview-panel [data-osg-control="seek"]';
const RENDER_BUTTON = '.video-rendering-section.expanded [data-osg-action="render-video"]';

const ANIMATION_VALUES = Object.freeze([
  'fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale', 'typewriter',
  'bounce', 'flip', 'rotate',
]);
const EASING_VALUES = Object.freeze([
  'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out',
  'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
]);
const BORDER_VALUES = Object.freeze(['none', 'solid', 'dashed', 'dotted', 'double']);
const POSITION_VALUES = Object.freeze(['bottom', 'top', 'center', 'custom']);
const ALIGN_VALUES = Object.freeze(['left', 'center', 'right', 'justify']);
const TRANSFORM_VALUES = Object.freeze(['none', 'uppercase', 'lowercase', 'capitalize']);
const GRADIENT_DIRECTION_VALUES = Object.freeze([
  '0deg', '90deg', '45deg', '135deg', '180deg', '270deg',
]);
const RESOLUTION_VALUES = Object.freeze(['360p', '480p', '720p', '1080p', '1440p', '4K', '8K']);
const FRAME_RATE_VALUES = Object.freeze([24, 25, 30, 50, 60, 120]);

/* global $, $$, Element, MutationObserver, browser, describe, document, getComputedStyle, it, window */

const pathInside = (root, path, label) => {
  const inside = relative(resolve(root), resolve(path));
  assert.ok(
    inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`),
    `${label} escaped the disposable run root`,
  );
  return path;
};

const installProblemLedger = () => browser.execute(() => {
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

const visibleProblems = () => browser.execute(() => {
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

const recordedProblems = () => browser.execute(() => {
  const ledger = window.__OSG_E2E_EXPORT_PARITY_LEDGER__;
  return [...new Set([...(ledger?.events ?? []), ...(ledger?.previewRefusals ?? [])])];
});

const dismissToasts = async () => {
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

const selectDropdown = async ({ selector, values, value, label }) => {
  assert.match(selector, /^#[A-Za-z][\w-]*$/u, `${label}: dropdown needs a stable public ID`);
  const target = String(value);
  const index = values.map(String).indexOf(target);
  assert.ok(index >= 0, `${label}: ${target} is not a reviewed public option`);
  const button = await $(selector);
  await button.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${label}: dropdown is absent` });
  if ((await button.getAttribute('data-value')) === target) return;
  await button.scrollIntoView({ block: 'center', inline: 'center' });
  await button.waitForClickable({ timeout: 30_000, timeoutMsg: `${label}: dropdown is not clickable` });
  await button.click();
  const listbox = await $(`${selector}-listbox`);
  await listbox.waitForDisplayed({ timeout: 5_000, timeoutMsg: `${label}: listbox did not open` });
  const options = await $$(`${selector}-listbox [role="option"]`);
  assert.equal(options.length, values.length, `${label}: option catalog changed`);
  await options[index].click();
  await browser.waitUntil(async () => (
    (await button.getAttribute('data-value')) === target
      && (await button.getAttribute('aria-expanded')) === 'false'
  ), {
    timeout: 10_000,
    interval: 50,
    timeoutMsg: `${label}: ${target} did not commit through the public dropdown`,
  });
};

const selectAnonymousDropdown = async ({ button, values, value, label }) => {
  const target = String(value);
  const index = values.map(String).indexOf(target);
  assert.ok(index >= 0, `${label}: ${target} is not a reviewed public option`);
  if ((await button.getAttribute('data-value')) === target) return;
  await button.scrollIntoView({ block: 'center', inline: 'center' });
  await button.waitForClickable({ timeout: 30_000, timeoutMsg: `${label}: dropdown is not clickable` });
  await button.click();
  const listbox = await $('.custom-dropdown-clipper [role="listbox"]');
  await listbox.waitForDisplayed({ timeout: 5_000, timeoutMsg: `${label}: listbox did not open` });
  const options = await $$('.custom-dropdown-clipper [role="option"]');
  assert.equal(options.length, values.length, `${label}: option catalog changed`);
  await options[index].click();
  await browser.waitUntil(async () => (
    (await button.getAttribute('data-value')) === target
      && (await button.getAttribute('aria-expanded')) === 'false'
  ), {
    timeout: 10_000,
    interval: 50,
    timeoutMsg: `${label}: ${target} did not commit through the public dropdown`,
  });
};

const rangeState = async (selector) => {
  const input = await $(selector);
  const [minimum, maximum, step, value] = await Promise.all([
    input.getAttribute('min').then(Number),
    input.getAttribute('max').then(Number),
    input.getAttribute('step').then(Number),
    input.getValue().then(Number),
  ]);
  return { input, minimum, maximum, step, value };
};

/** Drive the shipped native input through the audited embedded-provider compatibility bridge. */
const setRange = async (selector, value, label) => {
  assert.match(selector, /^#[A-Za-z][\w-]*$/u, `${label}: range needs one stable public ID`);
  const state = await rangeState(selector);
  const { input, minimum, maximum, step } = state;
  assert.ok([minimum, maximum, step, state.value, value].every(Number.isFinite), (
    `${label}: public range geometry is invalid`
  ));
  assert.ok(maximum > minimum && step > 0, `${label}: public range is not actionable`);
  assert.ok(value >= minimum && value <= maximum, `${label}: value is outside range`);
  const trackSelector = `[data-osg-control="range"][data-osg-range-id="${selector.slice(1)}"]`;
  const track = await $(trackSelector);
  await track.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${label}: visible range track is absent` });
  await track.scrollIntoView({ block: 'center', inline: 'center' });
  const width = await track.getSize('width');
  assert.ok(Number.isFinite(width) && width >= 40, `${label}: range track has no usable width`);
  const result = await actuateNativeRange({ driver: browser, selector, value, label });
  assert.equal(result.focused, true, `${label}: public native input did not receive focus`);
  let observed = Number(await input.getValue());
  await browser.waitUntil(async () => {
    observed = Number(await input.getValue());
    return Math.abs(observed - value) <= 0.000_001;
  }, { timeout: 5_000, interval: 30, timeoutMsg: `${label}: exact value ${value} did not commit` });
  assert.ok(Math.abs(observed - value) <= 0.000_001, `${label}: exact value ${value} did not commit`);
};

const setSwitch = async (selector, selected, label) => {
  const control = await $(selector);
  await control.waitForExist({ timeout: 30_000, timeoutMsg: `${label}: switch is absent` });
  const read = () => browser.execute(
    target => document.querySelector(target)?.selected ?? null,
    selector,
  );
  assert.equal(typeof (await read()), 'boolean', `${label}: switch has no selected state`);
  // One click can land during a customization-panel re-render and be dropped; a customer clicks
  // again when a switch visibly did not take. Re-click only while the state is still wrong, and
  // let the final assertion own the verdict.
  for (let attempt = 0; attempt < 3 && (await read()) !== selected; attempt += 1) {
    await control.scrollIntoView({ block: 'center', inline: 'center' });
    await control.waitForClickable({ timeout: 30_000, timeoutMsg: `${label}: switch is not clickable` });
    await control.click();
    try {
      await browser.waitUntil(async () => (await read()) === selected, {
        timeout: 2_500,
        interval: 50,
      });
    } catch { /* the bounded re-click and final assertion own the outcome */ }
  }
  assert.equal(await read(), selected, `${label}: switch did not become ${selected}`);
};

const setTextColor = async (textSelector, value, label) => {
  assert.match(value, /^#[0-9a-f]{6}$/iu, `${label}: picker needs one opaque RGB colour`);
  const input = await $(textSelector);
  await input.waitForClickable({ timeout: 30_000, timeoutMsg: `${label}: colour text field is absent` });
  await input.scrollIntoView({ block: 'center', inline: 'center' });
  await input.click();
  await input.clearValue();
  await browser.keys('#');
  await browser.waitUntil(async () => (
    (await input.getValue()) === '#' && (await input.getAttribute('aria-invalid')) === 'true'
  ), { timeout: 5_000, interval: 50, timeoutMsg: `${label}: invalid draft never reached React` });
  await browser.keys(value.slice(1));
  await browser.waitUntil(async () => (
    (await input.getValue()).toLowerCase() === value.toLowerCase()
      && (await input.getAttribute('aria-invalid')) === 'false'
  ), { timeout: 5_000, interval: 50, timeoutMsg: `${label}: complete colour draft was rejected` });
  await browser.keys('Enter');
  await browser.waitUntil(async () => (
    (await input.getValue()).toLowerCase() === value.toLowerCase()
      && await browser.execute(
        selector => document.activeElement !== document.querySelector(selector), textSelector,
      )
  ), {
    timeout: 5_000,
    interval: 50,
    timeoutMsg: `${label}: public colour ${value} did not commit on Enter`,
  });
};

const waitForDurableCase = async (root, definition, afterRevision) => {
  let durable = null;
  await browser.waitUntil(async () => {
    durable = durableRenderScenes(root).at(-1) ?? null;
    if (!(durable?.sceneRevision > afterRevision)) return false;
    if (durable.scene?.renderSettings?.resolution !== EXPORT_PARITY_RESOLUTION
        || durable.scene?.renderSettings?.frameRate !== EXPORT_PARITY_FPS) return false;
    return Object.entries(definition.customization).every(
      ([field, expected]) => durable.scene?.customization?.[field] === expected,
    );
  }, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: `${definition.id}: public controls did not reach the durable project scene`,
  });
  return durable;
};

const applyCaseThroughPublicControls = async (root, definition) => {
  const before = durableRenderScenes(root).at(-1) ?? null;
  assert.ok(before?.sceneRevision >= 1, `${definition.id}: no durable scene exists`);
  const defaultButton = await $('[data-osg-preset="default"]');
  await defaultButton.scrollIntoView({ block: 'center', inline: 'center' });
  await defaultButton.waitForClickable({ timeout: 30_000, timeoutMsg: 'Default preset is unavailable' });
  await defaultButton.click();

  await selectDropdown({
    selector: '#subtitle-animation-type', values: ANIMATION_VALUES,
    value: definition.animationType, label: `${definition.id} animation`,
  });
  await selectDropdown({
    selector: '#subtitle-animation-easing', values: EASING_VALUES,
    value: definition.animationEasing, label: `${definition.id} easing`,
  });
  await setRange('#fade-in-duration-slider', definition.customization.fadeInDuration, 'fade in');
  await setRange('#fade-out-duration-slider', definition.customization.fadeOutDuration, 'fade out');
  await selectDropdown({
    selector: '#subtitle-border-style', values: BORDER_VALUES,
    value: definition.borderStyle, label: `${definition.id} border style`,
  });
  await setRange('#border-width-slider', definition.customization.borderWidth, 'border width');
  await selectDropdown({
    selector: '#subtitle-position', values: POSITION_VALUES,
    value: definition.position, label: `${definition.id} position`,
  });
  if (definition.position === 'custom') {
    await setRange('#position-x-slider', definition.customization.customPositionX, 'custom X');
    await setRange('#position-y-slider', definition.customization.customPositionY, 'custom Y');
  }
  await selectDropdown({
    selector: '#render-text-align', values: ALIGN_VALUES,
    value: definition.textAlign, label: `${definition.id} text alignment`,
  });
  await selectDropdown({
    selector: '#render-text-transform', values: TRANSFORM_VALUES,
    value: definition.textTransform, label: `${definition.id} text transform`,
  });
  await setRange('#font-size-slider', definition.customization.fontSize, 'font size');
  await setRange('#max-width-slider', definition.customization.maxWidth, 'maximum width');
  await setRange('#margin-bottom-slider', definition.customization.marginBottom, 'bottom margin');
  await setRange('#margin-top-slider', definition.customization.marginTop, 'top margin');
  await setRange('#margin-left-slider', definition.customization.marginLeft, 'left margin');
  await setRange('#margin-right-slider', definition.customization.marginRight, 'right margin');

  await setSwitch('#glow-enabled', definition.customization.glowEnabled, 'glow');
  if (definition.customization.glowEnabled) {
    await setTextColor('#subtitle-glow-color', definition.customization.glowColor, 'glow colour');
    await setRange('#glow-intensity-slider', definition.customization.glowIntensity, 'glow intensity');
  }
  await setSwitch('#gradient-enabled', definition.customization.gradientEnabled, 'gradient');
  if (definition.customization.gradientEnabled) {
    await setTextColor(
      '#subtitle-gradient-start-color', definition.customization.gradientColorStart,
      'gradient start',
    );
    await setTextColor(
      '#subtitle-gradient-end-color', definition.customization.gradientColorEnd,
      'gradient end',
    );
    await selectDropdown({
      selector: '#subtitle-gradient-direction',
      values: GRADIENT_DIRECTION_VALUES,
      value: definition.customization.gradientDirection,
      label: 'gradient direction',
    });
  }
  await setSwitch('#stroke-enabled', definition.customization.strokeEnabled, 'stroke');
  if (definition.customization.strokeEnabled) {
    await setTextColor('#subtitle-stroke-color', definition.customization.strokeColor, 'stroke colour');
    await setRange('#stroke-width-slider', definition.customization.strokeWidth, 'stroke width');
  }
  return waitForDurableCase(root, definition, before.sceneRevision);
};

const setFastExactRenderFormat = async (root) => {
  const controls = await $$(
    '.video-rendering-section.expanded .rendering-row:not(.queue-row) '
      + '> .row-content > .custom-dropdown > .custom-dropdown-button',
  );
  assert.equal(controls.length, 2, 'the public resolution/frame-rate controls changed shape');
  await selectAnonymousDropdown({
    button: controls[0], values: RESOLUTION_VALUES, value: EXPORT_PARITY_RESOLUTION,
    label: 'render resolution',
  });
  await selectAnonymousDropdown({
    button: controls[1], values: FRAME_RATE_VALUES, value: EXPORT_PARITY_FPS,
    label: 'render frame rate',
  });
  let durable = null;
  await browser.waitUntil(async () => {
    durable = durableRenderScenes(root).at(-1) ?? null;
    return durable?.scene?.renderSettings?.resolution === EXPORT_PARITY_RESOLUTION
      && durable?.scene?.renderSettings?.frameRate === EXPORT_PARITY_FPS;
  }, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: 'the 360p/30 public render format did not become durable',
  });
  return durable;
};

const waitForDurableCues = async (root) => {
  let cues = [];
  await browser.waitUntil(() => {
    cues = durableState(root).cues.map(cue => ({
      text: cue.text,
      startMs: Number(cue.start_ms),
      endMs: Number(cue.end_ms),
    }));
    return cues.length === EXPORT_ANIMATION_PARITY_CASES.length;
  }, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: 'the ten imported parity cues did not become durable',
  });
  return Object.freeze(cues.map(cue => Object.freeze(cue)));
};

const canvasState = (canvasSelector, videoSelector, stateSelector) => browser.execute((
  canvasTarget,
  videoTarget,
  stateTarget,
) => {
  const canvas = document.querySelector(canvasTarget);
  const video = document.querySelector(videoTarget);
  const state = document.querySelector(stateTarget);
  const sourceMediaTime = canvas?.dataset.osgSourceMediaTime;
  const transportTime = canvas?.dataset.osgTransportTime;
  const sceneTime = canvas?.dataset.osgSceneTime;
  return {
    revision: Number(canvas?.dataset.osgFrameRevision ?? 0),
    sourceMediaTime: sourceMediaTime === undefined || sourceMediaTime === ''
      ? null
      : Number(sourceMediaTime),
    transportTime: transportTime === undefined || transportTime === ''
      ? null
      : Number(transportTime),
    sourceClockProvenance: canvas?.dataset.osgSourceClockProvenance || null,
    sceneTime: sceneTime === undefined || sceneTime === '' ? null : Number(sceneTime),
    overlayRebuilds: Number(canvas?.dataset.osgOverlayRebuilds ?? 0),
    cue: canvas?.dataset.osgCueIndex ?? '',
    currentTime: video?.currentTime ?? null,
    paused: video?.paused ?? null,
    seeking: video?.seeking ?? null,
    readyState: video?.readyState ?? null,
    videoError: video?.error === null || video === null
      ? null
      : { code: video.error.code, message: video.error.message },
    preview: state?.getAttribute('data-osg-preview') ?? null,
    previewCode: state?.getAttribute('data-osg-preview-code') || null,
    fullscreen: document.fullscreenElement !== null,
  };
}, canvasSelector, videoSelector, stateSelector);

const waitForExactCanvas = async ({
  canvasSelector,
  videoSelector,
  stateSelector,
  seconds,
  cueIndex,
  beforeRevision,
  label,
}) => {
  let state = null;
  await waitUntilWithFreshDiagnostic(async () => {
    state = await canvasState(canvasSelector, videoSelector, stateSelector);
    // No overlay-rebuild demand here: the cached static overlay only rebuilds for static
    // subtitles, and these samples deliberately land inside animated entry/exit phases, which
    // paint directly. Subtitle presence is proven by the source-vs-composed pixel mask that
    // follows every sample, not by a counter that animation legitimately never touches.
    return state.revision > beforeRevision
      && state.cue === String(cueIndex)
      && Math.abs(state.currentTime - seconds) <= 0.000_001
      && Number.isFinite(state.transportTime)
      && Number.isFinite(state.sceneTime)
      && Math.abs(state.sceneTime - seconds) <= (1 / (2 * EXPORT_PARITY_FPS))
      && Math.abs(state.transportTime - seconds) <= 0.000_001
      && (state.sourceClockProvenance === 'rvfc'
        ? Number.isFinite(state.sourceMediaTime)
        : state.sourceMediaTime === null)
      && state.paused === true
      && state.seeking === false
      && state.readyState >= 2
      && state.videoError === null
      && state.preview === 'ready'
      && state.previewCode === null
      && state.fullscreen === false;
  }, {
    timeout: 120_000,
    interval: 100,
    diagnostic: () => `${label}: exact native frame did not publish: ${JSON.stringify(state)}`,
  });
  return state;
};

const ensurePausedThroughPublicControl = async ({ state, playPauseSelector, label }) => {
  if (state.paused === true) return;
  const control = await $(playPauseSelector);
  await control.waitForClickable({ timeout: 30_000, timeoutMsg: `${label}: Pause is unavailable` });
  await control.click();
  await browser.waitUntil(async () => (
    (await browser.execute(selector => document.querySelector(selector)?.paused ?? null,
      label === 'Main' ? MAIN_VIDEO : RENDER_VIDEO)) === true
  ), { timeout: 5_000, interval: 30, timeoutMsg: `${label}: public Pause did not settle` });
};

const pointerSeek = async ({ control, controlSelector, minimum, maximum, seconds, label }) => {
  const width = await control.getSize('width');
  assert.ok(Number.isFinite(width) && width >= 80, `${label}: seek control has no usable width`);
  const ratio = (seconds - minimum) / (maximum - minimum);
  assert.ok(ratio > 0 && ratio < 1, `${label}: sample is outside the public seek range`);
  const half = width / 2;
  const x = Math.round(Math.max(-half + 2, Math.min(half - 2, (ratio - 0.5) * width)));
  await browser.action('pointer')
    .move({ origin: control, x, y: 0 })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform();
  assert.equal(
    await browser.execute(
      selector => document.activeElement === document.querySelector(selector), controlSelector,
    ),
    true,
    `${label}: pointer seek did not focus its public keyboard surface`,
  );
};

const exactFrameKeys = async ({
  canvasSelector, videoSelector, stateSelector, frame, label, maximumFrame,
}) => {
  const keys = [];
  const read = () => canvasState(canvasSelector, videoSelector, stateSelector);
  let state = await read();
  let currentFrame = Math.round(state.currentTime * EXPORT_PARITY_FPS);
  // Even when pointer rounding lands in the requested frame, issue a public one-frame round trip so
  // the final media time is bound to the exact rational grid rather than merely inside its bucket.
  if (currentFrame === frame) {
    const first = frame < maximumFrame ? 'ArrowRight' : 'ArrowLeft';
    const second = first === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
    for (const [index, key] of [first, second].entries()) {
      const expectedFrame = index === 0 ? frame + (first === 'ArrowRight' ? 1 : -1) : frame;
      await browser.keys(key);
      keys.push(key);
      await browser.waitUntil(async () => {
        state = await read();
        return state.paused === true && state.seeking === false
          && Math.round(state.currentTime * EXPORT_PARITY_FPS) === expectedFrame;
      }, {
        timeout: 5_000,
        interval: 30,
        timeoutMsg: `${label}: ${key} did not reach frame ${expectedFrame}`,
      });
    }
    currentFrame = Math.round(state.currentTime * EXPORT_PARITY_FPS);
  }
  assert.ok(Math.abs(currentFrame - frame) <= 64, `${label}: pointer missed by too many frames`);
  while (currentFrame !== frame) {
    const key = currentFrame < frame ? 'ArrowRight' : 'ArrowLeft';
    const expectedFrame = currentFrame + (key === 'ArrowRight' ? 1 : -1);
    await browser.keys(key);
    keys.push(key);
    await browser.waitUntil(async () => {
      state = await read();
      return state.paused === true
        && state.seeking === false
        && Math.round(state.currentTime * EXPORT_PARITY_FPS) === expectedFrame;
    }, {
      timeout: 5_000,
      interval: 30,
      timeoutMsg: `${label}: ${key} did not reach frame ${expectedFrame}`,
    });
    currentFrame = expectedFrame;
  }
  assert.ok(keys.length <= 66, `${label}: keyboard correction is unbounded`);
  return Object.freeze([...keys]);
};

const seekThroughPublicControl = async ({ surface, frame, cueIndex }) => {
  const seconds = exactFrameSeconds(frame);
  const main = surface === 'Main';
  const canvasSelector = main ? MAIN_CANVAS : RENDER_CANVAS;
  const videoSelector = main ? MAIN_VIDEO : RENDER_VIDEO;
  const stateSelector = main ? MAIN_STATE : RENDER_STATE;
  const seekSelector = main ? MAIN_SEEK : RENDER_SEEK;
  const playPauseSelector = main ? MAIN_PLAY_PAUSE : '.video-preview-panel [data-osg-control="play-pause"]';
  if (main) {
    // The Main transport is hover-gated; the pointer-move shortcut does not reliably produce the
    // hover state in the hidden window, so cross the product's real mouseover reveal boundary.
    await revealMainTransportControls();
  }
  const control = await $(seekSelector);
  await control.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${surface}: public seek is absent` });
  await control.scrollIntoView({ block: 'center', inline: 'center' });
  const before = await canvasState(canvasSelector, videoSelector, stateSelector);
  await ensurePausedThroughPublicControl({ state: before, playPauseSelector, label: surface });
  const minimum = Number(await control.getAttribute(main ? 'aria-valuemin' : 'min'));
  const maximum = Number(await control.getAttribute(main ? 'aria-valuemax' : 'max'));
  assert.equal(minimum, 0, `${surface}: public seek no longer starts at zero`);
  assert.ok(Number.isFinite(maximum) && maximum > seconds, `${surface}: sample exceeds seek range`);
  if (!main) {
    const step = Number(await control.getAttribute('step'));
    assert.ok(Math.abs(step - 1 / EXPORT_PARITY_FPS) <= Number.EPSILON, (
      `Render: public seek step is not the exact ${EXPORT_PARITY_FPS}-fps grid: ${step}`
    ));
  }
  // Main seeks through a real pointer press on its slider, which both quantizes near the target
  // and grants genuine keyboard focus for the exact-frame arrow correction. The Render surface's
  // native range cannot rely on keyboard focus in the hidden non-activatable window (neither a JS
  // focus() nor a trusted click reliably delivers later key events there), so it takes the exact
  // rational value through the native value setter instead: the seek lands on the 30-fps grid
  // directly and the 1e-6 transport gate below still pins exactness.
  if (main) {
    await pointerSeek({
      control,
      controlSelector: seekSelector,
      minimum,
      maximum,
      seconds,
      label: `${surface} frame ${frame}`,
    });
  } else {
    const actuated = await actuateNativeRange({
      driver: browser,
      selector: seekSelector,
      value: seconds,
      label: `${surface} frame ${frame}`,
    });
    assert.ok(Math.abs(actuated.value - seconds) <= 0.000_001,
      `${surface} frame ${frame}: the native range did not commit the exact grid value`);
  }
  let pointerState = null;
  await waitUntilWithFreshDiagnostic(async () => {
    pointerState = await canvasState(canvasSelector, videoSelector, stateSelector);
    return pointerState.paused === true
      && pointerState.seeking === false
      && Number.isFinite(pointerState.currentTime)
      && Math.abs(pointerState.currentTime - seconds) <= Math.max(0.1, maximum / 500);
  }, {
    timeout: 30_000,
    interval: 30,
    diagnostic: () => `${surface}: pointer seek did not settle near ${seconds}: `
      + JSON.stringify(pointerState),
  });
  const keySequence = main
    ? await exactFrameKeys({
      canvasSelector,
      videoSelector,
      stateSelector,
      frame,
      label: `${surface} frame ${frame}/${EXPORT_PARITY_FPS}`,
      maximumFrame: Math.floor(maximum * EXPORT_PARITY_FPS),
    })
    : Object.freeze([]);
  const state = await waitForExactCanvas({
    canvasSelector,
    videoSelector,
    stateSelector,
    seconds,
    cueIndex,
    beforeRevision: before.revision,
    label: `${surface} frame ${frame}/${EXPORT_PARITY_FPS}`,
  });
  return Object.freeze({ ...state, keySequence });
};

const copyFrameArtifact = ({ name, source, description }) => copyWorkflowArtifact({
  workflow: WORKFLOW,
  name,
  source,
  description,
});

const capturePhase = async ({ root, selectedSource, definition, cueIndex, phase, frame }) => {
  const directory = join(root, 'evidence', WORKFLOW, definition.id);
  mkdirSync(directory, { recursive: true });
  const mainPath = join(directory, `${phase}-main-preview.png`);
  const mainSourcePath = join(directory, `${phase}-main-source-only.png`);
  const renderPath = join(directory, `${phase}-render-preview.png`);
  const renderSourcePath = join(directory, `${phase}-render-source-only.png`);
  const independentSourcePath = join(directory, `${phase}-independent-source.png`);

  const mainState = await seekThroughPublicControl({ surface: 'Main', frame, cueIndex });
  await savePreviewElementFrame(mainPath, MAIN_CANVAS);
  await savePreviewSourceFrame(mainSourcePath, MAIN_CANVAS);
  const renderState = await seekThroughPublicControl({ surface: 'Render', frame, cueIndex });
  await savePreviewElementFrame(renderPath, RENDER_CANVAS);
  await savePreviewSourceFrame(renderSourcePath, RENDER_CANVAS);
  extractFrame(selectedSource, exactFrameSeconds(frame), independentSourcePath);
  const mainSubtitlePixels = compareFramePixels(
    mainSourcePath, mainPath, { channelDeltaThreshold: 20 },
  );
  const renderSubtitlePixels = compareFramePixels(
    renderSourcePath, renderPath, { channelDeltaThreshold: 20 },
  );
  for (const [surface, subtitlePixels] of Object.entries({
    Main: mainSubtitlePixels, Render: renderSubtitlePixels,
  })) {
    // Presence only, at an absolute floor: a bounce or scale ENTRY is legitimately tiny (a
    // glow cue at 40% eased progress measured 84 real pixels at delta 27), so a frame-relative
    // ratio or a fixed high delta rejects correct animation math. The ROI difference-mask oracle
    // downstream owns the substantive per-surface and export agreement claims.
    assert.ok(
      subtitlePixels.changedPixels >= 32,
      `${definition.id} ${phase}: ${surface} added no subtitle pixels at all: `
        + JSON.stringify(subtitlePixels),
    );
  }
  const mainRender = compareFrames(mainPath, renderPath);

  copyFrameArtifact({
    name: `${definition.id}-${phase}-main-preview`,
    source: mainPath,
    description: `Main native preview at exact frame ${frame}/${EXPORT_PARITY_FPS}.`,
  });
  copyFrameArtifact({
    name: `${definition.id}-${phase}-render-preview`,
    source: renderPath,
    description: `Render native preview at exact frame ${frame}/${EXPORT_PARITY_FPS}.`,
  });
  copyFrameArtifact({
    name: `${definition.id}-${phase}-main-source-only`,
    source: mainSourcePath,
    description: 'Main WebView source frame with only its native subtitle canvas hidden.',
  });
  copyFrameArtifact({
    name: `${definition.id}-${phase}-render-source-only`,
    source: renderSourcePath,
    description: 'Render WebView source frame with only its native subtitle canvas hidden.',
  });
  copyFrameArtifact({
    name: `${definition.id}-${phase}-independent-source`,
    source: independentSourcePath,
    description: `Independent FFmpeg source decode at exact frame ${frame}/${EXPORT_PARITY_FPS}.`,
  });
  return Object.freeze({
    frame,
    seconds: exactFrameSeconds(frame),
    mainPath,
    mainSourcePath,
    renderPath,
    renderSourcePath,
    independentSourcePath,
    mainRender,
    mainSubtitlePixels,
    renderSubtitlePixels,
    mainState,
    renderState,
  });
};

const waitForNewCompletedRow = async (beforeCount, definition) => {
  await browser.waitUntil(async () => (await $$('.video-rendering-section .queue-item')).length === beforeCount + 1, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: `${definition.id}: Render did not create exactly one queue row`,
  });
  const rows = await $$('.video-rendering-section .queue-item');
  // VideoRenderingSection prepends with `[queueItem, ...prev]`. Selecting by the previous row count
  // works only for the first render and silently points at an older completed export thereafter.
  // The just-admitted row is therefore exactly the first row after the +1 cardinality assertion.
  const row = rows[0];
  let className = '';
  let text = '';
  await waitUntilWithFreshDiagnostic(async () => {
    className = await row.getAttribute('class');
    text = (await row.getText()).slice(0, 2_000);
    return /(?:^|\s)(?:completed|failed)(?:\s|$)/u.test(className);
  }, {
    timeout: 900_000,
    interval: 500,
    diagnostic: () => `${definition.id}: render never completed: ${JSON.stringify({ className, text })}`,
  });
  assert.match(className, /(?:^|\s)completed(?:\s|$)/u, `${definition.id}: render failed: ${text}`);
  return { row, text };
};

const waitForStableSavedMedia = async (destination, before, definition) => {
  let path = null;
  let priorSize = -1;
  let stableSamples = 0;
  await browser.waitUntil(() => {
    path = newestMediaFile(destination, before);
    if (path === null) return false;
    const size = statSync(path).size;
    stableSamples = size > 0 && size === priorSize ? stableSamples + 1 : 0;
    priorSize = size;
    return stableSamples >= 2;
  }, {
    timeout: 180_000,
    interval: 250,
    timeoutMsg: `${definition.id}: staged save produced no one stable media file`,
  });
  return path;
};

const archiveSavedMedia = ({ root, exported, definition }) => {
  const directory = join(root, 'evidence', WORKFLOW, definition.id);
  mkdirSync(directory, { recursive: true });
  const archived = join(directory, `${definition.id}.mp4`);
  assert.equal(existsSync(archived), false, `${definition.id}: archived output already exists`);
  pathInside(root, exported, 'staged export');
  pathInside(root, archived, 'archived export');
  renameSync(exported, archived);
  assert.equal(existsSync(exported), false, `${definition.id}: staged filename was not released`);
  assert.ok(statSync(archived).size > 100_000, `${definition.id}: archived output is implausibly small`);
  return archived;
};

const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');

const renderAndDecode = async ({
  root,
  destination,
  sourceProbe,
  definition,
  durableScene,
  durableCues,
  entry,
  exit,
  durableOwnership,
  selectedSourceIdentity,
  sourceAudioSignal,
}) => {
  await dismissToasts();
  const beforeCount = (await $$('.video-rendering-section .queue-item')).length;
  const beforeFiles = listMediaFiles(destination);
  const beforeLedger = durableState(root);
  const beforeJobIds = new Set(beforeLedger.jobs.map(({ id }) => id));
  const beforeArtifactIds = new Set(beforeLedger.artifacts.map(({ id }) => id));
  const renderButton = await $(RENDER_BUTTON);
  await renderButton.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'public Render is absent' });
  assert.equal(await renderButton.isEnabled(), true, `${definition.id}: public Render is disabled`);
  await clickControl(RENDER_BUTTON);
  await browser.pause(1_000);
  const admission = await browser.execute(() => ({
    inline: document.querySelector('.render-admission-status, .rendering-overlay')?.innerText?.trim() ?? null,
    refusal: [...document.querySelectorAll('.toast-item.live .toast-error, .toast-item.live .toast-warning')]
      .map(node => (node.innerText || node.textContent || '').trim()).filter(Boolean),
    fullscreen: document.fullscreenElement !== null,
  }));
  assert.equal(admission.inline, null, `${definition.id}: render progress leaked inline`);
  assert.deepEqual(admission.refusal, [], `${definition.id}: render was refused`);
  assert.equal(admission.fullscreen, false, `${definition.id}: Render activated fullscreen`);
  const completed = await waitForNewCompletedRow(beforeCount, definition);
  const completedLedger = durableState(root);
  const createdJobs = completedLedger.jobs.filter(
    ({ id, kind }) => kind === 'renderVideo' && !beforeJobIds.has(id),
  );
  const createdArtifacts = completedLedger.artifacts.filter(
    ({ id, kind }) => kind === 'renderedVideo' && !beforeArtifactIds.has(id),
  );
  assert.equal(createdJobs.length, 1, `${definition.id}: Render did not create one durable job`);
  assert.equal(createdArtifacts.length, 1, `${definition.id}: Render did not create one durable artifact`);
  const [createdJob] = createdJobs;
  const [createdArtifact] = createdArtifacts;
  const durableArtifactPath = resolveManagedArtifact(root, createdArtifact.relative_path);
  const download = await completed.row.$('.download-btn-success');
  await download.waitForClickable({ timeout: 30_000, timeoutMsg: `${definition.id}: save is unavailable` });
  await download.click();
  const saved = await waitForStableSavedMedia(destination, beforeFiles, definition);
  const archived = archiveSavedMedia({ root, exported: saved, definition });
  const exportOwnership = Object.freeze({
    jobs: createdJobs.map(({ id, kind, state }) => ({ id, kind, state })),
    artifacts: createdArtifacts.map(({
      id, project_id: projectId, job_id: jobId, kind, state, size_bytes: sizeBytes,
    }) => ({
      id, project_id: projectId, job_id: jobId, kind, state, size_bytes: sizeBytes,
    })),
    durableArtifact: Object.freeze({
      sizeBytes: statSync(durableArtifactPath).size,
      sha256: sha256File(durableArtifactPath),
    }),
    customerSave: Object.freeze({
      sizeBytes: statSync(archived).size,
      sha256: sha256File(archived),
    }),
    expectedJobId: createdJob.id,
    expectedArtifactId: createdArtifact.id,
  });
  const probe = probeMedia(archived);

  const directory = join(root, 'evidence', WORKFLOW, definition.id);
  const decodedEntry = join(directory, 'entry-decoded-export.png');
  const decodedExit = join(directory, 'exit-decoded-export.png');
  extractFrame(archived, entry.seconds, decodedEntry);
  extractFrame(archived, exit.seconds, decodedExit);
  assert.ok(statSync(decodedEntry).size > 1_000, `${definition.id}: entry decode is empty`);
  assert.ok(statSync(decodedExit).size > 1_000, `${definition.id}: exit decode is empty`);
  const videoStream = probe.streams?.find(stream => stream.codec_type === 'video');
  const geometry = { width: Number(videoStream?.width), height: Number(videoStream?.height) };
  assert.ok(Number.isSafeInteger(geometry.width) && geometry.width > 0
    && Number.isSafeInteger(geometry.height) && geometry.height > 0, (
    `${definition.id}: export geometry is unavailable for ROI analysis`
  ));
  const decodedByPhase = { entry: decodedEntry, exit: decodedExit };
  const regions = {};
  const scores = {
    entry: {
      renderExport: compareFrames(entry.renderPath, decodedEntry),
      sourceExport: compareFrames(entry.independentSourcePath, decodedEntry),
      mainRender: entry.mainRender,
      mainExport: compareFrames(entry.mainPath, decodedEntry),
      mainSourceSelected: compareFrames(entry.independentSourcePath, entry.mainSourcePath),
      renderSourceSelected: compareFrames(entry.independentSourcePath, entry.renderSourcePath),
    },
    exit: {
      renderExport: compareFrames(exit.renderPath, decodedExit),
      sourceExport: compareFrames(exit.independentSourcePath, decodedExit),
      mainRender: exit.mainRender,
      mainExport: compareFrames(exit.mainPath, decodedExit),
      mainSourceSelected: compareFrames(exit.independentSourcePath, exit.mainSourcePath),
      renderSourceSelected: compareFrames(exit.independentSourcePath, exit.renderSourcePath),
    },
  };
  for (const [phase, captured] of Object.entries({ entry, exit })) {
    regions[phase] = analyzeSubtitleParityRgba({
      ...geometry,
      independentSource: decodeFrameRgba(captured.independentSourcePath, geometry),
      mainSource: decodeFrameRgba(captured.mainSourcePath, geometry),
      renderSource: decodeFrameRgba(captured.renderSourcePath, geometry),
      main: decodeFrameRgba(captured.mainPath, geometry),
      render: decodeFrameRgba(captured.renderPath, geometry),
      exported: decodeFrameRgba(decodedByPhase[phase], geometry),
    });
  }
  const phasePaths = {
    main: { entry: entry.mainPath, exit: exit.mainPath },
    render: { entry: entry.renderPath, exit: exit.renderPath },
    exported: { entry: decodedEntry, exit: decodedExit },
    independentSource: {
      entry: entry.independentSourcePath,
      exit: exit.independentSourcePath,
    },
  };
  const phaseBinding = {
    frames: { entry: entry.frame, exit: exit.frame },
    publicSeeks: {
      main: {
        entry: { frame: Math.round(entry.mainState.currentTime * EXPORT_PARITY_FPS), seconds: entry.mainState.currentTime, keys: entry.mainState.keySequence },
        exit: { frame: Math.round(exit.mainState.currentTime * EXPORT_PARITY_FPS), seconds: exit.mainState.currentTime, keys: exit.mainState.keySequence },
      },
      render: {
        entry: { frame: Math.round(entry.renderState.currentTime * EXPORT_PARITY_FPS), seconds: entry.renderState.currentTime, keys: entry.renderState.keySequence },
        exit: { frame: Math.round(exit.renderState.currentTime * EXPORT_PARITY_FPS), seconds: exit.renderState.currentTime, keys: exit.renderState.keySequence },
      },
    },
    hashes: {},
    deltas: {},
  };
  for (const [surface, paths] of Object.entries(phasePaths)) {
    phaseBinding.hashes[surface] = {
      entry: sha256File(paths.entry),
      exit: sha256File(paths.exit),
    };
    phaseBinding.deltas[surface] = compareFramePixels(
      paths.entry, paths.exit, { channelDeltaThreshold: 12 },
    );
  }
  await dismissToasts();
  const problems = await visibleProblems();
  const history = await recordedProblems();
  const verified = verifyExportAnimationParityObservation({
    definition,
    probe,
    sourceProbe,
    durableScene,
    durableCues,
    scores,
    regions,
    phaseBinding,
    durableOwnership,
    selectedSourceIdentity,
    exportOwnership,
    audioSignals: { source: sourceAudioSignal, exported: measureAudioSignal(archived) },
    visibleProblems: problems,
    recordedProblems: history,
  });

  copyWorkflowArtifact({
    workflow: WORKFLOW,
    name: `${definition.id}-exported-video`,
    source: archived,
    description: 'Customer-saved native MP4 from the fail-closed staged destination.',
  });
  copyFrameArtifact({
    name: `${definition.id}-entry-decoded-export`,
    source: decodedEntry,
    description: `FFmpeg-decoded export frame at exact entry frame ${entry.frame}/${EXPORT_PARITY_FPS}.`,
  });
  copyFrameArtifact({
    name: `${definition.id}-exit-decoded-export`,
    source: decodedExit,
    description: `FFmpeg-decoded export frame at exact exit frame ${exit.frame}/${EXPORT_PARITY_FPS}.`,
  });
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: `${definition.id}-export-verified`,
    description: `${definition.animationType} completed through the native queue/save pipeline and both animated edges independently match preview.`,
    details: {
      animation: definition.animationType,
      easing: definition.animationEasing,
      borderStyle: definition.borderStyle,
      durableSceneRevision: durableScene.sceneRevision,
      queueText: completed.text,
      ...verified,
    },
    focusSelector: '.video-rendering-section .queue-manager-panel',
  });
  return verified;
};

describe('decoded native export animation parity matrix', () => {
  it('keeps all ten public animation/style cases WYSIWYG at entry and exit', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    const selectedSource = process.env.OSG_E2E_MEDIA_SELECTION;
    assert.ok(root && existsSync(root), 'the app must use one disposable data root');
    assert.ok(destination && existsSync(destination), 'the staged save directory must exist');
    assert.ok(selectedSource && existsSync(selectedSource), 'the staged real media selection is missing');
    pathInside(root, destination, 'save destination');
    pathInside(root, selectedSource, 'selected media');

    await installProblemLedger();
    await openProjectWithMedia();
    await importSubtitleDocument(
      buildExportAnimationParitySrt(),
      'export-animation-parity-matrix.srt',
      EXPORT_ANIMATION_PARITY_CASES[0].text,
    );
    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'Render did not expose its native preview and public controls',
    });
    assert.equal(
      await browser.execute(() => document.fullscreenElement === null),
      true,
      'the hidden journey must never enter fullscreen',
    );
    await setFastExactRenderFormat(root);
    const durableCues = await waitForDurableCues(root);
    const sourceProbe = probeMedia(selectedSource);
    const sourceAudioSignal = measureAudioSignal(selectedSource);
    const selectedSourceIdentity = Object.freeze({
      displayName: basename(selectedSource),
      sizeBytes: statSync(selectedSource).size,
      sha256: sha256File(selectedSource),
    });
    const state = durableState(root);
    const customerIdentity = durableCustomerIdentity(root);
    const durableOwnership = Object.freeze({
      projects: state.projects.map(({ id }) => ({ id })),
      media: state.media.map(({
        id, display_name: displayName, size_bytes: sizeBytes, content_hash: contentHash,
      }) => ({ id, display_name: displayName, size_bytes: sizeBytes, content_hash: contentHash })),
      links: state.links.map(({ project_id: projectId, media_id: mediaId, role }) => ({
        project_id: projectId, media_id: mediaId, role,
      })),
      sourceFiles: customerIdentity.sourceFiles.map(({
        mediaId, available, size, sha256,
      }) => ({
        media_id: String(mediaId).toLowerCase(), available, size_bytes: size, sha256,
      })),
    });
    const results = [];

    for (let index = 0; index < EXPORT_ANIMATION_PARITY_CASES.length; index += 1) {
      const definition = EXPORT_ANIMATION_PARITY_CASES[index];
      const durableScene = await applyCaseThroughPublicControls(root, definition);
      const entry = await capturePhase({
        root,
        selectedSource,
        definition,
        cueIndex: index,
        phase: 'entry',
        frame: definition.entryFrame,
      });
      const exit = await capturePhase({
        root,
        selectedSource,
        definition,
        cueIndex: index,
        phase: 'exit',
        frame: definition.exitFrame,
      });
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: `${definition.id}-native-previews`,
        description: `Main and Render both publish ${definition.animationType} at exact entry/exit frame fractions with no source-only substitution.`,
        details: {
          animation: definition.animationType,
          easing: definition.animationEasing,
          borderStyle: definition.borderStyle,
          position: definition.position,
          textAlign: definition.textAlign,
          textTransform: definition.textTransform,
          effects: definition.effects,
          textFeatures: definition.textFeatures,
          entry: {
            frame: `${entry.frame}/${EXPORT_PARITY_FPS}`,
            mainKeySequence: entry.mainState.keySequence,
            renderKeySequence: entry.renderState.keySequence,
            mainRenderSsim: entry.mainRender,
            mainChangedPixelsFromSource: entry.mainSubtitlePixels.changedPixels,
            renderChangedPixelsFromSource: entry.renderSubtitlePixels.changedPixels,
          },
          exit: {
            frame: `${exit.frame}/${EXPORT_PARITY_FPS}`,
            mainKeySequence: exit.mainState.keySequence,
            renderKeySequence: exit.renderState.keySequence,
            mainRenderSsim: exit.mainRender,
            mainChangedPixelsFromSource: exit.mainSubtitlePixels.changedPixels,
            renderChangedPixelsFromSource: exit.renderSubtitlePixels.changedPixels,
          },
        },
        focusSelector: '.preview-customization-row',
      });
      results.push(await renderAndDecode({
        root,
        destination,
        sourceProbe,
        definition,
        durableScene,
        durableCues,
        entry,
        exit,
        durableOwnership,
        selectedSourceIdentity,
        sourceAudioSignal,
      }));
    }

    assert.equal(results.length, 10, 'the decoded export matrix skipped a case');
    assert.deepEqual(
      results.map(result => result.id),
      EXPORT_ANIMATION_PARITY_CASES.map(definition => definition.id),
      'the decoded export matrix changed case order',
    );
    assert.deepEqual(await visibleProblems(), [], 'a visible refusal remains after the matrix');
    assert.deepEqual(await recordedProblems(), [], 'the matrix emitted a transient refusal');
    assert.equal(
      await browser.execute(() => document.fullscreenElement === null),
      true,
      'the hidden journey activated fullscreen',
    );
  });
});

async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}
