import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import {
  ensureNativeDownloadInspectionReady,
  ensureNativeDownloadReady,
  recoverNativeDownloaderAfterFailure,
} from './nativeDownloadPreflight';
import { DOWNLOAD_COOKIE_SOURCES } from './downloadCookiePreference';

export { DOWNLOAD_COOKIE_SOURCES } from './downloadCookiePreference';
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
const activeJobStates = new Set(['running', 'cancelling']);
const cancellationResponseStates = new Set([
  'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const downloadCommandCodes = new Set([
  'internal',
  'invalidInput',
  'mediaToolsUnavailable',
  'downloaderExecutionFailed',
  'jobAlreadyExists',
  'jobNotFound',
  'jobConflict',
  'invalidJobState',
  'jobRegistry',
  'database',
]);

const snapshotDataRecord = (value, {
  required,
  allowed = required,
  failure,
}) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))
        || required.some((key) => !keys.includes(key))) {
      throw failure();
    }
    const snapshot = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw failure();
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw failure();
  }
};

const snapshotDataArray = (value, maximum, failure) => {
  try {
    if (!Array.isArray(value)) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) {
      throw failure();
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== length + 1) throw failure();
    const snapshot = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw failure();
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    throw failure();
  }
};

const exactRecord = (value, keys, failure) => snapshotDataRecord(value, {
  required: keys,
  failure,
});

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
  let code = 'downloadCommandFailed';
  try {
    const candidate = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? error.code
      : null;
    if (downloadCommandCodes.has(candidate)) code = candidate;
  } catch {
    // A hostile transport accessor is not authoritative error metadata.
  }
  return new DownloadServiceError(code, 'The native media download could not be completed');
};

const triggerNativeDownloaderRecovery = () => {
  try {
    Promise.resolve(recoverNativeDownloaderAfterFailure()).catch(() => undefined);
  } catch {
    // Automatic recovery is best-effort and cannot create an orphan rejection.
  }
};

const normalizeStatus = (value) => {
  const data = exactRecord(value, [
    'available',
    'inspectAvailable',
    'version',
    'reason',
    'maxConcurrentDownloads',
    'inventoryTtlSeconds',
  ], invalidResponse);
  if (typeof data.available !== 'boolean'
      || typeof data.inspectAvailable !== 'boolean'
      || (data.version !== null
        && (typeof data.version !== 'string'
          || !/^[A-Za-z0-9._-]{1,64}$/.test(data.version)))
      || (data.reason !== null && !unavailableReasons.has(data.reason))
      || !isSafeInteger(data.maxConcurrentDownloads, { positive: true })
      || data.maxConcurrentDownloads > 64
      || !isSafeInteger(data.inventoryTtlSeconds, { positive: true })
      || data.inventoryTtlSeconds > 24 * 60 * 60
      || (data.available && (!data.inspectAvailable || data.reason !== null))
      || (!data.available && data.reason === null)
      || (data.inspectAvailable && data.version === null)
      || (!data.inspectAvailable && data.version !== null)) {
    throw invalidResponse();
  }
  return data;
};

const normalizeVideoFormat = (value) => {
  const data = exactRecord(value, [
    'formatId',
    'container',
    'width',
    'height',
    'fpsMilli',
    'codec',
    'includesAudio',
    'sizeBytes',
    'bitrateKbps',
  ], invalidResponse);
  if (!isFormatId(data.formatId)
      || !containers.has(data.container)
      || !isOptionalSafeInteger(data.width)
      || !isOptionalSafeInteger(data.height)
      || !isOptionalSafeInteger(data.fpsMilli)
      || (data.codec !== null
        && (typeof data.codec !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(data.codec)))
      || typeof data.includesAudio !== 'boolean'
      || !isOptionalSafeInteger(data.sizeBytes)
      || !isOptionalSafeInteger(data.bitrateKbps)) {
    throw invalidResponse();
  }
  return data;
};

const normalizeAudioFormat = (value) => {
  const data = exactRecord(value, [
    'formatId', 'container', 'codec', 'sizeBytes', 'bitrateKbps',
  ], invalidResponse);
  if (!isFormatId(data.formatId)
      || !containers.has(data.container)
      || (data.codec !== null
        && (typeof data.codec !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(data.codec)))
      || !isOptionalSafeInteger(data.sizeBytes)
      || !isOptionalSafeInteger(data.bitrateKbps)) {
    throw invalidResponse();
  }
  return data;
};

const normalizeQuality = (value) => {
  const data = exactRecord(
    value,
    ['height', 'hasCombined', 'hasVideoOnly'],
    invalidResponse
  );
  if (!isSafeInteger(data.height, { positive: true })
      || data.height > 16_384
      || typeof data.hasCombined !== 'boolean'
      || typeof data.hasVideoOnly !== 'boolean'
      || (!data.hasCombined && !data.hasVideoOnly)) {
    throw invalidResponse();
  }
  return data;
};

const normalizeSubtitleTrack = (value) => {
  const data = exactRecord(value, ['language', 'source', 'formats'], invalidResponse);
  const formats = snapshotDataArray(data.formats, 7, invalidResponse);
  if (!isLanguage(data.language)
      || !subtitleSources.has(data.source)
      || formats.length === 0
      || formats.some((format) => !subtitleFormats.has(format))
      || new Set(formats).size !== formats.length) {
    throw invalidResponse();
  }
  return Object.freeze({
    language: data.language,
    source: data.source,
    formats,
  });
};

const normalizeInventory = (value) => {
  const data = exactRecord(
    value,
    ['title', 'durationSeconds', 'formats', 'subtitles'],
    invalidResponse
  );
  const formatData = exactRecord(data.formats, ['video', 'audio', 'qualities'], invalidResponse);
  const rawVideo = snapshotDataArray(formatData.video, MAX_FORMATS, invalidResponse);
  const rawAudio = snapshotDataArray(formatData.audio, MAX_FORMATS, invalidResponse);
  const rawQualities = snapshotDataArray(formatData.qualities, MAX_FORMATS, invalidResponse);
  const rawSubtitles = snapshotDataArray(data.subtitles, MAX_SUBTITLES, invalidResponse);
  if (!isSafeDisplayText(data.title, 120)
      || !isOptionalSafeInteger(data.durationSeconds)
      || rawVideo.length + rawAudio.length > MAX_FORMATS
      || rawVideo.length + rawAudio.length === 0) {
    throw invalidResponse();
  }
  const video = rawVideo.map(normalizeVideoFormat);
  const audio = rawAudio.map(normalizeAudioFormat);
  const formatIds = video.concat(audio).map((format) => format.formatId);
  if (new Set(formatIds).size !== formatIds.length) throw invalidResponse();
  const qualities = rawQualities.map(normalizeQuality);
  const subtitles = rawSubtitles.map(normalizeSubtitleTrack);
  const subtitleKeys = subtitles.map((track) => `${track.source}:${track.language}`);
  if (new Set(subtitleKeys).size !== subtitleKeys.length) throw invalidResponse();
  return Object.freeze({
    title: data.title,
    durationSeconds: data.durationSeconds,
    formats: Object.freeze({
      video: Object.freeze(video),
      audio: Object.freeze(audio),
      qualities: Object.freeze(qualities),
    }),
    subtitles: Object.freeze(subtitles),
  });
};

const normalizeInspection = (value) => {
  const data = exactRecord(value, ['capability', 'inventory'], invalidResponse);
  const capability = exactRecord(data.capability, ['id', 'expiresAtMs'], invalidResponse);
  if (!isUuidVersion(capability.id, 7)
      || !isSafeInteger(capability.expiresAtMs, { positive: true })) {
    throw invalidResponse();
  }
  return Object.freeze({
    capability,
    inventory: normalizeInventory(data.inventory),
  });
};

const normalizeInspectRequest = (request) => {
  const data = exactRecord(request, ['url', 'cookieSource'], invalidRequest);
  if (!characterCountWithin(data.url, MAX_URL_CHARACTERS)
      || data.url.length === 0
      || data.url.includes('\\')
      || hasControlCharacter(data.url)
      || !cookieSources.has(data.cookieSource)) {
    throw invalidRequest();
  }
  return data;
};

const normalizeQualityRequest = (quality, kind) => {
  const data = snapshotDataRecord(quality, {
    required: ['mode'],
    allowed: ['mode', 'height', 'formatId'],
    failure: invalidRequest,
  });
  if (typeof data.mode !== 'string') throw invalidRequest();
  if (data.mode === 'best' && Object.keys(data).length === 1) {
    return Object.freeze({ mode: 'best' });
  }
  if (kind === 'video'
      && data.mode === 'atMost'
      && Object.keys(data).length === 2 && Object.hasOwn(data, 'height')
      && Number.isInteger(data.height)
      && data.height >= 144
      && data.height <= 4_320) {
    return Object.freeze({ mode: 'atMost', height: data.height });
  }
  if (data.mode === 'exact'
      && Object.keys(data).length === 2 && Object.hasOwn(data, 'formatId')
      && isFormatId(data.formatId)) {
    return Object.freeze({ mode: 'exact', formatId: data.formatId });
  }
  throw invalidRequest();
};

const normalizeMediaRequest = (media) => {
  const data = snapshotDataRecord(media, {
    required: ['kind', 'quality'],
    allowed: ['kind', 'quality', 'format'],
    failure: invalidRequest,
  });
  if (data.kind !== 'video' && data.kind !== 'audio') {
    throw invalidRequest();
  }
  if (data.kind === 'video' && Object.keys(data).length === 2) {
    return Object.freeze({
      kind: 'video',
      quality: normalizeQualityRequest(data.quality, 'video'),
    });
  }
  if (data.kind === 'audio'
      && Object.keys(data).length === 3 && Object.hasOwn(data, 'format')
      && audioFormats.has(data.format)) {
    return Object.freeze({
      kind: 'audio',
      quality: normalizeQualityRequest(data.quality, 'audio'),
      format: data.format,
    });
  }
  throw invalidRequest();
};

const normalizeStartRequest = (request) => {
  const data = exactRecord(request, ['inventoryId', 'media', 'subtitle'], invalidRequest);
  const subtitle = data.subtitle === null
    ? null
    : exactRecord(data.subtitle, ['language', 'source'], invalidRequest);
  if (!isUuidVersion(data.inventoryId, 7)
      || (subtitle !== null
        && (!isLanguage(subtitle.language) || !subtitleSources.has(subtitle.source)))) {
    throw invalidRequest();
  }
  return Object.freeze({
    inventoryId: data.inventoryId,
    media: normalizeMediaRequest(data.media),
    subtitle,
  });
};

const normalizeJob = (value, expectedKind = 'downloadMedia') => {
  const data = exactRecord(value, ['id', 'kind', 'state', 'progress', 'sequence'], invalidResponse);
  const progress = exactRecord(data.progress, ['basisPoints'], invalidResponse);
  if (!isUuidVersion(data.id, 7)
      || data.kind !== expectedKind
      || !jobStates.has(data.state)
      || !isSafeInteger(progress.basisPoints)
      || progress.basisPoints > 10_000
      || !isSafeInteger(data.sequence)
      || (data.state === 'queued'
        && (progress.basisPoints !== 0 || data.sequence !== 0))
      || (data.state === 'succeeded'
        && (progress.basisPoints !== 10_000 || data.sequence < 2))
      || (data.state !== 'queued' && data.sequence < 1)) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: data.id,
    kind: data.kind,
    state: data.state,
    progress: Object.freeze({ basisPoints: progress.basisPoints }),
    sequence: data.sequence,
  });
};

const normalizeProgress = (value) => {
  const data = exactRecord(value, [
    'phase',
    'downloadedBytes',
    'totalBytes',
    'bytesPerSecond',
    'etaSeconds',
    'fraction',
  ], invalidResponse);
  if (!progressPhases.has(data.phase)
      || !isOptionalSafeInteger(data.downloadedBytes)
      || !isOptionalSafeInteger(data.totalBytes)
      || !isOptionalSafeInteger(data.bytesPerSecond)
      || !isOptionalSafeInteger(data.etaSeconds)
      || (data.fraction !== null
        && (typeof data.fraction !== 'number'
          || !Number.isFinite(data.fraction)
          || data.fraction < 0
          || data.fraction > 1))) {
    throw invalidResponse();
  }
  return Object.freeze({
    phase: data.phase,
    downloadedBytes: data.downloadedBytes,
    totalBytes: data.totalBytes,
    bytesPerSecond: data.bytesPerSecond,
    etaSeconds: data.etaSeconds,
    fraction: data.fraction,
  });
};

const normalizeSummary = (value) => {
  const data = exactRecord(value, [
    'title',
    'durationSeconds',
    'mediaFilename',
    'mediaBytes',
    'subtitleFilename',
    'subtitleBytes',
    'subtitleLanguage',
  ], invalidResponse);
  const subtitleFields = [
    data.subtitleFilename,
    data.subtitleBytes,
    data.subtitleLanguage,
  ];
  const hasNoSubtitle = subtitleFields.every((field) => field === null);
  const hasCompleteSubtitle = subtitleFields.every((field) => field !== null);
  if (!isSafeDisplayText(data.title, 120)
      || !isOptionalSafeInteger(data.durationSeconds)
      || !isSafeDisplayText(data.mediaFilename, MAX_SAFE_FILENAME_CHARACTERS)
      || !isSafeInteger(data.mediaBytes, { positive: true })
      || (data.subtitleFilename !== null
        && !isSafeDisplayText(data.subtitleFilename, MAX_SAFE_FILENAME_CHARACTERS))
      || !isOptionalSafeInteger(data.subtitleBytes)
      || (data.subtitleLanguage !== null && !isLanguage(data.subtitleLanguage))
      || (!hasNoSubtitle && !hasCompleteSubtitle)) {
    throw invalidResponse();
  }
  return Object.freeze({
    title: data.title,
    durationSeconds: data.durationSeconds,
    mediaFilename: data.mediaFilename,
    mediaBytes: data.mediaBytes,
    subtitleFilename: data.subtitleFilename,
    subtitleBytes: data.subtitleBytes,
    subtitleLanguage: data.subtitleLanguage,
  });
};

const normalizeMedia = (value, summary) => {
  const data = exactRecord(value, ['asset', 'contentIdentity'], invalidResponse);
  const asset = exactRecord(
    data.asset,
    ['id', 'displayName', 'extension', 'sizeBytes', 'kind'],
    invalidResponse
  );
  const contentIdentity = exactRecord(
    data.contentIdentity,
    ['algorithm', 'digest', 'sizeBytes'],
    invalidResponse
  );
  if (!isUuidVersion(asset.id, 7)
      || !isSafeDisplayText(asset.displayName, MAX_SAFE_FILENAME_CHARACTERS)
      || typeof asset.extension !== 'string'
      || !/^[a-z0-9]{1,16}$/.test(asset.extension)
      || !mediaKinds.has(asset.kind)
      || asset.sizeBytes !== summary.mediaBytes
      || asset.displayName !== summary.mediaFilename
      || contentIdentity.algorithm !== 'blake3-256'
      || typeof contentIdentity.digest !== 'string'
      || !/^[0-9a-f]{64}$/.test(contentIdentity.digest)
      || contentIdentity.sizeBytes !== asset.sizeBytes) {
    throw invalidResponse();
  }
  return Object.freeze({
    asset: Object.freeze({
      id: asset.id,
      displayName: asset.displayName,
      extension: asset.extension,
      sizeBytes: asset.sizeBytes,
      kind: asset.kind,
    }),
    contentIdentity: Object.freeze({
      algorithm: contentIdentity.algorithm,
      digest: contentIdentity.digest,
      sizeBytes: contentIdentity.sizeBytes,
    }),
  });
};

const normalizeSubtitle = (value, summary) => {
  if (value === null) {
    if (summary.subtitleFilename !== null) throw invalidResponse();
    return null;
  }
  const data = exactRecord(value, ['filename', 'language', 'content'], invalidResponse);
  if (data.filename !== summary.subtitleFilename
      || data.language !== summary.subtitleLanguage
      || typeof data.content !== 'string'
      || utf8ByteLength(data.content) > MAX_SUBTITLE_BYTES) {
    throw invalidResponse();
  }
  return Object.freeze({
    filename: data.filename,
    language: data.language,
    content: data.content,
  });
};

const normalizeError = (value) => {
  const data = exactRecord(value, ['code', 'message'], invalidResponse);
  const { code, message } = data;
  if (typeof code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(code)
      || typeof message !== 'string'
      || message.length > 2_048) {
    throw invalidResponse();
  }
  return Object.freeze({
    code: downloadCommandCodes.has(code) ? code : 'downloadCommandFailed',
    message: 'The native media download could not be completed',
  });
};

const downloadEventKeys = Object.freeze([
  'event', 'job', 'progress', 'media', 'summary', 'subtitle', 'error',
]);

const hasSnapshotKeys = (value, expected) => {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

export const normalizeDownloadEvent = (value) => {
  const data = snapshotDataRecord(value, {
    required: ['event', 'job'],
    allowed: downloadEventKeys,
    failure: invalidResponse,
  });
  if (typeof data.event !== 'string') throw invalidResponse();
  switch (data.event) {
    case 'progress':
      if (!hasSnapshotKeys(data, ['event', 'job', 'progress'])) throw invalidResponse();
      {
        const job = normalizeJob(data.job);
        if (!activeJobStates.has(job.state)) throw invalidResponse();
        return Object.freeze({
          event: 'progress',
          job,
          progress: normalizeProgress(data.progress),
        });
      }
    case 'completed': {
      if (!hasSnapshotKeys(data, ['event', 'job', 'media', 'summary', 'subtitle'])) {
        throw invalidResponse();
      }
      const job = normalizeJob(data.job);
      if (job.state !== 'succeeded') throw invalidResponse();
      const summary = normalizeSummary(data.summary);
      return Object.freeze({
        event: 'completed',
        job,
        media: normalizeMedia(data.media, summary),
        summary,
        subtitle: normalizeSubtitle(data.subtitle, summary),
      });
    }
    case 'cancelled': {
      if (!hasSnapshotKeys(data, ['event', 'job'])) throw invalidResponse();
      const job = normalizeJob(data.job);
      if (job.state !== 'cancelled') throw invalidResponse();
      return Object.freeze({ event: 'cancelled', job });
    }
    case 'failed': {
      if (!hasSnapshotKeys(data, ['event', 'job', 'error'])) throw invalidResponse();
      const job = data.job === null ? null : normalizeJob(data.job);
      if (job !== null && job.state !== 'failed') throw invalidResponse();
      return Object.freeze({ event: 'failed', job, error: normalizeError(data.error) });
    }
    default:
      throw invalidResponse();
  }
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  const keys = ['onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed', 'onProtocolError'];
  const data = snapshotDataRecord(handlers, {
    required: [],
    allowed: keys,
    failure: invalidRequest,
  });
  for (const handler of Object.values(data)) {
    if (handler !== undefined && typeof handler !== 'function') throw invalidRequest();
  }
  return data;
};

export const createNativeDownloadService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const invoke = async (command, args, normalize) => {
    if (!isNativeRuntime()) throw runtimeRequired();
    let rawValue;
    try {
      rawValue = await invokeCommand(command, args);
    } catch (error) {
      throw normalizeInvocationFailure(error);
    }
    return normalize(rawValue);
  };

  const getStatus = () => invoke('download_status', {}, normalizeStatus);

  const inspectUrl = (request) => invoke(
    'download_inspect',
    { request: normalizeInspectRequest(request) },
    normalizeInspection
  );

  const cancelNativeJob = (jobId) => invoke('download_cancel', { jobId }, (value) => {
    const snapshot = normalizeJob(value);
    if (snapshot.id !== jobId || !cancellationResponseStates.has(snapshot.state)) {
      throw invalidResponse();
    }
    return snapshot;
  });

  const releaseEntry = (entry) => {
    entry.quarantined = true;
    if (activeChannels.get(entry.id) === entry) activeChannels.delete(entry.id);
    try {
      entry.channel.onmessage = () => undefined;
    } catch {
      // The map is still released even if a custom test channel rejects reassignment.
    }
  };

  const cancelEntry = (entry) => {
    if (entry.cancelPromise !== null) return entry.cancelPromise;
    entry.cancelPromise = cancelNativeJob(entry.id).then((snapshot) => {
      if (snapshot.state !== 'cancelling') entry.consumeCancelSnapshot(snapshot);
      return snapshot;
    });
    return entry.cancelPromise;
  };

  const cancelDownload = (jobId) => {
    if (!isUuidVersion(jobId, 7)) return Promise.reject(invalidRequest());
    if (!isNativeRuntime()) return Promise.reject(runtimeRequired());
    const entry = activeChannels.get(jobId);
    return entry === undefined ? cancelNativeJob(jobId) : cancelEntry(entry);
  };

  const startDownload = async (request, rawHandlers) => {
    if (!isNativeRuntime()) throw runtimeRequired();
    const normalizedRequest = normalizeStartRequest(request);
    const handlers = normalizeHandlers(rawHandlers);
    const pending = [];
    let initial = null;
    let terminal = false;
    let protocolFailed = false;
    let ownedEntry = null;
    let ledger = null;

    const call = (handler, event) => {
      if (typeof handler !== 'function') return;
      try {
        const returned = handler(event);
        Promise.resolve(returned).catch(() => undefined);
      } catch {
        // UI handlers cannot break the native Channel protocol.
      }
    };

    const bindOwned = (identity) => {
      if (identity === null || !activeJobStates.has(identity.state) && identity.state !== 'queued') {
        return ownedEntry;
      }
      if (ownedEntry === null) {
        ownedEntry = {
          id: identity.id,
          channel,
          cancelPromise: null,
          consumeCancelSnapshot,
          quarantined: false,
        };
      }
      return ownedEntry;
    };

    const snapshotJobEnvelope = (value) => {
      try {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return null;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const keys = Reflect.ownKeys(descriptors);
        const id = descriptors.id;
        const kind = descriptors.kind;
        const state = descriptors.state;
        const identity = !id || !kind || !state
            || !Object.hasOwn(id, 'value') || !Object.hasOwn(kind, 'value')
            || !Object.hasOwn(state, 'value')
            || id.enumerable !== true || kind.enumerable !== true || state.enumerable !== true
            || !isUuidVersion(id.value, 7)
            || kind.value !== 'downloadMedia'
            || !jobStates.has(state.value)
          ? null
          : Object.freeze({ id: id.value, state: state.value });
        const expectedKeys = ['id', 'kind', 'state', 'progress', 'sequence'];
        const valid = keys.length === expectedKeys.length
          && keys.every((key) => typeof key === 'string' && expectedKeys.includes(key))
          && expectedKeys.every((key) => {
            const descriptor = descriptors[key];
            return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
          });
        const snapshot = {};
        for (const key of expectedKeys) {
          const descriptor = descriptors[key];
          if (descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true) {
            snapshot[key] = descriptor.value;
          }
        }
        return Object.freeze({ value: Object.freeze(snapshot), identity, valid });
      } catch {
        return null;
      }
    };

    const snapshotEventEnvelope = (value) => {
      try {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return null;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const keys = Reflect.ownKeys(descriptors);
        let valid = keys.every((key) => typeof key === 'string'
          && downloadEventKeys.includes(key));
        const snapshot = {};
        for (const key of downloadEventKeys) {
          const descriptor = descriptors[key];
          if (descriptor === undefined) continue;
          if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
            valid = false;
            continue;
          }
          snapshot[key] = descriptor.value;
        }
        const jobEnvelope = Object.hasOwn(snapshot, 'job') && snapshot.job !== null
          ? snapshotJobEnvelope(snapshot.job)
          : null;
        if (jobEnvelope !== null) snapshot.job = jobEnvelope.value;
        if (Object.hasOwn(snapshot, 'job') && snapshot.job !== null
            && (jobEnvelope === null || !jobEnvelope.valid)) {
          valid = false;
        }
        return Object.freeze({
          value: Object.freeze(snapshot),
          identity: jobEnvelope?.identity ?? null,
          valid,
        });
      } catch {
        return null;
      }
    };

    const requestProtocolCancellation = () => {
      if (ownedEntry === null) return null;
      const cancellation = cancelEntry(ownedEntry);
      cancellation.catch(() => undefined);
      return cancellation;
    };

    const awaitProtocolCancellation = async () => {
      const cancellation = requestProtocolCancellation();
      if (cancellation !== null) await cancellation.catch(() => null);
    };

    const protocolError = () => {
      if (terminal || protocolFailed) return;
      protocolFailed = true;
      pending.length = 0;
      if (ownedEntry !== null) {
        requestProtocolCancellation();
        releaseEntry(ownedEntry);
      }
      call(handlers.onProtocolError, invalidResponse());
    };

    const recordEvent = (event) => {
      if (event.job === null
          || event.job.sequence < ledger.sequence
          || event.job.progress.basisPoints < ledger.basisPoints) {
        throw invalidResponse();
      }
      if (event.job.sequence === ledger.sequence) {
        if (event.job.state !== ledger.state
            || event.job.progress.basisPoints !== ledger.basisPoints) {
          throw invalidResponse();
        }
        return;
      }
      ledger.sequence = event.job.sequence;
      ledger.state = event.job.state;
      ledger.basisPoints = event.job.progress.basisPoints;
    };

    const dispatch = (event) => {
      if (terminal || protocolFailed) return;
      const eventJobId = event.job?.id;
      if (eventJobId === undefined || eventJobId !== initial.id) {
        protocolError();
        return;
      }
      try {
        recordEvent(event);
      } catch {
        protocolError();
        return;
      }
      if (event.event !== 'progress') {
        terminal = true;
        releaseEntry(ownedEntry);
      }
      if (event.event === 'failed' && event.error.code === 'downloaderExecutionFailed') {
        triggerNativeDownloaderRecovery();
      }
      call(handlers.onEvent, event);
      if (event.event === 'progress') call(handlers.onProgress, event);
      if (event.event === 'completed') call(handlers.onCompleted, event);
      if (event.event === 'cancelled') call(handlers.onCancelled, event);
      if (event.event === 'failed') call(handlers.onFailed, event);
    };

    function consumeCancelSnapshot(jobSnapshot) {
      if (terminal || protocolFailed || jobSnapshot.state === 'cancelling') return;
      if (jobSnapshot.state === 'cancelled') {
        const event = Object.freeze({ event: 'cancelled', job: jobSnapshot });
        terminal = true;
        pending.length = 0;
        const onEvent = handlers.onEvent;
        const onCancelled = handlers.onCancelled;
        releaseEntry(ownedEntry);
        call(onEvent, event);
        call(onCancelled, event);
        return;
      }
      protocolFailed = true;
      pending.length = 0;
      const onProtocolError = handlers.onProtocolError;
      releaseEntry(ownedEntry);
      call(onProtocolError, invalidResponse());
    }

    const channel = new ChannelConstructor();
    channel.onmessage = (rawEvent) => {
      if (terminal || protocolFailed) return;
      const envelope = snapshotEventEnvelope(rawEvent);
      const identity = envelope?.identity ?? null;
      if (identity !== null) {
        if (ownedEntry === null) bindOwned(identity);
        else if (ownedEntry.id !== identity.id) {
          protocolError();
          return;
        }
      }
      let event;
      try {
        if (envelope === null || !envelope.valid) throw invalidResponse();
        event = normalizeDownloadEvent(envelope.value);
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

    let rawSnapshot;
    try {
      rawSnapshot = await invokeCommand('download_start', {
        request: normalizedRequest,
        onEvent: channel,
      });
    } catch (error) {
      pending.length = 0;
      terminal = true;
      if (ownedEntry !== null) {
        releaseEntry(ownedEntry);
        await awaitProtocolCancellation();
      }
      throw normalizeInvocationFailure(error);
    }

    const returnedEnvelope = snapshotJobEnvelope(rawSnapshot);
    const returnedIdentity = returnedEnvelope?.identity ?? null;
    if (ownedEntry === null && returnedIdentity !== null) bindOwned(returnedIdentity);

    let snapshot;
    try {
      if (returnedEnvelope === null || !returnedEnvelope.valid) throw invalidResponse();
      snapshot = normalizeJob(returnedEnvelope.value);
    } catch {
      pending.length = 0;
      terminal = true;
      if (ownedEntry !== null) {
        releaseEntry(ownedEntry);
        await awaitProtocolCancellation();
      }
      throw invalidResponse();
    }

    if (ownedEntry !== null && ownedEntry.id !== snapshot.id) {
      pending.length = 0;
      terminal = true;
      releaseEntry(ownedEntry);
      call(handlers.onProtocolError, invalidResponse());
      await awaitProtocolCancellation();
      throw invalidResponse();
    }

    initial = snapshot;
    if (snapshot.state !== 'running') {
      pending.length = 0;
      terminal = true;
      if (ownedEntry !== null) {
        releaseEntry(ownedEntry);
        await awaitProtocolCancellation();
      }
      throw invalidResponse();
    }
    if (protocolFailed) {
      terminal = true;
      releaseEntry(ownedEntry);
      await awaitProtocolCancellation();
      throw invalidResponse();
    }
    if (ownedEntry === null) bindOwned(snapshot);
    ledger = {
      sequence: snapshot.sequence,
      state: snapshot.state,
      basisPoints: snapshot.progress.basisPoints,
    };
    const existingEntry = activeChannels.get(snapshot.id);
    if (existingEntry !== undefined && existingEntry !== ownedEntry) {
      terminal = true;
      releaseEntry(ownedEntry);
      call(handlers.onProtocolError, invalidResponse());
      throw invalidResponse();
    }
    activeChannels.set(snapshot.id, ownedEntry);
    for (const event of pending.splice(0)) {
      dispatch(event);
      if (protocolFailed) break;
    }
    if (protocolFailed) {
      terminal = true;
      releaseEntry(ownedEntry);
      await awaitProtocolCancellation();
      throw invalidResponse();
    }
    return snapshot;
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
      triggerNativeDownloaderRecovery();
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
