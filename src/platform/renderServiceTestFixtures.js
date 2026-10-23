// Shared fixtures for the split native render service suites: a scriptable channel, a hostile
// abort signal, and canonical request/job/result shapes.
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import { defaultCustomization } from '../components/subtitleCustomization/defaultCustomization';
import {
  getAnimationEasing,
  getAnimationTypes,
  getBorderStyleOptions,
  getPositionOptions,
  getTextAlignOptions,
  getTextTransformOptions,
} from '../components/subtitleCustomization/fontOptions';

import { buildNativeRenderRequest } from './renderService';

export class TestChannel {
  static latest = null;

  onmessage = () => {};

  constructor() {
    TestChannel.latest = this;
  }

  emit(event) {
    this.onmessage(event);
  }
}

export const createTrackedAbortSignal = ({
  initiallyAborted = false,
  abortDuringAdd = false,
  throwOnAdd = false,
  throwOnRemove = false,
  throwingGetter = null,
} = {}) => {
  let aborted = initiallyAborted;
  let abortListener = null;
  const counts = {
    abortedGets: 0,
    addGets: 0,
    removeGets: 0,
    addCalls: 0,
    removeCalls: 0,
  };
  const signal = {};
  Object.defineProperties(signal, {
    aborted: {
      enumerable: true,
      get() {
        counts.abortedGets += 1;
        if (throwingGetter === 'aborted') throw new Error('hostile aborted getter');
        return aborted;
      },
    },
    addEventListener: {
      enumerable: true,
      get() {
        counts.addGets += 1;
        if (throwingGetter === 'addEventListener') throw new Error('hostile add getter');
        return (_event, listener) => {
          counts.addCalls += 1;
          abortListener = listener;
          if (abortDuringAdd) {
            aborted = true;
            listener();
          }
          if (throwOnAdd) throw new Error('hostile add');
        };
      },
    },
    removeEventListener: {
      enumerable: true,
      get() {
        counts.removeGets += 1;
        if (throwingGetter === 'removeEventListener') throw new Error('hostile remove getter');
        return (_event, listener) => {
          counts.removeCalls += 1;
          if (throwOnRemove) throw new Error('hostile remove');
          if (abortListener === listener) abortListener = null;
        };
      },
    },
  });
  return {
    signal,
    counts,
    abort() {
      if (aborted) return;
      aborted = true;
      abortListener?.();
    },
  };
};

export const sourceAsset = () => ({
  id: uuidv7(),
  displayName: 'source.mp4',
  extension: 'mp4',
  sizeBytes: 1_024,
  kind: 'video',
});


export const requestWith = ({
  lyrics = [{ id: 7, start: 0, end: 2.5, text: 'Hello' }],
  customization = { ...defaultCustomization },
  crop = {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    aspectRatio: null,
    canvasBgMode: 'solid',
    canvasBgColor: '#000000',
    canvasBgBlur: 24,
    flipX: false,
    flipY: false,
  },
} = {}) => buildNativeRenderRequest({
  sourceAsset: sourceAsset(),
  projectId: uuidv7(),
  narrationArtifactId: uuidv7(),
  lyrics,
  settings: {
    resolution: '1080p',
    frameRate: 30,
    originalAudioVolume: 100,
    narrationVolume: 80,
    trimStart: 0,
    trimEnd: 2.5,
  },
  customization,
  crop,
});

const catalogLabel = (_key, fallback) => fallback;

export const editorCustomizationCatalogs = Object.freeze([
  ['animationEasing', getAnimationEasing(catalogLabel)],
  ['animationType', getAnimationTypes(catalogLabel)],
  ['borderStyle', getBorderStyleOptions(catalogLabel)],
  ['position', getPositionOptions(catalogLabel)],
  ['textAlign', getTextAlignOptions(catalogLabel)],
  ['textTransform', getTextTransformOptions(catalogLabel)],
]);

export const job = (overrides = {}) => ({
  id: uuidv7(),
  kind: 'renderVideo',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
  ...overrides,
});

export const result = (overrides = {}) => {
  const playbackId = uuidv4();
  const asset = {
    id: uuidv7(),
    displayName: 'rendered-video.mp4',
    extension: 'mp4',
    sizeBytes: 4_096,
    kind: 'video',
  };
  return {
    artifactId: uuidv7(),
    asset,
    sourceAssetId: uuidv7(),
    projectId: uuidv7(),
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 75,
    playback: {
      id: playbackId,
      playbackUrl: `http://127.0.0.1:49152/asset/${playbackId}?token=${'a'.repeat(64)}`,
      mimeType: 'video/mp4',
      byteLength: asset.sizeBytes,
    },
    ...overrides,
  };
};


export const request = () => requestWith();
