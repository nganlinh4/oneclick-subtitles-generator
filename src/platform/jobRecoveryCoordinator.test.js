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
} = {}) => {
  const byId = new Map(knownJobs.map((snapshot) => [snapshot.id, snapshot]));
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
    releaseRenderPlayback,
    storage,
  });
  return { coordinator, invokeCommand, releaseRenderPlayback, storage };
};

describe('native durable-job startup recovery', () => {
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
      .toEqual(['job_get', 'job_get', 'job_get', 'job_get']);
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
