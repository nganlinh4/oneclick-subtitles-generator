// A non-Cartesian real-customer sweep of subtitle material, placement and animation. The guarded
// binary stays off-screen/non-focusable/muted; every action goes through a shipped WebView control.

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

import { durableRenderScenes } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import {
  compareFrameDominantDifferenceComponent,
  compareFramePixels,
  compareFramePixelGeometry,
  compareFrames,
  measureFrameSignal,
  savePreviewElementFrame,
} from '../support/nativeMediaOracle.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import {
  ANIMATION_CASES,
  ANIMATION_CUE,
  ANIMATION_EASING_VALUES,
  ANIMATION_PHASES,
  ANIMATION_TYPE_VALUES,
  MATERIAL_GROUPS,
  verifyAnimationCoverage,
  verifyAnimationObservation,
  verifyLiveFontPresetTransition,
  verifyMaterialAction,
  verifyMaterialCoverage,
  verifySubtitleContainment,
} from '../support/subtitleMaterialAnimationOracle.js';
import {
  describeCustomizationNativeFrame,
  verifyCustomizationTransition,
} from '../support/subtitleCustomizationFrameOracle.js';
import { importSubtitleDocument, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'subtitle-material-and-animation';
const CANVAS = '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]';
const SEEK = '.video-preview-panel [data-osg-control="seek"]';
const PLAY_PAUSE = '.video-preview-panel [data-osg-control="play-pause"]';
const CUE_START = ANIMATION_CUE.start;
const CUE_END = ANIMATION_CUE.end;
const MATERIAL_TIME = 8;
const CUE_TEXT = 'Mixed Case café é — Tiếng Việt rõ ràng — 한국어 자막 😀';
const MATERIAL_SRT = `1
00:00:02,000 --> 00:00:14,000
${CUE_TEXT}
Arabic العربية مرحبا 123 — emoji 👨‍👩‍👧‍👦 — combining é
Long wrapping line proves alignment, line height, margins, width, transforms and typewriter clusters.
`;

/* global $, $$, MutationObserver, browser, describe, document, getComputedStyle, it, performance, requestAnimationFrame, window */

const errorSelector = [
  '.video-rendering-section.expanded [role="alert"]',
  '.video-rendering-section.expanded .error',
  '.video-rendering-section.expanded .error-message',
  '.video-rendering-section.expanded .video-error',
  '.toast-item.live .toast-error',
  '.toast-item.live .toast-warning',
].join(',');

const installVisibleErrorLedger = () => browser.execute((selector) => {
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

const previewState = () => browser.execute((selector) => {
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

const waitForReady = async ({
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

const publicSeek = async (seconds, paused, { cue = '0', status = 'ready' } = {}) => {
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
      return state.video !== null
        && state.video.paused === paused
        && !state.video.seeking
        && Math.abs(state.video.currentTime - seconds) <= 0.05
        && state.canvas?.revision > before.canvas.revision
        && Number.isFinite(state.canvas.transportTime)
        && Number.isFinite(state.canvas.sceneTime)
        && Math.abs(state.canvas.sceneTime - seconds) <= 0.05
        && Math.abs(state.canvas.transportTime - reachableSeconds) <= 0.000_001
        && state.canvas.sceneTime <= state.canvas.transportTime + 0.000_001
        && state.canvas.transportTime - state.canvas.sceneTime <= step + 0.000_001
        && (state.canvas.sourceClockProvenance === 'rvfc'
          ? Number.isFinite(state.canvas.sourceMediaTime)
          : state.canvas.sourceMediaTime === null)
        && state.canvas.cue === cue
        && state.preview?.status === status;
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

const setPlaying = async (playing) => {
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

const usePublicDropdown = async (spec) => {
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

const performControl = (spec) => {
  if (spec.kind === 'range') return setPublicRange(spec);
  if (spec.kind === 'dropdown') return usePublicDropdown(spec);
  if (spec.kind === 'colour') return setPublicColour(spec);
  if (spec.kind === 'toggle') return setPublicToggle(spec);
  throw new Error(`unsupported public control kind: ${spec.kind}`);
};

const soleDurableRenderScene = (root, expectedProjectId = null, context = 'render scene') => {
  const scenes = durableRenderScenes(root);
  assert.equal(scenes.length, 1, `${context}: isolated workflow owns ${scenes.length} durable scenes`);
  const scene = scenes[0];
  assert.equal(scene.schemaVersion, 1, `${context}: durable scene schema is not v1`);
  if (expectedProjectId !== null) {
    assert.equal(scene.projectId, expectedProjectId, `${context}: durable scene changed project identity`);
  }
  return scene;
};

const waitForDurableCustomization = async (
  root,
  expectedProjectId,
  expectedCustomization,
  afterRevision,
  context,
) => {
  let scene = null;
  await waitUntilWithFreshDiagnostic(async () => {
    scene = soleDurableRenderScene(root, expectedProjectId, context);
    return scene?.sceneRevision > afterRevision
      && isDeepStrictEqual(scene?.scene?.customization, expectedCustomization);
  }, {
    timeout: 10_000,
    interval: 100,
    diagnostic: () => `${context}: SQLite did not commit the complete expected customization: ${JSON.stringify(scene)}`,
  });
  return scene;
};

const waitForDurablePreset = async (root, expectedProjectId, preset, afterRevision) => {
  let scene = null;
  await waitUntilWithFreshDiagnostic(async () => {
    scene = soleDurableRenderScene(root, expectedProjectId, `preset ${preset}`);
    return scene?.sceneRevision > afterRevision && scene?.scene?.customization?.preset === preset;
  }, {
    timeout: 10_000,
    interval: 100,
    diagnostic: () => `SQLite did not commit preset ${preset}: ${JSON.stringify(scene)}`,
  });
  return scene;
};

const captureNativeFrame = async (root, name) => {
  const path = join(root, 'evidence', 'subtitle-material-animation', `${name}.png`);
  const geometry = await savePreviewElementFrame(path, CANVAS);
  assert.ok(Number.isFinite(geometry.capture?.clock?.transportTime), (
    `${name}: captured frame omitted its transport clock`
  ));
  assert.ok(Number.isFinite(geometry.capture?.clock?.sceneTime), (
    `${name}: captured frame omitted its output-scene clock`
  ));
  assert.ok(geometry.capture?.crop?.cropWidth > 0 && geometry.capture?.crop?.cropHeight > 0, (
    `${name}: captured frame omitted its physical WebView crop plan`
  ));
  assert.ok(['rvfc', 'settled-transport', 'transport-only'].includes(
    geometry.capture?.clock?.sourceClockProvenance,
  ), `${name}: captured frame omitted source-clock provenance`);
  assert.equal(
    Number.isFinite(geometry.capture?.clock?.sourceMediaTime),
    geometry.capture?.clock?.sourceClockProvenance === 'rvfc',
    `${name}: decoded-source PTS does not agree with its provenance`,
  );
  const frame = describeCustomizationNativeFrame(path, geometry);
  return Object.freeze({ path, geometry, frame });
};

const assertComparableCapture = (source, candidate, context) => {
  assert.ok(source !== null && candidate !== null, `${context}: capture telemetry is absent`);
  for (const field of ['width', 'height']) {
    assert.equal(candidate.window?.[field], source.window?.[field], (
      `${context}: WebView ${field} changed between the source and composed captures`
    ));
    assert.equal(candidate.canvas?.[field], source.canvas?.[field], (
      `${context}: Canvas backing ${field} changed between the source and composed captures`
    ));
    assert.equal(candidate.viewport?.[field], source.viewport?.[field], (
      `${context}: renderer viewport ${field} changed between the source and composed captures`
    ));
    assert.equal(candidate.screenshot?.[field], source.screenshot?.[field], (
      `${context}: WebView screenshot ${field} changed between the source and composed captures`
    ));
    const targetField = `target${field[0].toUpperCase()}${field.slice(1)}`;
    assert.equal(candidate.crop?.[targetField], source.crop?.[targetField], (
      `${context}: normalized crop ${field} changed`
    ));
    const boundsDelta = Math.abs(
      Number(candidate.canvas?.bounds?.[field]) - Number(source.canvas?.bounds?.[field]),
    );
    assert.ok(Number.isFinite(boundsDelta) && boundsDelta <= 0.02, (
      `${context}: Canvas CSS ${field} drifted by ${boundsDelta} pixels`
    ));
  }
  for (const field of ['cropWidth', 'cropHeight']) {
    const delta = Math.abs(Number(candidate.crop?.[field]) - Number(source.crop?.[field]));
    assert.ok(Number.isFinite(delta) && delta <= 1, (
      `${context}: physical ${field} drifted by ${delta} pixels`
    ));
  }
  for (const [cropField, boundsField, windowField, screenshotField] of [
    ['cropLeft', 'left', 'width', 'width'],
    ['cropTop', 'top', 'height', 'height'],
  ]) {
    const relativeCrop = capture => Number(capture.crop?.[cropField]) - Math.round(
      Number(capture.canvas?.bounds?.[boundsField])
        * Number(capture.screenshot?.[screenshotField]) / Number(capture.window?.[windowField]),
    );
    const delta = Math.abs(relativeCrop(candidate) - relativeCrop(source));
    assert.ok(Number.isFinite(delta) && delta <= 1, (
      `${context}: Canvas-relative ${cropField} drifted by ${delta} pixels`
    ));
  }
  for (const field of ['transportTime', 'sceneTime']) {
    const delta = Math.abs(Number(candidate.clock?.[field]) - Number(source.clock?.[field]));
    assert.ok(Number.isFinite(delta) && delta <= 0.02, (
      `${context}: ${field} drifted by ${delta} seconds`
    ));
  }
  const sourceHasPts = source.clock?.sourceClockProvenance === 'rvfc';
  const candidateHasPts = candidate.clock?.sourceClockProvenance === 'rvfc';
  if (sourceHasPts && candidateHasPts) {
    const delta = Math.abs(
      Number(candidate.clock.sourceMediaTime) - Number(source.clock.sourceMediaTime),
    );
    assert.ok(Number.isFinite(delta) && delta <= 0.02, (
      `${context}: authoritative decoded-source PTS drifted by ${delta} seconds`
    ));
  }
  return Object.freeze({
    maximumRelativeCropDeltaPixels: 1,
    maximumClockDeltaSeconds: 0.02,
  });
};

/**
 * Capture source-only controls through the exact Canvas presentation path later used for subtitle
 * composition. Hiding Canvas and screenshotting the DOM video crosses two colour/scaling paths;
 * sparse conversion differences then polluted geometry bounds across almost the entire frame.
 */
const captureSourceCanvasBaselines = async (root) => {
  const baselines = {};
  for (const phase of ANIMATION_PHASES) {
    await publicSeek(phase.seconds, true, { cue: '', status: 'empty' });
    const first = await captureNativeFrame(root, `source-canvas-${phase.name}-first`);
    await publicSeek(phase.seconds + 0.12, true, { cue: '', status: 'empty' });
    await publicSeek(phase.seconds, true, { cue: '', status: 'empty' });
    const repeated = await captureNativeFrame(root, `source-canvas-${phase.name}-repeated`);
    assertComparableCapture(
      first.geometry.capture,
      repeated.geometry.capture,
      `${phase.name} repeated source baseline`,
    );
    assert.equal(repeated.frame.sha256, first.frame.sha256, (
      `${phase.name}: repeated ready-empty Canvas source frame was not deterministic`
    ));
    baselines[phase.name] = first;
  }
  return Object.freeze(baselines);
};

const publicFrame = frame => Object.freeze({
  sha256: frame.frame.sha256,
  sizeBytes: frame.frame.sizeBytes,
  width: frame.frame.width,
  height: frame.frame.height,
  capture: frame.geometry.capture ?? null,
});

const applyMaterialAction = async ({
  root,
  projectId,
  spec,
  state,
  beforeFrame,
  ordinal,
  expectedCustomization,
}) => {
  const beforeScene = soleDurableRenderScene(root, projectId, `${spec.token} prior scene`);
  assert.ok(beforeScene?.sceneRevision >= 1, `${spec.token}: prior durable scene is absent`);
  const observedValue = await performControl(spec);
  const nextExpectedCustomization = Object.freeze({
    ...expectedCustomization,
    [spec.field]: observedValue,
    preset: 'custom',
  });
  // `data-osg-overlay-rebuilds` counts rebuilds of the renderer's cached *static* overlay. A cue
  // sampled inside its fade window is intentionally dynamic and paints directly into each frame,
  // so that counter must not advance. Requiring it here made a visibly correct animated frame wait
  // forever. Revision/cue/readiness below and the independently decoded before/after pixels remain
  // mandatory; only the inapplicable static-cache counter is omitted for boundary samples.
  const samplesDynamicAnimationPhase = Number.isFinite(spec.atSeconds);
  const nextState = await waitForReady({
    before: state,
    paused: true,
    overlay: !samplesDynamicAnimationPhase,
    context: spec.token,
  });
  const durableScene = await waitForDurableCustomization(
    root,
    projectId,
    nextExpectedCustomization,
    beforeScene.sceneRevision,
    spec.token,
  );
  const nextFrame = await captureNativeFrame(
    root, `material-${String(ordinal).padStart(2, '0')}-${spec.token}`,
  );
  const frameChange = verifyCustomizationTransition({
    beforePath: beforeFrame.path,
    afterPath: nextFrame.path,
    compare: compareFrames,
    maximumSsim: 0.999_99,
    minimumChangedPixels: 32,
    minimumChangedRatio: 0.000_05,
  });
  const observation = verifyMaterialAction({
    spec,
    observedValue,
    beforeRevision: beforeScene.sceneRevision,
    expectedCustomization: nextExpectedCustomization,
    expectedProjectId: projectId,
    durableScene,
    frameChange,
    state: nextState,
  });
  return Object.freeze({
    state: nextState,
    frame: nextFrame,
    observation,
    expectedCustomization: nextExpectedCustomization,
    durableScene,
  });
};

const copyGroupEvidence = ({ group, frame, observations }) => {
  const name = `${group.step}-native-frame`;
  const artifact = copyWorkflowArtifact({
    workflow: WORKFLOW,
    name,
    source: frame.path,
    description: `${group.description} Native compositor frame after the complete group.`,
  });
  const copied = describeCustomizationNativeFrame(artifact, frame.geometry);
  assert.equal(copied.sha256, frame.frame.sha256, `${group.id}: copied frame bytes changed`);
  return Object.freeze({
    artifact,
    frame: publicFrame(frame),
    controls: observations.map(item => item.observation),
  });
};

const applyAnimationDropdown = async ({
  root, projectId, spec, state, expectedCustomization,
}) => {
  const beforeScene = soleDurableRenderScene(root, projectId, `${spec.token} prior scene`);
  assert.ok(beforeScene?.sceneRevision >= 1);
  const value = await usePublicDropdown(spec);
  const nextState = await waitForReady({
    before: state,
    paused: false,
    overlay: true,
    context: spec.token,
  });
  assert.equal(expectedCustomization[spec.field], value, `${spec.token}: intended animation delta is wrong`);
  const durable = await waitForDurableCustomization(
    root,
    projectId,
    expectedCustomization,
    beforeScene.sceneRevision,
    spec.token,
  );
  assert.deepEqual(nextState.currentErrors, []);
  assert.deepEqual(nextState.recordedErrors, []);
  assert.deepEqual(nextState.recordedRefusals, []);
  return Object.freeze({ state: nextState, durable });
};

const startAnimationWitness = () => browser.execute((selector, phases) => {
  window.__OSG_E2E_ANIMATION_WITNESS__?.cleanup?.();
  const video = document.querySelector('.video-preview-panel video');
  const canvas = document.querySelector(
    '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]',
  );
  if (video === null || canvas === null || video.paused) throw new Error('animation playback is not running');
  const witness = {
    active: true,
    startedAt: performance.now(),
    samples: [],
    mediaEvents: [],
    publications: [],
    transientTransitions: [],
    listeners: [],
  };
  const restorers = [];
  let transitionObserver = null;
  let publicationObserver = null;
  let cleaned = false;
  witness.cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    witness.active = false;
    transitionObserver?.disconnect();
    publicationObserver?.disconnect();
    for (const [type, listener] of witness.listeners) video.removeEventListener(type, listener);
    witness.listeners = [];
    while (restorers.length > 0) restorers.pop()();
  };
  const preview = document.querySelector('.video-preview-panel [data-osg-preview]');
  const panel = canvas.closest('.video-preview-panel');
  if (panel === null
      || canvas.dataset.osgCueIndex !== '0'
      || preview?.getAttribute('data-osg-preview') !== 'ready') {
    throw new Error('animation witness did not start from one ready authored cue');
  }

  try {
    // Capability-origin video intentionally taints the presentation canvas, so a pixel-only WebView
    // oracle would be disabled on the exact production path it must protect. Trace the independent
    // Canvas2D primitives that publish the visible surface and also read a deterministic 24x14 ROI
    // whenever the browser permits it. The operation trace does not trust frame-revision/status data:
    // it follows real video and glyph-atlas paint through the work canvases into each visible draw.
    const visibleContext = canvas.getContext('2d');
  if (visibleContext === null) throw new Error('animation canvas has no readable 2D presentation context');
  const contextPrototype = Object.getPrototypeOf(visibleContext);
  const canvasStates = new WeakMap();
  let publication = null;
  let publicationSequence = 0;
  let pixelMode = 'probing';
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 24;
  sampleCanvas.height = 14;
  const sampleContext = sampleCanvas.getContext('2d', { alpha: true });
  if (sampleContext === null) throw new Error('animation visual sentinel could not allocate its ROI');

  const blankCanvasState = () => ({
    known: false,
    hasVideo: false,
    hasOverlay: false,
    hasGlyphInk: false,
    backdrop: 'unknown',
    sourceTime: null,
  });
  const canvasState = (target) => {
    let state = canvasStates.get(target);
    if (state === undefined) {
      state = blankCanvasState();
      canvasStates.set(target, state);
    }
    return state;
  };
  const coversCanvas = (target, args) => Number(args[0]) <= 0 && Number(args[1]) <= 0
    && Number(args[2]) >= target.width && Number(args[3]) >= target.height;
  const blackPaint = value => typeof value === 'string' && (
    /^(?:#0{3,8}|black)$/iu.test(value.trim())
    || /^rgba?\(\s*0\s*[, ]\s*0\s*[, ]\s*0(?:\s*[,/]\s*(?:1(?:\.0*)?|100%))?\s*\)$/iu.test(value.trim())
  );
  const replaceState = (target, next) => {
    const state = canvasState(target);
    Object.assign(state, next);
    return state;
  };
  const publishVisibleState = (method) => {
    const state = canvasState(canvas);
    publicationSequence += 1;
    publication = {
      sequence: publicationSequence,
      method,
      hasVideo: state.hasVideo,
      hasOverlay: state.hasOverlay,
      hasGlyphInk: state.hasGlyphInk,
      backdrop: state.backdrop,
      sourceTime: state.sourceTime,
    };
  };
  const inspectOriginCleanCanvas = (source) => {
    const state = canvasState(source);
    if (state.known || source.width <= 0 || source.height <= 0) return state;
    try {
      const sourceContext = source.getContext('2d');
      const pixels = sourceContext?.getImageData(0, 0, source.width, source.height).data;
      if (pixels === undefined) return state;
      let hasAlpha = false;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] !== 0) {
          hasAlpha = true;
          break;
        }
      }
      replaceState(source, {
        known: true,
        hasVideo: false,
        hasOverlay: hasAlpha,
        hasGlyphInk: hasAlpha,
        backdrop: hasAlpha ? 'paint' : 'transparent',
        sourceTime: null,
      });
    } catch {
      // A tainted work canvas must already have acquired its video flag through the traced draw.
      // Leaving an otherwise unknown canvas unknown makes the publication fail closed below.
    }
    return state;
  };
  const patchContextMethod = (name, after) => {
    const original = contextPrototype[name];
    if (typeof original !== 'function') throw new Error(`Canvas2D.${name} is unavailable`);
    const wrapped = function wrappedCanvasMethod(...args) {
      const result = Reflect.apply(original, this, args);
      after(this, args);
      return result;
    };
    contextPrototype[name] = wrapped;
    restorers.push(() => {
      if (contextPrototype[name] === wrapped) contextPrototype[name] = original;
    });
    if (contextPrototype[name] !== wrapped) throw new Error(`Canvas2D.${name} could not be observed`);
  };

  patchContextMethod('clearRect', (context, args) => {
    if (!coversCanvas(context.canvas, args)) return;
    replaceState(context.canvas, {
      known: true,
      hasVideo: false,
      hasOverlay: false,
      hasGlyphInk: false,
      backdrop: 'transparent',
      sourceTime: null,
    });
    if (context === visibleContext) publishVisibleState('clearRect');
  });
  patchContextMethod('fillRect', (context, args) => {
    const state = canvasState(context.canvas);
    const opaqueReplacement = coversCanvas(context.canvas, args)
      && context.globalCompositeOperation === 'source-over'
      && context.globalAlpha >= 0.999;
    if (opaqueReplacement) {
      replaceState(context.canvas, {
        known: true,
        hasVideo: false,
        hasOverlay: false,
        hasGlyphInk: false,
        backdrop: blackPaint(context.fillStyle) ? 'black' : 'paint',
        sourceTime: null,
      });
    } else if (state.hasVideo || state.hasOverlay || context.globalCompositeOperation !== 'source-over') {
      state.known = true;
      state.hasOverlay = true;
    } else if (blackPaint(context.fillStyle)) {
      state.known = true;
      state.backdrop = 'black';
    }
    if (context === visibleContext) publishVisibleState('fillRect');
  });
  for (const name of ['fill', 'stroke']) {
    patchContextMethod(name, (context) => {
      const state = canvasState(context.canvas);
      state.known = true;
      state.hasOverlay = true;
      if (context === visibleContext) publishVisibleState(name);
    });
  }
  patchContextMethod('putImageData', (context, args) => {
    const pixels = args[0]?.data;
    let hasAlpha = false;
    if (pixels !== undefined) {
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] !== 0) {
          hasAlpha = true;
          break;
        }
      }
    }
    const state = canvasState(context.canvas);
    state.known = true;
    state.hasOverlay ||= hasAlpha;
    state.hasGlyphInk ||= hasAlpha;
    if (context === visibleContext) publishVisibleState('putImageData');
  });
  patchContextMethod('drawImage', (context, args) => {
    const source = args[0];
    const target = canvasState(context.canvas);
    if (source === video) {
      target.known = true;
      target.hasVideo = true;
      target.sourceTime = video.currentTime;
    } else if (source !== null && typeof source === 'object'
        && Number.isFinite(source.width) && Number.isFinite(source.height)
        && typeof source.getContext === 'function') {
      const sourceState = inspectOriginCleanCanvas(source);
      if (context === visibleContext) {
        replaceState(context.canvas, { ...sourceState });
      } else {
        target.known ||= sourceState.known;
        target.hasVideo ||= sourceState.hasVideo;
        target.hasOverlay ||= sourceState.hasOverlay;
        target.hasGlyphInk ||= sourceState.hasGlyphInk;
        if (sourceState.hasVideo) target.sourceTime = sourceState.sourceTime;
      }
    }
    if (context === visibleContext) publishVisibleState('drawImage');
  });

  const pixelSample = () => {
    if (pixelMode === 'tainted-operation-trace') return null;
    try {
      sampleContext.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
      sampleContext.drawImage(canvas, 0, 0, sampleCanvas.width, sampleCanvas.height);
      const pixels = sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
      let transparent = 0;
      let nearBlack = 0;
      let hash = 2_166_136_261;
      for (let index = 0; index < pixels.length; index += 4) {
        const alpha = pixels[index + 3];
        if (alpha === 0) transparent += 1;
        if (pixels[index] <= 4 && pixels[index + 1] <= 4 && pixels[index + 2] <= 4) nearBlack += 1;
        hash ^= pixels[index];
        hash = Math.imul(hash, 16_777_619);
        hash ^= pixels[index + 1];
        hash = Math.imul(hash, 16_777_619);
        hash ^= pixels[index + 2];
        hash = Math.imul(hash, 16_777_619);
        hash ^= alpha;
        hash = Math.imul(hash, 16_777_619);
      }
      pixelMode = 'pixels-and-operation-trace';
      const count = sampleCanvas.width * sampleCanvas.height;
      return {
        hash: (hash >>> 0).toString(16).padStart(8, '0'),
        transparent: transparent === count,
        nearBlack: nearBlack / count >= 0.995,
      };
    } catch (error) {
      if (error?.name !== 'SecurityError') throw error;
      pixelMode = 'tainted-operation-trace';
      return null;
    }
  };
  const visualSample = () => {
    const pixels = pixelSample();
    const classified = publication !== null;
    const hasVideo = publication?.hasVideo === true;
    const hasGlyphInk = publication?.hasGlyphInk === true;
    const style = getComputedStyle(canvas);
    const bounds = canvas.getBoundingClientRect();
    const visible = canvas.isConnected
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity) > 0
      && bounds.width > 0
      && bounds.height > 0
      && canvas.width > 0
      && canvas.height > 0;
    return {
      mode: pixelMode,
      classified,
      publication: publication?.sequence ?? 0,
      method: publication?.method ?? null,
      hasVideo,
      hasOverlay: publication?.hasOverlay === true,
      hasGlyphInk,
      visible,
      blank: classified && !hasVideo,
      transparent: classified && !hasVideo
        && (publication?.backdrop === 'transparent' || pixels?.transparent === true),
      black: classified && !hasVideo
        && (publication?.backdrop === 'black' || pixels?.nearBlack === true),
      sourceOnly: classified && hasVideo && (!hasGlyphInk || !visible),
      sourceTime: publication?.sourceTime ?? null,
      pixelHash: pixels?.hash ?? null,
    };
  };
  witness.markTransition = () => ({
    atMs: performance.now() - witness.startedAt,
    mediaTime: video.currentTime,
    revision: Number(canvas.dataset.osgFrameRevision ?? 0),
    overlayRebuilds: Number(canvas.dataset.osgOverlayRebuilds ?? 0),
    visual: visualSample(),
  });
  transitionObserver = new MutationObserver((records) => {
    for (const mutation of records) {
      const current = mutation.target.getAttribute?.(mutation.attributeName) ?? null;
      const previous = mutation.oldValue;
      let failed = false;
      if (mutation.attributeName === 'data-osg-cue-index') {
        failed = previous !== current && (previous !== '0' || current !== '0');
      } else if (mutation.attributeName === 'data-osg-preview') {
        failed = previous !== current && (previous !== 'ready' || current !== 'ready');
      } else if (mutation.attributeName === 'data-osg-preview-code') {
        failed = previous !== current && ((previous ?? '') !== '' || (current ?? '') !== '');
      }
      if (failed) witness.transientTransitions.push({
        attribute: mutation.attributeName,
        previous,
        current,
        atMs: performance.now() - witness.startedAt,
        mediaTime: video.currentTime,
      });
    }
  });
  transitionObserver.observe(panel, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['data-osg-cue-index', 'data-osg-preview', 'data-osg-preview-code'],
    subtree: true,
  });
  const visibleErrors = () => [...document.querySelectorAll(selector)].filter((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }).map(node => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean);
  publicationObserver = new MutationObserver(() => {
    const revision = Number(canvas.dataset.osgFrameRevision ?? 0);
    if (revision <= 0 || witness.publications.at(-1)?.revision === revision) return;
    witness.publications.push({
      atMs: performance.now() - witness.startedAt,
      mediaTime: video.currentTime,
      revision,
      overlayRebuilds: Number(canvas.dataset.osgOverlayRebuilds ?? 0),
      visibleErrors: visibleErrors(),
      recordedRefusals: [...(window.__OSG_E2E_MATERIAL_ERROR_LEDGER__?.refusals ?? [])],
      visual: visualSample(),
    });
  });
  publicationObserver.observe(canvas, {
    attributes: true,
    attributeFilter: ['data-osg-frame-revision'],
  });
  const onMediaEvent = (event) => witness.mediaEvents.push({
    type: event.type,
    atMs: performance.now() - witness.startedAt,
    mediaTime: video.currentTime,
    readyState: video.readyState,
    error: video.error === null ? null : { code: video.error.code, message: video.error.message },
  });
  for (const type of ['abort', 'emptied', 'error', 'playing', 'stalled', 'waiting']) {
    video.addEventListener(type, onMediaEvent);
    witness.listeners.push([type, onMediaEvent]);
  }
  const tick = () => {
    if (!witness.active) return;
    const mediaTime = video.currentTime;
    const phase = phases.find(candidate => mediaTime >= candidate.minimum && mediaTime <= candidate.maximum);
    witness.samples.push({
      phase: phase?.name ?? null,
      atMs: performance.now() - witness.startedAt,
      mediaTime,
      revision: Number(canvas.dataset.osgFrameRevision ?? 0),
      overlayRebuilds: Number(canvas.dataset.osgOverlayRebuilds ?? 0),
      cue: canvas.dataset.osgCueIndex ?? '',
      preview: document.querySelector('.video-preview-panel [data-osg-preview]')
        ?.getAttribute('data-osg-preview') ?? null,
      previewCode: document.querySelector('.video-preview-panel [data-osg-preview]')
        ?.getAttribute('data-osg-preview-code') || null,
      paused: video.paused,
      ended: video.ended,
      readyState: video.readyState,
      error: video.error === null ? null : { code: video.error.code, message: video.error.message },
      visibleErrors: visibleErrors(),
      recordedRefusals: [...(window.__OSG_E2E_MATERIAL_ERROR_LEDGER__?.refusals ?? [])],
      visual: visualSample(),
    });
    // 5,000 bounds memory while still spanning the whole cue on high-refresh (240 Hz) displays.
    if (witness.samples.length < 5_000) requestAnimationFrame(tick);
  };
  window.__OSG_E2E_ANIMATION_WITNESS__ = witness;
  requestAnimationFrame(tick);
  return true;
  } catch (error) {
    witness.cleanup();
    throw error;
  }
}, errorSelector, ANIMATION_PHASES);

const markAnimationWitnessTransition = () => browser.execute(() => {
  const witness = window.__OSG_E2E_ANIMATION_WITNESS__;
  if (witness === undefined || witness.active !== true || typeof witness.markTransition !== 'function') {
    throw new Error('animation witness cannot mark a live transition');
  }
  return witness.markTransition();
});

const cleanupAnimationWitness = () => browser.execute(() => {
  window.__OSG_E2E_ANIMATION_WITNESS__?.cleanup?.();
  return true;
});

const stopAnimationWitness = () => browser.execute(() => {
  const witness = window.__OSG_E2E_ANIMATION_WITNESS__;
  if (witness === undefined) throw new Error('animation witness disappeared');
  witness.cleanup();
  return {
    samples: witness.samples,
    mediaEvents: witness.mediaEvents,
    publications: witness.publications,
    transientTransitions: witness.transientTransitions,
  };
});

const witnessThroughCue = async () => {
  await startAnimationWitness();
  let witness = null;
  try {
    let state = null;
    await waitUntilWithFreshDiagnostic(async () => {
      state = await previewState();
      return state.video?.paused === false && state.video.currentTime >= ANIMATION_CUE.witnessEnd;
    }, {
      timeout: 30_000,
      interval: 40,
      diagnostic: () => `continuous entry-to-exit playback stalled: ${JSON.stringify(state)}`,
    });
    witness = await stopAnimationWitness();
  } finally {
    await cleanupAnimationWitness();
  }
  return Object.freeze({
    continuitySamples: witness.samples,
    mediaEvents: witness.mediaEvents,
    transientTransitions: witness.transientTransitions,
    samplesByPhase: Object.fromEntries(ANIMATION_PHASES.map(phase => [
      phase.name,
      witness.samples.filter(sample => sample.phase === phase.name),
    ])),
  });
};

const captureSourceControl = async (root, animation, phase, mediaTime, sourceBaseline) => {
  const composed = await captureNativeFrame(root, `animation-${animation.id}-${phase.name}-composed`);
  assert.ok(sourceBaseline?.path && sourceBaseline?.frame, `${phase.name}: source Canvas baseline is absent`);
  const sourcePath = sourceBaseline.path;
  const captureCompatibility = assertComparableCapture(
    sourceBaseline.geometry.capture,
    composed.geometry.capture,
    `${animation.id}/${phase.name}`,
  );
  const subtitlePixels = compareFramePixels(sourcePath, composed.path, { channelDeltaThreshold: 16 });
  const subtitleGeometry = compareFramePixelGeometry(
    sourcePath,
    composed.path,
    { channelDeltaThreshold: 16 },
  );
  return Object.freeze({
    phase: phase.name,
    mediaTime,
    composed,
    sourcePath,
    sourceCapture: sourceBaseline.geometry.capture ?? null,
    captureCompatibility,
    subtitlePixels,
    subtitleGeometry,
    composedSignal: measureFrameSignal(composed.path),
    sourceSignal: measureFrameSignal(sourcePath),
  });
};

const captureAnimationPhaseProofs = async (root, animation, sourceBaselines) => {
  const proofs = {};
  for (const phase of ANIMATION_PHASES) {
    const state = await publicSeek(phase.seconds, true);
    proofs[phase.name] = await captureSourceControl(
      root,
      animation,
      phase,
      state.video.currentTime,
      sourceBaselines[phase.name],
    );
  }
  return Object.freeze(proofs);
};

const temporalPhaseTransitions = frameProofs => Object.freeze({
  entryToSteady: verifyCustomizationTransition({
    beforePath: frameProofs.entry.composed.path,
    afterPath: frameProofs.steady.composed.path,
    compare: compareFrames,
    maximumSsim: 0.999_99,
    minimumChangedPixels: 64,
    minimumChangedRatio: 0.000_1,
  }),
  steadyToExit: verifyCustomizationTransition({
    beforePath: frameProofs.steady.composed.path,
    afterPath: frameProofs.exit.composed.path,
    compare: compareFrames,
    maximumSsim: 0.999_99,
    minimumChangedPixels: 64,
    minimumChangedRatio: 0.000_1,
  }),
  entryToExit: verifyCustomizationTransition({
    beforePath: frameProofs.entry.composed.path,
    afterPath: frameProofs.exit.composed.path,
    compare: compareFrames,
    maximumSsim: 0.999_99,
    minimumChangedPixels: 64,
    minimumChangedRatio: 0.000_1,
  }),
});

const animationTypeSpec = animation => ({
  token: `animation-${animation.type}`,
  field: 'animationType',
  selector: '#subtitle-animation-type',
  kind: 'dropdown',
  value: animation.type,
  values: ANIMATION_TYPE_VALUES,
});

const animationEasingSpec = animation => ({
  token: `easing-${animation.index}`,
  field: 'animationEasing',
  selector: '#subtitle-animation-easing',
  kind: 'dropdown',
  value: animation.easing,
  values: ANIMATION_EASING_VALUES,
});

describe('subtitle material and animation real preview', () => {
  it('persists every material control and keeps every animation drawable through playback', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run against an isolated data root');
    await installVisibleErrorLedger();
    await openProjectWithMedia();
    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'Render did not expose its native controls',
    });
    let state = await waitForReady({
      paused: true,
      cue: '',
      status: 'empty',
      requireOverlay: false,
      context: 'ready-empty source Canvas',
    });
    const sourceBaselines = await captureSourceCanvasBaselines(root);
    await importSubtitleDocument(MATERIAL_SRT, 'material-animation-unicode.srt', CUE_TEXT);
    state = await publicSeek(MATERIAL_TIME, true);

    const beforeGamingScene = soleDurableRenderScene(root, null, 'Gaming baseline');
    assert.ok(beforeGamingScene?.sceneRevision >= 1, 'Gaming baseline has no durable prior scene');
    const projectId = beforeGamingScene.projectId;
    const gaming = await $('[data-osg-preset="gaming"]');
    await gaming.waitForClickable({ timeout: 30_000, timeoutMsg: 'Gaming public preset is absent' });
    state = await setPlaying(true);
    await startAnimationWitness();
    let gamingWitness = null;
    let gamingTransition = null;
    try {
      await browser.pause(120);
      gamingTransition = await markAnimationWitnessTransition();
      await gaming.click();
      state = await waitForReady({
        before: state,
        paused: false,
        overlay: true,
        context: 'Gaming live font/preset baseline',
      });
      await browser.pause(360);
      gamingWitness = await stopAnimationWitness();
    } finally {
      await cleanupAnimationWitness();
    }
    state = await setPlaying(false);
    const gamingScene = await waitForDurablePreset(
      root,
      projectId,
      'gaming',
      beforeGamingScene.sceneRevision,
    );
    assert.ok(gamingScene.scene.customization.borderWidth > 0);
    assert.notEqual(gamingScene.scene.customization.borderStyle, 'none');
    assert.equal(gamingScene.scene.customization.glowEnabled, true);
    assert.equal(gamingScene.scene.customization.strokeEnabled, true);
    const gamingTransitionProof = verifyLiveFontPresetTransition({
      samples: gamingWitness.samples,
      publications: gamingWitness.publications,
      mediaEvents: gamingWitness.mediaEvents,
      transientTransitions: gamingWitness.transientTransitions,
      transition: gamingTransition,
      beforePreset: beforeGamingScene.scene.customization.preset,
      afterPreset: gamingScene.scene.customization.preset,
      beforeFontFamily: beforeGamingScene.scene.customization.fontFamily,
      afterFontFamily: gamingScene.scene.customization.fontFamily,
    });
    assert.ok(gamingTransitionProof.publishedFrames >= 2);
    // The live-preset witness intentionally advances playback. Every following material frame is
    // compared with the independently captured 8s source baseline, so restore that exact public
    // instant before establishing the composed baseline. Without this seek the old oracle compared
    // video pixels from ~8.7s with source pixels from 8.0s and mislabeled the full-frame delta as
    // subtitle clipping.
    state = await publicSeek(MATERIAL_TIME, true);
    let frame = await captureNativeFrame(root, '00-gaming-active-material-baseline');
    let expectedCustomization = Object.freeze({ ...gamingScene.scene.customization });

    const materialObservations = [];
    let ordinal = 0;
    for (const group of MATERIAL_GROUPS) {
      const groupResults = [];
      for (const spec of group.actions) {
        if (Number.isFinite(spec.atSeconds)) {
          state = await publicSeek(spec.atSeconds, true);
          frame = await captureNativeFrame(root, `material-${spec.token}-same-instant-baseline`);
        }
        ordinal += 1;
        const result = await applyMaterialAction({
          root,
          projectId,
          spec,
          state,
          beforeFrame: frame,
          ordinal,
          expectedCustomization,
        });
        state = result.state;
        frame = result.frame;
        expectedCustomization = result.expectedCustomization;
        groupResults.push(result);
        materialObservations.push(result.observation);
      }
      let containment = null;
      if (group.id === 'custom-position') {
        const captureCompatibility = assertComparableCapture(
          sourceBaselines.steady.geometry.capture,
          frame.geometry.capture,
          'custom-position containment',
        );
        containment = verifySubtitleContainment(compareFrameDominantDifferenceComponent(
          sourceBaselines.steady.path,
          frame.path,
          // The high threshold and dominant continuous component keep this contract about the
          // authored double-border material, not disconnected WebView crop/colour noise.
          {
            channelDeltaThreshold: 64,
            frameEdgeFringePixels: 3,
            dominantHaloPixels: 32,
          },
        ));
        containment = Object.freeze({ ...containment, captureCompatibility });
      }
      const evidence = copyGroupEvidence({ group, frame, observations: groupResults });
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: group.step,
        description: group.description,
        details: containment === null ? evidence : {
          ...evidence,
          containment,
          containmentSourceCapture: sourceBaselines.steady.geometry.capture ?? null,
        },
        focusSelector: '.preview-customization-row',
      });
    }
    const finalMaterialScene = soleDurableRenderScene(root, projectId, 'final material scene');
    const materialCoverage = verifyMaterialCoverage(materialObservations, {
      expectedCustomization,
      durableCustomization: finalMaterialScene?.scene?.customization,
    });

    const animationObservations = [];
    let previousEntry = null;
    for (const animation of ANIMATION_CASES) {
      state = await publicSeek(ANIMATION_CUE.witnessStart, true);
      state = await setPlaying(true);
      const caseBeforeScene = soleDurableRenderScene(root, projectId, `${animation.id} prior scene`);
      assert.ok(caseBeforeScene?.sceneRevision >= 1, `${animation.type}: prior durable scene is absent`);
      const expectedTypeCustomization = Object.freeze({
        ...expectedCustomization,
        ...(animation.editType ? { animationType: animation.type, preset: 'custom' } : {}),
      });
      let typeScene = caseBeforeScene;
      if (animation.editType) {
        const result = await applyAnimationDropdown({
          root,
          projectId,
          spec: animationTypeSpec(animation),
          state,
          expectedCustomization: expectedTypeCustomization,
        });
        state = result.state;
        typeScene = result.durable;
      } else {
        assert.equal(typeScene.scene.customization.animationType, animation.type);
      }
      const expectedFinalCustomization = Object.freeze({
        ...expectedTypeCustomization,
        ...(animation.editEasing ? { animationEasing: animation.easing, preset: 'custom' } : {}),
      });
      let easingScene = typeScene;
      if (animation.editEasing) {
        const result = await applyAnimationDropdown({
          root,
          projectId,
          spec: animationEasingSpec(animation),
          state,
          expectedCustomization: expectedFinalCustomization,
        });
        state = result.state;
        easingScene = result.durable;
      } else {
        assert.equal(easingScene.scene.customization.animationEasing, animation.easing);
      }
      expectedCustomization = expectedFinalCustomization;
      state = await publicSeek(ANIMATION_CUE.witnessStart, false);
      const temporal = await witnessThroughCue();
      state = await setPlaying(false);
      const frameProofs = await captureAnimationPhaseProofs(root, animation, sourceBaselines);
      const phaseTransitions = temporalPhaseTransitions(frameProofs);
      const entryChange = previousEntry === null ? null : verifyCustomizationTransition({
        beforePath: previousEntry.path,
        afterPath: frameProofs.entry.composed.path,
        compare: compareFrames,
        maximumSsim: 0.999_99,
        minimumChangedPixels: 64,
        minimumChangedRatio: 0.000_1,
      });
      const observation = verifyAnimationObservation({
        animation,
        beforeRevision: caseBeforeScene.sceneRevision,
        expectedProjectId: projectId,
        expectedTypeCustomization,
        expectedFinalCustomization,
        typeScene,
        easingScene,
        continuitySamples: temporal.continuitySamples,
        samplesByPhase: temporal.samplesByPhase,
        frameProofs,
        phaseTransitions,
        entryChange,
        transientTransitions: temporal.transientTransitions,
        mediaEvents: temporal.mediaEvents,
      });
      animationObservations.push(observation);
      previousEntry = frameProofs.entry.composed;

      if (animation.captureEvidence) {
        const representativePhase = animation.type === 'bounce' ? 'steady' : 'entry';
        const representative = frameProofs[representativePhase].composed;
        const name = `animation-${animation.id}-${representativePhase}-native-frame`;
        const artifact = copyWorkflowArtifact({
          workflow: WORKFLOW,
          name,
          source: representative.path,
          description: `${animation.type}/${animation.easing} at the ${representativePhase} phase.`,
        });
        const copied = describeCustomizationNativeFrame(artifact, representative.geometry);
        assert.equal(copied.sha256, representative.frame.sha256);
        state = await publicSeek(
          ANIMATION_PHASES.find(phase => phase.name === representativePhase).seconds,
          true,
        );
        await captureWorkflowStep({
          workflow: WORKFLOW,
          step: `animation-${animation.id}-${representativePhase}`,
          description: `${animation.type} stays drawable during real playback and differs from the same-instant source-only frame.`,
          details: {
            ...observation,
            representativePhase,
            frame: publicFrame(representative),
            sourceDelta: frameProofs[representativePhase].subtitlePixels,
            sourceCapture: frameProofs[representativePhase].sourceCapture,
          },
          focusSelector: '.preview-customization-row',
        });
      }
    }

    const animationCoverage = verifyAnimationCoverage(animationObservations);
    const finalState = await previewState();
    assert.equal(finalState.video.paused, true);
    assert.equal(finalState.preview.status, 'ready');
    assert.equal(finalState.canvas.cue, '0');
    assert.deepEqual(finalState.currentErrors, []);
    assert.deepEqual(finalState.recordedErrors, []);
    assert.deepEqual(finalState.recordedRefusals, []);
    assert.deepEqual(materialCoverage, { actions: materialObservations.length, groups: 7 });
    assert.deepEqual(animationCoverage, { cases: 16, types: 10, easings: 7 });
    assert.ok(
      finalState.video.currentTime > CUE_START - ANIMATION_CUE.fadeIn
        && finalState.video.currentTime < CUE_END + ANIMATION_CUE.fadeOut,
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
