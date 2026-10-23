// Shared job IDs, in-memory storage and a coordinator harness for jobRecoveryCoordinator tests.

import { vi } from 'vitest';
import { createNativeJobRecoveryCoordinator } from './jobRecoveryCoordinator';

export const RENDER_ID = '0198a8d7-dbf7-7ee0-a949-f13427fdd78a';
export const SPEECH_ID = '0198a8d7-dbf8-7ee0-a949-f13427fdd78a';
export const ALIGNMENT_ID = '0198a8d7-dbf9-7ee0-a949-f13427fdd78a';
export const OTHER_ID = '0198a8d7-dbfa-7ee0-a949-f13427fdd78a';
export const PROJECT_A = '0198a8d7-dbfd-7ee0-a949-f13427fdd78a';

export class MemoryStorage {
  #values = new Map();

  constructor(values = {}) {
    Object.entries(values).forEach(([key, value]) => this.#values.set(key, value));
  }

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }
}

export const job = ({
  id,
  kind,
  state = 'running',
  basisPoints = state === 'succeeded' ? 10_000 : 2_500,
  sequence = state === 'succeeded' ? 3 : 2,
}) => ({
  id,
  kind,
  state,
  progress: { basisPoints },
  sequence,
});

export const createHarness = ({
  jobs = [],
  knownJobs = jobs,
  storage = new MemoryStorage(),
  adapters = {},
  pending = [],
  pendingResults = vi.fn(async (kind = null, afterDeliveryId = null) => (
    pending
      .filter((header) => kind === null || header.kind === kind)
      .filter((header) => afterDeliveryId === null || header.deliveryId > afterDeliveryId)
      .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId))
      .slice(0, 256)
  )),
  discardAsrResult = vi.fn().mockResolvedValue(true),
  abandonTranscribe = null,
} = {}) => {
  const byId = new Map(knownJobs.map((snapshot) => [snapshot.id, snapshot]));
  const abandon = abandonTranscribe ?? vi.fn(async (jobId) => ({
    ...byId.get(jobId),
    state: 'cancelled',
    sequence: byId.get(jobId).sequence + 1,
  }));
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'jobs_list') return jobs;
    if (command === 'job_get') {
      const found = byId.get(args.id);
      if (!found) throw Object.assign(new Error('missing'), { code: 'jobNotFound' });
      return found;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const releaseRenderPlayback = vi.fn().mockResolvedValue(true);
  const coordinator = createNativeJobRecoveryCoordinator({
    invokeCommand,
    isNativeRuntime: () => true,
    adapters,
    pendingResults,
    discardAsrResult,
    abandonTranscribe: abandon,
    releaseRenderPlayback,
    storage,
  });
  return {
    coordinator,
    abandonTranscribe: abandon,
    discardAsrResult,
    invokeCommand,
    pendingResults,
    releaseRenderPlayback,
    storage,
  };
};
