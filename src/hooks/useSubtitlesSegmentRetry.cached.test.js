// Cached-clip segment retry (RETRY_SEGMENT_FROM_CACHE): backoff, checkpoint order and completion events.
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
  mocks,
  resetSegmentRetryMocks,
} from './useSubtitlesSegmentRetryTestFixtures';

const createHarness = (options) => createSegmentRetryHarness(useSubtitlesSegmentRetry, options);

beforeEach(resetSegmentRetryMocks);

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
