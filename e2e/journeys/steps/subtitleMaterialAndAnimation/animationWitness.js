// In-page Canvas animation witness: per-frame samples, publications and media events through
// one real playback of the animated cue.

/* global MutationObserver, browser, document, getComputedStyle, performance, requestAnimationFrame, window */

import {
  ANIMATION_CUE,
  ANIMATION_PHASES,
} from '../../../support/subtitleMaterialAnimationOracle.js';

import { errorSelector, previewState, waitUntilWithFreshDiagnostic } from './previewControls.js';

export const startAnimationWitness = () => browser.execute((selector, phases) => {
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
    // Set when a composition consumed a canvas whose contents predate this witness: a tainted
    // frozen source captured before attach can never be inspected, so a publication built from it
    // must classify as unknown provenance rather than as a black/no-video frame.
    unknownSource: false,
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
      unknownSource: state.unknownSource === true,
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
      unknownSource: false,
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
        unknownSource: false,
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
        if (sourceState.known !== true || sourceState.unknownSource === true) {
          target.unknownSource = true;
        }
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
    // A publication that consumed pre-attach pixels is honestly unclassifiable: the trace never
    // observed the video enter that tainted canvas. The continuity gate tolerates the bounded
    // unclassified window until the first post-attach capture publishes.
    const classified = publication !== null && publication.unknownSource !== true;
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
  // Discriminator self-probe (no extra timer): each tick's own `performance.now()` against the
  // previous tick's is already a free rAF-interval measurement, distinguishing 'the whole JS
  // thread stalled' (this interval itself balloons) from 'only decoded-video delivery stalled'
  // (this interval stays ~one frame while mediaTime/revision plateau).
  let lastTickAtMs = witness.startedAt;
  const tick = () => {
    if (!witness.active) return;
    const nowMs = performance.now();
    const rafIntervalMs = nowMs - lastTickAtMs;
    lastTickAtMs = nowMs;
    const mediaTime = video.currentTime;
    const phase = phases.find(candidate => mediaTime >= candidate.minimum && mediaTime <= candidate.maximum);
    witness.samples.push({
      phase: phase?.name ?? null,
      atMs: nowMs - witness.startedAt,
      rafIntervalMs,
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

export const markAnimationWitnessTransition = () => browser.execute(() => {
  const witness = window.__OSG_E2E_ANIMATION_WITNESS__;
  if (witness === undefined || witness.active !== true || typeof witness.markTransition !== 'function') {
    throw new Error('animation witness cannot mark a live transition');
  }
  return witness.markTransition();
});

export const cleanupAnimationWitness = () => browser.execute(() => {
  window.__OSG_E2E_ANIMATION_WITNESS__?.cleanup?.();
  return true;
});

export const stopAnimationWitness = () => browser.execute(() => {
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

export const witnessThroughCue = async () => {
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
