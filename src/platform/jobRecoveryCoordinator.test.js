import { v7 as createUuidV7 } from 'uuid';

import {
  LEGACY_NATIVE_JOB_STORAGE_KEYS,
  NATIVE_JOB_IDS_STORAGE_KEY,
  createNativeJobRecoveryCoordinator,
} from './jobRecoveryCoordinator';

const RENDER_ID = '0198a8d7-dbf7-7ee0-a949-f13427fdd78a';
const SPEECH_ID = '0198a8d7-dbf8-7ee0-a949-f13427fdd78a';
const ALIGNMENT_ID = '0198a8d7-dbf9-7ee0-a949-f13427fdd78a';
const OTHER_ID = '0198a8d7-dbfa-7ee0-a949-f13427fdd78a';
const PROJECT_A = '0198a8d7-dbfd-7ee0-a949-f13427fdd78a';

class MemoryStorage {
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

const job = ({
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

const createHarness = ({
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

describe('native durable-job startup recovery', () => {
  test('shares one in-flight attempt, caches success, and retries after unavailable recovery', async () => {
    let releaseFirstList;
    const invokeCommand = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirstList = resolve; }))
      .mockResolvedValue([]);
    const pendingResults = vi.fn().mockResolvedValue([]);
    const coordinator = createNativeJobRecoveryCoordinator({
      invokeCommand,
      isNativeRuntime: () => true,
      adapters: {},
      pendingResults,
      storage: new MemoryStorage(),
    });

    const first = coordinator.start();
    const concurrent = coordinator.start();
    expect(concurrent).toBe(first);
    await vi.waitFor(() => expect(releaseFirstList).toBeTypeOf('function'));
    releaseFirstList([]);
    await expect(first).resolves.toEqual({ recovered: 0, discarded: 0, unavailable: false });
    await expect(coordinator.start()).resolves.toEqual({
      recovered: 0,
      discarded: 0,
      unavailable: false,
    });
    expect(invokeCommand).toHaveBeenCalledTimes(1);

    const retryingInvoke = vi.fn()
      .mockRejectedValueOnce(new Error('transport closed'))
      .mockResolvedValue([]);
    const retrying = createNativeJobRecoveryCoordinator({
      invokeCommand: retryingInvoke,
      isNativeRuntime: () => true,
      adapters: {},
      pendingResults: vi.fn().mockResolvedValue([]),
      storage: new MemoryStorage(),
    });
    await expect(retrying.ensureReady()).rejects.toMatchObject({
      code: 'nativeJobRecoveryUnavailable',
      retryable: true,
      result: { unavailable: true },
    });
    await expect(retrying.ensureReady()).resolves.toEqual({
      recovered: 0,
      discarded: 0,
      unavailable: false,
    });
    expect(retryingInvoke).toHaveBeenCalledTimes(2);
  });

  test('retains remembered IDs on job_get transport errors but forgets definitive absence', async () => {
    const render = job({ id: RENDER_ID, kind: 'renderVideo' });
    const storage = new MemoryStorage({
      [NATIVE_JOB_IDS_STORAGE_KEY]: JSON.stringify([RENDER_ID]),
    });
    const adapter = vi.fn(async () => ({ job: render, result: null }));
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'jobs_list') return [render];
      if (command === 'job_get') throw new Error('transport closed');
      throw new Error('unexpected');
    });
    const coordinator = createNativeJobRecoveryCoordinator({
      invokeCommand,
      isNativeRuntime: () => true,
      adapters: { renderVideo: adapter },
      pendingResults: vi.fn().mockResolvedValue([]),
      storage,
    });

    await expect(coordinator.start()).resolves.toMatchObject({ unavailable: true });
    expect(storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).toBe(JSON.stringify([RENDER_ID]));
    expect(adapter).not.toHaveBeenCalled();

    invokeCommand.mockImplementation(async (command) => {
      if (command === 'jobs_list') return [render];
      if (command === 'job_get') {
        throw Object.assign(new Error('missing'), { code: 'jobNotFound' });
      }
      throw new Error('unexpected');
    });
    await expect(coordinator.start()).resolves.toEqual({
      recovered: 0,
      discarded: 1,
      unavailable: false,
    });
    expect(storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).toBeNull();
  });

  test('retains an orphaned ASR result for exact retry when discard transport fails', async () => {
    const transcription = job({ id: OTHER_ID, kind: 'transcribe', state: 'succeeded' });
    const header = {
      deliveryId: '0198a8d7-dbfb-7ee0-a949-f13427fdd78a',
      jobId: OTHER_ID,
      kind: 'asrTranscription',
    };
    const adapter = vi.fn();
    const discardAsrResult = vi.fn().mockRejectedValue(new Error('WebView transport closed'));
    const storage = new MemoryStorage();
    const { coordinator } = createHarness({
      jobs: [transcription],
      storage,
      adapters: { transcribe: adapter },
      pending: [header],
      discardAsrResult,
    });

    await expect(coordinator.start()).resolves.toEqual({
      recovered: 0,
      discarded: 0,
      unavailable: true,
    });
    expect(discardAsrResult).toHaveBeenCalledExactlyOnceWith(
      OTHER_ID,
      header.deliveryId,
    );
    expect(adapter).not.toHaveBeenCalled();
    expect(storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).toBe(JSON.stringify([OTHER_ID]));
  });

  test.each([
    ['after window one before aggregate commit', []],
    ['after aggregate commit before acknowledgement', [{ text: 'durable aggregate' }]],
    ['after an overlapping editor change', [{ text: 'newer manual edit' }]],
  ])('relaunch discards exact orphaned ASR output %s without applying or claiming it', async (
    _crashPoint,
    durableRows,
  ) => {
    const transcription = job({ id: OTHER_ID, kind: 'transcribe', state: 'succeeded' });
    const header = {
      deliveryId: '0198a8d7-dbfb-7ee0-a949-f13427fdd78a',
      jobId: OTHER_ID,
      kind: 'asrTranscription',
    };
    const adapter = vi.fn();
    const before = structuredClone(durableRows);
    const { coordinator, discardAsrResult, invokeCommand } = createHarness({
      jobs: [transcription],
      adapters: { transcribe: adapter },
      pending: [header],
    });

    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 0,
      discarded: 1,
      unavailable: false,
    });

    expect(discardAsrResult).toHaveBeenCalledExactlyOnceWith(
      OTHER_ID,
      header.deliveryId,
    );
    expect(adapter).not.toHaveBeenCalled();
    expect(invokeCommand).toHaveBeenCalledExactlyOnceWith('jobs_list', {});
    expect(coordinator.list('transcribe')).toEqual([]);
    expect(durableRows).toEqual(before);
  });

  test('a lost acknowledgement remains retryable and the next recovery attempt releases it', async () => {
    const header = {
      deliveryId: '0198a8d7-dbfb-7ee0-a949-f13427fdd78a',
      jobId: OTHER_ID,
      kind: 'asrTranscription',
    };
    let pending = true;
    const pendingResults = vi.fn(async () => (pending ? [header] : []));
    const discardAsrResult = vi.fn()
      .mockRejectedValueOnce(new Error('transport closed'))
      .mockImplementationOnce(async () => { pending = false; });
    const storage = new MemoryStorage();
    const { coordinator } = createHarness({
      jobs: [],
      knownJobs: [],
      storage,
      pendingResults,
      discardAsrResult,
    });

    await expect(coordinator.ensureReady()).rejects.toMatchObject({
      code: 'nativeJobRecoveryUnavailable',
      result: { recovered: 0, discarded: 0, unavailable: true },
    });
    expect(storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).toBe(JSON.stringify([OTHER_ID]));

    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 0,
      discarded: 1,
      unavailable: false,
    });
    expect(discardAsrResult).toHaveBeenCalledTimes(2);
    expect(storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).toBeNull();
  });

  test('drains a local ASR delivery that completes after WebView reload recovery begins', async () => {
    const running = job({ id: OTHER_ID, kind: 'transcribe', state: 'running' });
    const succeeded = job({ id: OTHER_ID, kind: 'transcribe', state: 'succeeded' });
    const header = {
      deliveryId: '0198a8d7-dbfb-7ee0-a949-f13427fdd78a',
      jobId: OTHER_ID,
      kind: 'asrTranscription',
    };
    let completed = false;
    const pendingResults = vi.fn(async (kind = null) => (
      completed && (kind === null || kind === 'asrTranscription') ? [header] : []
    ));
    const abandonTranscribe = vi.fn(async () => {
      completed = true;
      return succeeded;
    });
    const discardAsrResult = vi.fn(async () => { completed = false; });
    const { coordinator } = createHarness({
      jobs: [running],
      knownJobs: [succeeded],
      pendingResults,
      abandonTranscribe,
      discardAsrResult,
    });

    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 0,
      discarded: 1,
      unavailable: false,
    });
    expect(abandonTranscribe).toHaveBeenCalledExactlyOnceWith(OTHER_ID);
    expect(discardAsrResult).toHaveBeenCalledExactlyOnceWith(
      OTHER_ID,
      header.deliveryId,
    );
    expect(pendingResults).toHaveBeenNthCalledWith(1, 'asrTranscription');
    expect(pendingResults).toHaveBeenNthCalledWith(2, 'asrTranscription');
    expect(pendingResults).toHaveBeenLastCalledWith('geminiText', null);
  });

  test('terminalizes an orphaned queued transcription before memoizing recovery success', async () => {
    const queued = job({
      id: OTHER_ID,
      kind: 'transcribe',
      state: 'queued',
      basisPoints: 0,
      sequence: 0,
    });
    const abandonTranscribe = vi.fn(async () => ({
      ...queued,
      state: 'cancelled',
      sequence: 1,
    }));
    const { coordinator } = createHarness({
      jobs: [queued],
      knownJobs: [queued],
      abandonTranscribe,
    });

    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 0,
      discarded: 1,
      unavailable: false,
    });
    expect(abandonTranscribe).toHaveBeenCalledExactlyOnceWith(OTHER_ID);
    await coordinator.start();
    expect(abandonTranscribe).toHaveBeenCalledTimes(1);
  });

  test('routes and retains a paid Gemini transcribe delivery for its product consumer', async () => {
    const transcription = job({ id: OTHER_ID, kind: 'transcribe', state: 'succeeded' });
    const recoveryKey = 'a'.repeat(64);
    const header = {
      deliveryId: '0198a8d7-dbfb-7ee0-a949-f13427fdd78a',
      jobId: OTHER_ID,
      kind: 'geminiText',
    };
    const delivery = {
      ...header,
      projectId: PROJECT_A,
      assetId: null,
      payload: {
        schemaVersion: 2,
        task: 'transcribe',
        expectedProjectStateVersion: 9,
        recoveryKey,
        text: '{"subtitles":[]}',
        usage: null,
      },
      createdAtMs: 1,
    };
    const transcribe = vi.fn(async () => ({ job: transcription, delivery }));
    const { coordinator, discardAsrResult } = createHarness({
      jobs: [transcription],
      adapters: { transcribe },
      pending: [header],
    });

    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 1,
      discarded: 0,
      unavailable: false,
    });
    expect(transcribe).toHaveBeenCalledExactlyOnceWith(OTHER_ID);
    expect(discardAsrResult).not.toHaveBeenCalled();
    expect(coordinator.list('transcribe')).toEqual([
      expect.objectContaining({ job: transcription, value: { job: transcription, delivery } }),
    ]);
    expect(coordinator.claimGemini({
      task: 'transcribe',
      projectId: PROJECT_A,
      expectedProjectStateVersion: 9,
      recoveryKey,
    })).toMatchObject({ job: transcription });
    expect(coordinator.claimGemini({
      task: 'transcribe',
      projectId: PROJECT_A,
      expectedProjectStateVersion: 10,
      recoveryKey,
    })).toBeNull();
    delivery.payload.usage = { totalTokenCount: -1 };
    expect(coordinator.claimGemini({
      task: 'transcribe',
      projectId: PROJECT_A,
      expectedProjectStateVersion: 9,
      recoveryKey,
    })).toBeNull();
    expect(coordinator.list('transcribe')).toHaveLength(1);
  });

  test('does not report a running transcription terminal before its worker confirms quiescence', async () => {
    const running = job({ id: OTHER_ID, kind: 'transcribe', state: 'running' });
    const cancelling = { ...running, state: 'cancelling', sequence: running.sequence + 1 };
    const cancelled = { ...cancelling, state: 'cancelled', sequence: cancelling.sequence + 1 };
    let attempt = 0;
    const abandonTranscribe = vi.fn(async () => (++attempt === 1 ? cancelling : cancelled));
    const { coordinator } = createHarness({
      jobs: [running],
      knownJobs: [running],
      abandonTranscribe,
    });

    await expect(coordinator.ensureReady()).rejects.toMatchObject({
      code: 'nativeJobRecoveryUnavailable',
      result: { recovered: 0, discarded: 0, unavailable: true },
    });
    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 0,
      discarded: 1,
      unavailable: false,
    });
    expect(abandonTranscribe).toHaveBeenCalledTimes(2);
  });

  test('a retained Gemini transcribe remains claimable without acknowledging its outbox', async () => {
    const transcription = job({ id: OTHER_ID, kind: 'transcribe', state: 'succeeded' });
    const header = {
      deliveryId: '0198a8d7-dbfb-7ee0-a949-f13427fdd78a',
      jobId: OTHER_ID,
      kind: 'geminiText',
    };
    const storage = new MemoryStorage();
    const { coordinator } = createHarness({
      jobs: [transcription],
      storage,
      adapters: { transcribe: vi.fn(async () => ({ job: transcription, delivery: header })) },
      pending: [header],
    });

    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 1,
      discarded: 0,
      unavailable: false,
    });
    expect(coordinator.claim(OTHER_ID)).toMatchObject({ job: transcription });
    expect(storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).toBeNull();
  });

  test('drains a saturated 256-result ASR page without claiming payloads or exhausting candidates', async () => {
    const headers = Array.from({ length: 256 }, () => ({
      deliveryId: createUuidV7(),
      jobId: createUuidV7(),
      kind: 'asrTranscription',
    }));
    const remaining = new Set(headers.map(({ jobId }) => jobId));
    const pendingResults = vi.fn(async () => headers.filter(({ jobId }) => remaining.has(jobId)));
    const discardAsrResult = vi.fn(async (jobId) => { remaining.delete(jobId); });
    const adapter = vi.fn();
    const { coordinator, invokeCommand } = createHarness({
      jobs: [],
      knownJobs: [],
      adapters: { transcribe: adapter },
      pendingResults,
      discardAsrResult,
    });

    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 0,
      discarded: 256,
      unavailable: false,
    });

    expect(discardAsrResult).toHaveBeenCalledTimes(256);
    expect(pendingResults).toHaveBeenCalledTimes(3);
    expect(pendingResults).toHaveBeenNthCalledWith(1, 'asrTranscription');
    expect(pendingResults).toHaveBeenNthCalledWith(3, 'geminiText', null);
    expect(adapter).not.toHaveBeenCalled();
    expect(invokeCommand).toHaveBeenCalledExactlyOnceWith('jobs_list', {});
    expect(remaining.size).toBe(0);
  });

  test('drains more than 1024 filtered ASR deliveries in one bounded recovery attempt', async () => {
    const headers = Array.from({ length: 1_025 }, () => ({
      deliveryId: createUuidV7(),
      jobId: createUuidV7(),
      kind: 'asrTranscription',
    }));
    const remaining = new Set(headers.map(({ jobId }) => jobId));
    const pendingResults = vi.fn(async () => headers
      .filter(({ jobId }) => remaining.has(jobId))
      .slice(0, 256));
    const discardAsrResult = vi.fn(async (jobId) => { remaining.delete(jobId); });
    const { coordinator } = createHarness({
      jobs: [],
      knownJobs: [],
      pendingResults,
      discardAsrResult,
    });

    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 0,
      discarded: 1_025,
      unavailable: false,
    });
    expect(remaining.size).toBe(0);
    expect(discardAsrResult).toHaveBeenCalledTimes(1_025);
  });

  test('keyset-pages more than 1024 mixed Gemini deliveries without starving later jobs', async () => {
    const snapshots = Array.from({ length: 1_025 }, (_, index) => job({
      id: createUuidV7(),
      kind: ['translate', 'analyzeSubtitles', 'transcribe'][index % 3],
      state: 'succeeded',
    }));
    const headers = snapshots.map((snapshot) => ({
      deliveryId: createUuidV7(),
      jobId: snapshot.id,
      kind: 'geminiText',
    }));
    const headerByJob = new Map(headers.map((header) => [header.jobId, header]));
    const adapter = vi.fn(async (jobId) => ({
      job: snapshots.find((snapshot) => snapshot.id === jobId),
      delivery: headerByJob.get(jobId),
    }));
    const { coordinator, pendingResults } = createHarness({
      jobs: [],
      knownJobs: snapshots,
      pending: headers,
      adapters: {
        translate: adapter,
        analyzeSubtitles: adapter,
        transcribe: adapter,
      },
    });

    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 1_025,
      discarded: 0,
      unavailable: false,
    });
    expect(coordinator.list()).toHaveLength(1_025);
    expect(adapter).toHaveBeenCalledTimes(1_025);
    expect(pendingResults).toHaveBeenCalledWith('geminiText', headers
      .map(({ deliveryId }) => deliveryId)
      .sort()
      .at(1_023));
  });

  test('continues beyond the bounded 4096-row Gemini scan before memoizing startup success', async () => {
    const snapshots = Array.from({ length: 4_097 }, (_, index) => job({
      id: createUuidV7(),
      kind: ['translate', 'analyzeSubtitles', 'transcribe'][index % 3],
      state: 'succeeded',
    }));
    const byJobId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const headers = snapshots.map((snapshot) => ({
      deliveryId: createUuidV7(),
      jobId: snapshot.id,
      kind: 'geminiText',
    })).sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
    const headerByJobId = new Map(headers.map((header) => [header.jobId, header]));
    const pendingResults = vi.fn(async (kind, afterDeliveryId) => {
      if (kind === 'asrTranscription') return [];
      expect(kind).toBe('geminiText');
      const start = afterDeliveryId === null
        ? 0
        : headers.findIndex(({ deliveryId }) => deliveryId === afterDeliveryId) + 1;
      return headers.slice(start, start + 256);
    });
    const adapter = vi.fn(async (jobId) => ({
      job: byJobId.get(jobId),
      delivery: headerByJobId.get(jobId),
    }));
    const { coordinator } = createHarness({
      jobs: [],
      knownJobs: snapshots,
      pendingResults,
      adapters: {
        translate: adapter,
        analyzeSubtitles: adapter,
        transcribe: adapter,
      },
    });

    await expect(coordinator.ensureReady()).rejects.toMatchObject({
      code: 'nativeJobRecoveryUnavailable',
      result: { recovered: 4_096, unavailable: true },
    });
    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 1,
      discarded: 0,
      unavailable: false,
    });
    await coordinator.start();

    expect(coordinator.list()).toHaveLength(4_097);
    expect(adapter).toHaveBeenCalledTimes(4_097);
    expect(pendingResults.mock.calls.filter(([kind]) => kind === 'geminiText')).toHaveLength(17);
  });

  test('rediscovers an unacknowledged paid result after a coordinator restart', async () => {
    const translation = job({ id: OTHER_ID, kind: 'translate', state: 'succeeded' });
    const header = {
      deliveryId: '0198a8d7-dbfb-7ee0-a949-f13427fdd78a',
      jobId: OTHER_ID,
      kind: 'geminiText',
    };
    const delivery = {
      ...header,
      projectId: PROJECT_A,
      assetId: null,
      payload: {
        schemaVersion: 2,
        task: 'translate',
        expectedProjectStateVersion: 9,
        recoveryKey: 'b'.repeat(64),
        text: 'durable paid output',
        usage: null,
      },
      createdAtMs: 1,
    };
    const translate = vi.fn(async () => ({ job: translation, delivery }));
    const first = createHarness({
      jobs: [translation],
      pending: [header],
      adapters: { translate },
    });
    const second = createHarness({
      jobs: [translation],
      pending: [header],
      adapters: { translate },
    });

    await expect(first.coordinator.ensureReady()).resolves.toMatchObject({ recovered: 1 });
    expect(first.coordinator.claimGemini({
      task: 'translate',
      projectId: PROJECT_A,
      expectedProjectStateVersion: 9,
      recoveryKey: 'b'.repeat(64),
    })).not.toBeNull();
    await expect(second.coordinator.ensureReady()).resolves.toMatchObject({ recovered: 1 });
    expect(second.coordinator.claimGemini({
      task: 'translate',
      projectId: PROJECT_A,
      expectedProjectStateVersion: 9,
      recoveryKey: 'b'.repeat(64),
    })).not.toBeNull();
    expect(translate).toHaveBeenCalledTimes(2);
  });

  test('discards only orphaned ASR deliveries and preserves another feature result for recovery', async () => {
    const transcription = job({ id: OTHER_ID, kind: 'transcribe', state: 'succeeded' });
    const translation = job({ id: SPEECH_ID, kind: 'translate', state: 'succeeded' });
    const asrHeader = {
      deliveryId: '0198a8d7-dbfb-7ee0-a949-f13427fdd78a',
      jobId: OTHER_ID,
      kind: 'asrTranscription',
    };
    const translationHeader = {
      deliveryId: '0198a8d7-dbfc-7ee0-a949-f13427fdd78a',
      jobId: SPEECH_ID,
      kind: 'geminiText',
    };
    const translate = vi.fn(async () => ({ job: translation, delivery: translationHeader }));
    const { coordinator, discardAsrResult } = createHarness({
      jobs: [transcription, translation],
      adapters: { translate },
      pending: [asrHeader, translationHeader],
    });

    await expect(coordinator.ensureReady()).resolves.toEqual({
      recovered: 1,
      discarded: 1,
      unavailable: false,
    });

    expect(discardAsrResult).toHaveBeenCalledExactlyOnceWith(
      OTHER_ID,
      asrHeader.deliveryId,
    );
    expect(translate).toHaveBeenCalledExactlyOnceWith(SPEECH_ID);
    expect(coordinator.list('translate')).toEqual([
      expect.objectContaining({ job: translation }),
    ]);
  });

  test('synchronously destroys legacy payload records and persists only UUID job IDs', async () => {
    const secretPayload = JSON.stringify({
      subtitles: [{ text: 'private subtitle' }],
      request: { path: 'C:\\private\\voice.wav' },
      playbackUrl: 'http://127.0.0.1:49152/media/private-token',
    });
    const storage = new MemoryStorage(Object.fromEntries(
      LEGACY_NATIVE_JOB_STORAGE_KEYS.map((key) => [key, secretPayload]),
    ));
    const coordinator = createNativeJobRecoveryCoordinator({
      isNativeRuntime: () => false,
      storage,
      pendingResults: vi.fn().mockResolvedValue([]),
    });

    const startup = coordinator.start();
    for (const key of LEGACY_NATIVE_JOB_STORAGE_KEYS) {
      expect(storage.getItem(key)).toBeNull();
    }
    expect(coordinator.remember('not-a-job')).toBe(false);
    expect(coordinator.remember(RENDER_ID)).toBe(true);
    expect(storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).toBe(JSON.stringify([RENDER_ID]));
    expect(storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).not.toMatch(
      /subtitle|request|path|playback|token|private/i,
    );
    await expect(startup).resolves.toEqual({
      recovered: 0,
      discarded: 0,
      unavailable: true,
    });
    expect(storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).toBe(JSON.stringify([RENDER_ID]));
  });

  test('lists native jobs, refreshes candidates with job_get, and uses typed feature adapters', async () => {
    const snapshots = [
      job({ id: RENDER_ID, kind: 'renderVideo' }),
      job({ id: SPEECH_ID, kind: 'synthesizeNarration', state: 'interrupted' }),
      job({ id: ALIGNMENT_ID, kind: 'alignNarration', state: 'succeeded' }),
      job({ id: OTHER_ID, kind: 'transcribe' }),
    ];
    const storage = new MemoryStorage({
      [NATIVE_JOB_IDS_STORAGE_KEY]: JSON.stringify([SPEECH_ID, ALIGNMENT_ID, OTHER_ID]),
    });
    const adapters = {
      renderVideo: vi.fn(async () => ({ job: snapshots[0], result: null })),
      synthesizeNarration: vi.fn(async () => ({
        job: snapshots[1],
        backend: 'gtts',
        results: [],
      })),
      alignNarration: vi.fn(async () => ({
        job: snapshots[2],
        result: { artifact: { artifactId: OTHER_ID } },
      })),
    };
    const { coordinator, invokeCommand } = createHarness({
      jobs: snapshots,
      storage,
      adapters,
    });

    await expect(coordinator.start()).resolves.toEqual({
      recovered: 3,
      discarded: 1,
      unavailable: false,
    });
    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'jobs_list', {});
    expect(invokeCommand.mock.calls.slice(1).map((call) => call[0]))
      .toEqual(['job_get', 'job_get', 'job_get']);
    expect(adapters.renderVideo).toHaveBeenCalledWith(RENDER_ID);
    expect(adapters.synthesizeNarration).toHaveBeenCalledWith(SPEECH_ID);
    expect(adapters.alignNarration).toHaveBeenCalledWith(ALIGNMENT_ID);
    expect(coordinator.list().map(({ job: snapshot }) => snapshot.id).sort())
      .toEqual([ALIGNMENT_ID, RENDER_ID, SPEECH_ID].sort());
    expect(JSON.parse(storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).sort())
      .toEqual([ALIGNMENT_ID, RENDER_ID, SPEECH_ID].sort());
  });

  test('ignores unremembered interrupted history instead of resurrecting stale work', async () => {
    const interrupted = job({ id: SPEECH_ID, kind: 'synthesizeNarration', state: 'interrupted' });
    const adapter = vi.fn();
    const { coordinator, invokeCommand } = createHarness({
      jobs: [interrupted],
      adapters: { synthesizeNarration: adapter },
    });

    await expect(coordinator.start()).resolves.toEqual({
      recovered: 0,
      discarded: 0,
      unavailable: false,
    });
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    expect(adapter).not.toHaveBeenCalled();
    expect(coordinator.list()).toEqual([]);
  });

  test('lazily resolves a remembered job omitted from the bounded host list', async () => {
    const interrupted = job({ id: SPEECH_ID, kind: 'synthesizeNarration', state: 'interrupted' });
    const storage = new MemoryStorage({
      [NATIVE_JOB_IDS_STORAGE_KEY]: JSON.stringify([SPEECH_ID]),
    });
    const adapter = vi.fn(async () => ({
      job: interrupted,
      backend: 'gtts',
      results: [],
    }));
    const { coordinator, invokeCommand } = createHarness({
      jobs: [],
      knownJobs: [interrupted],
      storage,
      adapters: { synthesizeNarration: adapter },
    });

    await expect(coordinator.start()).resolves.toEqual({
      recovered: 1,
      discarded: 0,
      unavailable: false,
    });
    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'jobs_list', {});
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'job_get', { id: SPEECH_ID });
    expect(adapter).toHaveBeenCalledWith(SPEECH_ID);
    expect(coordinator.list('synthesizeNarration')).toHaveLength(1);
  });

  test('fails closed on hostile lists, duplicate IDs, impossible states, and adapter identity swaps', async () => {
    const malformedLists = [
      {},
      Array.from({ length: 513 }, () => job({
        id: createUuidV7(),
        kind: 'renderVideo',
      })),
      [job({ id: RENDER_ID, kind: 'renderVideo' }), job({ id: RENDER_ID, kind: 'renderVideo' })],
      [{ ...job({ id: RENDER_ID, kind: 'renderVideo' }), privatePath: 'C:\\private' }],
      [job({ id: RENDER_ID, kind: 'renderVideo', state: 'queued', basisPoints: 1, sequence: 0 })],
    ];
    for (const jobs of malformedLists) {
      const invokeCommand = vi.fn().mockResolvedValue(jobs);
      const adapter = vi.fn();
      const coordinator = createNativeJobRecoveryCoordinator({
        invokeCommand,
        isNativeRuntime: () => true,
        adapters: { renderVideo: adapter },
        storage: new MemoryStorage(),
        pendingResults: vi.fn().mockResolvedValue([]),
      });
      await expect(coordinator.start()).resolves.toMatchObject({ unavailable: true });
      expect(adapter).not.toHaveBeenCalled();
    }

    const current = job({ id: RENDER_ID, kind: 'renderVideo' });
    const swapped = job({ id: OTHER_ID, kind: 'renderVideo' });
    const storage = new MemoryStorage({
      [NATIVE_JOB_IDS_STORAGE_KEY]: JSON.stringify([RENDER_ID]),
    });
    const { coordinator } = createHarness({
      jobs: [current],
      storage,
      adapters: { renderVideo: vi.fn(async () => ({ job: swapped, result: null })) },
    });
    await expect(coordinator.start()).resolves.toEqual({
      recovered: 0,
      discarded: 1,
      unavailable: false,
    });
    expect(coordinator.list()).toEqual([]);
    expect(storage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).toBeNull();
  });

  test('claim transfers a playback capability while discard releases an unclaimed one', async () => {
    const render = job({ id: RENDER_ID, kind: 'renderVideo', state: 'succeeded' });
    const playbackId = '9f20900b-8b1a-4e01-9173-b413fb31d1e8';
    const response = { job: render, result: { playback: { id: playbackId } } };
    const firstStorage = new MemoryStorage({
      [NATIVE_JOB_IDS_STORAGE_KEY]: JSON.stringify([RENDER_ID]),
    });
    const first = createHarness({
      jobs: [render],
      storage: firstStorage,
      adapters: { renderVideo: vi.fn(async () => response) },
    });
    await first.coordinator.start();
    expect(first.coordinator.claim(RENDER_ID)?.value).toBe(response);
    expect(first.releaseRenderPlayback).not.toHaveBeenCalled();
    expect(firstStorage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).toBeNull();

    const secondStorage = new MemoryStorage({
      [NATIVE_JOB_IDS_STORAGE_KEY]: JSON.stringify([RENDER_ID]),
    });
    const second = createHarness({
      jobs: [render],
      storage: secondStorage,
      adapters: { renderVideo: vi.fn(async () => response) },
    });
    await second.coordinator.start();
    expect(second.coordinator.discard(RENDER_ID)).toBe(true);
    expect(second.releaseRenderPlayback).toHaveBeenCalledWith(playbackId);
    expect(secondStorage.getItem(NATIVE_JOB_IDS_STORAGE_KEY)).toBeNull();
  });
});
