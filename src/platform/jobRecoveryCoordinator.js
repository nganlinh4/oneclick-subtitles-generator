import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import { nativeNarrationAlignmentService } from './narrationAlignmentService';
import { getNativeRenderResult, releaseNativeRenderPlayback } from './renderService';
import { getSpeechJobResults } from './speechService';

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
const MAX_RECOVERY_CANDIDATES = MAX_JOB_SNAPSHOTS + MAX_REMEMBERED_JOB_IDS;
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
const ACTIVE_JOB_STATES = new Set(['queued', 'running', 'cancelling']);
export const RECOVERABLE_NATIVE_JOB_KINDS = Object.freeze([
  'alignNarration',
  'renderVideo',
  'synthesizeNarration',
]);
const recoverableKinds = new Set(RECOVERABLE_NATIVE_JOB_KINDS);

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

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

const normalizeJob = (value) => {
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

const normalizeJobList = (value) => {
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

const storageOrNull = (provided) => {
  if (provided !== undefined) return provided;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const scrubLegacyPayloads = (storage) => {
  if (storage === null) return;
  for (const key of LEGACY_NATIVE_JOB_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Browser storage is optional; native SQLite remains authoritative.
    }
  }
};

const readRememberedIds = (storage) => {
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

const writeRememberedIds = (storage, ids) => {
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

const sameOrNewerJob = (expected, actual) => (
  actual.id === expected.id
  && actual.kind === expected.kind
  && actual.sequence >= expected.sequence
);

const responseJob = (value, expected) => {
  if (!isPlainRecord(value) || !Object.hasOwn(value, 'job')) {
    throw new Error('The feature adapter returned an invalid recovery result');
  }
  const job = normalizeJob(value.job);
  if (!sameOrNewerJob(expected, job)) {
    throw new Error('The feature adapter returned a mismatched recovery job');
  }
  return job;
};

const defaultAdapters = Object.freeze({
  alignNarration: nativeNarrationAlignmentService.getAlignmentResult,
  renderVideo: getNativeRenderResult,
  synthesizeNarration: getSpeechJobResults,
});

export const createNativeJobRecoveryCoordinator = ({
  invokeCommand = invokeDesktop,
  isNativeRuntime = isDesktopRuntime,
  adapters = defaultAdapters,
  releaseRenderPlayback = releaseNativeRenderPlayback,
  storage: providedStorage,
} = {}) => {
  const storage = storageOrNull(providedStorage);
  const recovered = new Map();
  let started = null;

  const remember = (jobId) => {
    if (!isUuidV7(jobId)) return false;
    writeRememberedIds(storage, [...readRememberedIds(storage), jobId]);
    return true;
  };

  const forget = (jobId) => {
    if (!isUuidV7(jobId)) return false;
    writeRememberedIds(
      storage,
      readRememberedIds(storage).filter((candidate) => candidate !== jobId),
    );
    return true;
  };

  const releaseEntry = (entry) => {
    if (entry?.job.kind !== 'renderVideo') return;
    const playbackId = entry.value?.result?.playback?.id;
    if (typeof playbackId === 'string') {
      Promise.resolve(releaseRenderPlayback(playbackId)).catch(() => undefined);
    }
  };

  const discard = (jobId) => {
    if (!isUuidV7(jobId)) return false;
    const entry = recovered.get(jobId);
    recovered.delete(jobId);
    forget(jobId);
    releaseEntry(entry);
    return entry !== undefined;
  };

  const claim = (jobId) => {
    if (!isUuidV7(jobId)) return null;
    const entry = recovered.get(jobId) ?? null;
    if (entry === null) return null;
    recovered.delete(jobId);
    forget(jobId);
    return entry;
  };

  const list = (kind = null) => {
    if (kind !== null && !recoverableKinds.has(kind)) return Object.freeze([]);
    return Object.freeze([...recovered.values()]
      .filter((entry) => kind === null || entry.job.kind === kind)
      .sort((left, right) => right.job.id.localeCompare(left.job.id)));
  };

  const recoverOne = async (jobId, listedJob, wasRemembered) => {
    let current;
    try {
      current = normalizeJob(await invokeCommand('job_get', { id: jobId }));
      if (current.id !== jobId
          || (listedJob !== undefined && !sameOrNewerJob(listedJob, current))) {
        throw new Error('mismatched job');
      }
    } catch {
      forget(jobId);
      return 'discarded';
    }
    if (!recoverableKinds.has(current.kind)) {
      forget(current.id);
      return 'discarded';
    }
    if (!wasRemembered && !ACTIVE_JOB_STATES.has(current.state)) return 'ignored';
    if (['failed', 'cancelled'].includes(current.state)) {
      forget(current.id);
      return 'discarded';
    }

    const adapter = adapters[current.kind];
    if (typeof adapter !== 'function') {
      forget(current.id);
      return 'discarded';
    }
    try {
      const value = await adapter(current.id);
      const latest = responseJob(value, current);
      if (['failed', 'cancelled'].includes(latest.state)) {
        forget(latest.id);
        return 'discarded';
      }
      const entry = Object.freeze({ job: latest, value, wasRemembered });
      recovered.set(latest.id, entry);
      remember(latest.id);
      return 'recovered';
    } catch {
      forget(current.id);
      return 'discarded';
    }
  };

  const start = () => {
    if (started !== null) return started;
    scrubLegacyPayloads(storage);
    const remembered = new Set(readRememberedIds(storage));
    started = (async () => {
      if (!isNativeRuntime()) {
        writeRememberedIds(storage, []);
        return Object.freeze({ recovered: 0, discarded: remembered.size, unavailable: true });
      }
      let jobs;
      try {
        jobs = normalizeJobList(await invokeCommand('jobs_list', {}));
      } catch {
        return Object.freeze({ recovered: 0, discarded: 0, unavailable: true });
      }
      const byId = new Map(jobs.map((job) => [job.id, job]));
      const candidateIds = new Set([
        ...remembered,
        ...jobs.filter((job) => (
          recoverableKinds.has(job.kind) && ACTIVE_JOB_STATES.has(job.state)
        )).map((job) => job.id),
      ]);
      if (candidateIds.size > MAX_RECOVERY_CANDIDATES) {
        return Object.freeze({ recovered: 0, discarded: 0, unavailable: true });
      }
      let recoveredCount = 0;
      let discardedCount = 0;
      for (const jobId of [...candidateIds].sort()) {
        const listedJob = byId.get(jobId);
        const outcome = await recoverOne(jobId, listedJob, remembered.has(jobId));
        if (outcome === 'recovered') recoveredCount += 1;
        if (outcome === 'discarded') discardedCount += 1;
      }
      return Object.freeze({
        recovered: recoveredCount,
        discarded: discardedCount,
        unavailable: false,
      });
    })();
    return started;
  };

  return Object.freeze({ start, remember, forget, list, claim, discard });
};

const nativeJobRecovery = createNativeJobRecoveryCoordinator();

export const startNativeJobRecovery = nativeJobRecovery.start;
export const rememberNativeJobId = nativeJobRecovery.remember;
export const forgetNativeJobId = nativeJobRecovery.forget;
export const listRecoveredNativeJobs = nativeJobRecovery.list;
export const claimRecoveredNativeJob = nativeJobRecovery.claim;
export const discardRecoveredNativeJob = nativeJobRecovery.discard;
