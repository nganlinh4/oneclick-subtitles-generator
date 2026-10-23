// Authors one parity case through the visible subtitle and render controls, then waits for the
// durable scene and cue rows to reflect it.

import { strict as assert } from 'node:assert';

import { durableRenderScenes, durableState } from '../../../support/database.js';
import {
  EXPORT_ANIMATION_PARITY_CASES,
  EXPORT_PARITY_FPS,
  EXPORT_PARITY_RESOLUTION,
} from '../../../support/exportAnimationParityOracle.js';
import { actuateNativeRange } from '../../../support/nativeRange.js';

/* global $, $$, browser, document */
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

export const applyCaseThroughPublicControls = async (root, definition) => {
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

export const setFastExactRenderFormat = async (root) => {
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

export const waitForDurableCues = async (root) => {
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
