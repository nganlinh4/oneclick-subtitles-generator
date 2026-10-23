// Reads the Main/Render preview canvas clocks and moves them only through the public transport:
// pause, pointer seek and bounded arrow-key frame correction.

import { strict as assert } from 'node:assert';

import { EXPORT_PARITY_FPS } from '../../../support/exportAnimationParityOracle.js';
import { MAIN_VIDEO, RENDER_VIDEO, waitUntilWithFreshDiagnostic } from './surfaces.js';

/* global $, browser, document */
export const canvasState = (canvasSelector, videoSelector, stateSelector) => browser.execute((
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

export const waitForExactCanvas = async ({
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

export const ensurePausedThroughPublicControl = async ({ state, playPauseSelector, label }) => {
  if (state.paused === true) return;
  const control = await $(playPauseSelector);
  await control.waitForClickable({ timeout: 30_000, timeoutMsg: `${label}: Pause is unavailable` });
  await control.click();
  await browser.waitUntil(async () => (
    (await browser.execute(selector => document.querySelector(selector)?.paused ?? null,
      label === 'Main' ? MAIN_VIDEO : RENDER_VIDEO)) === true
  ), { timeout: 5_000, interval: 30, timeoutMsg: `${label}: public Pause did not settle` });
};

export const pointerSeek = async ({ control, controlSelector, minimum, maximum, seconds, label }) => {
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

export const exactFrameKeys = async ({
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
