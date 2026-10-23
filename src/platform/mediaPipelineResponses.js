// Validation of host-returned media pipeline data: jobs, assets, inspections, results and events.
import {
  activeJobStates,
  compatibilityActions,
  compatibilityIssues,
  expectedJobKind,
  hasControlCharacter,
  invalidResponse,
  isFiniteNumber,
  isSafeInteger,
  isUuidV4,
  isUuidV7,
  jobKinds,
  jobStates,
  MAX_DURATION_US,
  MAX_WAVEFORM_PYRAMID_POINTS,
  MEDIA_MIME_PATTERN,
  mediaFailureMessage,
  mediaKinds,
  mediaPipelineCommandCodes,
  mediaPipelineEventKeys,
  operations,
  phases,
  PLAYBACK_PATTERN,
} from './mediaPipelineContract';
import {
  exactRecord,
  hasSnapshotKeys,
  snapshotDataArray,
  snapshotDataRecord,
} from './nativeDataSnapshot';

export const normalizeJob = (value, expectedKind = null) => {
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

export const normalizeInspection = (value, expectedAssetId = null) => {
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
    allowed: ['kind', 'media', 'inspection', 'assetId', 'waveform', 'cacheHit'],
    failure: invalidResponse,
  });
  if (data.kind === 'media') return normalizeMediaResult(data, operation, sourceAssetId);
  if (data.kind === 'waveform') {
    if (operation !== 'generateWaveform'
        || !hasSnapshotKeys(data, ['kind', 'assetId', 'cacheHit', 'waveform'])
        || data.assetId !== sourceAssetId
        || typeof data.cacheHit !== 'boolean') {
      throw invalidResponse();
    }
    return Object.freeze({
      kind: 'waveform',
      assetId: data.assetId,
      cacheHit: data.cacheHit,
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
    message: mediaFailureMessage(code),
  });
};

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
