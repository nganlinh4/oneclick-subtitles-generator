// Shared mocks, media and harness for the useSubtitlesSegmentRetry test files. It imports no
// product module, so vi.mock factories can load it without a cycle through the mocked modules.
import { vi } from 'vitest';
import { renderHook } from '@testing-library/react';

export const mocks = {
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
};

export const subtitleCacheMock = () => ({
  captureDurableSubtitleSegmentRevision: mocks.captureDurableSubtitleSegmentRevision,
  commitDurableSubtitleSegmentCheckpoint: mocks.commitDurableSubtitleSegmentCheckpoint,
  isDurableSubtitleCheckpointReceipt: (value, context) => (
    mocks.receipts.has(value)
    && value.runId === context.runId
    && value.cacheId === context.cacheId
    && value.projectId === context.projectId
  ),
});

export const subtitleOperationOwnershipMock = () => {
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
};

export const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
export const PLAYBACK_URL = `http://127.0.0.1:49152/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`;
export const media = Object.freeze({
  __nativeMedia: true,
  assetId: ASSET_ID,
  playbackId: PLAYBACK_ID,
  name: 'source.mp4',
  type: 'video/mp4',
  size: 4_096,
  lastModified: 0,
  playbackUrl: PLAYBACK_URL,
});

export const issueReceipt = (context, subtitles) => {
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

export const createSegmentRetryHarness = (useSubtitlesSegmentRetry, {
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

export const resetSegmentRetryMocks = () => {
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
  mocks.checkpointBeforeUpdate.mockResolvedValue(undefined);
  mocks.captureDurableSubtitleSegmentRevision.mockResolvedValue(Object.freeze({
    kind: 'subtitle-segment-revision',
  }));
  mocks.commitDurableSubtitleSegmentCheckpoint.mockImplementation(async ({
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
};
