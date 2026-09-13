import { strict as assert } from 'node:assert';
import { existsSync, lstatSync } from 'node:fs';
import {
  isAbsolute, relative, resolve, sep,
} from 'node:path';

import { durableRenderScenes, durableState } from './database.js';
import { managedArtifactFiles } from './downloadJourneyOracle.js';

/* global $, $$, MutationObserver, browser, document, getComputedStyle, window */

/**
 * The public render queue surface and its two settings dropdowns, shared by every journey that
 * admits native render jobs. One reader and one actuation path keep the cancel/retry journey and
 * the interrupt-recovery scenario looking at exactly the same customer surface.
 */

export const RENDER_ROW = '.video-rendering-section .rendering-row:has([data-osg-action="render-video"])';
export const RENDER_BUTTON = `${RENDER_ROW} [data-osg-action="render-video"]`;

const DEFAULT_MAX_RECORDED_RENDER_ERRORS = 32;

/**
 * A bounded MutationObserver ledger over the render section's error/warning surfaces.
 *
 * `queueSurface()` only reads what is currently visible; a toast that appeared and auto-dismissed
 * between two polls would never be observed. Installing this once at the start of a render journey
 * makes `assertNoRenderFailure` reject that transient failure too, through the same
 * `recordedErrors`/`recordedErrorOverflow` fields `queueSurface()` already exposes.
 */
export const installTransientRenderErrorLedger = (
  maximumEvents = DEFAULT_MAX_RECORDED_RENDER_ERRORS,
) => browser.execute((maximum) => {
  window.__OSG_E2E_RENDER_ERROR_LEDGER__?.observer?.disconnect?.();
  const events = [];
  let overflow = 0;
  const selector = [
    '.video-rendering-section [role="alert"]',
    '.video-rendering-section .error',
    '.video-rendering-section .error-message',
    '.video-rendering-section .video-error',
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
    const message = (node.innerText || node.textContent || '')
      .trim().replace(/\s+/g, ' ').slice(0, 400);
    if (!message || events.includes(message)) return;
    if (events.length >= maximum) {
      overflow += 1;
      return;
    }
    events.push(message);
  };
  const inspect = (candidate, requireVisible) => {
    const node = candidate?.nodeType === 1 ? candidate : candidate?.parentElement;
    if (node === null || node === undefined) return;
    if (node.matches?.(selector)) record(node, requireVisible);
    for (const descendant of node.querySelectorAll?.(selector) ?? []) {
      record(descendant, requireVisible);
    }
  };
  const captureVisible = () => {
    for (const node of document.querySelectorAll(selector)) record(node, true);
  };
  const observer = new MutationObserver((records) => {
    for (const mutation of records) {
      inspect(mutation.target, true);
      for (const added of mutation.addedNodes) inspect(added, false);
    }
    captureVisible();
  });
  observer.observe(document.body, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  window.__OSG_E2E_RENDER_ERROR_LEDGER__ = {
    events, get overflow() { return overflow; }, observer,
  };
  captureVisible();
  return true;
}, maximumEvents);

export const queueSurface = () => browser.execute(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
  };
  const text = (node) => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
  const statuses = ['pending', 'processing', 'cancelling', 'cancelled', 'completed', 'failed'];
  const rows = [...document.querySelectorAll('.video-rendering-section .queue-item')]
    .map((node, index) => ({
      index,
      status: statuses.find((candidate) => node.classList.contains(candidate)) ?? null,
      current: node.classList.contains('current'),
      text: text(node).slice(0, 1_000),
      canCancel: node.querySelector('.cancel-btn') !== null,
      canDownload: node.querySelector('.download-btn-success') !== null,
    }));
  return {
    rows,
    renderEnabled: document.querySelector(
      '.video-rendering-section [data-osg-action="render-video"]',
    )?.disabled === false,
    settingLabels: [...document.querySelectorAll(
      '.video-rendering-section .rendering-row:has([data-osg-action="render-video"]) '
      + '.custom-dropdown-button .dropdown-value',
    )].map(text),
    inlineErrors: [...document.querySelectorAll(
      '.video-rendering-section .error, .video-rendering-section [role="alert"]',
    )].filter(visible).map(text).filter(Boolean),
    toasts: [...document.querySelectorAll('.toast-item.live .toast')]
      .filter(visible).map((node) => ({ className: node.className, text: text(node) }))
      .filter(({ text: message }) => Boolean(message)),
    recordedErrors: [...(window.__OSG_E2E_RENDER_ERROR_LEDGER__?.events ?? [])],
    recordedErrorOverflow: window.__OSG_E2E_RENDER_ERROR_LEDGER__?.overflow ?? 0,
  };
});

export const assertNoRenderFailure = (surface) => {
  assert.deepEqual(surface.inlineErrors, [], 'the render queue shows an inline error');
  assert.deepEqual(
    surface.toasts.filter(({ className }) => /toast-(?:error|warning)/.test(className)),
    [],
    'the render queue shows an error or warning toast',
  );
  assert.equal(
    surface.rows.some(({ status }) => status === 'failed'),
    false,
    `the render queue contains a failed row: ${JSON.stringify(surface.rows)}`,
  );
  assert.equal(
    surface.recordedErrorOverflow,
    0,
    'the bounded transient render-error ledger overflowed',
  );
  assert.deepEqual(
    surface.recordedErrors,
    [],
    'a transient render error or warning appeared during the journey',
  );
};

export const chooseRenderSetting = async (dropdownIndex, optionIndex, expectedPrefix) => {
  const buttons = await $$(`${RENDER_ROW} .custom-dropdown-button`);
  assert.equal(buttons.length, 2, 'the render settings row does not expose two public dropdowns');
  const button = buttons[dropdownIndex];
  await button.waitForClickable({
    timeout: 30_000,
    timeoutMsg: `render dropdown ${dropdownIndex} never became clickable`,
  });
  const currentLabel = (await button.$('.dropdown-value').getText()).trim().replace(/\s+/g, ' ');
  // Re-selecting the current row is not a customer action and races the dropdown's morph animation.
  // Read the public value first so persistence journeys remain deterministic when their requested
  // setting is already the project default.
  if (currentLabel.startsWith(expectedPrefix)) return currentLabel;
  await button.click();
  const menu = await $('.custom-dropdown-clipper');
  await menu.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: `render dropdown ${dropdownIndex} did not open its public option list`,
  });
  const options = await $$('.custom-dropdown-clipper .dropdown-option');
  assert.ok(optionIndex >= 0 && optionIndex < options.length, (
    `render dropdown ${dropdownIndex} has no option ${optionIndex}`
  ));
  const option = options[optionIndex];
  const optionLabel = (await option.getText()).trim().replace(/\s+/g, ' ');
  assert.ok(optionLabel.startsWith(expectedPrefix), (
    `render option ${optionIndex} did not start with ${expectedPrefix}: ${optionLabel}`
  ));
  await option.waitForClickable({
    timeout: 30_000,
    timeoutMsg: `render option ${optionLabel} never became clickable`,
  });
  // CustomDropdown commits on its public pointer down/up contract, not on a synthetic change.
  await browser.action('pointer')
    .move({ origin: option })
    .down({ button: 0 })
    .pause(75)
    .up({ button: 0 })
    .perform();
  const value = await button.$('.dropdown-value');
  await browser.waitUntil(async () => (
    (await value.getText()).trim().replace(/\s+/g, ' ') === optionLabel
  ), {
    timeout: 30_000,
    interval: 50,
    timeoutMsg: `render dropdown ${dropdownIndex} never selected ${optionLabel}`,
  });
  await menu.waitForExist({
    reverse: true,
    timeout: 30_000,
    interval: 50,
    timeoutMsg: `render dropdown ${dropdownIndex} left its old option portal mounted`,
  });
  return optionLabel;
};

export const setRenderSettings = async ({
  root, resolution, resolutionOptionIndex, frameRate, frameRateOptionIndex, frameRatePrefix,
}) => {
  await chooseRenderSetting(0, resolutionOptionIndex, resolution);
  const frameRateLabel = await chooseRenderSetting(1, frameRateOptionIndex, frameRatePrefix);
  let observation = null;
  try {
    await browser.waitUntil(async () => {
      const scenes = durableRenderScenes(root);
      const durableScene = scenes.at(-1) ?? null;
      const latest = durableScene?.scene?.renderSettings ?? null;
      const surface = await queueSurface();
      observation = { durableScene, latest, labels: surface.settingLabels };
      return latest?.resolution === resolution
        && latest?.frameRate === frameRate
        && surface.settingLabels[0] === resolution
        && surface.settingLabels[1] === frameRateLabel;
    }, { timeout: 30_000, interval: 100 });
  } catch (error) {
    throw new Error(`render settings did not become durable: ${JSON.stringify(observation)}`, {
      cause: error,
    });
  }
  return observation.durableScene;
};

export const newJobsSince = (ledger, priorIds) => ledger.jobs.filter(({ id }) => !priorIds.has(id));

export const safeArtifactPath = (root, artifact) => {
  const artifactRoot = resolve(root, 'data', 'artifacts');
  const path = resolve(artifactRoot, artifact.relative_path);
  const child = relative(artifactRoot, path);
  assert.ok(
    child.length > 0
      && child !== '..'
      && !child.startsWith(`..${sep}`)
      && !isAbsolute(child),
    `render artifact escaped the isolated artifact root: ${artifact.relative_path}`,
  );
  return path;
};

/** Every durable artifact row and every byte in the artifact root must explain each other. */
export const assertManagedArtifactLedgerMatchesDisk = (root) => {
  const state = durableState(root);
  const artifactRoot = resolve(root, 'data', 'artifacts');
  const expected = [];
  for (const artifact of state.artifacts) {
    const path = safeArtifactPath(root, artifact);
    if (artifact.state === 'ready') {
      assert.ok(existsSync(path), `ready artifact ${artifact.id} has no managed bytes`);
      const metadata = lstatSync(path);
      assert.equal(metadata.isSymbolicLink(), false, `ready artifact ${artifact.id} is a symlink`);
      assert.equal(metadata.isFile(), true, `ready artifact ${artifact.id} is not a file`);
      assert.equal(
        metadata.size,
        artifact.size_bytes,
        `ready artifact ${artifact.id} byte count disagrees with its durable row`,
      );
      expected.push(relative(artifactRoot, path).split(sep).join('/'));
      continue;
    }
    assert.ok(
      artifact.state === 'pending' || artifact.state === 'failed',
      `artifact ${artifact.id} has an unknown durable state: ${artifact.state}`,
    );
    assert.equal(
      existsSync(path),
      false,
      `${artifact.state} artifact ${artifact.id} retained bytes that could look finished`,
    );
  }
  expected.sort();
  const actual = managedArtifactFiles(root)
    .map((path) => relative(resolve(root, 'data', 'artifacts'), path).split(sep).join('/'))
    .sort();
  assert.deepEqual(
    actual,
    expected,
    'the artifact root does not exactly match the ready durable artifact ledger',
  );
};
