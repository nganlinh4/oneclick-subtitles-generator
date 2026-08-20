import { act, renderHook } from '@testing-library/react';

import { EVENTS } from '../../../events/constants';
import { checkpointBeforeUpdate } from '../../../services/lifecycleOrchestrator';
import {
  analyzeVideoAndWaitForUserChoice,
  commitVideoAnalysisForContext,
} from '../../../utils/videoProcessing/analysisUtils';
import { getVideoDuration } from '../../../utils/durationUtils';
import { getTranscriptionRulesForCache } from '../../../utils/transcriptionRulesStore';
import {
  getUserProvidedSubtitlesForCache,
  subscribeCurrentCacheId,
} from '../../../utils/userSubtitlesStore';
import { showErrorToast } from '../../../utils/toastUtils';
import useAutoGenerateFlow from './useAutoGenerateFlow';

const ownershipWatch = vi.hoisted(() => ({ onLost: null }));

vi.mock('../../../services/lifecycleOrchestrator', () => ({ checkpointBeforeUpdate: vi.fn() }));
vi.mock('../../../utils/videoProcessing/analysisUtils', () => ({
  analyzeVideoAndWaitForUserChoice: vi.fn(),
  commitVideoAnalysisForContext: vi.fn(),
}));
vi.mock('../../../utils/durationUtils', () => ({ getVideoDuration: vi.fn() }));
vi.mock('../../../utils/transcriptionRulesStore', () => ({
  getTranscriptionRulesForCache: vi.fn(),
}));
vi.mock('../../../utils/userSubtitlesStore', () => ({
  getUserProvidedSubtitlesForCache: vi.fn(),
  subscribeCurrentCacheId: vi.fn(() => vi.fn()),
}));
vi.mock('../../../utils/toastUtils', () => ({
  showInfoToast: vi.fn(),
  showErrorToast: vi.fn(),
}));
vi.mock('../../../utils/autoGenerationOwnership', () => ({
  createAutoGenerationRequest: vi.fn(({ runId, signal }) => ({ runId, signal })),
  createAutoGenerationContext: vi.fn((prepared) => prepared.context),
  assertAutoGenerationContextCurrent: vi.fn((context) => {
    if (context.signal.aborted) throw new DOMException('Stopped', 'AbortError');
    if (context.current === false) throw new Error('The active media changed.');
    return context;
  }),
  assertAutoGenerationContextDurable: vi.fn(async (context) => {
    if (context.signal.aborted) throw new DOMException('Stopped', 'AbortError');
    if (context.current === false) throw new Error('The active media changed.');
    return context;
  }),
  subscribeAutoGenerationOwnership: vi.fn((_context, onLost) => {
    ownershipWatch.onLost = onLost;
    return vi.fn();
  }),
  isAutoGenerationCancellation: vi.fn((error, signal) => (
    signal?.aborted || error?.name === 'AbortError'
  )),
  isAutoGenerationCompletion: vi.fn((value, context) => (
    value?.kind === 'auto-generation-completion'
    && value.runId === context.runId
    && value.cacheId === context.cacheId
    && value.projectId === context.projectId
    && ((value.terminal === 'subtitles' && value.subtitleCount > 0)
      || (value.terminal === 'no-speech' && value.subtitleCount === 0))
  )),
}));

const t = (_key, fallback, values) => (
  values?.message ? fallback.replace('{{message}}', values.message) : fallback
);
const media = { assetId: 'asset-1', type: 'video/mp4' };
const preparedFrom = (request, overrides = {}) => ({
  context: {
    runId: request.runId,
    signal: request.signal,
    media,
    cacheId: 'cache-1',
    projectId: 'project-1',
    sourceIdentity: 'asset:asset-1',
    current: true,
    ...overrides,
  },
});
const completionFor = (context, overrides = {}) => ({
  kind: 'auto-generation-completion',
  runId: context.runId,
  cacheId: context.cacheId,
  projectId: context.projectId,
  terminal: 'subtitles',
  subtitleCount: 2,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  ownershipWatch.onLost = null;
  localStorage.clear();
  checkpointBeforeUpdate.mockResolvedValue(undefined);
  getVideoDuration.mockResolvedValue(30);
  getTranscriptionRulesForCache.mockResolvedValue({ terminology: [] });
  getUserProvidedSubtitlesForCache.mockResolvedValue('');
  subscribeCurrentCacheId.mockReturnValue(vi.fn());
  analyzeVideoAndWaitForUserChoice.mockResolvedValue({ analysisResult: {} });
  commitVideoAnalysisForContext.mockResolvedValue(undefined);
});

const renderFlow = ({ prepare, process } = {}) => {
  const handleGenerateSubtitles = prepare ?? vi.fn(async (request) => preparedFrom(request));
  const handleProcessWithOptions = process ?? vi.fn(async (options) => (
    completionFor(options.autoRunContext)
  ));
  const hook = renderHook(() => useAutoGenerateFlow({
    apiKeysSet: { gemini: true },
    t,
    handleGenerateSubtitles,
    handleProcessWithOptions,
  }));
  return { ...hook, handleGenerateSubtitles, handleProcessWithOptions };
};

test('carries authoritative prepared media and exact project receipt through success', async () => {
  const { result, handleGenerateSubtitles, handleProcessWithOptions } = renderFlow();
  let succeeded;
  await act(async () => { succeeded = await result.current.startAutoGenerateFlow(); });

  expect(succeeded).toBe(true);
  const request = handleGenerateSubtitles.mock.calls[0][0];
  expect(checkpointBeforeUpdate).toHaveBeenCalledWith({
    source: 'auto-generation-start',
    runId: request.runId,
    signal: request.signal,
  });
  expect(getVideoDuration).toHaveBeenCalledWith(media);
  expect(handleProcessWithOptions).toHaveBeenCalledWith(expect.objectContaining({
    videoFile: media,
    generationScope: 'full-media',
    autoRunContext: expect.objectContaining({ cacheId: 'cache-1' }),
  }));
  expect(showErrorToast).not.toHaveBeenCalled();
});

test('rejects a boolean or wrong-project completion instead of reporting success', async () => {
  const process = vi.fn().mockResolvedValue(true);
  const { result } = renderFlow({ process });
  await act(async () => {
    await expect(result.current.startAutoGenerateFlow()).resolves.toBe(false);
  });
  expect(showErrorToast).toHaveBeenCalledWith(
    expect.stringContaining('durable result'),
    4_000,
  );
});

test('stops before preparation when the real checkpoint fails', async () => {
  checkpointBeforeUpdate.mockRejectedValue(new Error('checkpoint failed'));
  const prepare = vi.fn();
  const { result } = renderFlow({ prepare });
  await act(async () => {
    await expect(result.current.startAutoGenerateFlow()).resolves.toBe(false);
  });
  expect(prepare).not.toHaveBeenCalled();
});

test('Stop aborts a pending checkpoint promptly before preparation', async () => {
  checkpointBeforeUpdate.mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), {
      once: true,
    });
  }));
  const prepare = vi.fn();
  const { result } = renderFlow({ prepare });
  let flow;
  act(() => { flow = result.current.startAutoGenerateFlow(); });
  await vi.waitFor(() => expect(checkpointBeforeUpdate).toHaveBeenCalled());

  act(() => result.current.stopAutoFlow());

  await act(async () => { await expect(flow).resolves.toBe(false); });
  expect(prepare).not.toHaveBeenCalled();
  expect(showErrorToast).not.toHaveBeenCalled();
});

test('takes a synchronous lock before React can disable the button', async () => {
  let release;
  checkpointBeforeUpdate.mockReturnValue(new Promise((resolve) => { release = resolve; }));
  const { result, handleGenerateSubtitles } = renderFlow();
  let first;
  let duplicate;
  act(() => {
    first = result.current.startAutoGenerateFlow();
    duplicate = result.current.startAutoGenerateFlow();
  });
  await expect(duplicate).resolves.toBe(false);
  release();
  await act(async () => { await first; });
  expect(handleGenerateSubtitles).toHaveBeenCalledTimes(1);
});

test('stop aborts preparation and suppresses failure UI', async () => {
  let release;
  const prepare = vi.fn((request) => new Promise((resolve) => {
    release = () => resolve(preparedFrom(request));
  }));
  const process = vi.fn();
  const { result } = renderFlow({ prepare, process });
  let flow;
  act(() => { flow = result.current.startAutoGenerateFlow(); });
  await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
  act(() => result.current.stopAutoFlow());
  release();
  await act(async () => { await expect(flow).resolves.toBe(false); });
  expect(process).not.toHaveBeenCalled();
  expect(showErrorToast).not.toHaveBeenCalled();
});

test('unmount aborts a live preparation owner', async () => {
  let capturedSignal;
  const prepare = vi.fn((request) => {
    capturedSignal = request.signal;
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
    });
  });
  const { result, unmount } = renderFlow({ prepare });
  act(() => { void result.current.startAutoGenerateFlow(); });
  await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
  unmount();
  expect(capturedSignal.aborted).toBe(true);
});

test('a mid-native source switch aborts only the owned run and stays silently obsolete', async () => {
  let nativeSignal;
  const process = vi.fn((options) => {
    nativeSignal = options.autoRunContext.signal;
    return new Promise((_resolve, reject) => {
      nativeSignal.addEventListener('abort', () => reject(
        nativeSignal.reason ?? new DOMException('Stopped', 'AbortError')
      ), { once: true });
    });
  });
  const { result } = renderFlow({ process });
  let flow;
  act(() => { flow = result.current.startAutoGenerateFlow(); });
  await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1));

  act(() => ownershipWatch.onLost(Object.assign(new Error('source switched'), {
    code: 'autoGenerationOwnershipLost',
  })));

  await expect(flow).resolves.toBe(false);
  expect(nativeSignal.aborted).toBe(true);
  expect(showErrorToast).not.toHaveBeenCalled();
});

test('stops after duration without starting Gemini processing', async () => {
  let releaseDuration;
  getVideoDuration.mockReturnValue(new Promise((resolve) => { releaseDuration = resolve; }));
  const process = vi.fn();
  const { result } = renderFlow({ process });
  let flow;
  act(() => { flow = result.current.startAutoGenerateFlow(); });
  await vi.waitFor(() => expect(getVideoDuration).toHaveBeenCalled());
  act(() => result.current.stopAutoFlow());
  releaseDuration(30);
  await act(async () => { await expect(flow).resolves.toBe(false); });
  expect(process).not.toHaveBeenCalled();
});

test('waits for the exact analysis run/project event and ignores another run', async () => {
  getTranscriptionRulesForCache
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ terminology: [] });
  let committedContext;
  commitVideoAnalysisForContext.mockImplementation(async ({ context }) => {
    committedContext = context;
  });
  const { result, handleProcessWithOptions } = renderFlow();
  let flow;
  act(() => { flow = result.current.startAutoGenerateFlow(); });
  await vi.waitFor(() => expect(commitVideoAnalysisForContext).toHaveBeenCalled());

  act(() => window.dispatchEvent(new CustomEvent(EVENTS.VIDEO_ANALYSIS_SETTLED, {
    detail: { success: true, runId: 'other', cacheId: 'cache-1', projectId: 'project-1' },
  })));
  expect(handleProcessWithOptions).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new CustomEvent(EVENTS.VIDEO_ANALYSIS_SETTLED, {
    detail: {
      success: true,
      runId: committedContext.runId,
      cacheId: committedContext.cacheId,
      projectId: committedContext.projectId,
    },
  })));

  await act(async () => { await expect(flow).resolves.toBe(true); });
});

test('project switch while the editor is open discards the run before Gemini', async () => {
  getTranscriptionRulesForCache.mockResolvedValueOnce(null);
  let listener;
  subscribeCurrentCacheId.mockImplementation((next) => {
    listener = next;
    return vi.fn();
  });
  const process = vi.fn();
  const { result } = renderFlow({ process });
  let flow;
  act(() => { flow = result.current.startAutoGenerateFlow(); });
  await vi.waitFor(() => expect(subscribeCurrentCacheId).toHaveBeenCalled());
  act(() => listener('cache-2'));

  await act(async () => { await expect(flow).resolves.toBe(false); });
  expect(process).not.toHaveBeenCalled();
});
