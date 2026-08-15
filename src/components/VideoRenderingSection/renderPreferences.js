const RENDER_RESOLUTIONS = new Set(['360p', '480p', '720p', '1080p', '1440p', '4K', '8K']);
const FRAME_RATES = new Set([24, 25, 30, 50, 60, 120]);
const SUBTITLE_SOURCES = new Set(['original', 'translated']);
const NARRATION_SOURCES = new Set(['none', 'generated']);
const COLOR_PATTERN = /^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i;
const MAX_RENDER_DURATION_SECONDS = 24 * 60 * 60;

export const DEFAULT_RENDER_SETTINGS = Object.freeze({
  resolution: '1080p',
  frameRate: 30,
  videoType: 'Subtitled Video',
  originalAudioVolume: 100,
  narrationVolume: 100,
  trimStart: 0,
  trimEnd: 0,
});

export const DEFAULT_CROP_SETTINGS = Object.freeze({
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
});

const dataValue = (record, key) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};

const finiteWithin = (value, minimum, maximum) => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= minimum
  && value <= maximum
);

const integerWithin = (value, minimum, maximum) => (
  Number.isInteger(value) && value >= minimum && value <= maximum
);

const parseStoredRecord = (serialized) => {
  if (typeof serialized !== 'string') return null;
  try {
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readStorage = (key, storage) => {
  try {
    return (storage ?? globalThis.localStorage).getItem(key);
  } catch {
    return null;
  }
};

export const loadRenderSettings = (storage) => {
  const candidate = parseStoredRecord(readStorage('videoRender_renderSettings', storage));
  const normalized = { ...DEFAULT_RENDER_SETTINGS };
  const resolution = dataValue(candidate, 'resolution');
  const frameRate = dataValue(candidate, 'frameRate');
  const videoType = dataValue(candidate, 'videoType');
  const originalAudioVolume = dataValue(candidate, 'originalAudioVolume');
  const narrationVolume = dataValue(candidate, 'narrationVolume');
  const trimStart = dataValue(candidate, 'trimStart');
  const trimEnd = dataValue(candidate, 'trimEnd');
  if (RENDER_RESOLUTIONS.has(resolution)) normalized.resolution = resolution;
  if (FRAME_RATES.has(frameRate)) normalized.frameRate = frameRate;
  if (videoType === 'Subtitled Video') normalized.videoType = videoType;
  if (integerWithin(originalAudioVolume, 0, 100)) {
    normalized.originalAudioVolume = originalAudioVolume;
  }
  if (integerWithin(narrationVolume, 0, 100)) normalized.narrationVolume = narrationVolume;
  if (finiteWithin(trimStart, 0, MAX_RENDER_DURATION_SECONDS)) normalized.trimStart = trimStart;
  if (finiteWithin(trimEnd, 0, MAX_RENDER_DURATION_SECONDS)) normalized.trimEnd = trimEnd;
  if (normalized.trimEnd !== 0 && normalized.trimEnd <= normalized.trimStart) {
    normalized.trimStart = 0;
    normalized.trimEnd = 0;
  }
  return normalized;
};

export const loadCropSettings = (storage) => {
  const candidate = parseStoredRecord(readStorage('videoRender_cropSettings', storage));
  const normalized = { ...DEFAULT_CROP_SETTINGS };
  for (const key of ['x', 'y']) {
    const value = dataValue(candidate, key);
    if (finiteWithin(value, -1_000, 1_000)) normalized[key] = value;
  }
  for (const key of ['width', 'height']) {
    const value = dataValue(candidate, key);
    if (finiteWithin(value, 0.01, 1_000)) normalized[key] = value;
  }
  const aspectRatio = dataValue(candidate, 'aspectRatio');
  if (aspectRatio === null || finiteWithin(aspectRatio, 0.01, 100)) {
    normalized.aspectRatio = aspectRatio;
  }
  const canvasBgMode = dataValue(candidate, 'canvasBgMode');
  if (canvasBgMode === 'solid' || canvasBgMode === 'blur') {
    normalized.canvasBgMode = canvasBgMode;
  }
  const canvasBgColor = dataValue(candidate, 'canvasBgColor');
  if (typeof canvasBgColor === 'string' && COLOR_PATTERN.test(canvasBgColor)) {
    normalized.canvasBgColor = canvasBgColor;
  }
  const canvasBgBlur = dataValue(candidate, 'canvasBgBlur');
  if (finiteWithin(canvasBgBlur, 0, 1_000)) normalized.canvasBgBlur = canvasBgBlur;
  for (const key of ['flipX', 'flipY']) {
    const value = dataValue(candidate, key);
    if (typeof value === 'boolean') normalized[key] = value;
  }
  return normalized;
};

const loadChoice = (key, allowed, fallback, storage) => {
  const value = readStorage(key, storage);
  return allowed.has(value) ? value : fallback;
};

export const loadSubtitleSource = (storage) => loadChoice(
  'videoRender_selectedSubtitles',
  SUBTITLE_SOURCES,
  'original',
  storage,
);

export const loadNarrationSource = (storage) => loadChoice(
  'videoRender_selectedNarration',
  NARRATION_SOURCES,
  'none',
  storage,
);

export const loadPanelWidth = (storage) => {
  const value = Number(readStorage('videoRender_leftPanelWidth', storage));
  return Number.isFinite(value) && value > 0 && value < 100 ? value : 66.67;
};

export const storeRenderPreference = (key, value, { json = false, storage } = {}) => {
  try {
    (storage ?? globalThis.localStorage).setItem(key, json ? JSON.stringify(value) : String(value));
    return true;
  } catch {
    return false;
  }
};
