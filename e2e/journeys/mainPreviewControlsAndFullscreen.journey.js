// The main preview's customer controls and real A -> B media transition.
//
// This journey is deliberately off-screen and dialog-free. Both native picker answers are staged
// before the automation-only binary starts: the real YouTube source used by the rest of the suite,
// then W3C's pinned Sintel trailer. Every interaction below still goes through the shipped UI and
// the real select_media/import/activation path. No React state, localStorage or native command is
// written by the journey.

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { compareFrames, savePreviewElementFrame } from '../support/nativeMediaOracle.js';
import { SOURCE_SWITCH_VIDEO } from '../support/realMedia.js';
import {
  importSubtitles,
  openProjectWithMedia,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import {
  captureWorkflowStep,
  copyWorkflowArtifact,
} from '../support/workflowEvidence.js';

/* global $, browser, describe, document, getComputedStyle, it, requestAnimationFrame, window */

const WORKFLOW = 'main-preview-controls-and-fullscreen';
const PREVIEW = '.video-preview';
const CANVAS = `${PREVIEW} canvas[data-osg-preview-engine="canvas-atlas"]`;
const CONTROLS = `${PREVIEW} .custom-video-controls`;
const ASCII_SECOND_CUE = 'Second cue, plain text only';
const UNICODE_SECOND_CUE = 'Xin chào và 감사합니다 🎬';

const visiblePreviewState = () => browser.execute(() => {
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

const hoverPreview = async () => {
  const container = await $(`${PREVIEW} .native-video-container`);
  await container.waitForDisplayed({ timeout: 30_000 });
  const hovered = await browser.execute((target) => {
    const node = document.querySelector(target);
    if (node === null) return false;
    node.dispatchEvent(new window.MouseEvent('mouseover', {
      bubbles: true, cancelable: true, composed: true, view: window,
    }));
    return true;
  }, `${PREVIEW} .native-video-container`);
  assert.equal(hovered, true, 'the native preview disappeared before its hover boundary');
  await browser.waitUntil(async () => browser.execute((target) => {
    const control = document.querySelector(target);
    return control !== null && getComputedStyle(control).pointerEvents !== 'none';
  }, `${CONTROLS} [aria-label="Play"], ${CONTROLS} [aria-label="Pause"]`), {
    timeout: 10_000,
    interval: 50,
    timeoutMsg: 'the public preview hover did not reveal its transport controls',
  });
};

const seekWithCustomerProgress = async (fraction) => {
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

const rapidSeekWithCustomerProgress = async (fractions) => {
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

const clickTransportControl = async (label) => {
  await hoverPreview();
  const control = await $(`${CONTROLS} [aria-label="${label}"]`);
  await control.waitForClickable({
    timeout: 30_000,
    timeoutMsg: `${label} never became a clickable preview control`,
  });
  await control.click();
};

const setSpeedWithCustomerControl = async () => {
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

const setVolumeWithCustomerControl = async (target) => {
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

const clickMuteIcon = async (expectedIcon) => {
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

const startSourceSwitchWitness = async (before) => browser.execute((prior) => {
  const witness = {
    active: true,
    oldSrc: prior.video.src,
    oldFileName: prior.fileName,
    oldCue: prior.canvas.cue,
    animationFrames: 0,
    samples: [],
  };
  const sample = () => {
    if (!witness.active) return;
    witness.animationFrames += 1;
    const video = document.querySelector('.video-preview video.video-player');
    const canvas = document.querySelector(
      '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
    );
    const fileName = (document.querySelector('.file-info-card .file-name')?.textContent || '').trim();
    const next = {
      fileName,
      src: video?.currentSrc ?? '',
      duration: video?.duration ?? null,
      currentTime: video?.currentTime ?? null,
      paused: video?.paused ?? null,
      revision: canvas?.dataset.osgFrameRevision ?? null,
      cue: canvas?.dataset.osgCueIndex ?? null,
      preview: document.querySelector('.video-preview [data-osg-preview]')
        ?.getAttribute('data-osg-preview') ?? null,
    };
    const last = witness.samples.at(-1);
    const changed = last === undefined
      || Object.keys(next).some((key) => next[key] !== last[key]);
    if (changed && witness.samples.length < 900) witness.samples.push(next);
    requestAnimationFrame(sample);
  };
  window.__OSG_PREVIEW_SOURCE_SWITCH_WITNESS__ = witness;
  requestAnimationFrame(sample);
  return true;
}, before);

const stopSourceSwitchWitness = async () => browser.execute(() => {
  const witness = window.__OSG_PREVIEW_SOURCE_SWITCH_WITNESS__;
  if (witness === undefined) return null;
  witness.active = false;
  return {
    oldSrc: witness.oldSrc,
    oldFileName: witness.oldFileName,
    oldCue: witness.oldCue,
    animationFrames: witness.animationFrames,
    samples: witness.samples,
  };
});

describe('main preview customer controls and source transitions', () => {
  it('drives transport and a real A-to-B switch without stale frames', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run against an isolated data root');
    assert.ok(
      process.env.OSG_E2E_MEDIA_SELECTION_SEQUENCE,
      'this journey requires the automation-only two-selection dialog queue',
    );

    await openProjectWithMedia();
    await importSubtitles();
    let state = await seekWithCustomerProgress(0.22);
    state = await rapidSeekWithCustomerProgress([0.36, 0.51, 0.22]);
    await waitForCanvasSubtitleFrame(120_000);
    assert.equal(state.video?.paused, true, 'seeking a paused preview unexpectedly started it');

    const speed = await setSpeedWithCustomerControl();
    const beforePlay = await visiblePreviewState();
    await clickTransportControl('Play');
    await browser.pause(1_200);
    state = await visiblePreviewState();
    assert.equal(state.video?.paused, false, 'Play did not start the real media element');
    assert.ok(
      state.video.currentTime - beforePlay.video.currentTime >= speed * 0.65,
      `playback did not advance at ${speed}x: ${JSON.stringify({ beforePlay, state })}`,
    );
    assert.ok(
      state.canvas.revision > beforePlay.canvas.revision,
      'the native compositor did not publish while the customer video played',
    );
    await clickTransportControl('Pause');
    await browser.waitUntil(async () => (await visiblePreviewState()).video?.paused === true, {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'Pause did not stop the real media element',
    });

    state = await seekWithCustomerProgress(0.45);
    await browser.waitUntil(async () => (await visiblePreviewState()).canvas?.cue === '2', {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: 'the public seek control reached the third cue but the canvas did not',
    });

    await clickMuteIcon('volume_up');
    await browser.waitUntil(async () => (await visiblePreviewState()).video?.muted === true, {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'the customer mute control did not mute the media element',
    });
    await clickMuteIcon('volume_off');
    await browser.waitUntil(async () => {
      const current = await visiblePreviewState();
      return current.video !== null && !current.video.muted && current.video.volume > 0;
    }, {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'the customer mute control did not restore audible volume',
    });
    const volume = await setVolumeWithCustomerControl(0.35);

    // Return to a known active cue for the screenshot and the stale-cue witness below.
    state = await seekWithCustomerProgress(0.22);
    await browser.waitUntil(async () => (await visiblePreviewState()).canvas?.cue === '1', {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: 'the ASCII second cue did not return before the source switch',
    });
    await hoverPreview();
    state = await visiblePreviewState();
    assert.equal(state.cueRows.includes(ASCII_SECOND_CUE), true, 'the first project lost its cues');
    assert.equal(state.narrationRefresh.present, true, 'the preview lost its narration-refresh control');
    const narrationRefresh = {
      ...state.narrationRefresh,
      executed: false,
      reason: state.narrationRefresh.resultCount === 0
        ? 'No real narration exists in this journey; clicking refresh would manufacture an error state.'
        : 'Unexpected narration existed; this journey does not own its generation provenance.',
    };
    const fullscreenSafety = {
      controlPresent: state.fullscreen.controlPresent,
      executed: false,
      reason: 'Browser fullscreen relocates the off-screen HWND onto the physical monitor; unattended automation must never activate it.',
    };
    assert.equal(
      state.narrationRefresh.resultCount,
      0,
      'this control journey unexpectedly inherited narration from another project/profile',
    );

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-public-transport-controls',
      description: 'Real customer controls play, pause, seek, mute, restore volume and set speed while the native canvas follows.',
      details: {
        playbackRate: speed,
        volume,
        currentTime: state.video.currentTime,
        duration: state.video.duration,
        canvasRevision: state.canvas.revision,
        sourceMediaTime: state.canvas.sourceMediaTime,
        transportTime: state.canvas.transportTime,
        sourceClockProvenance: state.canvas.sourceClockProvenance,
        cue: state.canvas.cue,
        narrationRefresh,
        fullscreenSafety,
      },
      focusSelector: `${PREVIEW} .video-container`,
    });

    assert.equal(state.fullscreen.enabled, true, 'the embedded WebView reports Fullscreen API unavailable');
    assert.equal(state.fullscreen.controlPresent, true, 'the customer fullscreen control is absent');
    assert.equal(state.fullscreen.active, false, 'the off-screen journey unexpectedly entered fullscreen');

    await seekWithCustomerProgress(0.22);
    await browser.waitUntil(async () => (await visiblePreviewState()).canvas?.cue === '1', {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: 'the source-A frame did not settle for comparison',
    });
    const sourceAFrame = join(root, 'evidence', 'preview-source-a.png');
    await savePreviewElementFrame(sourceAFrame, CANVAS);
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'source-a-frame',
      source: sourceAFrame,
      description: 'The first real source with its ASCII second cue before switching media.',
    });
    let sourceA = await visiblePreviewState();
    const durableA = durableState(root);
    assert.equal(durableA.media.length, 1, 'the first file selection created multiple media assets');
    // Replace a source that is genuinely playing. The new logical media must still start paused at
    // zero; otherwise an A->B project switch is leaking transport state even if the pixels look new.
    await clickTransportControl('Play');
    await browser.waitUntil(async () => (await visiblePreviewState()).video?.paused === false, {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'source A did not start before the logical-media replacement witness',
    });
    sourceA = await visiblePreviewState();
    assert.equal(await startSourceSwitchWitness(sourceA), true);

    // Clicking the populated file card is the same public picker path as clicking the empty drop
    // zone. The automation-only native boundary returns the second pre-staged selection here.
    await clickControl('.file-info-card .file-info-content');
    let sourceB = null;
    await waitUntilWithFreshDiagnostic(async () => {
      sourceB = await visiblePreviewState();
      return sourceB.video !== null
        && sourceB.video.src !== sourceA.video.src
        && Math.abs(sourceB.video.duration - SOURCE_SWITCH_VIDEO.durationSeconds)
          <= SOURCE_SWITCH_VIDEO.durationToleranceSeconds
        && sourceB.video.width === SOURCE_SWITCH_VIDEO.width
        && sourceB.video.height === SOURCE_SWITCH_VIDEO.height
        && sourceB.video.paused === true
        && sourceB.video.currentTime <= (1 / 30)
        && sourceB.fileName.includes(SOURCE_SWITCH_VIDEO.filename);
    }, {
      timeout: 180_000,
      interval: 100,
      diagnostic: () => `the second real source never owned the preview: ${JSON.stringify(sourceB)}`,
    });
    await waitUntilWithFreshDiagnostic(async () => {
      sourceB = await visiblePreviewState();
      return sourceB.preview === 'empty'
        && sourceB.canvas !== null
        && sourceB.canvas.revision > 0
        && sourceB.canvas.cue === ''
        && sourceB.cueRows.length === 0;
    }, {
      timeout: 120_000,
      interval: 100,
      diagnostic: () => `the second project retained stale subtitle state: ${JSON.stringify(sourceB)}`,
    });
    const witness = await stopSourceSwitchWitness();
    assert.ok(witness, 'the source-switch witness disappeared');
    assert.ok(witness.animationFrames > 0, 'the hidden WebView published no frame during the switch');
    const transitionStarted = witness.samples.findIndex((sample) => (
      (sample.fileName && sample.fileName !== witness.oldFileName)
      || (sample.src && sample.src !== witness.oldSrc)
    ));
    assert.ok(transitionStarted >= 0, `the witness never observed source B: ${JSON.stringify(witness)}`);
    const stale = witness.samples.slice(transitionStarted).filter((sample) => (
      sample.cue === witness.oldCue && sample.cue !== ''
    ));
    assert.deepEqual(
      stale,
      [],
      `the old subtitle canvas survived after source B took ownership: ${JSON.stringify(stale)}`,
    );
    const leakedTransport = witness.samples.slice(transitionStarted).filter((sample) => (
      sample.src
      && sample.src !== witness.oldSrc
      && (sample.paused === false || (sample.currentTime ?? 0) > (1 / 30))
    ));
    assert.deepEqual(
      leakedTransport,
      [],
      `source B inherited source A's playhead or play state: ${JSON.stringify(leakedTransport)}`,
    );
    assert.equal(
      sourceB.waveform.inlineStatus,
      null,
      'background waveform work inserted an inline status into the customer timeline',
    );
    assert.deepEqual(
      sourceB.successToasts,
      [],
      `media activation falsely announced subtitle readiness: ${JSON.stringify(sourceB.successToasts)}`,
    );

    const durableB = durableState(root);
    assert.equal(durableB.media.length, 2, 'the distinct second file did not create a second media identity');
    assert.notEqual(
      durableB.media[0].content_hash,
      durableB.media[1].content_hash,
      'the supposedly distinct source switch reused one content identity',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-second-source-empty',
      description: 'A visibly different real video owns the player and old project cues disappear before any new subtitles are imported.',
      details: {
        sourceA: {
          duration: sourceA.video.duration,
          width: sourceA.video.width,
          height: sourceA.video.height,
          fileName: sourceA.fileName,
        },
        sourceB: {
          currentTime: sourceB.video.currentTime,
          duration: sourceB.video.duration,
          width: sourceB.video.width,
          height: sourceB.video.height,
          fileName: sourceB.fileName,
          paused: sourceB.video.paused,
        },
        witness: {
          animationFrames: witness.animationFrames,
          transitions: witness.samples.length,
          staleFrames: stale.length,
        },
      },
      focusSelector: `${PREVIEW} .video-container`,
    });

    await importSubtitles('cues-unicode.srt');
    await seekWithCustomerProgress(4 / SOURCE_SWITCH_VIDEO.durationSeconds);
    await waitForCanvasSubtitleFrame(120_000);
    await waitUntilWithFreshDiagnostic(async () => {
      sourceB = await visiblePreviewState();
      return sourceB.canvas?.cue === '1' && sourceB.cueRows.includes(UNICODE_SECOND_CUE);
    }, {
      timeout: 120_000,
      interval: 100,
      diagnostic: () => `source B did not draw its own Unicode cue: ${JSON.stringify(sourceB)}`,
    });
    const sourceBFrame = join(root, 'evidence', 'preview-source-b.png');
    await savePreviewElementFrame(sourceBFrame, CANVAS);
    const sourceSsim = compareFrames(sourceAFrame, sourceBFrame);
    assert.ok(sourceSsim < 0.9, `source B still looks like source A: SSIM ${sourceSsim}`);
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'source-b-frame',
      source: sourceBFrame,
      description: 'The second real source after its own Unicode subtitle track is composited.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-second-source-own-cues',
      description: 'The second project accepts and draws its own Unicode cues after the stale-frame boundary stays clean.',
      details: {
        sourceSsim,
        cue: sourceB.canvas.cue,
        cueText: UNICODE_SECOND_CUE,
        refreshNarration: narrationRefresh,
      },
      focusSelector: `${PREVIEW} .video-container`,
    });
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
