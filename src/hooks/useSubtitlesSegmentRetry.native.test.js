// Direct segment retry: option forwarding, ownership races, durable commit and Stop/unmount.
import { act, waitFor } from '@testing-library/react';

vi.mock('../services/engines/GeminiAdapter', async () => {
  const { mocks } = await import('./useSubtitlesSegmentRetryTestFixtures');
  return { processGeminiSegment: mocks.processGeminiSegment };
});
vi.mock('../services/lifecycleOrchestrator', async () => {
  const { mocks } = await import('./useSubtitlesSegmentRetryTestFixtures');
  return { checkpointBeforeUpdate: mocks.checkpointBeforeUpdate };
});
vi.mock('../platform/projectService', async (importOriginal) => ({
  ...(await importOriginal()),
  loadProject: vi.fn(async (projectId) => ({
    metadata: { id: projectId },
    stateVersion: 9,
  })),
}));
vi.mock('../services/subtitleCache', async () => (
  (await import('./useSubtitlesSegmentRetryTestFixtures')).subtitleCacheMock()
));
vi.mock('../utils/subtitleOperationOwnership', async () => (
  (await import('./useSubtitlesSegmentRetryTestFixtures')).subtitleOperationOwnershipMock()
));

import { EVENTS } from '../events/bus';
import { processGeminiSegment } from '../services/engines/GeminiAdapter';
import { commitDurableSubtitleSegmentCheckpoint } from '../services/subtitleCache';
import { checkpointBeforeUpdate } from '../services/lifecycleOrchestrator';
import { useSubtitlesSegmentRetry } from './useSubtitlesSegmentRetry';
import {
  createSegmentRetryHarness,
  issueReceipt,
  media,
  mocks,
  resetSegmentRetryMocks,
} from './useSubtitlesSegmentRetryTestFixtures';

const createHarness = (options) => createSegmentRetryHarness(useSubtitlesSegmentRetry, options);

beforeEach(resetSegmentRetryMocks);

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
