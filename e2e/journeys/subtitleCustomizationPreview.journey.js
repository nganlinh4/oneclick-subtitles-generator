// A customer changes subtitle appearance through the shipped Render controls. Every claimed style
// change must advance the native canvas, change independently captured pixels, stay drawable, and
// finally return to the known Default preset's pixels.

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { durableRenderScenes } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { compareFrames, savePreviewElementFrame } from '../support/nativeMediaOracle.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import {
  describeCustomizationNativeFrame,
  verifyCustomizationRestoration,
  verifyCustomizationTransition,
  verifyLiveCustomizationPlayback,
} from '../support/subtitleCustomizationFrameOracle.js';
import {
  SUBTITLE_PRESET_MATRIX,
  verifyExactWeightDropdown,
  verifyPresetObservation,
} from '../support/subtitleCustomizationPresetOracle.js';
import {
  importSubtitleDocument,
  openProjectWithMedia,
} from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'subtitle-customization-preview';
const CANVAS = '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]';
const COMPARE_AT_SECONDS = 1;
const SYSTEM_FONT = 'Impact';
const SYSTEM_FONT_CSS = "'Impact', sans-serif";
const SYSTEM_FONT_WEIGHT = 400;
const CUSTOMIZATION_CUE = 'Every subtitle appearance control must change this long native preview line independently';
const CUSTOMIZATION_SRT = `1
00:00:00,250 --> 00:00:05,500
${CUSTOMIZATION_CUE}
`;

/* global $, $$, MutationObserver, browser, describe, document, getComputedStyle, it, performance, requestAnimationFrame, window */

const installVisibleErrorLedger = () => browser.execute(() => {
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

const previewState = () => browser.execute(() => {
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

const assertReady = (state, context) => {
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

const waitForReadyChange = async (
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

const applyPreset = async (name, before) => {
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

const clickRenderTransport = async (paused) => {
  const control = await $('.video-preview-panel [data-osg-control="play-pause"]');
  await control.waitForClickable({
    timeout: 30_000,
    timeoutMsg: `the public Render ${paused ? 'Pause' : 'Play'} control is not clickable`,
  });
  await control.click();
  let state = null;
  await waitUntilWithFreshDiagnostic(async () => {
    state = await previewState();
    return state.video !== null && state.video.paused === paused;
  }, {
    timeout: 5_000,
    interval: 50,
    diagnostic: () => `the public Render transport did not become ${paused ? 'paused' : 'playing'}: ${JSON.stringify(state)}`,
  });
  return state;
};

const startLiveCustomizationWitness = async ({ expectedCue, expectedPreset }) => browser.execute(({
  cue,
  preset: initialPreset,
}) => {
  const video = document.querySelector('.video-preview-panel video');
  const canvas = document.querySelector(
    '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]',
  );
  if (video === null || canvas === null) throw new Error('the Render playback surface is incomplete');
  if (video.paused) throw new Error('the temporal witness must start after public Play succeeds');
  if ((canvas.dataset.osgCueIndex ?? '') !== cue) {
    throw new Error(`the temporal witness did not start inside cue ${cue}`);
  }
  const activePreset = () => [...document.querySelectorAll('.preset-buttons > .pill-button')]
    .find((button) => button.classList.contains('primary')
      && !button.classList.contains('save-preset-button'))
    ?.textContent?.trim() ?? null;
  const visibleErrors = () => [...document.querySelectorAll([
    '.video-rendering-section.expanded [role="alert"]',
    '.video-rendering-section.expanded .error',
    '.video-rendering-section.expanded .error-message',
    '.video-rendering-section.expanded .video-error',
    '.toast-item.live .toast-error',
    '.toast-item.live .toast-warning',
  ].join(','))].filter((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }).map((node) => (node.innerText || node.textContent || '')
    .trim().replace(/\s+/g, ' ').slice(0, 400)).filter(Boolean);
  if (activePreset() !== initialPreset) {
    throw new Error(`the temporal witness expected the ${initialPreset} preset`);
  }

  window.__OSG_E2E_LIVE_CUSTOMIZATION_WITNESS__?.cleanup?.();
  const witness = {
    active: true,
    startedAt: performance.now(),
    samples: [],
    mediaEvents: [],
    listeners: [],
  };
  const recordMediaEvent = (event) => {
    witness.mediaEvents.push({
      type: event.type,
      atMs: performance.now() - witness.startedAt,
      mediaTime: video.currentTime,
      readyState: video.readyState,
      error: video.error === null ? null : { code: video.error.code, message: video.error.message },
    });
  };
  for (const type of ['abort', 'emptied', 'error', 'playing', 'stalled', 'waiting']) {
    video.addEventListener(type, recordMediaEvent);
    witness.listeners.push([type, recordMediaEvent]);
  }
  witness.cleanup = () => {
    witness.active = false;
    for (const [type, listener] of witness.listeners) video.removeEventListener(type, listener);
    witness.listeners = [];
  };
  const sample = () => {
    if (!witness.active) return;
    const atMs = performance.now() - witness.startedAt;
    const prior = witness.samples.at(-1);
    if (prior === undefined || atMs > prior.atMs) {
      const preview = document.querySelector('.video-preview-panel [data-osg-preview]');
      witness.samples.push({
        atMs,
        mediaTime: video.currentTime,
        revision: Number(canvas.dataset.osgFrameRevision ?? 0),
        overlayRebuilds: Number(canvas.dataset.osgOverlayRebuilds ?? 0),
        cue: canvas.dataset.osgCueIndex ?? '',
        preview: preview?.getAttribute('data-osg-preview') ?? null,
        previewCode: preview?.getAttribute('data-osg-preview-code') || null,
        preset: activePreset(),
        paused: video.paused,
        ended: video.ended,
        readyState: video.readyState,
        error: video.error === null ? null : { code: video.error.code, message: video.error.message },
        visibleErrors: visibleErrors(),
      });
    }
    if (witness.samples.length < 600) requestAnimationFrame(sample);
  };
  window.__OSG_E2E_LIVE_CUSTOMIZATION_WITNESS__ = witness;
  sample();
  return {
    startedAtMediaTime: video.currentTime,
    startedAtRevision: Number(canvas.dataset.osgFrameRevision ?? 0),
  };
}, { cue: expectedCue, preset: expectedPreset });

const liveCustomizationWitnessElapsed = () => browser.execute(() => {
  const witness = window.__OSG_E2E_LIVE_CUSTOMIZATION_WITNESS__;
  return witness === undefined ? null : performance.now() - witness.startedAt;
});

const stopLiveCustomizationWitness = () => browser.execute(() => {
  const witness = window.__OSG_E2E_LIVE_CUSTOMIZATION_WITNESS__;
  if (witness === undefined) throw new Error('the live customization witness disappeared');
  witness.cleanup();
  return {
    samples: witness.samples,
    mediaEvents: witness.mediaEvents,
  };
});

const seekRenderPreviewWithPublicControl = async (seconds, before) => {
  const input = await $('.video-preview-panel [data-osg-control="seek"]');
  await input.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the public Render seek control is absent' });
  const [minimum, maximum, width] = await Promise.all([
    input.getAttribute('min').then(Number),
    input.getAttribute('max').then(Number),
    input.getSize('width'),
  ]);
  assert.ok([minimum, maximum, width, seconds].every(Number.isFinite), (
    'the public Render seek control has invalid geometry'
  ));
  assert.ok(maximum > minimum && width >= 100, 'the public Render seek control is not actionable');
  assert.ok(seconds > minimum && seconds < maximum, 'the comparison time is outside the Render seek control');
  await actuateNativeRange({
    driver: browser,
    selector: '.video-preview-panel [data-osg-control="seek"]',
    value: seconds,
    label: 'post-playback Render seek',
  });
  return waitForReadyChange(
    before,
    'post-playback public reseek',
    (next) => Math.abs(next.video.currentTime - seconds) <= 1 / 15,
    { requireOverlayChange: false },
  );
};

const applyPresetDuringPlayback = async ({ before, name }) => {
  assertReady(before, `before live ${name} rebuild`);
  assert.equal(before.activePreset, 'Default', 'the live rebuild did not start from Default');
  await clickRenderTransport(false);
  await startLiveCustomizationWitness({ expectedCue: '0', expectedPreset: 'Default' });
  await browser.pause(600);

  const button = await $(`//div[contains(@class,"preset-buttons")]//button[normalize-space()="${name}"]`);
  await button.waitForClickable({
    timeout: 30_000,
    timeoutMsg: `${name} preset is not clickable during Render playback`,
  });
  await button.click();
  let changed = null;
  await waitUntilWithFreshDiagnostic(async () => {
    changed = await previewState();
    return changed.activePreset === name
      && changed.video?.paused === false
      && changed.canvas?.overlayRebuilds > before.canvas.overlayRebuilds;
  }, {
    timeout: 1_500,
    interval: 50,
    diagnostic: () => `${name} did not rebuild while the real Render video kept playing: ${JSON.stringify(changed)}`,
  });

  const elapsed = await liveCustomizationWitnessElapsed();
  assert.ok(Number.isFinite(elapsed) && elapsed < 2_500, `the live preset rebuild exceeded its bound: ${elapsed}`);
  await browser.pause(Math.max(0, 3_200 - elapsed));
  const observed = await stopLiveCustomizationWitness();
  const beforePause = await previewState();
  assert.equal(beforePause.video?.paused, false, 'the Render video stopped before public Pause');
  const paused = await clickRenderTransport(true);
  const temporal = verifyLiveCustomizationPlayback({
    ...observed,
    afterPreset: name,
  });
  assert.deepEqual(paused.currentErrors, [], 'the live preset rebuild left a visible error');
  assert.deepEqual(paused.recordedErrors, [], 'the live preset rebuild emitted a transient error');
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: '01b-live-classic-rebuild-continuous',
    description: 'Classic is selected while the real Render video plays; media, native frames and the authored cue remain continuous.',
    details: {
      fromPreset: 'Default',
      toPreset: name,
      stoppedAtMediaTime: paused.video.currentTime,
      stoppedAtRevision: paused.canvas.revision,
      ...temporal,
    },
    focusSelector: '.preview-customization-row',
  });
  return seekRenderPreviewWithPublicControl(COMPARE_AT_SECONDS, paused);
};

const setPublicRange = async (selector, value) => {
  const input = await $(selector);
  await input.waitForExist({ timeout: 30_000, timeoutMsg: `slider is absent: ${selector}` });
  assert.match(selector, /^#[A-Za-z][\w-]*$/u, `range control needs one stable ID: ${selector}`);
  const track = await $(`//*[@id="${selector.slice(1)}"]/parent::*`
    + '[contains(concat(" ", normalize-space(@class), " "), " standard-slider-track-container ")]');
  await track.waitForExist({ timeout: 30_000, timeoutMsg: `slider track is absent: ${selector}` });
  await track.scrollIntoView({ block: 'center', inline: 'center' });
  const [minimum, maximum, step, current, width] = await Promise.all([
    input.getAttribute('min').then(Number),
    input.getAttribute('max').then(Number),
    input.getAttribute('step').then(Number),
    input.getValue().then(Number),
    track.getSize('width'),
  ]);
  assert.ok([minimum, maximum, step, current, width, value].every(Number.isFinite), (
    `slider geometry is invalid for ${selector}`
  ));
  assert.ok(maximum > minimum && step > 0 && width >= 40, `slider is not actionable: ${selector}`);
  assert.ok(value >= minimum && value <= maximum, `${value} is outside ${selector}'s public range`);
  assert.ok(current >= minimum && current <= maximum, `current value is outside ${selector}'s range`);
  await actuateNativeRange({ driver: browser, selector, value, label: selector });
  let observed = null;
  await waitUntilWithFreshDiagnostic(async () => {
    observed = await input.getValue();
    return String(observed) === String(value);
  }, {
    timeout: 5_000,
    interval: 50,
    diagnostic: () => `${selector} public drag requested ${value} but reached ${observed}`,
  });
};

const usePublicDropdown = async ({
  selector,
  expectedValues,
  selectValue = null,
  context,
}) => {
  assert.match(selector, /^#[A-Za-z][\w-]*$/u, `dropdown needs one stable ID: ${selector}`);
  assert.ok(Array.isArray(expectedValues) && expectedValues.length > 0, (
    `${context}: exact dropdown values are required`
  ));
  const values = expectedValues.map(String);
  const button = await $(selector);
  await button.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${context}: dropdown is absent` });
  await button.scrollIntoView({ block: 'center', inline: 'center' });
  const beforeValue = await button.getAttribute('data-value');
  const enabled = await button.isEnabled();
  if (values.length === 1) {
    assert.equal(enabled, false, `${context}: a one-choice dropdown should be non-interactive`);
    assert.equal(String(beforeValue), values[0], `${context}: the sole exact value is not selected`);
    assert.equal(await button.getAttribute('aria-expanded'), 'false', (
      `${context}: the one-choice dropdown claimed to be expanded`
    ));
    const exact = verifyExactWeightDropdown({
      expectedValues,
      currentValue: beforeValue,
      options: [{ label: (await button.getText()).trim(), selected: true, disabled: false }],
      context,
    });
    return Object.freeze({ ...exact, afterValue: String(beforeValue), controlDisabled: true });
  }
  assert.equal(enabled, true, `${context}: a multi-choice dropdown is disabled`);
  await button.waitForClickable({ timeout: 30_000, timeoutMsg: `${context}: dropdown is not clickable` });
  await button.click();
  const listbox = await $(`${selector}-listbox`);
  await listbox.waitForDisplayed({ timeout: 5_000, timeoutMsg: `${context}: listbox did not open` });
  const options = await $$(`${selector}-listbox [role="option"]`);
  // WebdriverIO's embedded ElementArray is indexable but its `.map()` is an async collection
  // command, not Array.prototype.map; wrapping that returned promise in Promise.all is invalid.
  // Materialize each public option explicitly so no lazy collection semantics are mistaken for a
  // JavaScript array and every advertised weight is still inspected.
  const observedOptions = [];
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    observedOptions.push({
      label: (await option.getText()).trim(),
      selected: (await option.getAttribute('aria-selected')) === 'true',
      disabled: (await option.getAttribute('disabled')) !== null,
    });
  }
  const exact = verifyExactWeightDropdown({
    expectedValues,
    currentValue: beforeValue,
    options: observedOptions,
    context,
  });

  if (selectValue === null) {
    await button.click();
    await listbox.waitForDisplayed({
      reverse: true,
      timeout: 5_000,
      timeoutMsg: `${context}: listbox did not close`,
    });
    return exact;
  }

  const targetValue = String(selectValue);
  const targetIndex = values.indexOf(targetValue);
  assert.ok(targetIndex >= 0, `${context}: ${targetValue} is not an exact dropdown option`);
  await options[targetIndex].click();
  let afterValue = null;
  await waitUntilWithFreshDiagnostic(async () => {
    afterValue = await button.getAttribute('data-value');
    return String(afterValue) === targetValue
      && (await button.getAttribute('aria-expanded')) === 'false';
  }, {
    timeout: 5_000,
    interval: 50,
    diagnostic: () => `${context}: public option ${targetValue} did not commit; reached ${afterValue}`,
  });
  return Object.freeze({ ...exact, afterValue: String(afterValue) });
};

const setPublicText = async (selector, value) => {
  const input = await $(selector);
  await input.scrollIntoView({ block: 'center', inline: 'center' });
  await input.waitForClickable({ timeout: 30_000, timeoutMsg: `text input is unavailable: ${selector}` });
  // The embedded provider's `setValue` can mutate a controlled input's DOM value without emitting
  // the React input sequence, and its Ctrl+A chord is not reliable inside this scroll container.
  // Clear the focused field, then type through a deliberately invalid `#` draft before completing
  // the value. The aria transition proves React—not merely the DOM property—received the typing.
  await input.click();
  assert.equal(
    await browser.execute(target => document.activeElement === document.querySelector(target), selector),
    true,
    `${selector} did not own keyboard focus`,
  );
  await input.clearValue();
  const typed = String(value);
  assert.ok(typed.startsWith('#') && typed.length > 1, `${selector} needs a complete hex colour`);
  await browser.keys('#');
  await browser.waitUntil(async () => (
    (await input.getValue()) === '#'
      && (await input.getAttribute('aria-invalid')) === 'true'
  ), {
    timeout: 5_000,
    interval: 50,
    timeoutMsg: `${selector} did not publish its invalid intermediate draft to React`,
  });
  await browser.keys(typed.slice(1));
  await browser.waitUntil(async () => (
    (await input.getValue()) === typed
      && (await input.getAttribute('aria-invalid')) === 'false'
  ), {
    timeout: 5_000,
    interval: 50,
    timeoutMsg: `${selector} did not publish its complete draft to React`,
  });
  // The embedded provider suppresses keyboard focus traversal for this non-focusable HWND, and a
  // pointer click on a non-focusable row label is allowed to leave the input focused. Enter is a
  // first-class public commit path of ColorControl: its real key handler blurs, and blur publishes
  // exactly one validated value. This exercises the same React boundary without a DOM shortcut.
  await browser.keys('Enter');
  let observed = null;
  let focused = true;
  await waitUntilWithFreshDiagnostic(async () => {
    ({ observed, focused } = await browser.execute((target) => {
      const node = document.querySelector(target);
      return {
        observed: node?.value ?? null,
        focused: document.activeElement === node,
      };
    }, selector));
    return observed === String(value) && focused === false;
  }, {
    timeout: 5_000,
    interval: 50,
    diagnostic: () => `${selector} public typing requested ${value} but reached ${JSON.stringify({ observed, focused })}`,
  });
};

const setControlAndWait = async ({
  state,
  selector,
  value,
  read,
  label,
  kind = 'range',
  expectedValues,
}) => {
  if (kind === 'text') await setPublicText(selector, value);
  else if (kind === 'dropdown') {
    await usePublicDropdown({
      selector,
      expectedValues,
      selectValue: value,
      context: label,
    });
  }
  else await setPublicRange(selector, value);
  return waitForReadyChange(state, label, (next) => String(read(next)) === String(value));
};

const waitForDurableCustomization = async (root, key, value, afterRevision) => {
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

const selectSystemFont = async (before) => {
  await clickControl('.font-selector-button');
  const modal = await $('.font-modal');
  await modal.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the public font picker did not open' });
  const search = await $('.font-search-input');
  await search.waitForDisplayed({ timeout: 10_000 });
  await search.setValue(SYSTEM_FONT);
  const card = await $(`//div[contains(@class,"font-card")][.//span[normalize-space()="${SYSTEM_FONT}"]]`);
  await card.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${SYSTEM_FONT} is absent from the font picker` });
  await card.scrollIntoView();
  await card.waitForClickable({ timeout: 30_000, timeoutMsg: `${SYSTEM_FONT} is not selectable` });
  return { card, modal, before };
};

const frameEvidence = async ({ root, stem, description }) => {
  const name = `${stem}-native-frame`;
  const path = join(root, 'evidence', 'subtitle-customization', `${name}.png`);
  // The compositor publishes its backing-store viewport before the screenshot. That is the
  // independent envelope: it follows the real device scale while a full-page screenshot cannot
  // masquerade as the native crop by supplying its own IHDR dimensions.
  const expectedGeometry = await savePreviewElementFrame(path, CANVAS);
  const captured = describeCustomizationNativeFrame(path, expectedGeometry);
  const artifactPath = copyWorkflowArtifact({ workflow: WORKFLOW, name, source: path, description });
  const frame = describeCustomizationNativeFrame(artifactPath, expectedGeometry);
  assert.equal(frame.sha256, captured.sha256, 'workflow artifact changed the native frame bytes');
  return { path, artifactPath, frame };
};

const publicFrame = ({ frame }) => ({
  sha256: frame.sha256,
  sizeBytes: frame.sizeBytes,
  width: frame.width,
  height: frame.height,
});

const waitForDurablePreset = async (root, presetId, afterRevision) => {
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

const applyCompletePresetMatrix = async ({ root, initialState }) => {
  let state = initialState;
  const observations = [];
  for (const preset of SUBTITLE_PRESET_MATRIX) {
    const beforeDurable = durableRenderScenes(root).at(-1) ?? null;
    assert.ok(beforeDurable?.sceneRevision >= 1, `${preset.name}: no prior durable render scene`);
    state = await applyPreset(preset.name, state);
    const durableScene = await waitForDurablePreset(root, preset.id, beforeDurable.sceneRevision);
    const exact = verifyPresetObservation({
      preset,
      activePreset: state.activePreset,
      activePresetId: state.activePresetId,
      beforeSceneRevision: beforeDurable.sceneRevision,
      durableScene,
    });
    const frame = await frameEvidence({
      root,
      stem: preset.evidenceStem,
      description: `${preset.name} exact preset fields rendered as a drawable native canvas frame.`,
    });
    assert.equal(frame.artifactPath.endsWith(`${preset.nativeArtifactName}.png`), true, (
      `${preset.name}: native artifact name drifted from the reviewed evidence plan`
    ));
    const observation = Object.freeze({
      ...exact,
      canvasRevision: state.canvas.revision,
      overlayRebuilds: state.canvas.overlayRebuilds,
      frame: publicFrame(frame),
    });
    observations.push(Object.freeze({ preset, state, frame, observation }));
    if (preset.captureScreenshot) {
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: preset.screenshotStep,
        description: `${preset.name} is active, durable, exact and drawable in the real Render surface.`,
        details: observation,
        focusSelector: '.preview-customization-row',
      });
    }
  }
  assert.equal(observations.length, 30, 'the public preset matrix did not exercise all 30 buttons');
  assert.deepEqual(
    observations.map(({ observation }) => observation.id),
    SUBTITLE_PRESET_MATRIX.map(({ id }) => id),
    'the public preset matrix changed order or skipped a preset',
  );
  return Object.freeze({ state, observations: Object.freeze(observations) });
};

const applyControlWithEvidence = async ({
  root,
  state,
  beforeFrame,
  selector,
  value,
  read,
  label,
  kind,
  expectedValues,
  evidenceStem,
  description,
}) => {
  const nextState = await setControlAndWait({
    state,
    selector,
    value,
    read,
    label,
    kind,
    expectedValues,
  });
  const nextFrame = await frameEvidence({ root, stem: evidenceStem, description });
  const change = verifyCustomizationTransition({
    beforePath: beforeFrame.path,
    afterPath: nextFrame.path,
    compare: compareFrames,
    maximumSsim: 0.999_9,
  });
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: `${evidenceStem}-control-applied`,
    description,
    details: {
      control: selector,
      value,
      revision: nextState.canvas.revision,
      ssimFromPrevious: change.ssim,
      changedPixels: change.pixels.changedPixels,
      changedPixelRatio: change.pixels.changedRatio,
      frame: publicFrame(nextFrame),
    },
    focusSelector: selector,
  });
  return { state: nextState, frame: nextFrame, change };
};

describe('subtitle customization native preview', () => {
  it('renders distinct presets and controls, resolves a Windows system font, and restores Default', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run against an isolated data root');
    await openProjectWithMedia();
    await importSubtitleDocument(CUSTOMIZATION_SRT, 'customization-long-cue.srt', CUSTOMIZATION_CUE);
    await installVisibleErrorLedger();
    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'Render did not expose the native subtitle preview',
    });

    const beforeSeek = await previewState();
    await browser.execute((seconds) => {
      const video = document.querySelector('.video-preview-panel video');
      if (video === null) throw new Error('the Render preview video is missing');
      video.pause();
      video.currentTime = seconds;
    }, COMPARE_AT_SECONDS);
    let state = await waitForReadyChange(
      beforeSeek,
      'initial Render preview',
      () => true,
      { requireOverlayChange: false },
    );
    if (state.activePreset !== 'Default') state = await applyPreset('Default', state);
    const baseline = await frameEvidence({
      root,
      stem: '01-default',
      description: 'Known Default preset at the fixed one-second native comparison frame.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-default-preset-ready',
      description: 'Default starts with a ready native subtitle frame and no error surface.',
      details: {
        preset: state.activePreset,
        font: state.selectedFont,
        revision: state.canvas.revision,
        overlayRebuilds: state.canvas.overlayRebuilds,
        frame: publicFrame(baseline),
      },
      focusSelector: '.preview-customization-row',
    });

    state = await applyPresetDuringPlayback({ before: state, name: 'Classic' });
    const matrix = await applyCompletePresetMatrix({ root, initialState: state });
    state = matrix.state;
    const matrixById = new Map(
      matrix.observations.map(observation => [observation.preset.id, observation]),
    );
    const classic = matrixById.get('classic')?.frame;
    const neon = matrixById.get('neon')?.frame;
    assert.ok(classic && neon, 'the complete matrix did not retain Classic and Neon native frames');
    verifyCustomizationTransition({
      beforePath: baseline.path,
      afterPath: classic.path,
      compare: compareFrames,
    });
    verifyCustomizationTransition({
      beforePath: classic.path,
      afterPath: neon.path,
      compare: compareFrames,
    });

    // The exhaustive matrix ends at Forest. Return through its public button to Neon so the
    // following exact Arial-weight proof starts from the shipped 700-weight Neon face.
    state = await applyPreset('Neon', state);

    const arialWeight = await applyControlWithEvidence({
      root,
      state,
      beforeFrame: neon,
      selector: '#font-weight-slider',
      value: SYSTEM_FONT_WEIGHT,
      read: (next) => next.controls.fontWeight,
      label: 'Arial exact 400 weight dropdown',
      kind: 'dropdown',
      expectedValues: [400, 700],
      evidenceStem: '04-arial-400-weight',
      description: 'The public exact-weight dropdown changes Neon Arial from 700 to its reviewed 400 face.',
    });
    state = arialWeight.state;

    const fontSelection = await selectSystemFont(state);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-system-font-picker',
      description: 'The public picker offers the exact reviewed Windows system face before selection.',
      details: { requestedFont: SYSTEM_FONT },
      focusSelector: '.font-modal',
    });
    await fontSelection.card.click();
    await fontSelection.modal.waitForDisplayed({
      reverse: true,
      timeout: 30_000,
      timeoutMsg: 'the font picker did not close after choosing the system face',
    });
    state = await waitForReadyChange(
      fontSelection.before,
      `${SYSTEM_FONT} system font`,
      (next) => next.selectedFont === SYSTEM_FONT
        && next.selectedFontCss?.includes(SYSTEM_FONT)
        && Number(next.controls.fontWeight) === SYSTEM_FONT_WEIGHT,
    );
    const impactWeightContract = await usePublicDropdown({
      selector: '#font-weight-slider',
      expectedValues: [SYSTEM_FONT_WEIGHT],
      context: 'Impact exact weight contract',
    });
    const systemFaceReady = await browser.execute((family, weight) => (
      document.fonts?.check(`${weight} 16px "${family}"`) ?? false
    ), SYSTEM_FONT, SYSTEM_FONT_WEIGHT);
    assert.equal(systemFaceReady, true, `${SYSTEM_FONT} was selected without an installed face`);
    assert.match(state.selectedFontCss, /Impact/u, 'the font picker label did not bind Impact CSS');
    const systemFont = await frameEvidence({
      root,
      stem: '06-impact-system-font',
      description: 'The selected Impact system face remains native-preview ready.',
    });
    const systemFontChange = verifyCustomizationTransition({
      beforePath: arialWeight.frame.path,
      afterPath: systemFont.path,
      compare: compareFrames,
    });
    assert.equal(state.activePreset, null, 'manual system font selection did not enter Custom state');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '06-system-font-applied',
      description: 'At the same 400 weight, selecting Impact rebuilds the atlas and changes actual pixels from Arial.',
      details: {
        font: state.selectedFont,
        requestedCss: SYSTEM_FONT_CSS,
        exactWeightOptions: impactWeightContract.values,
        revision: state.canvas.revision,
        ssimFromArial400: systemFontChange.ssim,
        frame: publicFrame(systemFont),
      },
      focusSelector: '.preview-customization-row',
    });

    const fontSize = await applyControlWithEvidence({
      root,
      state,
      beforeFrame: systemFont,
      selector: '#font-size-slider',
      value: 96,
      read: (next) => next.controls.fontSize,
      label: '96px font-size control',
      evidenceStem: '07-font-size',
      description: 'The visible font-size slider independently enlarges native subtitle pixels.',
    });
    const sceneBeforeBackground = durableRenderScenes(root).at(-1);
    assert.ok(sceneBeforeBackground?.sceneRevision >= 1, 'the customization scene is not durable');
    const backgroundColor = await applyControlWithEvidence({
      root,
      state: fontSize.state,
      beforeFrame: fontSize.frame,
      selector: '#subtitle-background-color',
      value: '#7a003c',
      read: (next) => next.controls.backgroundColor,
      label: 'background-colour control',
      kind: 'text',
      evidenceStem: '08-background-colour',
      description: 'The visible background colour field independently changes native pixels.',
    });
    const durableBackground = await waitForDurableCustomization(
      root,
      'backgroundColor',
      '#7a003c',
      sceneBeforeBackground.sceneRevision,
    );
    assert.equal(
      durableBackground.scene.customization.backgroundColor,
      '#7a003c',
      'the public color field changed without changing the project-owned render scene',
    );
    const backgroundOpacity = await applyControlWithEvidence({
      root,
      state: backgroundColor.state,
      beforeFrame: backgroundColor.frame,
      selector: '#background-opacity-slider',
      value: 95,
      read: (next) => next.controls.backgroundOpacity,
      label: 'background-opacity control',
      evidenceStem: '09-background-opacity',
      description: 'The visible opacity slider independently raises the native subtitle background to 95% opacity.',
    });
    const borderRadius = await applyControlWithEvidence({
      root,
      state: backgroundOpacity.state,
      beforeFrame: backgroundOpacity.frame,
      selector: '#border-radius-slider',
      value: 36,
      read: (next) => next.controls.borderRadius,
      label: 'border-radius control',
      evidenceStem: '10-border-radius',
      description: 'The visible radius slider independently rounds the native subtitle background.',
    });
    const maxWidth = await applyControlWithEvidence({
      root,
      state: borderRadius.state,
      beforeFrame: borderRadius.frame,
      selector: '#max-width-slider',
      value: 35,
      read: (next) => next.controls.maxWidth,
      label: 'maximum-width control',
      evidenceStem: '11-maximum-width',
      description: 'The visible width slider independently wraps the long cue in native pixels.',
    });
    state = maxWidth.state;

    state = await applyPreset('Default', state);
    const restored = await frameEvidence({
      root,
      stem: '12-default-restored',
      description: 'Default selected again after every preset and manual control change.',
    });
    const restoration = verifyCustomizationRestoration({
      baselinePath: baseline.path,
      restoredPath: restored.path,
      divergentPaths: [
        classic.path,
        neon.path,
        arialWeight.frame.path,
        systemFont.path,
        fontSize.frame.path,
        backgroundColor.frame.path,
        backgroundOpacity.frame.path,
        borderRadius.frame.path,
        maxWidth.frame.path,
      ],
      compare: compareFrames,
    });
    assert.equal(state.activePreset, 'Default');
    assert.equal(state.selectedFont, 'Google Sans');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '12-default-pixels-restored',
      description: 'Default restores its original native pixels, not only the selected button label.',
      details: {
        preset: state.activePreset,
        font: state.selectedFont,
        revision: state.canvas.revision,
        restoredSsim: restoration.restoredSsim,
        closestChangedSsim: restoration.closestDivergent,
        frame: publicFrame(restored),
      },
      focusSelector: '.preview-customization-row',
    });
    const finalState = assertReady(await previewState(), 'final restored Default evidence');
    assert.equal(finalState.activePreset, 'Default');
    assert.equal(finalState.selectedFont, 'Google Sans');
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
