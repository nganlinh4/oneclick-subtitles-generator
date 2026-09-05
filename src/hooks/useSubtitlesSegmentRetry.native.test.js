import { act, renderHook, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  processGeminiSegment: vi.fn(),
  checkpointBeforeUpdate: vi.fn(),
  captureDurableSubtitleSegmentRevision: vi.fn(),
  commitDurableSubtitleSegmentCheckpoint: vi.fn(),
  captureContext: vi.fn(),
  assertCurrent: vi.fn(),
  assertDurable: vi.fn(),
  finishContext: vi.fn(),
  acquireLease: vi.fn(),
  releaseLease: vi.fn(),
  current: true,
  projectId: 'project-a',
  receipts: new WeakSet(),
  durableRows: [],
}));

vi.mock('../services/engines/GeminiAdapter', () => ({
  processGeminiSegment: mocks.processGeminiSegment,
}));
vi.mock('../services/lifecycleOrchestrator', () => ({
  checkpointBeforeUpdate: mocks.checkpointBeforeUpdate,
}));
vi.mock('../platform/projectService', async (importOriginal) => ({
  ...(await importOriginal()),
  loadProject: vi.fn(async (projectId) => ({
    metadata: { id: projectId },
    stateVersion: 9,
  })),
}));
vi.mock('../services/subtitleCache', () => ({
  captureDurableSubtitleSegmentRevision: mocks.captureDurableSubtitleSegmentRevision,
  commitDurableSubtitleSegmentCheckpoint: mocks.commitDurableSubtitleSegmentCheckpoint,
  isDurableSubtitleCheckpointReceipt: (value, context) => (
    mocks.receipts.has(value)
    && value.runId === context.runId
    && value.cacheId === context.cacheId
    && value.projectId === context.projectId
  ),
}));
vi.mock('../utils/subtitleOperationOwnership', () => {
  class OwnershipError extends Error {
    constructor(code = 'subtitleOperationOwnershipLost') {
      super(code);
      this.name = 'SubtitleOperationOwnershipError';
      this.code = code;
    }
  }
  const validate = (context, { allowAborted = false } = {}) => {
    if (!allowAborted && context.signal.aborted) {
      throw new OwnershipError('subtitleOperationAborted');
    }
    if (!mocks.current || mocks.projectId !== context.projectId) throw new OwnershipError();
    return context;
  };
  return {
    SubtitleOperationOwnershipError: OwnershipError,
    captureSubtitleOperationContext: mocks.captureContext,
    assertSubtitleOperationCurrent: mocks.assertCurrent,
    assertSubtitleOperationDurable: mocks.assertDurable,
    isSubtitleOperationCurrent: (context, options) => {
      try {
        validate(context, options);
        return true;
      } catch {
        return false;
      }
    },
    finishSubtitleOperationContext: mocks.finishContext,
    acquireSubtitleProjectOperationLease: mocks.acquireLease,
    releaseSubtitleProjectOperationLease: mocks.releaseLease,
    isSubtitleOperationCancellation: (error, signal) => (
      signal?.aborted === true || error?.name === 'AbortError'
      || error?.code === 'subtitleOperationAborted'
    ),
    abortableSubtitleOperationDelay: (milliseconds, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  };
});

import { EVENTS } from '../events/bus';
import { processGeminiSegment } from '../services/engines/GeminiAdapter';
import {
  captureDurableSubtitleSegmentRevision,
  commitDurableSubtitleSegmentCheckpoint,
} from '../services/subtitleCache';
import { checkpointBeforeUpdate } from '../services/lifecycleOrchestrator';
import {
  resolveCachedRetrySource,
  useSubtitlesSegmentRetry,
} from './useSubtitlesSegmentRetry';

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAYBACK_URL = `http://127.0.0.1:49152/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`;
const media = Object.freeze({
  __nativeMedia: true,
  assetId: ASSET_ID,
  playbackId: PLAYBACK_ID,
  name: 'source.mp4',
  type: 'video/mp4',
  size: 4_096,
  lastModified: 0,
  playbackUrl: PLAYBACK_URL,
});

const issueReceipt = (context, subtitles) => {
  const receipt = Object.freeze({
    kind: 'durable-subtitle-checkpoint',
    runId: context.runId,
    cacheId: context.cacheId,
    projectId: context.projectId,
    subtitleCount: subtitles.length,
    subtitles,
  });
  mocks.receipts.add(receipt);
  return receipt;
};

const createHarness = ({
  initialSubtitles = [
    { start: 0, end: 2, text: 'before' },
    { start: 5, end: 6, text: 'old' },
    { start: 9, end: 10, text: 'after' },
  ],
  source = media,
} = {}) => {
  let subtitles = initialSubtitles;
  mocks.durableRows = initialSubtitles.map((row) => ({ ...row }));
  const setSubtitlesData = vi.fn((value) => {
    subtitles = typeof value === 'function' ? value(subtitles) : value;
  });
  const setStatus = vi.fn();
  const setIsGenerating = vi.fn();
  let retrying = [];
  const setRetryingSegments = vi.fn((value) => {
    retrying = typeof value === 'function' ? value(retrying) : value;
  });
  const currentSourceFileRef = { current: source };
  const currentRetryFromCacheRef = { current: null };
  const hook = renderHook(() => useSubtitlesSegmentRetry({
    t: (_key, fallback) => fallback,
    debugLog: vi.fn(),
    setSubtitlesData,
    setStatus,
    setIsGenerating,
    setRetryingSegments,
    currentSourceFileRef,
    currentRetryFromCacheRef,
  }));
  return {
    ...hook,
    getSubtitles: () => subtitles,
    setExternalSubtitles: (value) => { subtitles = value; },
    setSubtitlesData,
    setStatus,
    setIsGenerating,
    setRetryingSegments,
    currentSourceFileRef,
    currentRetryFromCacheRef,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  mocks.current = true;
  mocks.projectId = 'project-a';
  mocks.receipts = new WeakSet();
  mocks.captureContext.mockImplementation(async ({ runId, segment, controller }) => ({
    kind: 'subtitle-operation-context',
    runId,
    cacheId: 'cache-a',
    projectId: mocks.projectId,
    sourceIdentity: `asset:${ASSET_ID}`,
    assetId: ASSET_ID,
    segment,
    signal: controller.signal,
  }));
  mocks.assertCurrent.mockImplementation((context, options) => {
    if (!options?.allowAborted && context.signal.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    if (!mocks.current || mocks.projectId !== context.projectId) throw new Error('ownership lost');
    return context;
  });
  mocks.assertDurable.mockImplementation(async (context, options) => (
    mocks.assertCurrent(context, options)
  ));
  mocks.acquireLease.mockImplementation(async (context) => ({
    kind: 'subtitle-project-operation-lease',
    runId: context.runId,
    projectId: context.projectId,
  }));
  mocks.releaseLease.mockReturnValue(true);
  checkpointBeforeUpdate.mockResolvedValue(undefined);
  captureDurableSubtitleSegmentRevision.mockResolvedValue(Object.freeze({
    kind: 'subtitle-segment-revision',
  }));
  commitDurableSubtitleSegmentCheckpoint.mockImplementation(async ({
    context,
    replacement,
    validateOwnership,
  }) => {
    await validateOwnership(context);
    await validateOwnership(context);
    const subtitles = [
      ...mocks.durableRows.filter((row) => row.end <= context.segment.start),
      ...replacement,
      ...mocks.durableRows.filter((row) => row.start >= context.segment.end),
    ];
    mocks.durableRows = subtitles;
    return issueReceipt(context, subtitles);
  });
});

test('reopens the selected opaque native media for cached retry without WebView fetch', async () => {
  const fetchMedia = vi.fn(() => {
    throw new Error('WebView fetch must remain unreachable');
  });
  const selectedMedia = vi.fn(async () => media);

  await expect(resolveCachedRetrySource(null, PLAYBACK_URL, {
    nativeRuntime: () => true,
    selectedMedia,
    fetchMedia,
    expectedAssetId: ASSET_ID,
  })).resolves.toEqual({ sourceFile: media, usesOriginalMedia: true });
  expect(selectedMedia).toHaveBeenCalledTimes(1);
  expect(fetchMedia).not.toHaveBeenCalled();
});

test('replaces a stale browser source with the selected native descriptor', async () => {
  const fetchMedia = vi.fn();
  const selectedMedia = vi.fn(async () => media);

  await expect(resolveCachedRetrySource(new File(['stale'], 'stale.mp4'), PLAYBACK_URL, {
    nativeRuntime: () => true,
    selectedMedia,
    fetchMedia,
    expectedAssetId: ASSET_ID,
  })).resolves.toEqual({ sourceFile: media, usesOriginalMedia: true });
  expect(selectedMedia).toHaveBeenCalledTimes(1);
  expect(fetchMedia).not.toHaveBeenCalled();
});

test('reopens the exact active native asset for a URL project instead of trusting its stale source ref', async () => {
  const stale = Object.freeze({ ...media, assetId: '01890f39-7b62-7c4e-8c9a-000000000999' });
  const selectedMedia = vi.fn(async () => media);

  await expect(resolveCachedRetrySource(stale, PLAYBACK_URL, {
    nativeRuntime: () => true,
    selectedMedia,
    fetchMedia: vi.fn(),
    expectedAssetId: ASSET_ID,
  })).resolves.toEqual({ sourceFile: media, usesOriginalMedia: true });
  expect(selectedMedia).toHaveBeenCalledTimes(1);
});

test('rejects a native capability in browser fallback before any network request', async () => {
  const fetchMedia = vi.fn();
  await expect(resolveCachedRetrySource(null, PLAYBACK_URL, {
    nativeRuntime: () => false,
    fetchMedia,
  })).rejects.toThrow('cannot be fetched');
  expect(fetchMedia).not.toHaveBeenCalled();
});

test('keeps the browser cached-clip fallback and forwards operation cancellation', async () => {
  const blob = new Blob(['clip'], { type: 'video/mp4' });
  const fetchMedia = vi.fn(async () => ({ ok: true, blob: async () => blob }));
  const controller = new AbortController();

  const resolved = await resolveCachedRetrySource(null, 'blob:cached-segment', {
    nativeRuntime: () => false,
    fetchMedia,
    signal: controller.signal,
  });

  expect(fetchMedia).toHaveBeenCalledWith('blob:cached-segment', { signal: controller.signal });
  expect(resolved.usesOriginalMedia).toBe(false);
  expect(resolved.sourceFile).toBeInstanceOf(File);
});

test('direct retry streams, forwards every option and succeeds only after one branded durable save', async () => {
  processGeminiSegment.mockImplementation(async (_source, _segment, _options, hooks) => {
    hooks.onStreamingUpdate([{ start: 5, end: 6, text: 'partial' }], true);
    return [{ start: 5, end: 7, text: 'replacement' }];
  });
  const harness = createHarness();
  let succeeded;

  await act(async () => {
    succeeded = await harness.result.current.retrySegment(0, [{ start: 5, end: 8, status: 'error' }], {
      modelId: 'gemini-3.7-flash',
      userProvidedSubtitles: 'Exact words',
      autoSplitSubtitles: true,
      maxWordsPerSubtitle: 4,
      maxDurationPerRequest: 90,
      inlineExtraction: true,
    });
  });

  expect(succeeded).toBe(true);
  expect(checkpointBeforeUpdate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    source: 'segment-processing-start',
    segment: { start: 5, end: 8 },
    signal: expect.any(AbortSignal),
  }));
  expect(processGeminiSegment).toHaveBeenCalledTimes(1);
  expect(processGeminiSegment.mock.calls[0][0]).toBe(media);
  expect(processGeminiSegment.mock.calls[0][2]).toEqual(expect.objectContaining({
    model: 'gemini-3.7-flash',
    userProvidedSubtitles: 'Exact words',
    autoSplitSubtitles: true,
    maxWordsPerSubtitle: 4,
    maxDurationPerRequest: 90,
    forceInline: true,
    signal: expect.any(AbortSignal),
    projectId: 'project-a',
    expectedProjectStateVersion: 9,
  }));
  expect(commitDurableSubtitleSegmentCheckpoint).toHaveBeenCalledTimes(1);
  expect(harness.getSubtitles()).toEqual([
    { start: 0, end: 2, text: 'before' },
    { start: 5, end: 7, text: 'replacement' },
    { start: 9, end: 10, text: 'after' },
  ]);
  expect(harness.setStatus).toHaveBeenLastCalledWith({
    message: 'Subtitles updated successfully!',
    type: 'success',
  });
});

test('a queued different segment keeps the shared retry UI owned until the queue drains', async () => {
  let releaseSecondLease;
  let leaseCall = 0;
  mocks.acquireLease.mockImplementation(async (context) => {
    leaseCall += 1;
    if (leaseCall === 2) {
      await new Promise((resolve) => { releaseSecondLease = resolve; });
    }
    return {
      kind: 'subtitle-project-operation-lease',
      runId: context.runId,
      projectId: context.projectId,
    };
  });
  let resolveFirstAttempt;
  processGeminiSegment
    .mockReturnValueOnce(new Promise((resolve) => { resolveFirstAttempt = resolve; }))
    .mockResolvedValueOnce([{ start: 9, end: 11, text: 'second replacement' }]);
  const harness = createHarness();
  const segments = [
    { start: 5, end: 8 },
    { start: 9, end: 12 },
  ];

  let first;
  let second;
  await act(async () => {
    first = harness.result.current.retrySegment(0, segments);
    await waitFor(() => expect(processGeminiSegment).toHaveBeenCalledTimes(1));
    second = harness.result.current.retrySegment(1, segments);
    await waitFor(() => expect(mocks.acquireLease).toHaveBeenCalledTimes(2));
  });
  harness.setIsGenerating.mockClear();

  await act(async () => {
    resolveFirstAttempt([{ start: 5, end: 7, text: 'first replacement' }]);
    await first;
  });
  expect(harness.setIsGenerating).not.toHaveBeenCalledWith(false);
  expect(processGeminiSegment).toHaveBeenCalledTimes(1);

  await act(async () => {
    releaseSecondLease();
    await second;
  });
  expect(processGeminiSegment).toHaveBeenCalledTimes(2);
  expect(harness.setIsGenerating).toHaveBeenLastCalledWith(false);
});

test('discards an A to B switch during streaming without saving or mutating B', async () => {
  processGeminiSegment.mockImplementation(async (_source, _segment, _options, hooks) => {
    hooks.onStreamingUpdate([{ start: 5, end: 6, text: 'stale partial' }], true);
    mocks.current = false;
    return [{ start: 5, end: 7, text: 'stale final' }];
  });
  const harness = createHarness();

  let succeeded;
  await act(async () => {
    succeeded = await harness.result.current.retrySegment(0, [{ start: 5, end: 8 }]);
  });

  expect(succeeded).toBe(false);
  expect(commitDurableSubtitleSegmentCheckpoint).not.toHaveBeenCalled();
  expect(harness.getSubtitles()).toEqual([
    { start: 0, end: 2, text: 'before' },
    { start: 5, end: 6, text: 'old' },
    { start: 9, end: 10, text: 'after' },
  ]);
});

test('discards an A to B switch while a cached clip fetch is pending', async () => {
  let releaseFetch;
  const fetchMedia = vi.fn(() => new Promise((resolve) => {
    releaseFetch = resolve;
  }));
  vi.stubGlobal('fetch', fetchMedia);
  const harness = createHarness({ source: null });
  let terminal;

  await act(async () => {
    terminal = harness.result.current.retrySegment(0, [{
      start: 5,
      end: 8,
      url: 'https://example.test/cached-segment.mp4',
    }]);
    await waitFor(() => expect(fetchMedia).toHaveBeenCalledTimes(1));
  });
  mocks.current = false;
  releaseFetch({
    ok: true,
    blob: async () => new Blob(['stale'], { type: 'video/mp4' }),
  });
  await expect(terminal).resolves.toBe(false);

  expect(processGeminiSegment).not.toHaveBeenCalled();
  expect(commitDurableSubtitleSegmentCheckpoint).not.toHaveBeenCalled();
  expect(harness.getSubtitles()).toEqual([
    { start: 0, end: 2, text: 'before' },
    { start: 5, end: 6, text: 'old' },
    { start: 9, end: 10, text: 'after' },
  ]);
});

test('revalidates a remapped durable alias immediately before native Gemini starts', async () => {
  const harness = createHarness();
  harness.setStatus.mockImplementation((status) => {
    if (status.message === 'Processing video...') mocks.projectId = 'project-b';
  });

  let succeeded;
  await act(async () => {
    succeeded = await harness.result.current.retrySegment(0, [{ start: 5, end: 8 }]);
  });

  expect(succeeded).toBe(false);
  expect(processGeminiSegment).not.toHaveBeenCalled();
  expect(commitDurableSubtitleSegmentCheckpoint).not.toHaveBeenCalled();
});

test('does not restore A over B when ownership changes during the durable save', async () => {
  processGeminiSegment.mockResolvedValue([{ start: 5, end: 7, text: 'replacement' }]);
  const harness = createHarness();
  const projectB = [{ start: 1, end: 2, text: 'project B' }];
  commitDurableSubtitleSegmentCheckpoint.mockImplementation(async ({ context, validateOwnership }) => {
    await validateOwnership(context);
    harness.setExternalSubtitles(projectB);
    mocks.current = false;
    throw new Error('save failed after project switch');
  });

  let succeeded;
  await act(async () => {
    succeeded = await harness.result.current.retrySegment(0, [{ start: 5, end: 8 }]);
  });

  expect(succeeded).toBe(false);
  expect(commitDurableSubtitleSegmentCheckpoint).toHaveBeenCalledTimes(1);
  expect(harness.getSubtitles()).toBe(projectB);
  expect(harness.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
});

test('a rejected durable commit publishes no success status or completion event', async () => {
  processGeminiSegment.mockResolvedValue([{ start: 5, end: 7, text: 'replacement' }]);
  let rejectCommit;
  commitDurableSubtitleSegmentCheckpoint.mockReturnValue(new Promise((_resolve, reject) => {
    rejectCommit = reject;
  }));
  const harness = createHarness();
  const completions = vi.fn();
  window.addEventListener(EVENTS.STREAMING_COMPLETE, completions);
  let terminal;

  await act(async () => {
    terminal = harness.result.current.retrySegment(0, [{ start: 5, end: 8 }]);
    await waitFor(() => expect(commitDurableSubtitleSegmentCheckpoint).toHaveBeenCalledTimes(1));
  });
  expect(completions).not.toHaveBeenCalled();
  expect(harness.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));

  await act(async () => rejectCommit(new Error('durable write rejected')));
  await expect(terminal).resolves.toBe(false);
  expect(completions).not.toHaveBeenCalled();
  expect(harness.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  window.removeEventListener(EVENTS.STREAMING_COMPLETE, completions);
});

test('preserves a same-project manual edit that races retry progress and commit', async () => {
  const manualEdit = { start: 0, end: 2, text: 'manual edit during retry' };
  const harness = createHarness();
  processGeminiSegment.mockImplementation(async (_source, _segment, _options, hooks) => {
    hooks.onStreamingUpdate([{ start: 5, end: 6, text: 'preview only' }], true);
    harness.setExternalSubtitles([
      manualEdit,
      { start: 5, end: 6, text: 'old' },
      { start: 9, end: 10, text: 'after' },
    ]);
    mocks.durableRows = [
      manualEdit,
      { start: 5, end: 6, text: 'old' },
      { start: 9, end: 10, text: 'after' },
    ];
    return [{ start: 5, end: 7, text: 'replacement' }];
  });

  let succeeded;
  await act(async () => {
    succeeded = await harness.result.current.retrySegment(0, [{ start: 5, end: 8 }]);
  });
  expect(succeeded).toBe(true);
  expect(harness.getSubtitles()).toEqual([
    manualEdit,
    { start: 5, end: 7, text: 'replacement' },
    { start: 9, end: 10, text: 'after' },
  ]);
});

test('unmount immediately after the durable receipt keeps the commit and emits no late UI', async () => {
  processGeminiSegment.mockResolvedValue([{ start: 5, end: 7, text: 'replacement' }]);
  const harness = createHarness();
  const completions = vi.fn();
  let statusCallsAtReceipt = null;
  window.addEventListener(EVENTS.STREAMING_COMPLETE, completions);
  commitDurableSubtitleSegmentCheckpoint.mockImplementation(async ({
    context,
    replacement,
  }) => {
    const committed = [
      { start: 0, end: 2, text: 'before' },
      ...replacement,
      { start: 9, end: 10, text: 'after' },
    ];
    mocks.durableRows = committed;
    const receipt = issueReceipt(context, committed);
    statusCallsAtReceipt = harness.setStatus.mock.calls.length;
    harness.unmount();
    return receipt;
  });
  await expect(harness.result.current.retrySegment(0, [{ start: 5, end: 8 }]))
    .resolves.toBe(true);
  expect(mocks.durableRows).toEqual([
    { start: 0, end: 2, text: 'before' },
    { start: 5, end: 7, text: 'replacement' },
    { start: 9, end: 10, text: 'after' },
  ]);
  expect(completions).not.toHaveBeenCalled();
  expect(harness.setStatus).toHaveBeenCalledTimes(statusCallsAtReceipt);
  expect(harness.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  window.removeEventListener(EVENTS.STREAMING_COMPLETE, completions);
});

test.each([
  [[], 'empty'],
  [[{ start: 5, end: 6, text: '' }], 'malformed'],
])('treats %s Gemini output as failure and restores the snapshot', async (output) => {
  processGeminiSegment.mockImplementation(async (_source, _segment, _options, hooks) => {
    hooks.onStreamingUpdate([{ start: 5, end: 6, text: 'partial' }], true);
    return output;
  });
  const harness = createHarness();

  let succeeded;
  await act(async () => {
    succeeded = await harness.result.current.retrySegment(0, [{ start: 5, end: 8 }]);
  });

  expect(succeeded).toBe(false);
  expect(commitDurableSubtitleSegmentCheckpoint).not.toHaveBeenCalled();
  expect(harness.getSubtitles()).toEqual([
    { start: 0, end: 2, text: 'before' },
    { start: 5, end: 6, text: 'old' },
    { start: 9, end: 10, text: 'after' },
  ]);
});

test('Stop aborts the owned native request and unmount publishes no later UI state', async () => {
  let nativeSignal;
  processGeminiSegment.mockImplementation(async (_source, _segment, options) => {
    nativeSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  });
  const harness = createHarness();
  let terminal;
  await act(async () => {
    terminal = harness.result.current.retrySegment(0, [{ start: 5, end: 8 }]);
    await waitFor(() => expect(processGeminiSegment).toHaveBeenCalledTimes(1));
  });
  const statusCallsBeforeUnmount = harness.setStatus.mock.calls.length;

  harness.unmount();
  await expect(terminal).resolves.toBe(false);

  expect(nativeSignal.aborted).toBe(true);
  expect(harness.setStatus).toHaveBeenCalledTimes(statusCallsBeforeUnmount);
  expect(commitDurableSubtitleSegmentCheckpoint).not.toHaveBeenCalled();
});

test('Stop aborts a pending pre-retry checkpoint before Gemini can start', async () => {
  let checkpointSignal;
  checkpointBeforeUpdate.mockImplementation(({ signal }) => {
    checkpointSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('checkpoint aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  });
  const harness = createHarness();
  let terminal;
  await act(async () => {
    terminal = harness.result.current.retrySegment(0, [{ start: 5, end: 8 }]);
    await waitFor(() => expect(checkpointBeforeUpdate).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new CustomEvent(EVENTS.GEMINI_REQUESTS_ABORTED));
  });

  await expect(terminal).resolves.toBe(false);
  expect(checkpointSignal.aborted).toBe(true);
  expect(processGeminiSegment).not.toHaveBeenCalled();
  expect(commitDurableSubtitleSegmentCheckpoint).not.toHaveBeenCalled();
});

test('Stop cancels a cached retry backoff without starting another native attempt', async () => {
  processGeminiSegment.mockRejectedValue(new Error('503 overloaded'));
  const harness = createHarness();
  const completions = [];
  const completionHandler = (event) => completions.push(event.detail);
  window.addEventListener(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, completionHandler);

  act(() => {
    window.dispatchEvent(new CustomEvent(EVENTS.RETRY_SEGMENT_FROM_CACHE, {
      detail: { start: 5, end: 8, url: 'blob:cached-segment' },
    }));
  });
  await waitFor(() => expect(harness.setStatus).toHaveBeenCalledWith(expect.objectContaining({
    message: 'Retrying in {{n}}s...',
  })));
  act(() => {
    window.dispatchEvent(new CustomEvent(EVENTS.GEMINI_REQUESTS_ABORTED));
  });
  await waitFor(() => expect(completions).toEqual([
    expect.objectContaining({
      start: 5,
      end: 8,
      success: false,
      error: 'segmentRetryFailed',
    }),
  ]));

  expect(processGeminiSegment).toHaveBeenCalledTimes(1);
  window.removeEventListener(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, completionHandler);
  harness.unmount();
});

test('cached retry checkpoints first, commits exactly once, and emits success only after its receipt', async () => {
  localStorage.setItem('video_processing_audio_only', 'true');
  localStorage.setItem('gemini_model', 'gemini-3.1-flash-lite');
  checkpointBeforeUpdate.mockImplementation(async () => {
    // A settings edit while preparation is suspended must not rewrite this request.
    localStorage.setItem('video_processing_audio_only', 'false');
    localStorage.setItem('gemini_model', 'gemini-3.8-flash');
  });
  processGeminiSegment.mockResolvedValue([{ start: 5, end: 7, text: 'replacement' }]);
  let releaseSave;
  commitDurableSubtitleSegmentCheckpoint.mockImplementation(({ context, replacement, validateOwnership }) => (
    new Promise((resolve, reject) => {
      releaseSave = async () => {
        try {
          await validateOwnership(context);
          resolve(issueReceipt(context, [
            ...mocks.durableRows.filter((row) => row.end <= context.segment.start),
            ...replacement,
            ...mocks.durableRows.filter((row) => row.start >= context.segment.end),
          ]));
        } catch (error) {
          reject(error);
        }
      };
    })
  ));
  const harness = createHarness();
  const completions = [];
  const completionHandler = (event) => completions.push(event.detail);
  window.addEventListener(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, completionHandler);

  act(() => {
    window.dispatchEvent(new CustomEvent(EVENTS.RETRY_SEGMENT_FROM_CACHE, {
      detail: { start: 5, end: 8, url: 'blob:cached-segment' },
    }));
  });
  await waitFor(() => expect(commitDurableSubtitleSegmentCheckpoint).toHaveBeenCalledTimes(1));
  expect(checkpointBeforeUpdate).toHaveBeenCalledTimes(1);
  expect(checkpointBeforeUpdate).toHaveBeenCalledBefore(processGeminiSegment);
  expect(processGeminiSegment.mock.calls[0][2]).toMatchObject({
    audioOnly: true,
    model: 'gemini-3.1-flash-lite',
  });
  expect(completions).toEqual([]);

  await act(async () => releaseSave());
  await waitFor(() => expect(completions).toEqual([
    expect.objectContaining({ start: 5, end: 8, success: true }),
  ]));
  expect(commitDurableSubtitleSegmentCheckpoint).toHaveBeenCalledTimes(1);
  window.removeEventListener(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, completionHandler);
  harness.unmount();
});

test('cached persistence failure restores A and emits one fixed false completion', async () => {
  processGeminiSegment.mockImplementation(async (_source, _segment, _options, hooks) => {
    hooks.onStreamingUpdate([{ start: 5, end: 6, text: 'partial' }], true);
    return [{ start: 5, end: 7, text: 'replacement' }];
  });
  commitDurableSubtitleSegmentCheckpoint.mockRejectedValue(new Error('disk details must not leak'));
  const harness = createHarness();
  const completions = [];
  const completionHandler = (event) => completions.push(event.detail);
  window.addEventListener(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, completionHandler);

  act(() => {
    window.dispatchEvent(new CustomEvent(EVENTS.RETRY_SEGMENT_FROM_CACHE, {
      detail: { start: 5, end: 8, url: 'blob:cached-segment' },
    }));
  });
  await waitFor(() => expect(completions).toHaveLength(1));

  expect(completions).toEqual([
    expect.objectContaining({
      start: 5,
      end: 8,
      success: false,
      error: 'segmentRetryFailed',
    }),
  ]);
  expect(harness.getSubtitles()).toEqual([
    { start: 0, end: 2, text: 'before' },
    { start: 5, end: 6, text: 'old' },
    { start: 9, end: 10, text: 'after' },
  ]);
  window.removeEventListener(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, completionHandler);
  harness.unmount();
});
