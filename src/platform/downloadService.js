import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import {
  ensureNativeDownloadInspectionReady,
  ensureNativeDownloadReady,
  recoverNativeDownloaderAfterFailure,
} from './nativeDownloadPreflight';

export const DOWNLOAD_COOKIE_SOURCES = Object.freeze([
  'none',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'brave',
  'safari',
  'vivaldi',
  'opera',
  'whale',
]);
export const DOWNLOAD_AUDIO_FORMATS = Object.freeze(['mp3', 'm4a', 'flac', 'wav']);
export const DOWNLOAD_EVENT_TYPES = Object.freeze([
  'progress',
  'completed',
  'cancelled',
  'failed',
]);

const MAX_URL_CHARACTERS = 8_192;
const MAX_FORMATS = 4_096;
const MAX_SUBTITLES = 512;
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_EVENTS = 4_096;
const MAX_SAFE_FILENAME_CHARACTERS = 512;
const cookieSources = new Set(DOWNLOAD_COOKIE_SOURCES);
const audioFormats = new Set(DOWNLOAD_AUDIO_FORMATS);
const containers = new Set([
  'mp4', 'webm', 'm4a', 'mp3', 'opus', 'ogg', 'flac', 'wav', 'other',
]);
const subtitleFormats = new Set(['srt', 'vtt', 'ttml', 'ass', 'lrc', 'json3', 'other']);
const subtitleSources = new Set(['manual', 'automatic']);
const progressPhases = new Set(['downloading', 'downloadFinished', 'postProcessing']);
const mediaKinds = new Set(['audio', 'video']);
const unavailableReasons = new Set([
  'downloaderUnavailable',
  'downloaderHealthCheckFailed',
  'javascriptRuntimeUnavailable',
  'mediaToolsUnavailable',
  'cacheUnavailable',
]);
const jobStates = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const playbackPattern = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/asset\/([0-9a-f-]{36})\?token=([0-9a-f]{64})$/i;

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isPlainRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value, expected) => {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
};

const characterCountWithin = (value, maximum) => {
  if (typeof value !== 'string') return false;
  let count = 0;
  for (const character of value) {
    count += character.length > 0 ? 1 : 0;
    if (count > maximum) return false;
  }
  return true;
};

const utf8ByteLength = (value) => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};

const isUuidVersion = (value, expected) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expected;
  } catch {
    return false;
  }
};

const isSafeInteger = (value, { positive = false } = {}) => (
  Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0)
);

const isOptionalSafeInteger = (value) => value === null || isSafeInteger(value);

const hasControlCharacter = (value) => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || codePoint === 127;
});

const isSafeDisplayText = (value, maximum) => (
  characterCountWithin(value, maximum)
  && value.trim().length > 0
  && !hasControlCharacter(value)
  && !value.includes('/')
  && !value.includes('\\')
);

const isFormatId = (value) => (
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value)
);

const isLanguage = (value) => (
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,35}$/.test(value)
);

export class DownloadServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DownloadServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new DownloadServiceError(
  'invalidDownloadRequest',
  'The native download request is invalid'
);

const invalidResponse = () => new DownloadServiceError(
  'invalidDownloadResponse',
  'The desktop host returned invalid download data'
);

const runtimeRequired = () => new DownloadServiceError(
  'desktopRuntimeUnavailable',
  'Media downloads require the desktop runtime'
);

const normalizeInvocationFailure = (error) => {
  if (error instanceof DownloadServiceError) return error;
  const code = typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(error.code)
    ? error.code
    : 'downloadCommandFailed';
  return new DownloadServiceError(code, 'The native media download could not be completed');
};

const normalizeStatus = (value) => {
  if (!hasExactKeys(value, [
    'available',
    'inspectAvailable',
    'version',
    'reason',
    'maxConcurrentDownloads',
    'inventoryTtlSeconds',
  ])
      || typeof value.available !== 'boolean'
      || typeof value.inspectAvailable !== 'boolean'
      || (value.version !== null
        && (typeof value.version !== 'string'
          || !/^[A-Za-z0-9._-]{1,64}$/.test(value.version)))
      || (value.reason !== null && !unavailableReasons.has(value.reason))
      || !isSafeInteger(value.maxConcurrentDownloads, { positive: true })
      || value.maxConcurrentDownloads > 64
      || !isSafeInteger(value.inventoryTtlSeconds, { positive: true })
      || value.inventoryTtlSeconds > 24 * 60 * 60
      || (value.available && (!value.inspectAvailable || value.reason !== null))
      || (value.inspectAvailable && value.version === null)
      || (!value.inspectAvailable && value.version !== null)) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value });
};

const normalizeVideoFormat = (value) => {
  if (!hasExactKeys(value, [
    'formatId',
    'container',
    'width',
    'height',
    'fpsMilli',
    'codec',
    'includesAudio',
    'sizeBytes',
    'bitrateKbps',
  ])
      || !isFormatId(value.formatId)
      || !containers.has(value.container)
      || !isOptionalSafeInteger(value.width)
      || !isOptionalSafeInteger(value.height)
      || !isOptionalSafeInteger(value.fpsMilli)
      || (value.codec !== null
        && (typeof value.codec !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(value.codec)))
      || typeof value.includesAudio !== 'boolean'
      || !isOptionalSafeInteger(value.sizeBytes)
      || !isOptionalSafeInteger(value.bitrateKbps)) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value });
};

const normalizeAudioFormat = (value) => {
  if (!hasExactKeys(value, [
    'formatId', 'container', 'codec', 'sizeBytes', 'bitrateKbps',
  ])
      || !isFormatId(value.formatId)
      || !containers.has(value.container)
      || (value.codec !== null
        && (typeof value.codec !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(value.codec)))
      || !isOptionalSafeInteger(value.sizeBytes)
      || !isOptionalSafeInteger(value.bitrateKbps)) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value });
};

const normalizeQuality = (value) => {
  if (!hasExactKeys(value, ['height', 'hasCombined', 'hasVideoOnly'])
      || !isSafeInteger(value.height, { positive: true })
      || value.height > 16_384
      || typeof value.hasCombined !== 'boolean'
      || typeof value.hasVideoOnly !== 'boolean'
      || (!value.hasCombined && !value.hasVideoOnly)) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value });
};

const normalizeSubtitleTrack = (value) => {
  if (!hasExactKeys(value, ['language', 'source', 'formats'])
      || !isLanguage(value.language)
      || !subtitleSources.has(value.source)
      || !Array.isArray(value.formats)
      || value.formats.length === 0
      || value.formats.length > 7
      || value.formats.some((format) => !subtitleFormats.has(format))
      || new Set(value.formats).size !== value.formats.length) {
    throw invalidResponse();
  }
  return Object.freeze({
    language: value.language,
    source: value.source,
    formats: Object.freeze([...value.formats]),
  });
};

const normalizeInventory = (value) => {
  if (!hasExactKeys(value, ['title', 'durationSeconds', 'formats', 'subtitles'])
      || !isSafeDisplayText(value.title, 120)
      || !isOptionalSafeInteger(value.durationSeconds)
      || !hasExactKeys(value.formats, ['video', 'audio', 'qualities'])
      || !Array.isArray(value.formats.video)
      || !Array.isArray(value.formats.audio)
      || !Array.isArray(value.formats.qualities)
      || value.formats.video.length + value.formats.audio.length > MAX_FORMATS
      || value.formats.qualities.length > MAX_FORMATS
      || value.formats.video.length + value.formats.audio.length === 0
      || !Array.isArray(value.subtitles)
      || value.subtitles.length > MAX_SUBTITLES) {
    throw invalidResponse();
  }
  const video = value.formats.video.map(normalizeVideoFormat);
  const audio = value.formats.audio.map(normalizeAudioFormat);
  const formatIds = [...video, ...audio].map((format) => format.formatId);
  if (new Set(formatIds).size !== formatIds.length) throw invalidResponse();
  const qualities = value.formats.qualities.map(normalizeQuality);
  const subtitles = value.subtitles.map(normalizeSubtitleTrack);
  const subtitleKeys = subtitles.map((track) => `${track.source}:${track.language}`);
  if (new Set(subtitleKeys).size !== subtitleKeys.length) throw invalidResponse();
  return Object.freeze({
    title: value.title,
    durationSeconds: value.durationSeconds,
    formats: Object.freeze({
      video: Object.freeze(video),
      audio: Object.freeze(audio),
      qualities: Object.freeze(qualities),
    }),
    subtitles: Object.freeze(subtitles),
  });
};

const normalizeInspection = (value) => {
  if (!hasExactKeys(value, ['capability', 'inventory'])
      || !hasExactKeys(value.capability, ['id', 'expiresAtMs'])
      || !isUuidVersion(value.capability.id, 7)
      || !isSafeInteger(value.capability.expiresAtMs, { positive: true })) {
    throw invalidResponse();
  }
  return Object.freeze({
    capability: Object.freeze({ ...value.capability }),
    inventory: normalizeInventory(value.inventory),
  });
};

const normalizeInspectRequest = (request) => {
  if (!isPlainRecord(request)
      || !hasExactKeys(request, ['url', 'cookieSource'])
      || !characterCountWithin(request.url, MAX_URL_CHARACTERS)
      || request.url.length === 0
      || request.url.includes('\\')
      || hasControlCharacter(request.url)
      || !cookieSources.has(request.cookieSource)) {
    throw invalidRequest();
  }
  return Object.freeze({ url: request.url, cookieSource: request.cookieSource });
};

const normalizeQualityRequest = (quality, kind) => {
  if (!isPlainRecord(quality) || typeof quality.mode !== 'string') throw invalidRequest();
  if (quality.mode === 'best' && hasExactKeys(quality, ['mode'])) {
    return Object.freeze({ mode: 'best' });
  }
  if (kind === 'video'
      && quality.mode === 'atMost'
      && hasExactKeys(quality, ['mode', 'height'])
      && Number.isInteger(quality.height)
      && quality.height >= 144
      && quality.height <= 4_320) {
    return Object.freeze({ mode: 'atMost', height: quality.height });
  }
  if (quality.mode === 'exact'
      && hasExactKeys(quality, ['mode', 'formatId'])
      && isFormatId(quality.formatId)) {
    return Object.freeze({ mode: 'exact', formatId: quality.formatId });
  }
  throw invalidRequest();
};

const normalizeMediaRequest = (media) => {
  if (!isPlainRecord(media) || (media.kind !== 'video' && media.kind !== 'audio')) {
    throw invalidRequest();
  }
  if (media.kind === 'video' && hasExactKeys(media, ['kind', 'quality'])) {
    return Object.freeze({
      kind: 'video',
      quality: normalizeQualityRequest(media.quality, 'video'),
    });
  }
  if (media.kind === 'audio'
      && hasExactKeys(media, ['kind', 'quality', 'format'])
      && audioFormats.has(media.format)) {
    return Object.freeze({
      kind: 'audio',
      quality: normalizeQualityRequest(media.quality, 'audio'),
      format: media.format,
    });
  }
  throw invalidRequest();
};

const normalizeStartRequest = (request) => {
  if (!isPlainRecord(request)
      || !hasExactKeys(request, ['inventoryId', 'media', 'subtitle'])
      || !isUuidVersion(request.inventoryId, 7)
      || (request.subtitle !== null
        && (!hasExactKeys(request.subtitle, ['language', 'source'])
          || !isLanguage(request.subtitle.language)
          || !subtitleSources.has(request.subtitle.source)))) {
    throw invalidRequest();
  }
  return Object.freeze({
    inventoryId: request.inventoryId,
    media: normalizeMediaRequest(request.media),
    subtitle: request.subtitle === null ? null : Object.freeze({ ...request.subtitle }),
  });
};

const normalizeJob = (value) => {
  if (!hasExactKeys(value, ['id', 'kind', 'state', 'progress', 'sequence'])
      || !isUuidVersion(value.id, 7)
      || value.kind !== 'downloadMedia'
      || !jobStates.has(value.state)
      || !hasExactKeys(value.progress, ['basisPoints'])
      || !isSafeInteger(value.progress.basisPoints)
      || value.progress.basisPoints > 10_000
      || !isSafeInteger(value.sequence)
      || (value.state === 'queued'
        && (value.progress.basisPoints !== 0 || value.sequence !== 0))
      || (value.state === 'succeeded'
        && (value.progress.basisPoints !== 10_000 || value.sequence < 2))
      || (value.state !== 'queued' && value.sequence < 1)) {
    throw invalidResponse();
  }
  return Object.freeze({
    ...value,
    progress: Object.freeze({ basisPoints: value.progress.basisPoints }),
  });
};

const normalizeProgress = (value) => {
  if (!hasExactKeys(value, [
    'phase',
    'downloadedBytes',
    'totalBytes',
    'bytesPerSecond',
    'etaSeconds',
    'fraction',
  ])
      || !progressPhases.has(value.phase)
      || !isOptionalSafeInteger(value.downloadedBytes)
      || !isOptionalSafeInteger(value.totalBytes)
      || !isOptionalSafeInteger(value.bytesPerSecond)
      || !isOptionalSafeInteger(value.etaSeconds)
      || (value.fraction !== null
        && (typeof value.fraction !== 'number'
          || !Number.isFinite(value.fraction)
          || value.fraction < 0
          || value.fraction > 1))) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value });
};

const normalizeSummary = (value) => {
  const subtitleFields = [
    value?.subtitleFilename,
    value?.subtitleBytes,
    value?.subtitleLanguage,
  ];
  const hasNoSubtitle = subtitleFields.every((field) => field === null);
  const hasCompleteSubtitle = subtitleFields.every((field) => field !== null);
  if (!hasExactKeys(value, [
    'title',
    'durationSeconds',
    'mediaFilename',
    'mediaBytes',
    'subtitleFilename',
    'subtitleBytes',
    'subtitleLanguage',
  ])
      || !isSafeDisplayText(value.title, 120)
      || !isOptionalSafeInteger(value.durationSeconds)
      || !isSafeDisplayText(value.mediaFilename, MAX_SAFE_FILENAME_CHARACTERS)
      || !isSafeInteger(value.mediaBytes, { positive: true })
      || (value.subtitleFilename !== null
        && !isSafeDisplayText(value.subtitleFilename, MAX_SAFE_FILENAME_CHARACTERS))
      || !isOptionalSafeInteger(value.subtitleBytes)
      || (value.subtitleLanguage !== null && !isLanguage(value.subtitleLanguage))
      || (!hasNoSubtitle && !hasCompleteSubtitle)) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value });
};

const normalizeMedia = (value, summary) => {
  if (!hasExactKeys(value, ['asset', 'playback'])
      || !hasExactKeys(value.asset, ['id', 'displayName', 'extension', 'sizeBytes', 'kind'])
      || !isUuidVersion(value.asset.id, 7)
      || !isSafeDisplayText(value.asset.displayName, MAX_SAFE_FILENAME_CHARACTERS)
      || typeof value.asset.extension !== 'string'
      || !/^[a-z0-9]{1,16}$/.test(value.asset.extension)
      || !mediaKinds.has(value.asset.kind)
      || value.asset.sizeBytes !== summary.mediaBytes
      || value.asset.displayName !== summary.mediaFilename
      || !hasExactKeys(value.playback, ['id', 'playbackUrl', 'mimeType', 'byteLength'])
      || !isUuidVersion(value.playback.id, 4)
      || value.playback.byteLength !== value.asset.sizeBytes
      || typeof value.playback.mimeType !== 'string'
      || !value.playback.mimeType.startsWith(`${value.asset.kind}/`)) {
    throw invalidResponse();
  }
  const match = typeof value.playback.playbackUrl === 'string'
    ? playbackPattern.exec(value.playback.playbackUrl)
    : null;
  if (!match
      || Number(match[1]) < 1
      || Number(match[1]) > 65_535
      || match[2] !== value.playback.id) {
    throw invalidResponse();
  }
  return Object.freeze({
    asset: Object.freeze({ ...value.asset }),
    playback: Object.freeze({ ...value.playback }),
  });
};

const normalizeSubtitle = (value, summary) => {
  if (value === null) {
    if (summary.subtitleFilename !== null) throw invalidResponse();
    return null;
  }
  if (!hasExactKeys(value, ['filename', 'language', 'content'])
      || value.filename !== summary.subtitleFilename
      || value.language !== summary.subtitleLanguage
      || typeof value.content !== 'string'
      || utf8ByteLength(value.content) > MAX_SUBTITLE_BYTES) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value });
};

const normalizeError = (value) => {
  if (!hasExactKeys(value, ['code', 'message'])
      || typeof value.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(value.code)
      || typeof value.message !== 'string') {
    throw invalidResponse();
  }
  return Object.freeze({
    code: value.code,
    message: 'The native media download could not be completed',
  });
};

export const normalizeDownloadEvent = (value) => {
  if (!isRecord(value) || typeof value.event !== 'string') throw invalidResponse();
  switch (value.event) {
    case 'progress':
      if (!hasExactKeys(value, ['event', 'job', 'progress'])) throw invalidResponse();
      return Object.freeze({
        event: 'progress',
        job: normalizeJob(value.job),
        progress: normalizeProgress(value.progress),
      });
    case 'completed': {
      if (!hasExactKeys(value, ['event', 'job', 'media', 'summary', 'subtitle'])) {
        throw invalidResponse();
      }
      const job = normalizeJob(value.job);
      if (job.state !== 'succeeded') throw invalidResponse();
      const summary = normalizeSummary(value.summary);
      return Object.freeze({
        event: 'completed',
        job,
        media: normalizeMedia(value.media, summary),
        summary,
        subtitle: normalizeSubtitle(value.subtitle, summary),
      });
    }
    case 'cancelled': {
      if (!hasExactKeys(value, ['event', 'job'])) throw invalidResponse();
      const job = normalizeJob(value.job);
      if (job.state !== 'cancelled') throw invalidResponse();
      return Object.freeze({ event: 'cancelled', job });
    }
    case 'failed': {
      if (!hasExactKeys(value, ['event', 'job', 'error'])) throw invalidResponse();
      const job = value.job === null ? null : normalizeJob(value.job);
      if (job !== null && job.state !== 'failed') throw invalidResponse();
      return Object.freeze({ event: 'failed', job, error: normalizeError(value.error) });
    }
    default:
      throw invalidResponse();
  }
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  const keys = ['onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed', 'onProtocolError'];
  if (!isPlainRecord(handlers) || Object.keys(handlers).some((key) => !keys.includes(key))) {
    throw invalidRequest();
  }
  for (const handler of Object.values(handlers)) {
    if (handler !== undefined && typeof handler !== 'function') throw invalidRequest();
  }
  return Object.freeze({ ...handlers });
};

export const createNativeDownloadService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const invoke = async (command, args, normalize) => {
    if (!isNativeRuntime()) throw runtimeRequired();
    try {
      return normalize(await invokeCommand(command, args));
    } catch (error) {
      throw normalizeInvocationFailure(error);
    }
  };

  const getStatus = () => invoke('download_status', {}, normalizeStatus);

  const inspectUrl = (request) => invoke(
    'download_inspect',
    { request: normalizeInspectRequest(request) },
    normalizeInspection
  );

  const startDownload = async (request, rawHandlers) => {
    if (!isNativeRuntime()) throw runtimeRequired();
    const normalizedRequest = normalizeStartRequest(request);
    const handlers = normalizeHandlers(rawHandlers);
    const pending = [];
    let initial = null;
    let terminal = false;

    const call = (handler, event) => {
      if (typeof handler !== 'function') return;
      try {
        const returned = handler(event);
        if (returned && typeof returned.catch === 'function') returned.catch(() => undefined);
      } catch {
        // UI handlers cannot break the native Channel protocol.
      }
    };
    const protocolError = () => call(handlers.onProtocolError, invalidResponse());
    const dispatch = (event) => {
      const eventJobId = event.job?.id;
      if (terminal || (eventJobId !== undefined && eventJobId !== initial.id)) {
        protocolError();
        return;
      }
      if (event.event !== 'progress') {
        terminal = true;
        activeChannels.delete(initial.id);
      }
      if (event.event === 'failed' && event.error.code === 'downloaderExecutionFailed') {
        void recoverNativeDownloaderAfterFailure();
      }
      call(handlers.onEvent, event);
      if (event.event === 'progress') call(handlers.onProgress, event);
      if (event.event === 'completed') call(handlers.onCompleted, event);
      if (event.event === 'cancelled') call(handlers.onCancelled, event);
      if (event.event === 'failed') call(handlers.onFailed, event);
    };

    const channel = new ChannelConstructor();
    channel.onmessage = (rawEvent) => {
      let event;
      try {
        event = normalizeDownloadEvent(rawEvent);
      } catch {
        protocolError();
        return;
      }
      if (initial === null) {
        if (pending.length >= MAX_PENDING_EVENTS) {
          protocolError();
          return;
        }
        pending.push(event);
        return;
      }
      dispatch(event);
    };

    let snapshot;
    try {
      snapshot = normalizeJob(await invokeCommand('download_start', {
        request: normalizedRequest,
        onEvent: channel,
      }));
    } catch (error) {
      pending.length = 0;
      throw normalizeInvocationFailure(error);
    }
    initial = snapshot;
    if (snapshot.state !== 'running') {
      pending.length = 0;
      throw invalidResponse();
    }
    activeChannels.set(snapshot.id, channel);
    pending.splice(0).forEach(dispatch);
    if (terminal) activeChannels.delete(snapshot.id);
    return snapshot;
  };

  const cancelDownload = (jobId) => {
    if (!isUuidVersion(jobId, 7)) return Promise.reject(invalidRequest());
    return invoke('download_cancel', { jobId }, (value) => {
      const snapshot = normalizeJob(value);
      if (snapshot.id !== jobId) throw invalidResponse();
      return snapshot;
    });
  };

  return Object.freeze({ getStatus, inspectUrl, startDownload, cancelDownload });
};

const downloadService = createNativeDownloadService();

export const getDownloadStatus = downloadService.getStatus;
export const inspectDownloadUrl = async (request, preflightOptions) => {
  const normalizedRequest = normalizeInspectRequest(request);
  const readiness = await downloadService.getStatus();
  await ensureNativeDownloadInspectionReady(readiness, preflightOptions);
  try {
    return await downloadService.inspectUrl(normalizedRequest);
  } catch (error) {
    if (error?.code === 'downloaderExecutionFailed') {
      void recoverNativeDownloaderAfterFailure();
    }
    throw error;
  }
};
export const startDownload = async (request, handlers, preflightOptions) => {
  const normalizedRequest = normalizeStartRequest(request);
  const normalizedHandlers = normalizeHandlers(handlers);
  const readiness = await downloadService.getStatus();
  await ensureNativeDownloadReady(readiness, preflightOptions);
  return downloadService.startDownload(normalizedRequest, normalizedHandlers);
};
export const cancelDownload = downloadService.cancelDownload;
