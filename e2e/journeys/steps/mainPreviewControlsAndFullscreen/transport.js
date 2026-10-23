// Customer preview transport for the main preview journey: seek, speed, volume and mute.
/* global $, browser, document, getComputedStyle, window */

import { strict as assert } from 'node:assert';

import { revealMainTransportControls } from '../../../support/previewTransport.js';

export const PREVIEW = '.video-preview';
export const CANVAS = `${PREVIEW} canvas[data-osg-preview-engine="canvas-atlas"]`;
export const CONTROLS = `${PREVIEW} .custom-video-controls`;

export const visiblePreviewState = () => browser.execute(() => {
  const video = document.querySelector('.video-preview video.video-player');
  const canvas = document.querySelector(
    '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
  );
  const container = document.querySelector('.video-preview .native-video-container');
  const refreshIcon = [...document.querySelectorAll('.video-preview .material-symbols-rounded')]
    .find((node) => (node.textContent || '').trim() === 'refresh');
  const refresh = refreshIcon?.closest('.liquid-glass') ?? null;
  const finiteDatasetNumber = (element, key) => {
    const raw = element?.dataset?.[key];
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return {
    preview: document.querySelector('.video-preview [data-osg-preview]')
      ?.getAttribute('data-osg-preview') ?? null,
    previewCode: document.querySelector('.video-preview [data-osg-preview]')
      ?.getAttribute('data-osg-preview-code') ?? null,
    fileName: (document.querySelector('.file-info-card .file-name')?.textContent || '').trim(),
    cueRows: [...document.querySelectorAll('.lyric-text')]
      .map((node) => (node.textContent || '').trim()).filter(Boolean).slice(0, 10),
    video: video === null ? null : {
      src: video.currentSrc,
      duration: video.duration,
      currentTime: video.currentTime,
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      playbackRate: video.playbackRate,
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
    },
    canvas: canvas === null ? null : {
      revision: Number(canvas.dataset.osgFrameRevision ?? 0),
      sourceMediaTime: finiteDatasetNumber(canvas, 'osgSourceMediaTime'),
      transportTime: finiteDatasetNumber(canvas, 'osgTransportTime'),
      sourceClockProvenance: canvas.dataset.osgSourceClockProvenance || null,
      sceneTime: finiteDatasetNumber(canvas, 'osgSceneTime'),
      cue: canvas.dataset.osgCueIndex ?? '',
      width: canvas.width,
      height: canvas.height,
    },
    fullscreen: {
      enabled: document.fullscreenEnabled,
      controlPresent: document.querySelector(
        '.video-preview .custom-video-controls [aria-label="Fullscreen"]',
      ) !== null,
      active: document.fullscreenElement === container,
      elementClass: document.fullscreenElement?.className ?? null,
      containerRect: container === null ? null : (() => {
        const rect = container.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      inlinePosition: container?.style.position ?? '',
      inlineWidth: container?.style.width ?? '',
      inlineHeight: container?.style.height ?? '',
    },
    narrationRefresh: {
      present: refresh !== null,
      ariaLabel: refresh?.getAttribute('aria-label') ?? null,
      pointerEvents: refresh === null ? null : getComputedStyle(refresh).pointerEvents,
      resultCount: document.querySelectorAll('[data-narration-result-state="succeeded"]').length,
    },
    waveform: {
      state: document.querySelector('[data-osg-waveform-state]')
        ?.getAttribute('data-osg-waveform-state') ?? null,
      inlineStatus: (document.querySelector('.volume-visualizer-loading')?.textContent || '')
        .trim() || null,
    },
    successToasts: [...document.querySelectorAll('.toast-item.live .toast-success p')]
      .map((node) => (node.textContent || '').trim()).filter(Boolean),
    visibleSpeedOptions: [...document.querySelectorAll(
      '.video-preview .custom-video-controls .liquid-glass',
    )]
      .filter((node) => /^\d+(?:\.\d+)?x$/.test((node.textContent || '').trim()))
      .filter((node) => {
        const style = getComputedStyle(node);
        return style.pointerEvents !== 'none' && Number(style.opacity) > 0.01;
      }).length,
  };
});

export const hoverPreview = () => revealMainTransportControls({
  previewSelector: PREVIEW,
  controlsSelector: CONTROLS,
});

export const seekWithCustomerProgress = async (fraction) => {
  assert.ok(fraction > 0 && fraction < 1, 'seek fraction must stay inside the media');
  await hoverPreview();
  const seekResult = await browser.execute((target, requestedFraction) => {
    const progress = document.querySelector(target);
    if (progress === null) return { activated: false, width: 0 };
    const rect = progress.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { activated: false, width: rect.width };
    const clientX = rect.left + rect.width * requestedFraction;
    progress.dispatchEvent(new window.MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX,
      clientY: rect.top + rect.height / 2,
    }));
    document.dispatchEvent(new window.MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX,
      clientY: rect.top + rect.height / 2,
    }));
    return { activated: true, width: rect.width };
  }, `${CONTROLS} canvas[role="progressbar"]`, fraction);
  assert.equal(seekResult.activated, true, 'the customer seek surface was not measurable');
  const { width } = seekResult;
  assert.ok(width >= 100, `the customer seek control is implausibly narrow: ${width}`);

  let state = null;
  await waitUntilWithFreshDiagnostic(async () => {
    state = await visiblePreviewState();
    if (state.video === null || !Number.isFinite(state.video.duration)) return false;
    return Math.abs(state.video.currentTime - state.video.duration * fraction) <= 0.8
      && Number.isFinite(state.canvas?.transportTime)
      && Number.isFinite(state.canvas?.sceneTime)
      && Math.abs(state.canvas.sceneTime - state.video.currentTime) <= 0.05
      && Math.abs(state.canvas.transportTime - state.video.currentTime) <= 0.05
      && (state.canvas.sourceClockProvenance === 'rvfc'
        ? Number.isFinite(state.canvas.sourceMediaTime)
        : state.canvas.sourceMediaTime === null);
  }, {
    timeout: 30_000,
    interval: 100,
    diagnostic: () => `the customer seek did not reach ${fraction}: ${JSON.stringify(state)}`,
  });
  return state;
};

export const rapidSeekWithCustomerProgress = async (fractions) => {
  assert.ok(Array.isArray(fractions) && fractions.length >= 3);
  assert.ok(fractions.every(fraction => fraction > 0 && fraction < 1));
  await hoverPreview();
  const before = await visiblePreviewState();
  const result = await browser.execute((target, requestedFractions) => {
    const progress = document.querySelector(target);
    if (progress === null) return { activated: false, width: 0 };
    const rect = progress.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { activated: false, width: rect.width };
    for (const fraction of requestedFractions) {
      const clientX = rect.left + rect.width * fraction;
      progress.dispatchEvent(new window.MouseEvent('mousedown', {
        bubbles: true, cancelable: true, composed: true, view: window,
        button: 0, buttons: 1, clientX, clientY: rect.top + rect.height / 2,
      }));
      document.dispatchEvent(new window.MouseEvent('mouseup', {
        bubbles: true, cancelable: true, composed: true, view: window,
        button: 0, clientX, clientY: rect.top + rect.height / 2,
      }));
    }
    return { activated: true, width: rect.width };
  }, `${CONTROLS} canvas[role="progressbar"]`, fractions);
  assert.equal(result.activated, true, 'the rapid customer seek surface was not actionable');
  assert.ok(result.width >= 100, `the rapid customer seek surface is implausibly narrow: ${result.width}`);
  const finalFraction = fractions.at(-1);
  let state = null;
  await waitUntilWithFreshDiagnostic(async () => {
    state = await visiblePreviewState();
    if (state.video === null || !Number.isFinite(state.video.duration)) return false;
    const expected = state.video.duration * finalFraction;
    return Math.abs(state.video.currentTime - expected) <= 0.8
      && Number.isFinite(state.canvas?.transportTime)
      && Number.isFinite(state.canvas?.sceneTime)
      && Math.abs(state.canvas.sceneTime - state.video.currentTime) <= 0.05
      && Math.abs(state.canvas.transportTime - state.video.currentTime) <= 0.05
      && (state.canvas.sourceClockProvenance === 'rvfc'
        ? Number.isFinite(state.canvas.sourceMediaTime)
        : state.canvas.sourceMediaTime === null)
      && state.canvas.revision > (before.canvas?.revision ?? 0);
  }, {
    timeout: 30_000,
    interval: 50,
    diagnostic: () => `the latest rapid customer seek did not own the presented frame: ${JSON.stringify(state)}`,
  });
  return state;
};

export const clickTransportControl = async (label) => {
  await hoverPreview();
  const control = await $(`${CONTROLS} [aria-label="${label}"]`);
  await control.waitForClickable({
    timeout: 30_000,
    timeoutMsg: `${label} never became a clickable preview control`,
  });
  await control.click();
};

export const setSpeedWithCustomerControl = async () => {
  await hoverPreview();
  const menuTriggered = await browser.execute((controls) => {
    const current = [...document.querySelectorAll(`${controls} span`)]
      .find((node) => (node.textContent || '').trim() === '1x');
    const glass = current?.closest('.liquid-glass');
    const wrapper = glass?.parentElement;
    if (current === undefined || wrapper === null || wrapper === undefined) return false;
    wrapper.dispatchEvent(new window.MouseEvent('mouseover', {
      bubbles: true, cancelable: true, composed: true, view: window,
    }));
    wrapper.dispatchEvent(new window.MouseEvent('mouseenter', {
      bubbles: false, cancelable: true, composed: true, view: window,
    }));
    return true;
  }, CONTROLS);
  assert.equal(menuTriggered, true, 'the current playback-speed control is missing');
  await browser.pause(150);

  const activation = await browser.execute((controls) => {
    const glassNodes = [...document.querySelectorAll(`${controls} .liquid-glass`)];
    const speedSurfaces = glassNodes.map((node) => ({
      node,
      text: (node.textContent || '').trim(),
      pointerEvents: getComputedStyle(node).pointerEvents,
      opacity: getComputedStyle(node).opacity,
    })).filter((entry) => /^\d+(?:\.\d+)?x$/.test(entry.text));
    const expandedOption = speedSurfaces.find((entry) => (
      entry.text === '1.5x' && entry.pointerEvents !== 'none'
    ));
    if (expandedOption !== undefined) {
      expandedOption.node.click();
      return {
        clicked: true,
        target: 1.5,
        mode: 'expanded',
        surfaces: speedSurfaces.map(({ text, pointerEvents, opacity }) => ({
          text, pointerEvents, opacity,
        })),
      };
    }

    const video = document.querySelector(`${controls} video`)
      ?? document.querySelector('.video-preview video.video-player');
    const currentRate = video?.playbackRate ?? 1;
    const current = [...document.querySelectorAll(`${controls} span`)]
      .find((node) => (node.textContent || '').trim() === `${currentRate}x`);
    const button = current?.parentElement;
    const hasExpandedSurfaces = speedSurfaces.some((entry) => entry.text === '1.5x');
    if (button === null || button === undefined || hasExpandedSurfaces) {
      return {
        clicked: false,
        target: null,
        mode: hasExpandedSurfaces ? 'expanded-not-revealed' : 'missing-compact-control',
        currentRate,
        spanTexts: [...document.querySelectorAll(`${controls} span`)]
          .map((node) => (node.textContent || '').trim()).filter(Boolean).slice(0, 20),
        surfaces: speedSurfaces.map(({ text, pointerEvents, opacity }) => ({
          text, pointerEvents, opacity,
        })),
      };
    }
    const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
    const nextRate = rates[(rates.indexOf(currentRate) + 1) % rates.length];
    button.click();
    return {
      clicked: true,
      target: nextRate,
      mode: 'compact',
      surfaces: [],
    };
  }, CONTROLS);
  assert.equal(
    activation.clicked,
    true,
    `the playback-speed control did not activate: ${JSON.stringify(activation)}`,
  );
  const { target } = activation;

  let state = null;
  await waitUntilWithFreshDiagnostic(async () => {
    state = await visiblePreviewState();
    return Math.abs((state.video?.playbackRate ?? 0) - target) < 0.001;
  }, {
    timeout: 10_000,
    interval: 100,
    diagnostic: () => `the speed control did not set ${target}x: ${JSON.stringify(state)}`,
  });
  await browser.waitUntil(async () => (await visiblePreviewState()).visibleSpeedOptions === 0, {
    timeout: 5_000,
    interval: 50,
    timeoutMsg: 'the playback-speed menu remained open after choosing a rate',
  });
  return target;
};

export const setVolumeWithCustomerControl = async (target) => {
  await hoverPreview();
  const volumeResult = await browser.execute((wrapperTarget, sliderTarget, requestedVolume) => {
    const wrapper = document.querySelector(wrapperTarget);
    const slider = document.querySelector(sliderTarget);
    if (wrapper === null || !(slider instanceof window.HTMLInputElement)) {
      return { activated: false, height: 0 };
    }
    wrapper.dispatchEvent(new window.MouseEvent('mouseover', {
      bubbles: true, cancelable: true, composed: true, view: window,
    }));
    const track = slider.closest('.standard-slider-container')
      ?.querySelector('.standard-slider-track-container');
    const height = track?.getBoundingClientRect().height ?? 0;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    if (setter === undefined) return { activated: false, height };
    setter.call(slider, String(requestedVolume));
    slider.dispatchEvent(new window.Event('input', { bubbles: true, composed: true }));
    slider.dispatchEvent(new window.Event('change', { bubbles: true, composed: true }));
    return { activated: true, height };
  }, `${CONTROLS} .volume-pill-wrapper`,
  `${CONTROLS} .video-volume-slider input[type="range"]`, target);
  assert.equal(volumeResult.activated, true, 'the volume input was not available');
  const { height } = volumeResult;
  assert.ok(height >= 40, `the customer volume track is implausibly short: ${height}`);

  let state = null;
  await waitUntilWithFreshDiagnostic(async () => {
    state = await visiblePreviewState();
    return state.video !== null
      && !state.video.muted
      && Math.abs(state.video.volume - target) <= 0.08;
  }, {
    timeout: 10_000,
    interval: 100,
    diagnostic: () => `the volume control did not reach ${target}: ${JSON.stringify(state)}`,
  });
  return state.video.volume;
};

export const clickMuteIcon = async (expectedIcon) => {
  await hoverPreview();
  const clicked = await browser.execute((controls, iconText) => {
    const wrapper = document.querySelector(`${controls} .volume-pill-wrapper`);
    if (wrapper === null) return false;
    wrapper.dispatchEvent(new window.MouseEvent('mouseover', {
      bubbles: true, cancelable: true, composed: true, view: window,
    }));
    const icon = [...wrapper.querySelectorAll('.material-symbols-rounded')]
      .find((node) => (node.textContent || '').trim() === iconText);
    const button = icon?.parentElement;
    if (button === null || button === undefined) return false;
    button.click();
    return true;
  }, CONTROLS, expectedIcon);
  assert.equal(clicked, true, `${expectedIcon} is missing from the volume control`);
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
