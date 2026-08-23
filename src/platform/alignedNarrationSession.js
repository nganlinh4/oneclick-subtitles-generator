const createEmptyCache = () => Object.freeze({
  blob: null,
  url: null,
  filename: null,
  mode: null,
  previewPlan: null,
  nativeArtifactId: null,
  nativePlaybackId: null,
  nativeJobId: null,
  projectId: null,
  projectStateVersion: null,
  alignmentKey: null,
  timestamp: null,
  subtitleTimestamps: Object.freeze({}),
});

let cache = createEmptyCache();
let resetOwner = null;
const listeners = new Set();

export const createEmptyAlignedNarrationCache = createEmptyCache;
export const getAlignedNarrationCacheSnapshot = () => cache;

export const publishAlignedNarrationCache = (next) => {
  if (next === null || typeof next !== 'object' || Array.isArray(next)) {
    throw new TypeError('An aligned narration cache snapshot is required');
  }
  if (Object.is(cache, next)) return false;
  cache = Object.freeze({ ...next });
  [...listeners].forEach((listener) => listener());
  return true;
};

export const subscribeToAlignedNarrationCache = (listener) => {
  if (typeof listener !== 'function') throw new TypeError('A cache subscriber is required');
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const registerAlignedNarrationResetOwner = (owner) => {
  if (typeof owner !== 'function') throw new TypeError('An aligned narration reset owner is required');
  resetOwner = owner;
};

export const requestAlignedNarrationReset = () => {
  if (resetOwner !== null) return resetOwner();
  publishAlignedNarrationCache(createEmptyCache());
  return undefined;
};
