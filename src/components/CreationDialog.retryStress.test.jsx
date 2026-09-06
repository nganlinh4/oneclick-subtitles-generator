import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import CreateSubtitlesModal from './CreateSubtitlesModal';
import { useCreationDialogBridge } from './useCreationDialogBridge';
import { startWordNativeTranscription } from '../platform/nativeWordTranscription';

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      let str = typeof fallback === 'string' ? fallback : key;
      if (options && typeof options === 'object') {
        for (const [k, v] of Object.entries(options)) {
          str = str.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), String(v));
        }
      }
      return str;
    },
    i18n: { language: 'en' },
  }),
}));

// Mock platform bridge
vi.mock('../platform/nativeWordTranscription', () => ({
  startWordNativeTranscription: vi.fn(),
  cancelWordNativeTranscription: vi.fn().mockResolvedValue({ id: 'task-test-stress' }),
  isNativeWordTranscriptionSupported: vi.fn().mockReturnValue(true),
}));

// Mock toast utilities
vi.mock('../utils/toastUtils', () => ({
  showInfoToast: vi.fn(),
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
  showToast: vi.fn(),
}));

describe('Empirical Adversarial Stress Harness: Rapid Concurrent Clicks During Retry States', () => {
  let bridgeHandlers = {};
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onProcess: vi.fn(),
    onCompleted: vi.fn(),
    videoFile: { assetId: 'media-stress-retry', name: 'stress_retry.mp4', duration: 180 },
    videoDuration: 180,
    selectedSegment: null,
    initialTask: 'Speech',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    bridgeHandlers = {};

    startWordNativeTranscription.mockImplementation((_request, handlers) => {
      bridgeHandlers = handlers;
      return Promise.resolve({ id: 'task-stress-' + Math.random().toString(36).substring(7) });
    });
  });

  // =========================================================================
  // SCENARIO 1: RAPID 20X SYNCHRONOUS CLICKS ON RETRY BUTTON AFTER onFailed
  // =========================================================================
  it('Scenario 1: Locks out 20 rapid synchronous clicks on retry button after initial onFailed', async () => {
    render(<CreateSubtitlesModal {...defaultProps} />);
    const submitBtn = screen.getByTestId('create-subtitles-action');

    // Initial run
    await act(async () => {
      fireEvent.click(submitBtn);
    });
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

    // Initial run fails via onFailed
    act(() => {
      bridgeHandlers.onFailed?.({
        event: 'failed',
        jobId: 'task-initial-fail',
        error: {
          code: 'window_failed',
          message: 'Resource exhausted: quota exceeded (429)',
          windowIndex: 0,
          retryable: false,
        },
      });
    });

    // Re-query newly mounted retry button in DOM after failure
    const retryBtn = screen.getByTestId('create-subtitles-action');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(retryBtn).not.toBeDisabled();

    // Adversarial assault: User mashes retry button 20 times synchronously
    await act(async () => {
      for (let i = 0; i < 20; i++) {
        fireEvent.click(retryBtn);
      }
    });

    // Ref locks must ensure exactly 1 retry invocation was dispatched (total 2 calls)
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
  });

  // =========================================================================
  // SCENARIO 2: RAPID 20X SYNCHRONOUS CLICKS ON RETRY BUTTON AFTER onError
  // =========================================================================
  it('Scenario 2: Locks out 20 rapid synchronous clicks on retry button after initial onError', async () => {
    render(<CreateSubtitlesModal {...defaultProps} />);
    const submitBtn = screen.getByTestId('create-subtitles-action');

    // Initial run
    await act(async () => {
      fireEvent.click(submitBtn);
    });
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

    // Initial run fails via onError
    act(() => {
      bridgeHandlers.onError?.(new Error('Tauri IPC serialization fault'));
    });

    // Re-query newly mounted retry button in DOM after error
    const retryBtn = screen.getByTestId('create-subtitles-action');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(retryBtn).not.toBeDisabled();

    // Adversarial assault: 20 rapid clicks
    await act(async () => {
      for (let i = 0; i < 20; i++) {
        fireEvent.click(retryBtn);
      }
    });

    // Exactly 1 retry dispatch (total 2 calls)
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
  });

  // =========================================================================
  // SCENARIO 3: RAPID CLICKS DURING HIGH-LATENCY RETRY INVOCATION (PENDING PROMISE)
  // =========================================================================
  it('Scenario 3: Locks out clicks while retry IPC promise is pending with high latency', async () => {
    render(<CreateSubtitlesModal {...defaultProps} />);
    const submitBtn = screen.getByTestId('create-subtitles-action');

    // Initial run
    await act(async () => {
      fireEvent.click(submitBtn);
    });
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

    // Initial run fails
    act(() => {
      bridgeHandlers.onFailed?.({
        event: 'failed',
        jobId: 'task-latency-fail',
        error: { code: 'window_failed', message: 'Transient gateway error' },
      });
    });

    // Mock next start with delayed resolution (simulating slow native IPC startup)
    let resolveRetry;
    startWordNativeTranscription.mockImplementationOnce((_req, handlers) => {
      bridgeHandlers = handlers;
      return new Promise((resolve) => {
        resolveRetry = () => resolve({ id: 'task-slow-retry' });
      });
    });

    const retryBtn = screen.getByTestId('create-subtitles-action');

    // Click retry once to initiate
    act(() => {
      fireEvent.click(retryBtn);
    });
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);

    // While retry is pending startup, mash button 25 times
    act(() => {
      for (let i = 0; i < 25; i++) {
        fireEvent.click(retryBtn);
      }
    });
    // Still exactly 2 calls!
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);

    // Now resolve the delayed retry promise
    await act(async () => {
      resolveRetry();
    });

    // Still exactly 2 calls
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);

    // Once in-flight, clicks are still locked out
    act(() => {
      for (let i = 0; i < 5; i++) {
        fireEvent.click(retryBtn);
      }
    });
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
  });

  // =========================================================================
  // SCENARIO 4: MULTI-CYCLE STRESS TEST ACROSS 5 CONSECUTIVE FAILURE & RETRY LOOPS
  // =========================================================================
  it('Scenario 4: Multi-cycle stress test across 5 consecutive failure/retry cycles with 10 clicks each', async () => {
    render(<CreateSubtitlesModal {...defaultProps} />);
    const submitBtn = screen.getByTestId('create-subtitles-action');

    // Iteration 1: Initial start
    await act(async () => {
      fireEvent.click(submitBtn);
    });
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

    // Iteration 1 fails via onFailed
    act(() => {
      bridgeHandlers.onFailed?.({
        event: 'failed',
        jobId: 'task-cycle-1',
        error: { code: 'window_failed', message: 'Cycle 1 network failure' },
      });
    });

    // Iteration 2: Burst of 10 clicks
    await act(async () => {
      const btn = screen.getByTestId('create-subtitles-action');
      for (let i = 0; i < 10; i++) {
        fireEvent.click(btn);
      }
    });
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);

    // Iteration 2 fails via onFailed
    act(() => {
      bridgeHandlers.onFailed?.({
        event: 'failed',
        jobId: 'task-cycle-2',
        error: { code: 'window_failed', message: 'Cycle 2 timeout' },
      });
    });

    // Iteration 3: Burst of 10 clicks
    await act(async () => {
      const btn = screen.getByTestId('create-subtitles-action');
      for (let i = 0; i < 10; i++) {
        fireEvent.click(btn);
      }
    });
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(3);

    // Iteration 3 fails via onError
    act(() => {
      bridgeHandlers.onError?.(new Error('Cycle 3 client disconnect'));
    });

    // Iteration 4: Burst of 10 clicks with mock rejection
    startWordNativeTranscription.mockRejectedValueOnce(new Error('Cycle 4 IPC invocation rejected'));
    await act(async () => {
      const btn = screen.getByTestId('create-subtitles-action');
      for (let i = 0; i < 10; i++) {
        fireEvent.click(btn);
      }
    });
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(4);

    // Iteration 5: Burst of 10 clicks with success
    startWordNativeTranscription.mockImplementationOnce((_req, handlers) => {
      bridgeHandlers = handlers;
      return Promise.resolve({ id: 'task-cycle-5-final' });
    });
    await act(async () => {
      const btn = screen.getByTestId('create-subtitles-action');
      for (let i = 0; i < 10; i++) {
        fireEvent.click(btn);
      }
    });
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(5);

    // Iteration 5 completes
    act(() => {
      bridgeHandlers.onCompleted?.({
        event: 'completed',
        jobId: 'task-cycle-5-final',
        totalWords: 150,
      });
    });

    expect(defaultProps.onCompleted).toHaveBeenCalled();
  });

  // =========================================================================
  // SCENARIO 5: CONCURRENT INVOCATIONS ON useCreationDialogBridge HOOK DIRECTLY
  // =========================================================================
  it('Scenario 5: Direct hook stress test — 50 concurrent startTranscription calls per lifecycle stage', async () => {
    const { result } = renderHook(() => useCreationDialogBridge());

    // 1. Initial 50 concurrent calls
    await act(async () => {
      await Promise.all(
        Array.from({ length: 50 }, () =>
          result.current.startTranscription({ mediaAssetId: 'test-direct-1' })
        )
      );
    });
    // Exactly 1 dispatched
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);
    expect(result.current.isExecuting).toBe(true);

    // Simulate failure
    act(() => {
      bridgeHandlers.onFailed?.({
        event: 'failed',
        jobId: 'task-direct-1',
        error: { code: 'window_failed', message: 'Direct test fail 1' },
      });
    });
    expect(result.current.isExecuting).toBe(false);
    expect(result.current.activeTaskId).toBeNull();

    // 2. Retry: 50 concurrent calls after onFailed
    await act(async () => {
      await Promise.all(
        Array.from({ length: 50 }, () =>
          result.current.startTranscription({ mediaAssetId: 'test-direct-2' })
        )
      );
    });
    // Exactly 1 additional dispatch (total 2)
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
    expect(result.current.isExecuting).toBe(true);

    // Simulate client error
    act(() => {
      bridgeHandlers.onError?.(new Error('Direct test error 2'));
    });
    expect(result.current.isExecuting).toBe(false);
    expect(result.current.activeTaskId).toBeNull();

    // 3. Retry: 50 concurrent calls after onError
    await act(async () => {
      await Promise.all(
        Array.from({ length: 50 }, () =>
          result.current.startTranscription({ mediaAssetId: 'test-direct-3' })
        )
      );
    });
    // Exactly 1 additional dispatch (total 3)
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(3);
    expect(result.current.isExecuting).toBe(true);

    // Simulate failure on step 3
    act(() => {
      bridgeHandlers.onFailed?.({
        event: 'failed',
        jobId: 'task-direct-3',
        error: { code: 'window_failed', message: 'Direct test fail 3' },
      });
    });
    expect(result.current.isExecuting).toBe(false);

    // Set mock rejection for next call
    startWordNativeTranscription.mockRejectedValueOnce(new Error('Direct IPC reject 4'));

    // 4. Retry: 50 concurrent calls after rejection
    await act(async () => {
      await Promise.all(
        Array.from({ length: 50 }, () =>
          result.current.startTranscription({ mediaAssetId: 'test-direct-4' })
        )
      );
    });
    // Exactly 1 additional dispatch (total 4)
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(4);
    expect(result.current.isExecuting).toBe(false);
    expect(result.current.activeTaskId).toBeNull();
  });

  // =========================================================================
  // SCENARIO 6: SWITCHING TO LOCAL ASR AFTER GEMINI RETRY STATE WITH RAPID CLICKS
  // =========================================================================
  it('Scenario 6: Rapid clicks after switching engine to local-asr from a failed Gemini state', async () => {
    const onProcess = vi.fn();
    const onClose = vi.fn();
    render(<CreateSubtitlesModal {...defaultProps} onProcess={onProcess} onClose={onClose} />);
    const submitBtn = screen.getByTestId('create-subtitles-action');

    // Initial Gemini run fails
    await act(async () => {
      fireEvent.click(submitBtn);
    });
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

    act(() => {
      bridgeHandlers.onFailed?.({
        event: 'failed',
        jobId: 'task-gemini-fail',
        error: { code: 'quota_exceeded', message: 'Quota exceeded (429)' },
      });
    });

    // Switch to local-asr
    const engineSelect = screen.getByLabelText(/engine/i);
    fireEvent.change(engineSelect, { target: { value: 'local-asr' } });

    const localBtn = screen.getByTestId('create-subtitles-action');

    // Mash submit button 15 times
    await act(async () => {
      for (let i = 0; i < 15; i++) {
        fireEvent.click(localBtn);
      }
    });

    // Gemini was NOT called again
    expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);
    // local-asr processed and modal closed
    expect(onProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'Speech',
        engine: 'local-asr',
        method: 'nvidia-parakeet',
      })
    );
    expect(onClose).toHaveBeenCalled();
  });
});
