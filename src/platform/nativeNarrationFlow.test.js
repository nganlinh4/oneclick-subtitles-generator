import { nativeNarrationAdapter } from './nativeNarrationAdapter';
import {
  discardRecoveredNativeJob,
  forgetNativeJobId,
  listRecoveredNativeJobs,
  rememberNativeJobId,
  startNativeJobRecovery,
} from './jobRecoveryCoordinator';
import {
  cancelNativeNarrationJob,
  restorePersistedNativeNarration,
  runNativeNarrationJob,
} from './nativeNarrationFlow';

vi.mock('./nativeNarrationAdapter', () => ({
  nativeNarrationAdapter: {
    generate: vi.fn(),
    cancel: vi.fn(),
    restore: vi.fn(),
  },
}));

vi.mock('./jobRecoveryCoordinator', () => ({
  discardRecoveredNativeJob: vi.fn(),
  forgetNativeJobId: vi.fn(),
  listRecoveredNativeJobs: vi.fn(),
  rememberNativeJobId: vi.fn(),
  startNativeJobRecovery: vi.fn(),
}));

const JOB_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a1';

const request = () => ({
  method: 'gemini',
  subtitles: [{ id: 1, text: 'hello' }],
  settings: {
    credentialId: 'opaque-credential',
    apiKey: 'must-never-persist',
  },
});

describe('native narration flow ownership', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    startNativeJobRecovery.mockResolvedValue({ recovered: 0 });
    listRecoveredNativeJobs.mockReturnValue([]);
    rememberNativeJobId.mockReturnValue(true);
    forgetNativeJobId.mockReturnValue(true);
    discardRecoveredNativeJob.mockReturnValue(true);
  });

  test('rejects a competing start and keeps cancellation attached to the active job', async () => {
    let handlers;
    nativeNarrationAdapter.generate.mockImplementation(async (_request, callbacks) => {
      handlers = callbacks;
      return { job: { id: JOB_ID }, initialResults: [] };
    });
    nativeNarrationAdapter.cancel.mockResolvedValue({ id: JOB_ID, state: 'cancelling' });

    const active = runNativeNarrationJob(request());
    await Promise.resolve();
    await Promise.resolve();

    await expect(runNativeNarrationJob(request())).rejects.toMatchObject({
      code: 'nativeNarrationBusy',
    });
    await expect(cancelNativeNarrationJob('gemini')).resolves.toBe(true);
    expect(nativeNarrationAdapter.cancel).toHaveBeenCalledWith(JOB_ID);
    expect(rememberNativeJobId).toHaveBeenCalledWith(JOB_ID);
    expect(localStorage.length).toBe(0);

    handlers.onCancelled([]);
    await expect(active).resolves.toMatchObject({ status: 'cancelled', jobId: JOB_ID });
    expect(forgetNativeJobId).toHaveBeenCalledWith(JOB_ID);
  });

  test('fails closed when the worker dies and releases the active slot', async () => {
    nativeNarrationAdapter.generate.mockImplementation(async (_request, handlers) => {
      queueMicrotask(() => handlers.onError({ code: 'workerDied', results: [] }));
      return { job: { id: JOB_ID }, initialResults: [] };
    });
    await expect(runNativeNarrationJob(request())).rejects.toMatchObject({
      code: 'workerDied',
      results: [],
    });
    await expect(cancelNativeNarrationJob('gemini')).resolves.toBe(false);
  });

  test('reconnects an opaque recovered ID against the current in-memory subtitle plan', async () => {
    listRecoveredNativeJobs.mockReturnValue([{ job: { id: JOB_ID } }]);
    nativeNarrationAdapter.restore.mockResolvedValue({
      job: { id: JOB_ID, state: 'succeeded' },
      results: [{ subtitle_id: 7, success: false, pending: false }],
    });

    await expect(restorePersistedNativeNarration({
      method: 'gtts',
      subtitles: [{ id: 7, text: 'restored' }],
    })).resolves.toMatchObject({
      method: 'gtts',
      subtitles: [{ id: 7, text: 'restored' }],
      job: { id: JOB_ID, state: 'succeeded' },
    });
    expect(nativeNarrationAdapter.restore).toHaveBeenCalledWith({
      jobId: JOB_ID,
      method: 'gtts',
      subtitles: [{ id: 7, text: 'restored' }],
    });
    expect(discardRecoveredNativeJob).toHaveBeenCalledWith(JOB_ID);
    expect(localStorage.length).toBe(0);
  });

  test('keeps a reloaded running job exclusive until its durable terminal manifest is ready', async () => {
    listRecoveredNativeJobs.mockReturnValue([{ job: { id: JOB_ID } }]);
    nativeNarrationAdapter.restore
      .mockResolvedValueOnce({
        job: { id: JOB_ID, state: 'running' },
        results: [],
      })
      .mockResolvedValueOnce({
        job: { id: JOB_ID, state: 'succeeded' },
        results: [{ subtitle_id: 7, success: true, pending: false }],
      });

    const restored = restorePersistedNativeNarration({
      method: 'gtts',
      subtitles: [{ id: 7, text: 'restored' }],
      pollIntervalMs: 1,
      timeoutMs: 100,
    });
    await Promise.resolve();
    await expect(runNativeNarrationJob(request())).rejects.toMatchObject({
      code: 'nativeNarrationBusy',
    });
    await expect(restored).resolves.toMatchObject({
      job: { id: JOB_ID, state: 'succeeded' },
      results: [{ subtitle_id: 7, success: true }],
    });
    expect(nativeNarrationAdapter.restore).toHaveBeenCalledTimes(2);
    expect(discardRecoveredNativeJob).toHaveBeenCalledWith(JOB_ID);
    expect(localStorage.length).toBe(0);
  });

  test('never resurrects a legacy localStorage request payload', async () => {
    localStorage.setItem('osg.nativeNarrationJob.v1', JSON.stringify({
      jobId: JOB_ID,
      subtitles: [{ text: 'must not be read' }],
      request: { path: 'C:\\private\\voice.wav' },
    }));
    listRecoveredNativeJobs.mockReturnValue([]);
    const getItem = vi.spyOn(Storage.prototype, 'getItem');

    await expect(restorePersistedNativeNarration({
      method: 'gtts',
      subtitles: [{ id: 7, text: 'current memory only' }],
    })).resolves.toBeNull();

    expect(nativeNarrationAdapter.restore).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
  });
});
