// Synthetic observation fixtures shared by the subtitle material/animation oracle tests.

import {
  ANIMATION_CASES,
  ANIMATION_CUE,
  ANIMATION_PHASES,
  materialControlTokens,
  sweepEasedProgress,
} from './subtitleMaterialAnimationOracle.js';

export const clone = value => JSON.parse(JSON.stringify(value));
export const PROJECT_ID = 'project-a';

export const completeCustomization = (overrides = {}) => ({
  preset: 'custom',
  fontSize: 53,
  animationType: 'slide-up',
  animationEasing: 'linear',
  ...Object.fromEntries(Array.from({ length: 52 }, (_, index) => [`field${index}`, index])),
  ...overrides,
});

export const drawableState = () => ({
  canvas: { revision: 12, overlayRebuilds: 4, cue: '0', width: 640, height: 480 },
  preview: { status: 'ready', code: null },
  video: { paused: true, readyState: 4, error: null },
  currentErrors: [],
  recordedErrors: [],
  recordedRefusals: [],
});

export const changedFrame = () => ({
  ssim: 0.98,
  pixels: { changedPixels: 512, changedRatio: 0.01, maximumChannelDelta: 200 },
});

export const materialObservations = () => materialControlTokens().map((token, index) => ({
  token,
  sceneRevision: index + 2,
}));

// Holding/steady (eased == 1 for every easing, by definition) anchors the "full ink" reference; the
// oracle's new assertInkEnergyMagnitude reads this same steady value back out of the observation, so
// entry/exit here are computed via the SAME eased fraction (sweepEasedProgress, the oracle's own
// independent evaluator -- not the product's easeSubtitle) instead of an arbitrary monotonic ramp,
// keeping every fixture physically self-consistent regardless of which animation/easing is exercised.
const STEADY_INK_ENERGY = 90;

const geometry = (phase, index, animation) => {
  const easedFraction = phase.name === 'steady' ? 1 : sweepEasedProgress(animation.easing, phase.expectedProgress);
  return {
    width: 640,
    height: 480,
    changedPixels: 2_048 + (index * 97),
    centroidXRatio: 0.45 + (index * 0.01),
    centroidYRatio: 0.4 - (index * 0.1),
    bounds: {
      x: 100 + (index * 7),
      y: 80 - (index * 9),
      width: 180 + index,
      height: 70 + index,
      areaPixels: 4_096 + (index * 211),
    },
    meanChangedChannelDelta: STEADY_INK_ENERGY * easedFraction,
  };
};

const frameProof = (phase, index, animation) => ({
  mediaTime: phase.seconds,
  composed: { frame: { sha256: `composed-${index}` } },
  composedSignal: {
    totalPixels: 307_200, opaqueRatio: 1, nearBlackRatio: 0.2, meanLuma: 90,
  },
  sourceSignal: {
    totalPixels: 307_200, opaqueRatio: 1, nearBlackRatio: 0.25, meanLuma: 82,
  },
  subtitlePixels: {
    changedPixels: 2_048 + (index * 97),
    changedRatio: (2_048 + (index * 97)) / 307_200,
    maximumChannelDelta: 220,
  },
  subtitleGeometry: geometry(phase, index, animation),
});

const phaseSamples = phase => Array.from({ length: 10 }, (_, index) => ({
  atMs: index * 50,
  mediaTime: (phase.minimum + 0.02)
    + (index * ((phase.maximum - phase.minimum - 0.04) / 9)),
  revision: 100 + index,
  overlayRebuilds: 8,
  cue: '0',
  preview: 'ready',
  previewCode: null,
  paused: false,
  ended: false,
  readyState: 4,
  error: null,
  visibleErrors: [],
  recordedRefusals: [],
}));

const continuitySamples = () => Array.from({ length: 360 }, (_, index) => {
  const mediaTime = ANIMATION_CUE.witnessStart
    + (index * ((ANIMATION_CUE.witnessEnd - ANIMATION_CUE.witnessStart) / 359));
  return {
    atMs: index * 50,
    mediaTime,
    revision: 200 + index,
    overlayRebuilds: 8,
    cue: '0',
    preview: 'ready',
    previewCode: null,
    paused: false,
    ended: false,
    readyState: 4,
    error: null,
    visibleErrors: [],
    recordedRefusals: [],
    visual: {
      mode: 'tainted-operation-trace',
      classified: true,
      publication: index + 1,
      method: 'drawImage',
      hasVideo: true,
      hasOverlay: true,
      hasGlyphInk: true,
      visible: true,
      blank: false,
      transparent: false,
      black: false,
      sourceOnly: false,
      sourceTime: mediaTime,
      pixelHash: null,
    },
  };
});

export const animationObservationInput = (animation = ANIMATION_CASES[0]) => {
  const expectedTypeCustomization = completeCustomization({
    animationType: animation.type,
    animationEasing: animation.editEasing ? 'prior-easing' : animation.easing,
  });
  const expectedFinalCustomization = completeCustomization({
    animationType: animation.type,
    animationEasing: animation.easing,
  });
  return {
    animation,
    beforeRevision: 10,
    expectedProjectId: PROJECT_ID,
    expectedTypeCustomization,
    expectedFinalCustomization,
    typeScene: {
      projectId: PROJECT_ID,
      sceneRevision: animation.editType ? 11 : 10,
      schemaVersion: 1,
      scene: { customization: clone(expectedTypeCustomization) },
    },
    easingScene: {
      projectId: PROJECT_ID,
      sceneRevision: animation.editEasing ? (animation.editType ? 12 : 11) : 11,
      schemaVersion: 1,
      scene: { customization: clone(expectedFinalCustomization) },
    },
    continuitySamples: continuitySamples(),
    samplesByPhase: Object.fromEntries(ANIMATION_PHASES.map(phase => [phase.name, phaseSamples(phase)])),
    frameProofs: Object.fromEntries(ANIMATION_PHASES.map((phase, index) => [
      phase.name, frameProof(phase, index, animation),
    ])),
    phaseTransitions: {
      entryToSteady: changedFrame(), steadyToExit: changedFrame(), entryToExit: changedFrame(),
    },
    entryChange: changedFrame(),
    transientTransitions: [],
    mediaEvents: [],
  };
};

export const liveFontPresetInput = () => {
  const samples = continuitySamples().slice(0, 14).map((sample, index) => ({
    ...sample,
    atMs: index * 40,
    mediaTime: 8 + (index * 0.04),
    revision: 300 + index,
    overlayRebuilds: index < 5 ? 20 : 21,
    visual: {
      ...sample.visual,
      publication: 500 + index,
      sourceTime: 8 + (index * 0.04),
    },
  }));
  return {
    samples,
    publications: samples.slice(3).map(sample => clone(sample)),
    mediaEvents: [],
    transientTransitions: [
      {
        attribute: 'data-osg-preview', previous: 'ready', current: 'pending', atMs: 95, mediaTime: 8.1,
      },
      {
        attribute: 'data-osg-preview', previous: 'pending', current: 'ready', atMs: 135, mediaTime: 8.14,
      },
    ],
    transition: {
      atMs: 80,
      mediaTime: samples[2].mediaTime,
      revision: samples[2].revision,
      overlayRebuilds: samples[2].overlayRebuilds,
      visual: clone(samples[2].visual),
    },
    beforePreset: 'default',
    afterPreset: 'gaming',
    beforeFontFamily: "'Google Sans', sans-serif",
    afterFontFamily: "'Impact', sans-serif",
  };
};
