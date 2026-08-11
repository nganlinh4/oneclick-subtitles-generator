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
const mediaKinds = new Set(['audio', 'video']);
const jobStates = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const jobKinds = new Set(['processMedia', 'generateWaveform']);
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

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isPlainRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value, expected) => {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
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
  if (error instanceof MediaPipelineServiceError) return error;
  const code = typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(error.code)
    ? error.code
    : 'mediaPipelineFailed';
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
  if (!hasExactKeys(value, ['start', 'end'])) throw invalidRequest();
  const startUs = secondsToMicroseconds(value.start);
  const endUs = secondsToMicroseconds(value.end);
  if (endUs <= startUs) throw invalidRequest();
  return Object.freeze({ startUs, endUs });
};

export const normalizeMediaPipelineRequest = (request) => {
  if (!isPlainRecord(request) || !operations.has(request.operation)) throw invalidRequest();
  switch (request.operation) {
    case 'preparePlayback':
      if (!hasExactKeys(request, ['operation', 'assetId'])) throw invalidRequest();
      return Object.freeze({ operation: request.operation, assetId: requireAssetId(request.assetId) });
    case 'analysisClip': {
      if (!hasExactKeys(request, ['operation', 'assetId', 'range'])) throw invalidRequest();
      const range = normalizeRange(request.range);
      return Object.freeze({ operation: request.operation, assetId: requireAssetId(request.assetId), ...range });
    }
    case 'extractAudio': {
      if (!hasExactKeys(request, ['operation', 'assetId', 'format', 'range'])
          || !audioFormats.has(request.format)) {
        throw invalidRequest();
      }
      const range = normalizeRange(request.range, { optional: true });
      return Object.freeze({
        operation: request.operation,
        assetId: requireAssetId(request.assetId),
        format: request.format,
        ...(range === null ? { startUs: 0, endUs: null } : range),
      });
    }
    case 'generateWaveform': {
      if (!hasExactKeys(request, [
        'operation', 'assetId', 'range', 'pointsPerSecond', 'maxPoints',
      ])
          || !isSafeInteger(request.pointsPerSecond, 1, 400)
          || !isSafeInteger(request.maxPoints, 1_000, MAX_WAVEFORM_POINTS)) {
        throw invalidRequest();
      }
      const range = normalizeRange(request.range, { optional: true });
      return Object.freeze({
        operation: request.operation,
        assetId: requireAssetId(request.assetId),
        pointsPerSecond: request.pointsPerSecond,
        maxPoints: request.maxPoints,
        ...(range === null ? { startUs: 0, endUs: null } : range),
      });
    }
    default:
      throw invalidRequest();
  }
};

const normalizeJob = (value) => {
  if (!hasExactKeys(value, ['id', 'kind', 'state', 'progress', 'sequence'])
      || !isUuidV7(value.id)
      || !jobKinds.has(value.kind)
      || !jobStates.has(value.state)
      || !hasExactKeys(value.progress, ['basisPoints'])
      || !isSafeInteger(value.progress.basisPoints, 0, 10_000)
      || !isSafeInteger(value.sequence)) {
    throw invalidResponse();
  }
  return Object.freeze({
    ...value,
    progress: Object.freeze({ ...value.progress }),
  });
};

const normalizeAsset = (value) => {
  if (!hasExactKeys(value, ['id', 'displayName', 'extension', 'sizeBytes', 'kind'])
      || !isUuidV7(value.id)
      || typeof value.displayName !== 'string'
      || value.displayName.trim() !== value.displayName
      || value.displayName.length === 0
      || value.displayName.length > 512
      || value.displayName.includes('/')
      || value.displayName.includes('\\')
      || hasControlCharacter(value.displayName)
      || typeof value.extension !== 'string'
      || !/^[a-z0-9]{1,16}$/.test(value.extension)
      || !value.displayName.toLowerCase().endsWith(`.${value.extension}`)
      || !isSafeInteger(value.sizeBytes, 1)
      || !mediaKinds.has(value.kind)) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value });
};

const normalizePlayback = (value, asset) => {
  const match = typeof value?.playbackUrl === 'string'
    ? PLAYBACK_PATTERN.exec(value.playbackUrl)
    : null;
  const port = match === null ? 0 : Number(match[1]);
  if (!hasExactKeys(value, ['id', 'playbackUrl', 'mimeType', 'byteLength'])
      || !isUuidV4(value.id)
      || match === null
      || !isSafeInteger(port, 1, 65_535)
      || match[2].toLowerCase() !== value.id.toLowerCase()
      || typeof value.mimeType !== 'string'
      || !MEDIA_MIME_PATTERN.test(value.mimeType)
      || !value.mimeType.startsWith(`${asset.kind}/`)
      || value.byteLength !== asset.sizeBytes) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value });
};

const normalizeInspection = (value, expectedAssetId = null) => {
  if (!hasExactKeys(value, [
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
  ])
      || !isUuidV7(value.assetId)
      || (expectedAssetId !== null && value.assetId !== expectedAssetId)
      || (value.durationUs !== null && !isSafeInteger(value.durationUs, 1, MAX_DURATION_US))
      || typeof value.hasVideo !== 'boolean'
      || typeof value.hasAudio !== 'boolean'
      || (!value.hasVideo && !value.hasAudio)
      || (value.videoCodec !== null
        && (typeof value.videoCodec !== 'string'
          || !/^[a-z0-9._+-]{1,32}$/.test(value.videoCodec)))
      || (value.audioCodec !== null
        && (typeof value.audioCodec !== 'string'
          || !/^[a-z0-9._+-]{1,32}$/.test(value.audioCodec)))
      || (value.width !== null && !isSafeInteger(value.width, 1, 65_535))
      || (value.height !== null && !isSafeInteger(value.height, 1, 65_535))
      || (value.frameRate !== null && (!isFiniteNumber(value.frameRate) || value.frameRate <= 0 || value.frameRate > 1_000))
      || !compatibilityActions.has(value.compatibilityAction)
      || !Array.isArray(value.issues)
      || value.issues.length > 32
      || value.issues.some((issue) => !compatibilityIssues.has(issue))) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value, issues: Object.freeze([...value.issues]) });
};

const normalizeMediaResult = (value, operation, sourceAssetId) => {
  if (!hasExactKeys(value, ['kind', 'media', 'inspection'])
      || value.kind !== 'media'
      || !hasExactKeys(value.media, ['asset', 'playback'])) {
    throw invalidResponse();
  }
  const asset = normalizeAsset(value.media.asset);
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
      playback: normalizePlayback(value.media.playback, asset),
    }),
    inspection: normalizeInspection(value.inspection, asset.id),
  });
};

const normalizeWaveform = (value) => {
  if (!hasExactKeys(value, ['durationUs', 'sourceSampleRateHz', 'levels'])
      || !isSafeInteger(value.durationUs, 0, MAX_DURATION_US)
      || !isSafeInteger(value.sourceSampleRateHz, 1, 192_000)
      || !Array.isArray(value.levels)
      || value.levels.length === 0
      || value.levels.length > 16) {
    throw invalidResponse();
  }
  let totalPoints = 0;
  const levels = value.levels.map((level) => {
    if (!hasExactKeys(level, ['pointsPerSecond', 'points'])
        || !isFiniteNumber(level.pointsPerSecond)
        || level.pointsPerSecond <= 0
        || level.pointsPerSecond > 4_000
        || !Array.isArray(level.points)) {
      throw invalidResponse();
    }
    totalPoints += level.points.length;
    if (totalPoints > MAX_WAVEFORM_PYRAMID_POINTS) throw invalidResponse();
    const points = level.points.map((point) => {
      if (!hasExactKeys(point, ['minimum', 'maximum', 'rootMeanSquare'])
          || !isFiniteNumber(point.minimum)
          || !isFiniteNumber(point.maximum)
          || !isFiniteNumber(point.rootMeanSquare)
          || point.minimum < -1
          || point.maximum > 1
          || point.minimum > point.maximum
          || point.rootMeanSquare < 0
          || point.rootMeanSquare > 1) {
        throw invalidResponse();
      }
      return Object.freeze({ ...point });
    });
    return Object.freeze({ pointsPerSecond: level.pointsPerSecond, points: Object.freeze(points) });
  });
  return Object.freeze({ ...value, levels: Object.freeze(levels) });
};

const normalizeResult = (value, operation, sourceAssetId) => {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') throw invalidResponse();
  if (value.kind === 'media') return normalizeMediaResult(value, operation, sourceAssetId);
  if (value.kind === 'waveform') {
    if (operation !== 'generateWaveform'
        || !hasExactKeys(value, ['kind', 'assetId', 'waveform'])
        || value.assetId !== sourceAssetId) {
      throw invalidResponse();
    }
    return Object.freeze({
      kind: 'waveform',
      assetId: value.assetId,
      waveform: normalizeWaveform(value.waveform),
    });
  }
  throw invalidResponse();
};

const normalizeError = (value) => {
  if (!hasExactKeys(value, ['code', 'message'])
      || typeof value.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(value.code)
      || typeof value.message !== 'string'
      || value.message.length > 2_048) {
    throw invalidResponse();
  }
  return Object.freeze({
    code: value.code,
    message: 'The native media operation could not be completed',
  });
};

export const normalizeMediaPipelineEvent = (value, expected = {}) => {
  if (!isPlainRecord(value) || typeof value.event !== 'string') throw invalidResponse();
  const operation = value.operation;
  if (!operations.has(operation)
      || (expected.operation !== undefined && operation !== expected.operation)) {
    throw invalidResponse();
  }
  switch (value.event) {
    case 'progress': {
      if (!hasExactKeys(value, ['event', 'job', 'operation', 'phase', 'fraction'])
          || !phases.has(value.phase)
          || (value.fraction !== null
            && (!isFiniteNumber(value.fraction) || value.fraction < 0 || value.fraction > 1))) {
        throw invalidResponse();
      }
      return Object.freeze({ ...value, job: normalizeJob(value.job) });
    }
    case 'completed': {
      if (!hasExactKeys(value, ['event', 'job', 'operation', 'result'])
          || !isUuidV7(expected.assetId)) {
        throw invalidResponse();
      }
      const job = normalizeJob(value.job);
      if (job.state !== 'succeeded') throw invalidResponse();
      return Object.freeze({
        event: 'completed',
        job,
        operation,
        result: normalizeResult(value.result, operation, expected.assetId),
      });
    }
    case 'cancelled': {
      if (!hasExactKeys(value, ['event', 'job', 'operation'])) throw invalidResponse();
      const job = normalizeJob(value.job);
      if (job.state !== 'cancelled') throw invalidResponse();
      return Object.freeze({ event: 'cancelled', job, operation });
    }
    case 'failed': {
      if (!hasExactKeys(value, ['event', 'job', 'operation', 'error'])) throw invalidResponse();
      const job = value.job === null ? null : normalizeJob(value.job);
      if (job !== null && job.state !== 'failed') throw invalidResponse();
      return Object.freeze({
        event: 'failed', job, operation, error: normalizeError(value.error),
      });
    }
    default:
      throw invalidResponse();
  }
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  const allowed = new Set([
    'onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed', 'onProtocolError',
  ]);
  if (!isPlainRecord(handlers) || Object.keys(handlers).some((key) => !allowed.has(key))) {
    throw invalidRequest();
  }
  for (const handler of Object.values(handlers)) {
    if (handler !== undefined && typeof handler !== 'function') throw invalidRequest();
  }
  return Object.freeze({ ...handlers });
};

const normalizeRunOptions = (options) => {
  if (options === undefined) return Object.freeze({});
  if (!isPlainRecord(options)
      || Object.keys(options).some((key) => key !== 'signal' && key !== 'onProgress')
      || (options.onProgress !== undefined && typeof options.onProgress !== 'function')) {
    throw invalidRequest();
  }
  if (options.signal !== undefined
      && (typeof options.signal?.aborted !== 'boolean'
        || typeof options.signal?.addEventListener !== 'function'
        || typeof options.signal?.removeEventListener !== 'function')) {
    throw invalidRequest();
  }
  return Object.freeze({ ...options });
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
    try {
      return normalizeInspection(
        await invokeCommand('media_pipeline_inspect', { assetId: normalizedAssetId }),
        normalizedAssetId
      );
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  const start = async (rawRequest, rawHandlers) => {
    requireRuntime();
    const request = normalizeMediaPipelineRequest(rawRequest);
    const handlers = normalizeHandlers(rawHandlers);
    const pending = [];
    let initial = null;
    let terminal = false;

    const call = (handler, value) => {
      if (typeof handler !== 'function') return;
      try {
        const returned = handler(value);
        if (returned && typeof returned.catch === 'function') returned.catch(() => undefined);
      } catch {
        // UI handlers cannot corrupt the native channel lifecycle.
      }
    };
    const protocolError = () => call(handlers.onProtocolError, invalidResponse());
    const dispatch = (event) => {
      if (terminal || event.job === null || event.job.id !== initial.id) {
        protocolError();
        return;
      }
      if (event.event !== 'progress') {
        terminal = true;
        activeChannels.delete(initial.id);
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
        event = normalizeMediaPipelineEvent(rawEvent, request);
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

    try {
      initial = normalizeJob(await invokeCommand('media_pipeline_start', {
        request,
        onEvent: channel,
      }));
    } catch (error) {
      pending.length = 0;
      throw normalizeFailure(error);
    }
    if (initial.state !== 'running') throw invalidResponse();
    activeChannels.set(initial.id, channel);
    pending.splice(0).forEach(dispatch);
    if (terminal) activeChannels.delete(initial.id);
    return initial;
  };

  const cancel = async (jobId) => {
    requireRuntime();
    if (!isUuidV7(jobId)) throw invalidRequest();
    try {
      const job = normalizeJob(await invokeCommand('media_pipeline_cancel', { jobId }));
      if (job.id !== jobId) throw invalidResponse();
      return job;
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  const run = async (rawRequest, rawOptions) => {
    const options = normalizeRunOptions(rawOptions);
    const { signal, onProgress } = options;
    if (signal?.aborted) throw cancelledOperation();

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
        return job;
      }).catch((error) => {
        settle({ error: normalizeFailure(error) });
        return null;
      });
      return cancelPromise;
    };
    const handleAbort = () => {
      if (!settled) cancelStartedJob();
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
    try {
      initial = await start(rawRequest, {
        onProgress,
        onCompleted: (event) => settle({ result: event.result }),
        onCancelled: () => settle({ error: cancelledOperation() }),
        onFailed: (event) => settle({
          error: new MediaPipelineServiceError(event.error.code, event.error.message),
        }),
        onProtocolError: (error) => {
          cancelStartedJob();
          settle({ error });
        },
      });
      if (cancelRequested || (!settled && signal?.aborted)) cancelStartedJob();
      if (cancelRequested && cancelPromise !== null) await cancelPromise;
      const outcome = await terminal;
      if (outcome.error) throw outcome.error;
      return outcome.result;
    } finally {
      signal?.removeEventListener('abort', handleAbort);
    }
  };

  return Object.freeze({ inspect, start, cancel, run });
};

const mediaPipelineService = createNativeMediaPipelineService();

export const inspectMediaPipelineAsset = mediaPipelineService.inspect;
export const startMediaPipeline = mediaPipelineService.start;
export const cancelMediaPipeline = mediaPipelineService.cancel;
export const runMediaPipeline = mediaPipelineService.run;
