import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { resolveActiveNativeMediaAssetId } from './activeNativeMedia';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import { getSelectedMedia, isNativeMediaDescriptor, isNativeMediaPlaybackUrl } from './mediaService';
import { mutateProject } from './projectService';
import { resolveProjectForCache } from './subtitleProjectStore';

export const REMOTION_VERSION = '4.0.507';
export const MAX_RENDER_LYRICS = 100_000;

const MAX_RENDER_DURATION_MICROS = 24 * 60 * 60 * 1_000_000;
const MAX_PENDING_EVENTS = 4_096;
const MAX_POLL_MS = 24 * 60 * 60 * 1_000;
const JOB_STATES = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const ACTIVE_JOB_STATES = new Set(['queued', 'running', 'cancelling']);
const RENDER_PHASES = new Set([
  'staging', 'extractingFrames', 'extractingAudio', 'loadingComposition',
  'renderingFrames', 'encoding', 'muxing', 'publishing',
]);
const RESOLUTIONS = new Set(['360p', '480p', '720p', '1080p', '1440p', '4K', '8K']);
const FRAME_RATES = new Set([24, 25, 30, 50, 60, 120]);
const TEXT_ALIGNMENTS = new Set(['left', 'center', 'right']);
const TEXT_TRANSFORMS = new Set(['none', 'uppercase', 'lowercase', 'capitalize']);
const BORDER_STYLES = new Set(['none', 'solid', 'dashed', 'dotted']);
const GRADIENT_TYPES = new Set(['linear', 'radial']);
const SUBTITLE_POSITIONS = new Set(['bottom', 'top', 'center', 'custom']);
const ANIMATION_TYPES = new Set([
  'fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale', 'bounce',
  'flip', 'rotate', 'typewriter',
]);
const ANIMATION_EASINGS = new Set([
  'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out',
  'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
]);
const LINE_BREAK_BEHAVIORS = new Set(['auto', 'manual']);
const CUSTOMIZATION_KEYS = Object.freeze([
  'fontSize', 'fontFamily', 'fontWeight', 'textColor', 'textAlign', 'lineHeight',
  'letterSpacing', 'textTransform', 'backgroundColor', 'backgroundOpacity', 'borderRadius',
  'borderWidth', 'borderColor', 'borderStyle', 'textShadowEnabled', 'textShadowColor',
  'textShadowBlur', 'textShadowOffsetX', 'textShadowOffsetY', 'glowEnabled', 'glowColor',
  'glowIntensity', 'gradientEnabled', 'gradientType', 'gradientDirection',
  'gradientColorStart', 'gradientColorEnd', 'gradientColorMid', 'strokeEnabled',
  'strokeWidth', 'strokeColor', 'multiShadowEnabled', 'shadowLayers', 'pulseEnabled',
  'pulseSpeed', 'shakeEnabled', 'shakeIntensity', 'position', 'customPositionX',
  'customPositionY', 'marginBottom', 'marginTop', 'marginLeft', 'marginRight', 'maxWidth',
  'fadeInDuration', 'fadeOutDuration', 'animationType', 'animationEasing', 'wordWrap',
  'maxLines', 'lineBreakBehavior', 'rtlSupport', 'preset',
]);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isPlainRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .every((descriptor) => descriptor.enumerable && 'value' in descriptor);
};

const hasExactKeys = (value, keys) => (
  isPlainRecord(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
);

const hasOnlyKeys = (value, keys) => (
  isPlainRecord(value) && Object.keys(value).every((key) => keys.has(key))
);

const uuidHasVersion = (value, expectedVersion) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expectedVersion;
  } catch {
    return false;
  }
};

export class NativeRenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeRenderError';
    this.code = code;
  }
}

const invalidRequest = () => new NativeRenderError(
  'invalidRenderRequest',
  'The native video render request is invalid'
);

const invalidResponse = () => new NativeRenderError(
  'invalidRenderResponse',
  'The desktop host returned invalid native render data'
);

const runtimeRequired = () => new NativeRenderError(
  'desktopRenderRequired',
  'Native video rendering requires the desktop runtime'
);

const cancelled = () => {
  const error = new NativeRenderError('renderCancelled', 'The native video render was cancelled');
  error.name = 'AbortError';
  return error;
};

const normalizeFailure = (value) => {
  if (value instanceof NativeRenderError) return value;
  const code = typeof value?.code === 'string' ? value.code : 'nativeRenderFailed';
  return new NativeRenderError(code, 'The native video render could not be completed');
};

const requireInteger = (value, minimum, maximum, response = false) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw response ? invalidResponse() : invalidRequest();
  }
  return value;
};

const requireFinite = (value, minimum, maximum) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidRequest();
  }
  return value;
};

const requireUuid = (value, expectedVersion, response = false) => {
  if (!uuidHasVersion(value, expectedVersion)) {
    throw response ? invalidResponse() : invalidRequest();
  }
  return value;
};

const requireEnum = (value, allowed) => {
  if (!allowed.has(value)) throw invalidRequest();
  return value;
};

const requireString = (value, maximumBytes = 16_384) => {
  if (typeof value !== 'string' || value.length === 0
      || new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw invalidRequest();
  }
  return value;
};

const requireBoolean = (value) => {
  if (typeof value !== 'boolean') throw invalidRequest();
  return value;
};

const secondsToMicros = (value) => {
  const seconds = requireFinite(Number(value), 0, MAX_RENDER_DURATION_MICROS / 1_000_000);
  return requireInteger(Math.round(seconds * 1_000_000), 0, MAX_RENDER_DURATION_MICROS);
};

const canonicalAssetFromDescriptor = (descriptor) => {
  if (!isNativeMediaDescriptor(descriptor)) throw invalidRequest();
  const separator = descriptor.name.lastIndexOf('.');
  if (separator <= 0 || separator === descriptor.name.length - 1) throw invalidRequest();
  const extension = descriptor.name.slice(separator + 1).toLowerCase();
  const kind = descriptor.type.startsWith('video/') ? 'video'
    : descriptor.type.startsWith('audio/') ? 'audio' : null;
  if (kind === null) throw invalidRequest();
  return Object.freeze({
    id: descriptor.assetId,
    displayName: descriptor.name,
    extension,
    sizeBytes: descriptor.size,
    kind,
  });
};

const normalizeSourceAsset = (asset) => {
  if (!hasExactKeys(asset, ['id', 'displayName', 'extension', 'sizeBytes', 'kind'])
      || !uuidHasVersion(asset.id, 7)
      || typeof asset.displayName !== 'string'
      || asset.displayName.length === 0
      || Array.from(asset.displayName).length > 512
      || typeof asset.extension !== 'string'
      || !/^[A-Za-z0-9]{1,16}$/.test(asset.extension)
      || !Number.isSafeInteger(asset.sizeBytes)
      || asset.sizeBytes <= 0
      || !['audio', 'video'].includes(asset.kind)) {
    throw invalidRequest();
  }
  return Object.freeze({
    id: asset.id,
    displayName: asset.displayName,
    extension: asset.extension.toLowerCase(),
    sizeBytes: asset.sizeBytes,
    kind: asset.kind,
  });
};

export const resolveNativeRenderSource = async (value) => {
  if (!isDesktopRuntime()) throw runtimeRequired();
  if (isNativeMediaDescriptor(value)) {
    const asset = canonicalAssetFromDescriptor(value);
    if (asset.kind !== 'video') throw invalidRequest();
    return asset;
  }
  if (isPlainRecord(value)
      && hasExactKeys(value, ['id', 'displayName', 'extension', 'sizeBytes', 'kind'])) {
    const asset = normalizeSourceAsset(value);
    if (asset.kind !== 'video') throw invalidRequest();
    return asset;
  }
  const candidate = isRecord(value) && typeof value.url === 'string' ? value.url : value;
  const assetId = resolveActiveNativeMediaAssetId(candidate);
  if (assetId === null) throw invalidRequest();
  const selected = await getSelectedMedia();
  if (!isNativeMediaDescriptor(selected) || selected.assetId !== assetId) throw invalidRequest();
  const asset = canonicalAssetFromDescriptor(selected);
  if (asset.kind !== 'video') throw invalidRequest();
  return asset;
};

export const ensureNativeRenderProject = async (sourceAsset) => {
  if (!isDesktopRuntime()) throw runtimeRequired();
  const asset = normalizeSourceAsset(sourceAsset);
  const resolved = await resolveProjectForCache(asset.id, { create: true });
  if (!resolved || !uuidHasVersion(resolved.projectId, 7) || !isPlainRecord(resolved.snapshot)) {
    throw invalidRequest();
  }
  const existing = resolved.snapshot.media.find((candidate) => candidate.id === asset.id);
  if (existing) {
    if (existing.displayName !== asset.displayName
        || existing.extension !== asset.extension
        || existing.sizeBytes !== asset.sizeBytes
        || existing.kind !== asset.kind) {
      throw invalidRequest();
    }
    return resolved.projectId;
  }
  const committed = await mutateProject(
    resolved.projectId,
    'Associate source media for native render',
    (snapshot) => ({ ...snapshot, media: [...snapshot.media, asset] }),
    { retryOnConflict: true }
  );
  if (!committed?.snapshot?.media?.some((candidate) => candidate.id === asset.id)) {
    throw invalidResponse();
  }
  return resolved.projectId;
};

const normalizeLyrics = (lyrics) => {
  if (!Array.isArray(lyrics) || lyrics.length === 0 || lyrics.length > MAX_RENDER_LYRICS) {
    throw invalidRequest();
  }
  const ids = new Set();
  return Object.freeze(lyrics.map((lyric, index) => {
    if (!isRecord(lyric)) throw invalidRequest();
    const rawId = lyric.id ?? lyric.subtitle_id ?? index;
    const id = `cue-${index}-${String(rawId)}`;
    if (id.length > 128 || ids.has(id)) throw invalidRequest();
    ids.add(id);
    const startUs = secondsToMicros(lyric.start ?? lyric.start_time ?? lyric.startTime);
    const endUs = secondsToMicros(lyric.end ?? lyric.end_time ?? lyric.endTime);
    const text = requireString(String(lyric.text ?? ''), 16 * 1024);
    if (startUs >= endUs) throw invalidRequest();
    return Object.freeze({ id, startUs, endUs, text });
  }));
};

const normalizeSettings = (settings) => {
  if (!isRecord(settings)) throw invalidRequest();
  const trimStartUs = secondsToMicros(settings.trimStart ?? 0);
  const rawTrimEnd = Number(settings.trimEnd);
  const trimEndUs = Number.isFinite(rawTrimEnd) && rawTrimEnd > (trimStartUs / 1_000_000)
    ? secondsToMicros(rawTrimEnd)
    : null;
  return Object.freeze({
    resolution: requireEnum(settings.resolution, RESOLUTIONS),
    frameRate: requireEnum(Number(settings.frameRate), FRAME_RATES),
    originalAudioVolume: requireInteger(Number(settings.originalAudioVolume), 0, 100),
    narrationVolume: requireInteger(Number(settings.narrationVolume), 0, 100),
    trimStartUs,
    trimEndUs,
  });
};

const normalizeCustomization = (customization) => {
  if (!hasExactKeys(customization, CUSTOMIZATION_KEYS)) throw invalidRequest();
  const normalized = { ...customization };
  [
    'fontSize', 'lineHeight', 'letterSpacing', 'backgroundOpacity', 'borderRadius',
    'borderWidth', 'textShadowBlur', 'textShadowOffsetX', 'textShadowOffsetY',
    'glowIntensity', 'strokeWidth', 'pulseSpeed', 'shakeIntensity', 'customPositionX',
    'customPositionY', 'marginBottom', 'marginTop', 'marginLeft', 'marginRight', 'maxWidth',
    'fadeInDuration', 'fadeOutDuration',
  ].forEach((key) => requireFinite(normalized[key], -10_000, 10_000));
  ['fontWeight', 'shadowLayers', 'maxLines'].forEach((key) => {
    requireInteger(normalized[key], 0, 10_000);
  });
  [
    'textShadowEnabled', 'glowEnabled', 'gradientEnabled', 'strokeEnabled',
    'multiShadowEnabled', 'pulseEnabled', 'shakeEnabled', 'wordWrap', 'rtlSupport',
  ].forEach((key) => requireBoolean(normalized[key]));
  requireString(normalized.fontFamily, 256);
  requireString(normalized.preset, 128);
  requireEnum(normalized.textAlign, TEXT_ALIGNMENTS);
  requireEnum(normalized.textTransform, TEXT_TRANSFORMS);
  requireEnum(normalized.borderStyle, BORDER_STYLES);
  requireEnum(normalized.gradientType, GRADIENT_TYPES);
  requireEnum(normalized.position, SUBTITLE_POSITIONS);
  requireEnum(normalized.animationType, ANIMATION_TYPES);
  requireEnum(normalized.animationEasing, ANIMATION_EASINGS);
  requireEnum(normalized.lineBreakBehavior, LINE_BREAK_BEHAVIORS);
  return Object.freeze(normalized);
};

const normalizeCrop = (crop) => {
  if (!isRecord(crop)) throw invalidRequest();
  const aspectRatio = typeof crop.aspectRatio === 'number' && Number.isFinite(crop.aspectRatio)
    ? crop.aspectRatio
    : null;
  const canvasBgMode = crop.canvasBgMode ?? 'solid';
  if (!['solid', 'blur'].includes(canvasBgMode)) throw invalidRequest();
  return Object.freeze({
    x: requireFinite(Number(crop.x ?? 0), -1_000, 1_000),
    y: requireFinite(Number(crop.y ?? 0), -1_000, 1_000),
    width: requireFinite(Number(crop.width ?? 100), 0.01, 1_000),
    height: requireFinite(Number(crop.height ?? 100), 0.01, 1_000),
    aspectRatio,
    canvasBgMode,
    canvasBgColor: typeof crop.canvasBgColor === 'string' ? crop.canvasBgColor : '#000000',
    canvasBgBlur: requireFinite(Number(crop.canvasBgBlur ?? 24), 0, 1_000),
    flipX: Boolean(crop.flipX),
    flipY: Boolean(crop.flipY),
  });
};

export const buildNativeRenderRequest = ({
  sourceAsset,
  projectId,
  narrationArtifactId = null,
  lyrics,
  settings,
  customization,
  crop,
}) => {
  const source = normalizeSourceAsset(sourceAsset);
  if (source.kind !== 'video') throw invalidRequest();
  return Object.freeze({
    sourceAssetId: source.id,
    projectId: requireUuid(projectId, 7),
    narrationArtifactId: narrationArtifactId === null
      ? null
      : requireUuid(narrationArtifactId, 7),
    lyrics: normalizeLyrics(lyrics),
    settings: normalizeSettings(settings),
    customization: normalizeCustomization(customization),
    crop: normalizeCrop(crop),
  });
};

export const normalizeRenderJob = (job) => {
  if (!hasExactKeys(job, ['id', 'kind', 'state', 'progress', 'sequence'])
      || !hasExactKeys(job.progress, ['basisPoints'])
      || !uuidHasVersion(job.id, 7)
      || job.kind !== 'renderVideo'
      || !JOB_STATES.has(job.state)) {
    throw invalidResponse();
  }
  const progress = requireInteger(job.progress.basisPoints, 0, 10_000, true);
  const sequence = requireInteger(job.sequence, 0, Number.MAX_SAFE_INTEGER, true);
  if ((job.state === 'queued' && (progress !== 0 || sequence !== 0))
      || (job.state === 'succeeded' && progress !== 10_000)
      || (!['queued', 'succeeded'].includes(job.state) && sequence < 1)) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: job.id,
    kind: 'renderVideo',
    state: job.state,
    progress: Object.freeze({ basisPoints: progress }),
    sequence,
  });
};

const normalizeMediaAsset = (asset) => {
  try {
    return normalizeSourceAsset(asset);
  } catch {
    throw invalidResponse();
  }
};

const normalizePlayback = (playback, asset) => {
  if (!hasExactKeys(playback, ['id', 'playbackUrl', 'mimeType', 'byteLength'])
      || !uuidHasVersion(playback.id, 4)
      || !isNativeMediaPlaybackUrl(playback.playbackUrl, playback.id)
      || playback.mimeType !== 'video/mp4'
      || playback.byteLength !== asset.sizeBytes) {
    throw invalidResponse();
  }
  return Object.freeze({ ...playback });
};

export const normalizeRenderResult = (result) => {
  if (!hasExactKeys(result, [
    'artifactId', 'asset', 'sourceAssetId', 'projectId', 'width', 'height', 'fps',
    'durationInFrames', 'playback',
  ])) {
    throw invalidResponse();
  }
  const asset = normalizeMediaAsset(result.asset);
  if (asset.kind !== 'video' || asset.extension !== 'mp4') throw invalidResponse();
  return Object.freeze({
    artifactId: requireUuid(result.artifactId, 7, true),
    asset,
    sourceAssetId: requireUuid(result.sourceAssetId, 7, true),
    projectId: requireUuid(result.projectId, 7, true),
    width: requireInteger(result.width, 2, 15_360, true),
    height: requireInteger(result.height, 2, 8_640, true),
    fps: requireInteger(result.fps, 1, 120, true),
    durationInFrames: requireInteger(result.durationInFrames, 1, 1_000_000, true),
    playback: normalizePlayback(result.playback, asset),
  });
};

export const normalizeRenderResultResponse = (value) => {
  if (!hasExactKeys(value, ['job', 'result'])) throw invalidResponse();
  const job = normalizeRenderJob(value.job);
  const result = value.result === null ? null : normalizeRenderResult(value.result);
  if (job.state === 'succeeded' ? result === null : result !== null) throw invalidResponse();
  return Object.freeze({ job, result });
};

const normalizeCommandError = (value) => {
  if (!hasExactKeys(value, ['code', 'message'])
      || typeof value.code !== 'string'
      || typeof value.message !== 'string') {
    throw invalidResponse();
  }
  return Object.freeze({ code: value.code, message: value.message });
};

export const normalizeRenderEvent = (value) => {
  if (!isPlainRecord(value) || typeof value.event !== 'string') throw invalidResponse();
  if (value.event === 'progress') {
    if (!hasExactKeys(value, [
      'event', 'job', 'phase', 'fractionMillionths', 'renderedFrames', 'encodedFrames',
      'durationInFrames',
    ]) || !RENDER_PHASES.has(value.phase)) {
      throw invalidResponse();
    }
    const job = normalizeRenderJob(value.job);
    if (job.state !== 'running') throw invalidResponse();
    const durationInFrames = requireInteger(value.durationInFrames, 1, 1_000_000, true);
    return Object.freeze({
      event: 'progress',
      job,
      phase: value.phase,
      fractionMillionths: requireInteger(value.fractionMillionths, 0, 1_000_000, true),
      renderedFrames: requireInteger(value.renderedFrames, 0, durationInFrames, true),
      encodedFrames: requireInteger(value.encodedFrames, 0, durationInFrames, true),
      durationInFrames,
    });
  }
  if (value.event === 'completed') {
    if (!hasExactKeys(value, ['event', 'job', 'result'])) throw invalidResponse();
    const job = normalizeRenderJob(value.job);
    if (job.state !== 'succeeded') throw invalidResponse();
    return Object.freeze({ event: 'completed', job, result: normalizeRenderResult(value.result) });
  }
  if (value.event === 'cancelled') {
    if (!hasExactKeys(value, ['event', 'job'])) throw invalidResponse();
    const job = normalizeRenderJob(value.job);
    if (job.state !== 'cancelled') throw invalidResponse();
    return Object.freeze({ event: 'cancelled', job });
  }
  if (value.event === 'failed') {
    if (!hasExactKeys(value, ['event', 'job', 'error'])) throw invalidResponse();
    const job = value.job === null ? null : normalizeRenderJob(value.job);
    if (job !== null && !['failed', 'succeeded'].includes(job.state)) throw invalidResponse();
    return Object.freeze({ event: 'failed', job, error: normalizeCommandError(value.error) });
  }
  throw invalidResponse();
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  const allowed = new Set([
    'onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed', 'onProtocolError',
  ]);
  if (!hasOnlyKeys(handlers, allowed)
      || Object.values(handlers).some(
        (handler) => handler !== undefined && typeof handler !== 'function'
      )) {
    throw invalidRequest();
  }
  return Object.freeze({ ...handlers });
};

const callSafely = (handler, value) => {
  if (typeof handler !== 'function') return;
  try {
    const returned = handler(value);
    if (returned && typeof returned.catch === 'function') returned.catch(() => undefined);
  } catch {
    // Presentation callbacks never own the native render lifecycle.
  }
};

export const createNativeRenderService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const requireNative = () => {
    if (!isNativeRuntime()) throw runtimeRequired();
  };

  const status = async () => {
    requireNative();
    const value = await invokeCommand('render_runtime_status', {});
    if (!hasExactKeys(value, [
      'available', 'remotionVersion', 'reason', 'maxConcurrentRenders',
    ]) || typeof value.available !== 'boolean'
      || value.remotionVersion !== REMOTION_VERSION
      || (value.reason !== null && typeof value.reason !== 'string')
      || value.maxConcurrentRenders !== 1
      || (value.available && value.reason !== null)
      || (!value.available && value.reason === null)) {
      throw invalidResponse();
    }
    return Object.freeze({ ...value });
  };

  const cancel = async (jobId) => {
    requireNative();
    const id = requireUuid(jobId, 7);
    try {
      const job = normalizeRenderJob(await invokeCommand('job_cancel', { id }));
      if (job.id !== id) throw invalidResponse();
      return job;
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  const releasePlayback = async (playbackId) => {
    requireNative();
    const id = requireUuid(playbackId, 4);
    const released = await invokeCommand('render_playback_release', { playbackId: id });
    if (typeof released !== 'boolean') throw invalidResponse();
    return released;
  };

  const getResult = async (jobId) => {
    requireNative();
    const id = requireUuid(jobId, 7);
    try {
      const response = normalizeRenderResultResponse(
        await invokeCommand('render_result', { jobId: id })
      );
      if (response.job.id !== id) throw invalidResponse();
      return response;
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  const start = async (request, rawHandlers, { signal = null } = {}) => {
    requireNative();
    if (!isPlainRecord(request)) throw invalidRequest();
    if (signal !== null && (!isRecord(signal)
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) {
      throw invalidRequest();
    }
    if (signal?.aborted) throw cancelled();
    const handlers = normalizeHandlers(rawHandlers);
    const channel = new ChannelConstructor();
    if (!isRecord(channel)) throw invalidRequest();
    const pending = [];
    let initial = null;
    let lastSequence = null;
    let lastProgress = 0;
    let lastFraction = 0;
    let terminal = false;
    let protocolFailed = false;
    let cancellationIssued = false;

    const issueCancellation = () => {
      if (cancellationIssued || initial === null || terminal) return;
      cancellationIssued = true;
      cancel(initial.id).catch(() => undefined);
    };
    const onAbort = () => issueCancellation();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const release = () => {
      if (initial !== null) activeChannels.delete(initial.id);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const protocolError = () => {
      if (protocolFailed) return;
      protocolFailed = true;
      issueCancellation();
      callSafely(handlers.onProtocolError, invalidResponse());
    };
    const dispatch = (event) => {
      if (terminal || event.job === null
          || event.job.id !== initial.id
          || event.job.sequence < lastSequence
          || event.job.progress.basisPoints < lastProgress
          || (event.event !== 'progress' && event.job.sequence <= lastSequence)
          || (event.event === 'progress' && event.fractionMillionths < lastFraction)) {
        protocolError();
        return;
      }
      lastSequence = event.job.sequence;
      lastProgress = event.job.progress.basisPoints;
      if (event.event === 'progress') lastFraction = event.fractionMillionths;
      if (event.event !== 'progress') {
        terminal = true;
        release();
      }
      callSafely(handlers.onEvent, event);
      if (event.event === 'progress') callSafely(handlers.onProgress, event);
      if (event.event === 'completed') callSafely(handlers.onCompleted, event);
      if (event.event === 'cancelled') callSafely(handlers.onCancelled, event);
      if (event.event === 'failed') callSafely(handlers.onFailed, event);
    };
    channel.onmessage = (rawEvent) => {
      let event;
      try {
        event = normalizeRenderEvent(rawEvent);
      } catch {
        protocolError();
        return;
      }
      if (initial === null) {
        if (pending.length >= MAX_PENDING_EVENTS) {
          protocolError();
        } else {
          pending.push(event);
        }
        return;
      }
      dispatch(event);
    };

    try {
      initial = normalizeRenderJob(await invokeCommand('render_start', {
        request,
        onEvent: channel,
      }));
    } catch (error) {
      release();
      throw normalizeFailure(error);
    }
    if (initial.state !== 'running') {
      release();
      throw invalidResponse();
    }
    lastSequence = initial.sequence;
    lastProgress = initial.progress.basisPoints;
    activeChannels.set(initial.id, channel);
    if (signal?.aborted) issueCancellation();
    pending.splice(0).forEach(dispatch);
    if (protocolFailed) throw invalidResponse();
    return initial;
  };

  return Object.freeze({ status, start, getResult, cancel, releasePlayback });
};

const nativeRenderService = createNativeRenderService();

export const getNativeRenderStatus = nativeRenderService.status;
export const startNativeRender = nativeRenderService.start;
export const getNativeRenderResult = nativeRenderService.getResult;
export const cancelNativeRender = nativeRenderService.cancel;
export const releaseNativeRenderPlayback = nativeRenderService.releasePlayback;

export const runNativeRender = async (request, { signal = null, onStarted, onProgress } = {}) => {
  let settle;
  const terminal = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const initial = await startNativeRender(request, {
    onProgress,
    onCompleted: (event) => settle.resolve(event),
    onCancelled: () => settle.reject(cancelled()),
    onFailed: async (event) => {
      if (event.job?.state === 'succeeded') {
        try {
          const recovered = await getNativeRenderResult(event.job.id);
          if (recovered.result !== null) {
            settle.resolve(Object.freeze({
              event: 'completed',
              job: recovered.job,
              result: recovered.result,
            }));
            return;
          }
        } catch {
          // Fall through to the categorical native failure.
        }
      }
      settle.reject(normalizeFailure(event.error));
    },
    onProtocolError: (error) => settle.reject(error),
  }, { signal });
  callSafely(onStarted, initial);
  return terminal;
};

const abortableDelay = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(cancelled());
    return;
  }
  let timer = null;
  const cleanup = () => {
    if (signal) signal.removeEventListener('abort', onAbort);
  };
  const onAbort = () => {
    if (timer !== null) clearTimeout(timer);
    cleanup();
    reject(cancelled());
  };
  timer = setTimeout(() => {
    cleanup();
    resolve();
  }, milliseconds);
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }
});

export const waitForNativeRender = async (jobId, {
  signal = null,
  pollIntervalMs = 750,
  timeoutMs = MAX_POLL_MS,
  onUpdate,
} = {}) => {
  requireInteger(pollIntervalMs, 100, 10_000);
  requireInteger(timeoutMs, pollIntervalMs, MAX_POLL_MS);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const response = await getNativeRenderResult(jobId);
    callSafely(onUpdate, response);
    if (!ACTIVE_JOB_STATES.has(response.job.state)) return response;
    await abortableDelay(pollIntervalMs, signal);
  }
  throw new NativeRenderError('renderTimeout', 'The native render status wait timed out');
};
