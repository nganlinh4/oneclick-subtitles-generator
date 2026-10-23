// jobRecoveryCoordinator: retained Gemini/ASR result deliveries, bounded paging and restart rediscovery.

import { v7 as createUuidV7 } from 'uuid';
import { NATIVE_JOB_IDS_STORAGE_KEY } from './jobRecoveryCoordinator';
import {
  SPEECH_ID,
  OTHER_ID,
  PROJECT_A,
  MemoryStorage,
  job,
  createHarness,
} from './jobRecoveryCoordinatorTestHarness';

describe('native durable-job startup recovery', () => {
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

});
