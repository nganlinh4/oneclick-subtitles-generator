import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCreationDialogBridge } from './useCreationDialogBridge';
import {
  startWordNativeTranscription,
  cancelWordNativeTranscription,
} from '../platform/nativeWordTranscription';

vi.mock('../platform/nativeWordTranscription', () => ({
  startWordNativeTranscription: vi.fn(),
  cancelWordNativeTranscription: vi.fn().mockResolvedValue({ id: 'task-123' }),
}));

vi.mock('../utils/toastUtils', () => ({
  showInfoToast: vi.fn(),
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

describe('useCreationDialogBridge', () => {
  let handlers = {};

  beforeEach(() => {
    vi.clearAllMocks();
    startWordNativeTranscription.mockImplementation((_request, h) => {
      handlers = h;
      return Promise.resolve({ id: 'task-123' });
    });
  });

  it('manages full lifecycle from submission through window promotions to completion', async () => {
    const onCompleted = vi.fn();
    const onPartialPromotion = vi.fn();
    const { result } = renderHook(() =>
      useCreationDialogBridge({ onCompleted, onPartialPromotion })
    );

    expect(result.current.stage).toBe('idle');
    expect(result.current.isExecuting).toBe(false);

    // 1. Start transcription
    await act(async () => {
      await result.current.startTranscription({ mediaAssetId: 'asset-1' });
    });

    expect(result.current.isExecuting).toBe(true);
    expect(result.current.stage).toBe('audio_extracting');
    expect(result.current.activeTaskId).toBe('task-123');

    // 2. Stage changed to transcribing window 1
    act(() => {
      handlers.onStageChanged?.({
        event: 'stageChanged',
        jobId: 'task-123',
        stage: 'transcribing_window_1',
        message: 'Transcribing window 1 of 2...',
        windowIndex: 0,
        totalWindows: 2,
      });
    });
    expect(result.current.stage).toBe('transcribing_window_1');
    expect(result.current.stageMessage).toBe('Transcribing window 1 of 2...');

    // 3. Window progress fraction
    act(() => {
      handlers.onWindowProgress?.({
        event: 'windowProgress',
        jobId: 'task-123',
        windowIndex: 0,
        totalWindows: 2,
        fraction: 0.5,
      });
    });
    expect(result.current.progressFraction).toBeGreaterThan(0.2);

    // 4. Window 1 promoted
    act(() => {
      handlers.onWindowPromoted?.({
        event: 'windowPromoted',
        jobId: 'task-123',
        windowIndex: 0,
        totalWindows: 2,
        wordCount: 45,
        turnCount: 4,
        projectedCues: [{ id: 'cue-1', startMs: 0, endMs: 2000, text: 'Hello' }],
      });
    });
    expect(result.current.stats.wordsCount).toBe(45);
    expect(result.current.stats.turnsCount).toBe(4);
    expect(result.current.progressFraction).toBe(0.5);
    expect(onPartialPromotion).toHaveBeenCalledTimes(1);

    // 5. Completed
    act(() => {
      handlers.onCompleted?.({
        event: 'completed',
        jobId: 'task-123',
        totalWords: 95,
        totalTurns: 8,
        projectedCues: [
          { id: 'cue-1', startMs: 0, endMs: 2000, text: 'Hello' },
          { id: 'cue-2', startMs: 2100, endMs: 4000, text: 'World' },
        ],
      });
    });

    expect(result.current.isExecuting).toBe(false);
    expect(result.current.stage).toBe('completed');
    expect(result.current.progressFraction).toBe(1.0);
    expect(result.current.activeTaskId).toBeNull();
    expect(onCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ totalWords: 95 })
    );
  });

  it('handles cooperative cancellation cleanly without error state', async () => {
    const onCancelled = vi.fn();
    const { result } = renderHook(() => useCreationDialogBridge({ onCancelled }));

    await act(async () => {
      await result.current.startTranscription({ mediaAssetId: 'asset-1' });
    });

    expect(result.current.isExecuting).toBe(true);

    // Click cancel
    await act(async () => {
      await result.current.cancelTranscription();
    });

    expect(result.current.isCancelling).toBe(true);
    expect(cancelWordNativeTranscription).toHaveBeenCalledWith('task-123');

    // Engine emits Cancelled event
    act(() => {
      handlers.onCancelled?.({ jobId: 'task-123' });
    });

    expect(result.current.isExecuting).toBe(false);
    expect(result.current.isCancelling).toBe(false);
    expect(result.current.stage).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(onCancelled).toHaveBeenCalled();
  });

  it('captures structured error events for quota exhaustion (429)', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useCreationDialogBridge({ onError }));

    await act(async () => {
      await result.current.startTranscription({ mediaAssetId: 'asset-1' });
    });

    act(() => {
      handlers.onFailed?.({
        error: {
          code: 'window_failed',
          message: 'Resource exhausted: quota exceeded (429)',
          windowIndex: 0,
          retryable: false,
        },
      });
    });

    expect(result.current.isExecuting).toBe(false);
    expect(result.current.stage).toBe('failed');
    expect(result.current.error.code).toBe('window_failed');
    expect(result.current.error.message).toContain('quota exceeded (429)');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'window_failed' })
    );
  });

  it('handles client invocation failure gracefully', async () => {
    startWordNativeTranscription.mockRejectedValueOnce(new Error('Connection refused'));
    const { result } = renderHook(() => useCreationDialogBridge());

    await act(async () => {
      await result.current.startTranscription({ mediaAssetId: 'asset-1' });
    });

    expect(result.current.isExecuting).toBe(false);
    expect(result.current.stage).toBe('failed');
    expect(result.current.error.code).toBe('invocation_failed');
  });

  it('resets back to idle state', async () => {
    const { result } = renderHook(() => useCreationDialogBridge());

    await act(async () => {
      await result.current.startTranscription({ mediaAssetId: 'asset-1' });
    });
    expect(result.current.stage).toBe('audio_extracting');

    act(() => {
      result.current.reset();
    });

    expect(result.current.stage).toBe('idle');
    expect(result.current.isExecuting).toBe(false);
    expect(result.current.progressFraction).toBe(0);
    expect(result.current.stats.wordsCount).toBe(0);
  });

  it('allows retrying transcription after onFailed without being blocked by activeTaskId', async () => {
    const { result } = renderHook(() => useCreationDialogBridge());

    // 1. Initial attempt fails
    await act(async () => {
      await result.current.startTranscription({ mediaAssetId: 'asset-1' });
    });
    expect(result.current.isExecuting).toBe(true);
    expect(result.current.activeTaskId).toBe('task-123');
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

    act(() => {
      handlers.onFailed?.({
        error: {
          code: 'window_failed',
          message: 'Resource exhausted: quota exceeded (429)',
          windowIndex: 0,
          retryable: false,
        },
      });
    });

    expect(result.current.isExecuting).toBe(false);
    expect(result.current.stage).toBe('failed');
    expect(result.current.activeTaskId).toBeNull();

    // 2. Retry succeeds and initiates a new native job
    startWordNativeTranscription.mockImplementationOnce((_request, h) => {
      handlers = h;
      return Promise.resolve({ id: 'task-retry-456' });
    });

    await act(async () => {
      await result.current.startTranscription({ mediaAssetId: 'asset-1' });
    });

    expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
    expect(result.current.isExecuting).toBe(true);
    expect(result.current.stage).toBe('audio_extracting');
    expect(result.current.activeTaskId).toBe('task-retry-456');
    expect(result.current.error).toBeNull();
  });

  it('allows retrying transcription after onError without being blocked by activeTaskId', async () => {
    const { result } = renderHook(() => useCreationDialogBridge());

    // 1. Initial attempt fails with client error
    await act(async () => {
      await result.current.startTranscription({ mediaAssetId: 'asset-1' });
    });
    expect(result.current.isExecuting).toBe(true);
    expect(result.current.activeTaskId).toBe('task-123');

    act(() => {
      handlers.onError?.(new Error('Network disconnected'));
    });

    expect(result.current.isExecuting).toBe(false);
    expect(result.current.stage).toBe('failed');
    expect(result.current.activeTaskId).toBeNull();

    // 2. Retry succeeds and initiates a new native job
    startWordNativeTranscription.mockImplementationOnce((_request, h) => {
      handlers = h;
      return Promise.resolve({ id: 'task-retry-789' });
    });

    await act(async () => {
      await result.current.startTranscription({ mediaAssetId: 'asset-1' });
    });

    expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
    expect(result.current.isExecuting).toBe(true);
    expect(result.current.stage).toBe('audio_extracting');
    expect(result.current.activeTaskId).toBe('task-retry-789');
    expect(result.current.error).toBeNull();
  });
});

