import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

export const MEDIA_PIPELINE_OPERATIONS = Object.freeze([
  'preparePlayback',
  'analysisClip',
  'extractAudio',
  'generateWaveform',
]);
export const MEDIA_PIPELINE_PHASES = Object.freeze([
  'probing',
  'processing',
  'publishing',
]);

const operations = new Set(MEDIA_PIPELINE_OPERATIONS);
const phases = new Set(MEDIA_PIPELINE_PHASES);
const phaseRanks = Object.freeze({ probing: 0, processing: 1, publishing: 2 });
const mediaKinds = new Set(['audio', 'video']);
const jobStates = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const activeJobStates = new Set(['running', 'cancelling']);
const cancellationResponseStates = new Set([
  'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const jobKinds = new Set(['processMedia', 'generateWaveform']);
const mediaPipelineCommandCodes = new Set([
  'internal',
  'invalidInput',
  'invalidPath',
  'mediaUnavailable',
  'mediaToolsUnavailable',
  'invalidMediaLocation',
  'mediaIdentityConflict',
  'invalidMediaOperation',
  'mediaTimeout',
  'mediaCancelled',
  'mediaOutputExists',
  'mediaArtifactMissing',
  'invalidMediaMetadata',
  'mediaToolFailure',
  'mediaMissingAudio',
  'mediaNotPlayable',
  'invalidMediaRange',
  'mediaStagingUnavailable',
  'mediaRegistryFull',
  'mediaServer',
  'jobAlreadyExists',
  'jobNotFound',
  'jobConflict',
  'invalidJobState',
  'jobRegistry',
  'database',
  'artifactStorage',
  'artifactDataCorrupt',
  'invalidArtifactRequest',
  'artifactMetadataTooLarge',
  'artifactLimit',
  'artifactNotFound',
  'artifactContentMismatch',
  'artifactConflict',
  'artifactStateConflict',
  'artifactNotReady',
]);
const compatibilityActions = new Set([
  'direct', 'remux', 'transcodeAudio', 'transcodeVideo', 'transcodeAll', 'reject',
]);
const compatibilityIssues = new Set([
  'noPlayableStream',
  'unsupportedContainer',
  'unsupportedVideoCodec',
  'unsupportedAudioCodec',
  'problematicAudioProfile',
  'unsupportedPixelFormat',
  'audioPrecedesVideo',
  'missingDuration',
  'legacyHevcAssumption',
]);
const audioFormats = new Set(['wav', 'mp3', 'flac']);
const MAX_DURATION_US = 7 * 24 * 60 * 60 * 1_000_000;
const MAX_WAVEFORM_POINTS = 1_000_000;
const MAX_WAVEFORM_PYRAMID_POINTS = 1_400_000;
const MAX_PENDING_EVENTS = 4_096;
const PLAYBACK_PATTERN = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/asset\/([0-9a-f-]{36})\?token=([0-9a-f]{64})$/i;
const MEDIA_MIME_PATTERN = /^(audio|video)\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

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
    if (Reflect.ownKeys(descriptors).length !== length + 1) throw failure();
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

const hasSnapshotKeys = (value, expected) => {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

const isUuidVersion = (value, expected) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expected;
  } catch {
    return false;
  }
};

const isUuidV7 = (value) => isUuidVersion(value, 7);
const isUuidV4 = (value) => isUuidVersion(value, 4);
const isSafeInteger = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => (
  Number.isSafeInteger(value) && value >= minimum && value <= maximum
);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const hasControlCharacter = (value) => [...value].some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
});

export class MediaPipelineServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaPipelineServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new MediaPipelineServiceError(
  'invalidMediaPipelineRequest',
  'The native media operation request is invalid'
);

const invalidResponse = () => new MediaPipelineServiceError(
  'invalidMediaPipelineResponse',
  'The desktop host returned invalid media operation data'
);

const runtimeRequired = () => new MediaPipelineServiceError(
  'desktopRuntimeUnavailable',
  'Native media processing requires the desktop runtime'
);

const cancelledOperation = () => {
  const error = new Error('The native media operation was cancelled');
  error.name = 'AbortError';
  return error;
};

const normalizeFailure = (error) => {
  let code = 'mediaPipelineFailed';
  try {
    const candidate = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? error.code
      : null;
    if (mediaPipelineCommandCodes.has(candidate)) code = candidate;
  } catch {
    // A hostile transport accessor is not authoritative error metadata.
  }
  return new MediaPipelineServiceError(code, 'The native media operation could not be completed');
};

const requireAssetId = (value) => {
  if (!isUuidV7(value)) throw invalidRequest();
  return value;
};

const secondsToMicroseconds = (value) => {
  if (!isFiniteNumber(value) || value < 0 || value > MAX_DURATION_US / 1_000_000) {
    throw invalidRequest();
  }
  const microseconds = Math.round(value * 1_000_000);
  if (!isSafeInteger(microseconds, 0, MAX_DURATION_US)) throw invalidRequest();
  return microseconds;
};

const normalizeRange = (value, { optional = false } = {}) => {
  if (optional && (value === null || value === undefined)) return null;
  const data = exactRecord(value, ['start', 'end'], invalidRequest);
  const startUs = secondsToMicroseconds(data.start);
  const endUs = secondsToMicroseconds(data.end);
  if (endUs <= startUs) throw invalidRequest();
  return Object.freeze({ startUs, endUs });
};

export const normalizeMediaPipelineRequest = (request) => {
  const data = snapshotDataRecord(request, {
    required: ['operation', 'assetId'],
    allowed: ['operation', 'assetId', 'range', 'format', 'pointsPerSecond', 'maxPoints'],
    failure: invalidRequest,
  });
  if (!operations.has(data.operation)) throw invalidRequest();
  switch (data.operation) {
    case 'preparePlayback':
      if (!hasSnapshotKeys(data, ['operation', 'assetId'])) throw invalidRequest();
      return Object.freeze({ operation: data.operation, assetId: requireAssetId(data.assetId) });
    case 'analysisClip': {
      if (!hasSnapshotKeys(data, ['operation', 'assetId', 'range'])) throw invalidRequest();
      const range = normalizeRange(data.range);
      return Object.freeze({
        operation: data.operation,
        assetId: requireAssetId(data.assetId),
        startUs: range.startUs,
        endUs: range.endUs,
      });
    }
    case 'extractAudio': {
      if (!hasSnapshotKeys(data, ['operation', 'assetId', 'format', 'range'])
          || !audioFormats.has(data.format)) {
        throw invalidRequest();
      }
      const range = normalizeRange(data.range, { optional: true });
      return Object.freeze({
        operation: data.operation,
        assetId: requireAssetId(data.assetId),
        format: data.format,
        startUs: range === null ? 0 : range.startUs,
        endUs: range === null ? null : range.endUs,
      });
    }
    case 'generateWaveform': {
      if (!hasSnapshotKeys(data, [
        'operation', 'assetId', 'range', 'pointsPerSecond', 'maxPoints',
      ])
          || !isSafeInteger(data.pointsPerSecond, 1, 400)
          || !isSafeInteger(data.maxPoints, 1_000, MAX_WAVEFORM_POINTS)) {
        throw invalidRequest();
      }
      const range = normalizeRange(data.range, { optional: true });
      return Object.freeze({
        operation: data.operation,
        assetId: requireAssetId(data.assetId),
        pointsPerSecond: data.pointsPerSecond,
        maxPoints: data.maxPoints,
        startUs: range === null ? 0 : range.startUs,
        endUs: range === null ? null : range.endUs,
      });
    }
    default:
      throw invalidRequest();
  }
};

const normalizeJob = (value, expectedKind = null) => {
  const data = exactRecord(value, ['id', 'kind', 'state', 'progress', 'sequence'], invalidResponse);
  const progress = exactRecord(data.progress, ['basisPoints'], invalidResponse);
  if (!isUuidV7(data.id)
      || !jobKinds.has(data.kind)
      || (expectedKind !== null && data.kind !== expectedKind)
      || !jobStates.has(data.state)
      || !isSafeInteger(progress.basisPoints, 0, 10_000)
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

const normalizeAsset = (value) => {
  const data = exactRecord(
    value,
    ['id', 'displayName', 'extension', 'sizeBytes', 'kind'],
    invalidResponse
  );
  if (!isUuidV7(data.id)
      || typeof data.displayName !== 'string'
      || data.displayName.trim() !== data.displayName
      || data.displayName.length === 0
      || data.displayName.length > 512
      || data.displayName.includes('/')
      || data.displayName.includes('\\')
      || hasControlCharacter(data.displayName)
      || typeof data.extension !== 'string'
      || !/^[a-z0-9]{1,16}$/.test(data.extension)
      || !data.displayName.toLowerCase().endsWith(`.${data.extension}`)
      || !isSafeInteger(data.sizeBytes, 1)
      || !mediaKinds.has(data.kind)) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: data.id,
    displayName: data.displayName,
    extension: data.extension,
    sizeBytes: data.sizeBytes,
    kind: data.kind,
  });
};

const normalizePlayback = (value, asset) => {
  const data = exactRecord(value, ['id', 'playbackUrl', 'mimeType', 'byteLength'], invalidResponse);
  const match = typeof data.playbackUrl === 'string'
    ? PLAYBACK_PATTERN.exec(data.playbackUrl)
    : null;
  const port = match === null ? 0 : Number(match[1]);
  if (!isUuidV4(data.id)
      || match === null
      || !isSafeInteger(port, 1, 65_535)
      || match[2].toLowerCase() !== data.id.toLowerCase()
      || typeof data.mimeType !== 'string'
      || !MEDIA_MIME_PATTERN.test(data.mimeType)
      || !data.mimeType.startsWith(`${asset.kind}/`)
      || data.byteLength !== asset.sizeBytes) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: data.id,
    playbackUrl: data.playbackUrl,
    mimeType: data.mimeType,
    byteLength: data.byteLength,
  });
};

const normalizeInspection = (value, expectedAssetId = null) => {
  const data = exactRecord(value, [
    'assetId',
    'durationUs',
    'hasVideo',
    'hasAudio',
    'videoCodec',
    'audioCodec',
    'width',
    'height',
    'frameRate',
    'compatibilityAction',
    'issues',
  ], invalidResponse);
  const issues = snapshotDataArray(data.issues, 32, invalidResponse);
  if (!isUuidV7(data.assetId)
      || (expectedAssetId !== null && data.assetId !== expectedAssetId)
      || (data.durationUs !== null && !isSafeInteger(data.durationUs, 1, MAX_DURATION_US))
      || typeof data.hasVideo !== 'boolean'
      || typeof data.hasAudio !== 'boolean'
      || (!data.hasVideo && !data.hasAudio)
      || (data.videoCodec !== null
        && (typeof data.videoCodec !== 'string'
          || !/^[a-z0-9._+-]{1,32}$/.test(data.videoCodec)))
      || (data.audioCodec !== null
        && (typeof data.audioCodec !== 'string'
          || !/^[a-z0-9._+-]{1,32}$/.test(data.audioCodec)))
      || (data.width !== null && !isSafeInteger(data.width, 1, 65_535))
      || (data.height !== null && !isSafeInteger(data.height, 1, 65_535))
      || (data.frameRate !== null
        && (!isFiniteNumber(data.frameRate) || data.frameRate <= 0 || data.frameRate > 1_000))
      || !compatibilityActions.has(data.compatibilityAction)
      || issues.some((issue) => !compatibilityIssues.has(issue))) {
    throw invalidResponse();
  }
  return Object.freeze({
    assetId: data.assetId,
    durationUs: data.durationUs,
    hasVideo: data.hasVideo,
    hasAudio: data.hasAudio,
    videoCodec: data.videoCodec,
    audioCodec: data.audioCodec,
    width: data.width,
    height: data.height,
    frameRate: data.frameRate,
    compatibilityAction: data.compatibilityAction,
    issues,
  });
};

const normalizeMediaResult = (value, operation, sourceAssetId) => {
  const data = exactRecord(value, ['kind', 'media', 'inspection'], invalidResponse);
  const media = exactRecord(data.media, ['asset', 'playback'], invalidResponse);
  if (data.kind !== 'media') throw invalidResponse();
  const asset = normalizeAsset(media.asset);
  if ((operation === 'analysisClip' || operation === 'extractAudio')
      && asset.id === sourceAssetId) {
    throw invalidResponse();
  }
  if ((operation === 'preparePlayback' && asset.kind !== 'video')
      || (operation === 'extractAudio' && asset.kind !== 'audio')) {
    throw invalidResponse();
  }
  return Object.freeze({
    kind: 'media',
    media: Object.freeze({
      asset,
      playback: normalizePlayback(media.playback, asset),
    }),
    inspection: normalizeInspection(data.inspection, asset.id),
  });
};

const normalizeWaveform = (value) => {
  const data = exactRecord(value, ['durationUs', 'sourceSampleRateHz', 'levels'], invalidResponse);
  const rawLevels = snapshotDataArray(data.levels, 16, invalidResponse);
  if (!isSafeInteger(data.durationUs, 0, MAX_DURATION_US)
      || !isSafeInteger(data.sourceSampleRateHz, 1, 192_000)
      || rawLevels.length === 0) {
    throw invalidResponse();
  }
  let totalPoints = 0;
  const levels = rawLevels.map((level) => {
    const levelData = exactRecord(level, ['pointsPerSecond', 'points'], invalidResponse);
    if (!isFiniteNumber(levelData.pointsPerSecond)
        || levelData.pointsPerSecond <= 0
        || levelData.pointsPerSecond > 4_000) {
      throw invalidResponse();
    }
    const rawPoints = snapshotDataArray(
      levelData.points,
      MAX_WAVEFORM_PYRAMID_POINTS - totalPoints,
      invalidResponse
    );
    totalPoints += rawPoints.length;
    if (totalPoints > MAX_WAVEFORM_PYRAMID_POINTS) throw invalidResponse();
    const points = rawPoints.map((point) => {
      const pointData = exactRecord(
        point,
        ['minimum', 'maximum', 'rootMeanSquare'],
        invalidResponse
      );
      if (!isFiniteNumber(pointData.minimum)
          || !isFiniteNumber(pointData.maximum)
          || !isFiniteNumber(pointData.rootMeanSquare)
          || pointData.minimum < -1
          || pointData.maximum > 1
          || pointData.minimum > pointData.maximum
          || pointData.rootMeanSquare < 0
          || pointData.rootMeanSquare > 1) {
        throw invalidResponse();
      }
      return Object.freeze({
        minimum: pointData.minimum,
        maximum: pointData.maximum,
        rootMeanSquare: pointData.rootMeanSquare,
      });
    });
    return Object.freeze({ pointsPerSecond: levelData.pointsPerSecond, points: Object.freeze(points) });
  });
  return Object.freeze({
    durationUs: data.durationUs,
    sourceSampleRateHz: data.sourceSampleRateHz,
    levels: Object.freeze(levels),
  });
};

const normalizeResult = (value, operation, sourceAssetId) => {
  const data = snapshotDataRecord(value, {
    required: ['kind'],
    allowed: ['kind', 'media', 'inspection', 'assetId', 'waveform'],
    failure: invalidResponse,
  });
  if (data.kind === 'media') return normalizeMediaResult(data, operation, sourceAssetId);
  if (data.kind === 'waveform') {
    if (operation !== 'generateWaveform'
        || !hasSnapshotKeys(data, ['kind', 'assetId', 'waveform'])
        || data.assetId !== sourceAssetId) {
      throw invalidResponse();
    }
    return Object.freeze({
      kind: 'waveform',
      assetId: data.assetId,
      waveform: normalizeWaveform(data.waveform),
    });
  }
  throw invalidResponse();
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
    code: mediaPipelineCommandCodes.has(code) ? code : 'mediaPipelineFailed',
    message: 'The native media operation could not be completed',
  });
};

const expectedJobKind = (operation) => (
  operation === 'generateWaveform' ? 'generateWaveform' : 'processMedia'
);

const mediaPipelineEventKeys = Object.freeze([
  'event', 'job', 'operation', 'phase', 'fraction', 'result', 'error',
]);

export const normalizeMediaPipelineEvent = (value, expected = {}) => {
  const expectedData = snapshotDataRecord(expected, {
    required: [],
    allowed: ['operation', 'assetId'],
    failure: invalidResponse,
  });
  const data = snapshotDataRecord(value, {
    required: ['event', 'job', 'operation'],
    allowed: mediaPipelineEventKeys,
    failure: invalidResponse,
  });
  if (typeof data.event !== 'string') throw invalidResponse();
  const operation = data.operation;
  if (!operations.has(operation)
      || (expectedData.operation !== undefined && operation !== expectedData.operation)) {
    throw invalidResponse();
  }
  const jobKind = expectedJobKind(operation);
  switch (data.event) {
    case 'progress': {
      if (!hasSnapshotKeys(data, ['event', 'job', 'operation', 'phase', 'fraction'])
          || !phases.has(data.phase)
          || (data.fraction !== null
            && (!isFiniteNumber(data.fraction) || data.fraction < 0 || data.fraction > 1))) {
        throw invalidResponse();
      }
      const job = normalizeJob(data.job, jobKind);
      if (!activeJobStates.has(job.state)) throw invalidResponse();
      return Object.freeze({
        event: 'progress',
        job,
        operation,
        phase: data.phase,
        fraction: data.fraction,
      });
    }
    case 'completed': {
      if (!hasSnapshotKeys(data, ['event', 'job', 'operation', 'result'])
          || !isUuidV7(expectedData.assetId)) {
        throw invalidResponse();
      }
      const job = normalizeJob(data.job, jobKind);
      if (job.state !== 'succeeded') throw invalidResponse();
      return Object.freeze({
        event: 'completed',
        job,
        operation,
        result: normalizeResult(data.result, operation, expectedData.assetId),
      });
    }
    case 'cancelled': {
      if (!hasSnapshotKeys(data, ['event', 'job', 'operation'])) throw invalidResponse();
      const job = normalizeJob(data.job, jobKind);
      if (job.state !== 'cancelled') throw invalidResponse();
      return Object.freeze({ event: 'cancelled', job, operation });
    }
    case 'failed': {
      if (!hasSnapshotKeys(data, ['event', 'job', 'operation', 'error'])) throw invalidResponse();
      const job = data.job === null ? null : normalizeJob(data.job, jobKind);
      if (job !== null && job.state !== 'failed') throw invalidResponse();
      return Object.freeze({
        event: 'failed', job, operation, error: normalizeError(data.error),
      });
    }
    default:
      throw invalidResponse();
  }
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  const allowed = [
    'onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed', 'onProtocolError',
  ];
  const data = snapshotDataRecord(handlers, {
    required: [],
    allowed,
    failure: invalidRequest,
  });
  for (const handler of Object.values(data)) {
    if (handler !== undefined && typeof handler !== 'function') throw invalidRequest();
  }
  return data;
};

const normalizeRunOptions = (options) => {
  if (options === undefined) return Object.freeze({});
  const data = snapshotDataRecord(options, {
    required: [],
    allowed: ['signal', 'onProgress'],
    failure: invalidRequest,
  });
  if (data.onProgress !== undefined && typeof data.onProgress !== 'function') {
    throw invalidRequest();
  }
  let signal;
  if (data.signal !== undefined) {
    try {
      const rawSignal = data.signal;
      const addEventListener = rawSignal.addEventListener;
      const removeEventListener = rawSignal.removeEventListener;
      if (typeof addEventListener !== 'function' || typeof removeEventListener !== 'function') {
        throw invalidRequest();
      }
      signal = Object.freeze({
        readAborted: () => {
          try {
            const aborted = rawSignal.aborted;
            if (typeof aborted !== 'boolean') throw invalidRequest();
            return aborted;
          } catch {
            throw invalidRequest();
          }
        },
        addEventListener: (...args) => Reflect.apply(addEventListener, rawSignal, args),
        removeEventListener: (...args) => Reflect.apply(removeEventListener, rawSignal, args),
      });
    } catch {
      throw invalidRequest();
    }
  }
  return Object.freeze({ signal, onProgress: data.onProgress });
};

export const createNativeMediaPipelineService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const requireRuntime = () => {
    if (!isNativeRuntime()) throw runtimeRequired();
  };

  const inspect = async (assetId) => {
    requireRuntime();
    const normalizedAssetId = requireAssetId(assetId);
    let rawValue;
    try {
      rawValue = await invokeCommand('media_pipeline_inspect', { assetId: normalizedAssetId });
    } catch (error) {
      throw normalizeFailure(error);
    }
    return normalizeInspection(rawValue, normalizedAssetId);
  };

  const releaseEntry = (entry) => {
    entry.quarantined = true;
    if (activeChannels.get(entry.id) === entry) activeChannels.delete(entry.id);
    try {
      entry.channel.onmessage = () => undefined;
    } catch {
      // The active entry is still released for custom channels that reject reassignment.
    }
  };

  const cancelNativeJob = async (jobId, jobKind = null) => {
    let rawValue;
    try {
      rawValue = await invokeCommand('media_pipeline_cancel', { jobId });
    } catch (error) {
      throw normalizeFailure(error);
    }
    const job = normalizeJob(rawValue, jobKind);
    if (job.id !== jobId || !cancellationResponseStates.has(job.state)) {
      throw invalidResponse();
    }
    return job;
  };

  const cancelEntry = (entry) => {
    if (entry.cancelPromise !== null) return entry.cancelPromise;
    entry.cancelPromise = cancelNativeJob(entry.id, entry.jobKind).then((job) => {
      if (job.state !== 'cancelling') entry.consumeCancelSnapshot(job);
      return job;
    });
    return entry.cancelPromise;
  };

  const cancel = async (jobId) => {
    requireRuntime();
    if (!isUuidV7(jobId)) throw invalidRequest();
    const entry = activeChannels.get(jobId);
    return entry === undefined ? cancelNativeJob(jobId) : cancelEntry(entry);
  };

  const start = async (rawRequest, rawHandlers) => {
    requireRuntime();
    const request = normalizeMediaPipelineRequest(rawRequest);
    const handlers = normalizeHandlers(rawHandlers);
    const pending = [];
    let initial = null;
    let terminal = false;
    let protocolFailed = false;
    let ownedEntry = null;
    let ledger = null;
    const jobKind = expectedJobKind(request.operation);
    const eventExpectation = Object.freeze({
      operation: request.operation,
      assetId: request.assetId,
    });

    const call = (handler, value) => {
      if (typeof handler !== 'function') return;
      try {
        const returned = handler(value);
        Promise.resolve(returned).catch(() => undefined);
      } catch {
        // UI handlers cannot corrupt the native channel lifecycle.
      }
    };
    const bindOwned = (identity) => {
      if (identity === null || !activeJobStates.has(identity.state) && identity.state !== 'queued') {
        return ownedEntry;
      }
      if (ownedEntry === null) {
        ownedEntry = {
          id: identity.id,
          jobKind,
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
            || !isUuidV7(id.value)
            || kind.value !== jobKind
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
          && mediaPipelineEventKeys.includes(key));
        const snapshot = {};
        for (const key of mediaPipelineEventKeys) {
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
      if (event.job.sequence === ledger.sequence
          && (event.job.state !== ledger.state
            || event.job.progress.basisPoints !== ledger.basisPoints)) {
        throw invalidResponse();
      }
      if (event.event === 'progress') {
        const rank = phaseRanks[event.phase];
        if (rank < ledger.phaseRank
            || (rank === ledger.phaseRank
              && event.fraction !== null
              && ledger.fraction !== null
              && event.fraction < ledger.fraction)) {
          throw invalidResponse();
        }
        ledger.phaseRank = rank;
        ledger.fraction = event.fraction;
      }
      if (event.job.sequence > ledger.sequence) {
        ledger.sequence = event.job.sequence;
        ledger.state = event.job.state;
        ledger.basisPoints = event.job.progress.basisPoints;
      }
    };

    const dispatch = (event) => {
      if (terminal || protocolFailed) return;
      if (event.job === null || event.job.id !== initial.id) {
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
      call(handlers.onEvent, event);
      if (event.event === 'progress') call(handlers.onProgress, event);
      if (event.event === 'completed') call(handlers.onCompleted, event);
      if (event.event === 'cancelled') call(handlers.onCancelled, event);
      if (event.event === 'failed') call(handlers.onFailed, event);
    };

    function consumeCancelSnapshot(jobSnapshot) {
      if (terminal || protocolFailed || jobSnapshot.state === 'cancelling') return;
      if (jobSnapshot.state === 'cancelled') {
        const event = Object.freeze({
          event: 'cancelled',
          job: jobSnapshot,
          operation: request.operation,
        });
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
        event = normalizeMediaPipelineEvent(envelope.value, eventExpectation);
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

    let rawInitial;
    try {
      rawInitial = await invokeCommand('media_pipeline_start', {
        request,
        onEvent: channel,
      });
    } catch (error) {
      pending.length = 0;
      terminal = true;
      if (ownedEntry !== null) {
        releaseEntry(ownedEntry);
        await awaitProtocolCancellation();
      }
      throw normalizeFailure(error);
    }

    const returnedEnvelope = snapshotJobEnvelope(rawInitial);
    const returnedIdentity = returnedEnvelope?.identity ?? null;
    if (ownedEntry === null && returnedIdentity !== null) bindOwned(returnedIdentity);

    try {
      if (returnedEnvelope === null || !returnedEnvelope.valid) throw invalidResponse();
      initial = normalizeJob(returnedEnvelope.value, jobKind);
    } catch {
      pending.length = 0;
      terminal = true;
      if (ownedEntry !== null) {
        releaseEntry(ownedEntry);
        await awaitProtocolCancellation();
      }
      throw invalidResponse();
    }

    if (ownedEntry !== null && ownedEntry.id !== initial.id) {
      pending.length = 0;
      terminal = true;
      releaseEntry(ownedEntry);
      call(handlers.onProtocolError, invalidResponse());
      await awaitProtocolCancellation();
      throw invalidResponse();
    }

    if (initial.state !== 'running') {
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
    if (ownedEntry === null) bindOwned(initial);
    ledger = {
      sequence: initial.sequence,
      state: initial.state,
      basisPoints: initial.progress.basisPoints,
      phaseRank: -1,
      fraction: null,
    };
    const existingEntry = activeChannels.get(initial.id);
    if (existingEntry !== undefined && existingEntry !== ownedEntry) {
      terminal = true;
      releaseEntry(ownedEntry);
      call(handlers.onProtocolError, invalidResponse());
      throw invalidResponse();
    }
    activeChannels.set(initial.id, ownedEntry);
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
    return initial;
  };

  const run = async (rawRequest, rawOptions) => {
    const options = normalizeRunOptions(rawOptions);
    const { signal, onProgress } = options;

    let initial = null;
    let settled = false;
    let cancelRequested = false;
    let cancelPromise = null;
    let resolveTerminal;
    const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolveTerminal(outcome);
    };
    const cancelStartedJob = () => {
      cancelRequested = true;
      if (initial === null || cancelPromise !== null) return cancelPromise;
      cancelPromise = cancel(initial.id).then((job) => {
        if (job.state === 'cancelled') settle({ error: cancelledOperation() });
        else if (job.state !== 'cancelling') settle({ error: invalidResponse() });
        return job;
      }).catch((error) => {
        settle({ error });
        return null;
      });
      return cancelPromise;
    };
    const handleAbort = () => {
      if (settled) return;
      cancelRequested = true;
      settle({ error: cancelledOperation() });
      cancelStartedJob();
    };

    let listenerRegistrationAttempted = false;
    try {
      if (signal !== undefined) {
        listenerRegistrationAttempted = true;
        try {
          signal.addEventListener('abort', handleAbort, { once: true });
        } catch {
          throw invalidRequest();
        }
      }
      if (signal?.readAborted()) throw cancelledOperation();
      try {
        initial = await start(rawRequest, {
          onProgress,
          onCompleted: (event) => settle({ result: event.result }),
          onCancelled: () => settle({ error: cancelledOperation() }),
          onFailed: (event) => settle({
            error: new MediaPipelineServiceError(event.error.code, event.error.message),
          }),
          onProtocolError: (error) => settle({ error }),
        });
      } catch (error) {
        settle({ error });
      }
      if (initial !== null && cancelRequested) cancelStartedJob();
      if (cancelRequested && cancelPromise !== null) await cancelPromise;
      const outcome = await terminal;
      if (outcome.error) throw outcome.error;
      return outcome.result;
    } finally {
      if (listenerRegistrationAttempted) {
        try {
          signal.removeEventListener('abort', handleAbort);
        } catch {
          // A hostile signal cannot replace or leak the native operation outcome.
        }
      }
    }
  };

  return Object.freeze({ inspect, start, cancel, run });
};

const mediaPipelineService = createNativeMediaPipelineService();

export const inspectMediaPipelineAsset = mediaPipelineService.inspect;
export const startMediaPipeline = mediaPipelineService.start;
export const cancelMediaPipeline = mediaPipelineService.cancel;
export const runMediaPipeline = mediaPipelineService.run;
