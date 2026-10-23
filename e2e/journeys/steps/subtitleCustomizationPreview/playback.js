// Live playback while a preset changes: public transport, seek and an in-page frame witness.
/* global $, browser, document, getComputedStyle, performance, requestAnimationFrame, window */

import { strict as assert } from 'node:assert';

import { actuateNativeRange } from '../../../support/nativeRange.js';
import {
  verifyLiveCustomizationPlayback,
} from '../../../support/subtitleCustomizationFrameOracle.js';
import { captureWorkflowStep } from '../../../support/workflowEvidence.js';
import { COMPARE_AT_SECONDS, WORKFLOW } from './constants.js';
import {
  assertReady, previewState, waitForReadyChange, waitUntilWithFreshDiagnostic,
} from './previewState.js';

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

export const seekRenderPreviewWithPublicControl = async (seconds, before) => {
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

export const applyPresetDuringPlayback = async ({ before, name }) => {
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
