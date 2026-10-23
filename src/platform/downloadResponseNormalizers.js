// Validation of host-returned download data: status, inventories, job snapshots and Channel events.
import {
  activeJobStates,
  containers,
  downloadCommandCodes,
  invalidResponse,
  isFormatId,
  isLanguage,
  isOptionalSafeInteger,
  isSafeDisplayText,
  isSafeInteger,
  jobStates,
  MAX_FORMATS,
  MAX_SAFE_FILENAME_CHARACTERS,
  MAX_SUBTITLE_BYTES,
  MAX_SUBTITLES,
  mediaKinds,
  progressPhases,
  subtitleFormats,
  subtitleSources,
  unavailableReasons,
} from './downloadServiceContract';
import {
  exactRecord,
  isUuidVersion,
  snapshotDataArray,
  snapshotDataRecord,
} from './nativeDataSnapshot';
import { hasExactKeys, snapshotNativeError, utf8ByteLength } from './plainDataRecord';

export const normalizeStatus = (value) => {
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

export const normalizeInspection = (value) => {
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

export const normalizeJob = (value, expectedKind = 'downloadMedia') => {
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
  const error = snapshotNativeError(value);
  if (error === null || error.message.length > 2_048) throw invalidResponse();
  const { code } = error;
  return Object.freeze({
    code: downloadCommandCodes.has(code) ? code : 'downloadCommandFailed',
    message: 'The native media download could not be completed',
  });
};

export const downloadEventKeys = Object.freeze([
  'event', 'job', 'progress', 'media', 'summary', 'subtitle', 'error',
]);

export const normalizeDownloadEvent = (value) => {
  const data = snapshotDataRecord(value, {
    required: ['event', 'job'],
    allowed: downloadEventKeys,
    failure: invalidResponse,
  });
  if (typeof data.event !== 'string') throw invalidResponse();
  switch (data.event) {
    case 'progress':
      if (!hasExactKeys(data, ['event', 'job', 'progress'])) throw invalidResponse();
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
      if (!hasExactKeys(data, ['event', 'job', 'media', 'summary', 'subtitle'])) {
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
      if (!hasExactKeys(data, ['event', 'job'])) throw invalidResponse();
      const job = normalizeJob(data.job);
      if (job.state !== 'cancelled') throw invalidResponse();
      return Object.freeze({ event: 'cancelled', job });
    }
    case 'failed': {
      if (!hasExactKeys(data, ['event', 'job', 'error'])) throw invalidResponse();
      const job = data.job === null ? null : normalizeJob(data.job);
      if (job !== null && job.state !== 'failed') throw invalidResponse();
      return Object.freeze({ event: 'failed', job, error: normalizeError(data.error) });
    }
    default:
      throw invalidResponse();
  }
};

