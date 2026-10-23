// Durable job snapshot validation and the bounded browser-side job-ID memory used by the native
// job recovery coordinator. Pure helpers: no IPC.
import { validate as validateUuid, version as uuidVersion } from 'uuid';

export const NATIVE_JOB_IDS_STORAGE_KEY = 'osg.nativeJobIds.v1';
export const LEGACY_NATIVE_JOB_STORAGE_KEYS = Object.freeze([
  'currentRenderId',
  'currentRenderItem',
  'osg.nativeNarrationAlignment.v1',
  'osg.nativeNarrationJob.v1',
  'videoRenderQueue',
]);

const MAX_REMEMBERED_JOB_IDS = 64;
const MAX_JOB_SNAPSHOTS = 512;
export const MAX_RECOVERY_CANDIDATES = MAX_JOB_SNAPSHOTS + MAX_REMEMBERED_JOB_IDS;
export const MAX_PENDING_RESULT_PAGE = 256;
export const MAX_ASR_DISCARD_PASSES = 16;
export const MAX_GEMINI_DISCOVERY_PASSES = 16;
const JOB_KINDS = new Set([
  'importMedia',
  'probeMedia',
  'processMedia',
  'generateWaveform',
  'downloadMedia',
  'exportMedia',
  'transcribe',
  'translate',
  'analyzeSubtitles',
  'generateImage',
  'synthesizeNarration',
  'alignNarration',
  'renderVideo',
  'installEngine',
]);
const JOB_STATES = new Set([
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
export const ACTIVE_JOB_STATES = new Set(['queued', 'running', 'cancelling']);
const RECOVERABLE_NATIVE_JOB_KINDS = Object.freeze([
  'alignNarration',
  'renderVideo',
  'synthesizeNarration',
  'transcribe',
  'translate',
  'analyzeSubtitles',
]);
export const recoverableKinds = new Set(RECOVERABLE_NATIVE_JOB_KINDS);
export const GEMINI_TASK_JOB_KIND = Object.freeze({
  transcribe: 'transcribe',
  translate: 'translate',
  analyzeSubtitles: 'analyzeSubtitles',
});
const GEMINI_USAGE_FIELDS = Object.freeze([
  'promptTokenCount',
  'candidatesTokenCount',
  'totalTokenCount',
  'thoughtsTokenCount',
  'cachedContentTokenCount',
]);

export class NativeJobRecoveryUnavailableError extends Error {
  constructor(result) {
    super('Native job recovery is temporarily unavailable');
    this.name = 'NativeJobRecoveryUnavailableError';
    this.code = 'nativeJobRecoveryUnavailable';
    this.retryable = true;
    this.result = result;
  }
}

export const unavailableResult = (discarded = 0) => Object.freeze({
  recovered: 0,
  discarded,
  unavailable: true,
});

const isPlainRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value, keys) => (
  isPlainRecord(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
);

const isValidGeminiUsage = (value) => value === null || (
  hasExactKeys(value, GEMINI_USAGE_FIELDS)
  && GEMINI_USAGE_FIELDS.every((field) => (
    value[field] === null || (Number.isSafeInteger(value[field]) && value[field] >= 0)
  ))
);

export const recoveredGeminiMatches = (entry, request) => {
  const delivery = entry?.value?.delivery;
  const payload = delivery?.payload;
  return entry?.job?.kind === GEMINI_TASK_JOB_KIND[request.task]
    && delivery?.kind === 'geminiText'
    && delivery.projectId === (request.projectId ?? null)
    && (delivery.projectId !== null || delivery.assetId === (request.mediaAssetId ?? null))
    && payload?.schemaVersion === 2
    && payload.task === request.task
    && payload.recoveryKey === request.recoveryKey
    && payload.expectedProjectStateVersion === (request.expectedProjectStateVersion ?? null)
    && typeof payload.text === 'string'
    && isValidGeminiUsage(payload.usage);
};

export const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

export const normalizeJob = (value) => {
  if (!hasExactKeys(value, ['id', 'kind', 'state', 'progress', 'sequence'])
      || !hasExactKeys(value.progress, ['basisPoints'])
      || !isUuidV7(value.id)
      || !JOB_KINDS.has(value.kind)
      || !JOB_STATES.has(value.state)
      || !Number.isSafeInteger(value.progress.basisPoints)
      || value.progress.basisPoints < 0
      || value.progress.basisPoints > 10_000
      || !Number.isSafeInteger(value.sequence)
      || value.sequence < 0) {
    throw new Error('The desktop host returned an invalid durable job snapshot');
  }
  const basisPoints = value.progress.basisPoints;
  const validState = value.state === 'queued'
    ? basisPoints === 0 && value.sequence === 0
    : value.state === 'succeeded'
      ? basisPoints === 10_000 && value.sequence >= 2
      : value.sequence >= 1;
  if (!validState) {
    throw new Error('The desktop host returned an impossible durable job state');
  }
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    state: value.state,
    progress: Object.freeze({ basisPoints }),
    sequence: value.sequence,
  });
};

export const normalizeJobList = (value) => {
  if (!Array.isArray(value) || value.length > MAX_JOB_SNAPSHOTS) {
    throw new Error('The desktop host returned an invalid durable job list');
  }
  const seen = new Set();
  const jobs = value.map((candidate) => {
    const job = normalizeJob(candidate);
    if (seen.has(job.id)) {
      throw new Error('The desktop host returned duplicate durable jobs');
    }
    seen.add(job.id);
    return job;
  });
  return Object.freeze(jobs);
};

export const storageOrNull = (provided) => {
  if (provided !== undefined) return provided;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export const scrubLegacyPayloads = (storage) => {
  if (storage === null) return;
  for (const key of LEGACY_NATIVE_JOB_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Browser storage is optional; native SQLite remains authoritative.
    }
  }
};

export const readRememberedIds = (storage) => {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY);
    if (raw === null) return [];
    if (raw.length > (MAX_REMEMBERED_JOB_IDS * 40) + 2) throw new Error('oversized');
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)
        || ids.length > MAX_REMEMBERED_JOB_IDS
        || ids.some((id) => !isUuidV7(id))
        || new Set(ids).size !== ids.length) {
      throw new Error('invalid');
    }
    return ids;
  } catch {
    try {
      storage.removeItem(NATIVE_JOB_IDS_STORAGE_KEY);
    } catch {
      // Ignore an unavailable storage implementation.
    }
    return [];
  }
};

export const writeRememberedIds = (storage, ids) => {
  if (storage === null) return;
  try {
    const bounded = [...new Set(ids)]
      .filter(isUuidV7)
      .sort()
      .slice(-MAX_REMEMBERED_JOB_IDS);
    if (bounded.length === 0) storage.removeItem(NATIVE_JOB_IDS_STORAGE_KEY);
    else storage.setItem(NATIVE_JOB_IDS_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // A browser storage failure never changes the native job lifecycle.
  }
};

export const sameOrNewerJob = (expected, actual) => (
  actual.id === expected.id
  && actual.kind === expected.kind
  && actual.sequence >= expected.sequence
);

export const responseJob = (value, expected) => {
  if (!isPlainRecord(value) || !Object.hasOwn(value, 'job')) {
    throw new Error('The feature adapter returned an invalid recovery result');
  }
  const job = normalizeJob(value.job);
  if (!sameOrNewerJob(expected, job)) {
    throw new Error('The feature adapter returned a mismatched recovery job');
  }
  return job;
};

export const matchesPendingDelivery = (value, pending) => (
  isPlainRecord(value?.delivery)
  && value.delivery.jobId === pending.jobId
  && value.delivery.deliveryId === pending.deliveryId
  && value.delivery.kind === pending.kind
);
