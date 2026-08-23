import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktop } from './desktopRuntime';
import { normalizeJobSnapshot } from './geminiService';

const MAX_PENDING_RESULTS = 256;
const kinds = new Set(['asrTranscription', 'geminiText']);

const isPlainRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactKeys = (value, keys) => (
  isPlainRecord(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
);

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try { return uuidVersion(value) === 7; } catch { return false; }
};

const invalid = () => {
  const error = new Error('The desktop host returned an invalid durable job result');
  error.code = 'invalidJobResult';
  return error;
};

const requireId = (value) => {
  if (!isUuidV7(value)) throw invalid();
  return value;
};

const normalizeHeader = (value) => {
  if (!exactKeys(value, ['deliveryId', 'jobId', 'kind']) || !kinds.has(value.kind)) {
    throw invalid();
  }
  return Object.freeze({
    deliveryId: requireId(value.deliveryId),
    jobId: requireId(value.jobId),
    kind: value.kind,
  });
};

export const normalizePendingJobResults = (value) => {
  if (!Array.isArray(value) || value.length > MAX_PENDING_RESULTS) throw invalid();
  const seenJobs = new Set();
  return Object.freeze(value.map((raw) => {
    const header = normalizeHeader(raw);
    if (seenJobs.has(header.jobId)) throw invalid();
    seenJobs.add(header.jobId);
    return header;
  }));
};

export const normalizeClaimedJobResult = (value) => {
  if (value === null) return null;
  if (!exactKeys(value, ['job', 'delivery'])) throw invalid();
  const job = normalizeJobSnapshot(value.job);
  const delivery = value.delivery;
  if (!exactKeys(delivery, [
    'deliveryId', 'jobId', 'kind', 'projectId', 'assetId', 'payload', 'createdAtMs',
  ])
      || !kinds.has(delivery.kind)
      || !isPlainRecord(delivery.payload)
      || !Number.isSafeInteger(delivery.createdAtMs)
      || delivery.createdAtMs < 0
      || (delivery.projectId !== null && !isUuidV7(delivery.projectId))
      || (delivery.assetId !== null && !isUuidV7(delivery.assetId))) {
    throw invalid();
  }
  const normalized = Object.freeze({
    deliveryId: requireId(delivery.deliveryId),
    jobId: requireId(delivery.jobId),
    kind: delivery.kind,
    projectId: delivery.projectId,
    assetId: delivery.assetId,
    payload: delivery.payload,
    createdAtMs: delivery.createdAtMs,
  });
  const expectedKind = normalized.kind === 'asrTranscription'
    ? job.kind === 'transcribe'
    : ['transcribe', 'translate', 'analyzeSubtitles'].includes(job.kind);
  if (job.state !== 'succeeded' || job.id !== normalized.jobId || !expectedKind) throw invalid();
  return Object.freeze({ job, delivery: normalized });
};

export const listPendingJobResults = async ({ invokeCommand = invokeDesktop } = {}) => (
  normalizePendingJobResults(await invokeCommand('job_result_pending', {}))
);

export const claimJobResult = async (jobId, { invokeCommand = invokeDesktop } = {}) => {
  const id = requireId(jobId);
  const result = normalizeClaimedJobResult(await invokeCommand('job_result_claim', { jobId: id }));
  if (result !== null && result.job.id !== id) throw invalid();
  return result;
};

export const acknowledgeJobResult = async (
  jobId,
  deliveryId,
  { invokeCommand = invokeDesktop } = {},
) => {
  const result = await invokeCommand('job_result_ack', {
    jobId: requireId(jobId),
    deliveryId: requireId(deliveryId),
  });
  if (result !== true) throw invalid();
};
