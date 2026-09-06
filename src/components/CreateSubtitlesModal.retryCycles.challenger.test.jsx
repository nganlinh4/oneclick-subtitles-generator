import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import CreateSubtitlesModal from './CreateSubtitlesModal';
import { useCreationDialogBridge } from './useCreationDialogBridge';
import { renderHook } from '@testing-library/react';
import {
  startWordNativeTranscription,
  cancelWordNativeTranscription,
} from '../platform/nativeWordTranscription';

// Mock react-i18next with interpolation support
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      let str = typeof fallback === 'string' ? fallback : key;
      if (options && typeof options === 'object') {
        for (const [k, v] of Object.entries(options)) {
          str = str.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return str;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../platform/nativeWordTranscription', () => ({
  startWordNativeTranscription: vi.fn(),
  cancelWordNativeTranscription: vi.fn().mockResolvedValue({ id: 'task-cancelled' }),
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

describe('Empirical Challenger: In-Dialog Retry and Cancellation Cycles', () => {
  let bridgeHandlers = null;
  let jobCounter = 0;

  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onProcess: vi.fn(),
    onCompleted: vi.fn(),
    videoFile: {
      assetId: 'asset-challenger-retry',
      path: '/media/test_dialog_retry.mp4',
    },
    videoDuration: 120, // 2 minutes = 120,000 ms
  };

  beforeEach(() => {
    vi.clearAllMocks();
    jobCounter = 0;
    bridgeHandlers = null;

    startWordNativeTranscription.mockImplementation((_request, handlers) => {
      bridgeHandlers = handlers;
      jobCounter += 1;
      return Promise.resolve({ id: `job-native-v${jobCounter}` });
    });
  });

  describe('Dimension 1: Multi-Stage Consecutive Failures and In-Dialog Retries', () => {
    it('retries native transcription 5 consecutive times across heterogeneous errors without modal unmount', async () => {
      const onCompleted = vi.fn();
      const onProcess = vi.fn();
      const onClose = vi.fn();

      render(
        <CreateSubtitlesModal
          {...defaultProps}
          onCompleted={onCompleted}
          onProcess={onProcess}
          onClose={onClose}
        />
      );

      // --- CYCLE 1: Simulated 429 Quota Exhaustion ---
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);
      expect(startWordNativeTranscription).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mediaAssetId: 'asset-challenger-retry',
          rangeStartMs: 0,
          rangeEndMs: 120000,
        }),
        expect.any(Object)
      );

      // Simulate 429 quota exhaustion
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'job-native-v1',
          error: {
            code: 'quota_exceeded',
            message: 'Resource exhausted: Gemini API rate limit reached (429)',
            windowIndex: 0,
            retryable: false,
          },
        });
      });

      // Assert error alert displays quota title and retry button is re-rendered & enabled
      expect(screen.getByRole('alert')).toHaveTextContent(/Gemini API Quota Exceeded/i);
      expect(screen.getByTestId('create-subtitles-action')).not.toBeDisabled();
      expect(onClose).not.toHaveBeenCalled();

      // --- CYCLE 2: Simulated Audio Pipeline Error ---
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);

      // Simulate audio extraction failure
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'job-native-v2',
          error: {
            code: 'audio_extraction_failed',
            message: 'FFmpeg pipeline error: corrupt audio stream or missing audio track',
            windowIndex: 0,
            retryable: false,
          },
        });
      });

      // Assert error alert displays audio title and retry button is enabled
      expect(screen.getByRole('alert')).toHaveTextContent(/No Audio Track Found/i);
      expect(screen.getByTestId('create-subtitles-action')).not.toBeDisabled();
      expect(onClose).not.toHaveBeenCalled();

      // --- CYCLE 3: Simulated Client Error (Network Disconnect) ---
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(3);

      // Simulate client error callback
      act(() => {
        bridgeHandlers.onError?.(new Error('WebSocket connection terminated unexpectedly'));
      });

      // Assert generic error alert displays client error message and retry button is enabled
      expect(screen.getByRole('alert')).toHaveTextContent(/Transcription Failed/i);
      expect(screen.getByRole('alert')).toHaveTextContent(/WebSocket connection terminated unexpectedly/i);
      expect(screen.getByTestId('create-subtitles-action')).not.toBeDisabled();
      expect(onClose).not.toHaveBeenCalled();

      // --- CYCLE 4: Simulated Invocation Rejection ---
      startWordNativeTranscription.mockImplementationOnce(() => {
        return Promise.reject(new Error('IPC transport channel failure'));
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(4);

      // Assert invocation failure caught by bridge and retry button is enabled
      expect(screen.getByRole('alert')).toHaveTextContent(/Transcription Failed/i);
      expect(screen.getByRole('alert')).toHaveTextContent(/IPC transport channel failure/i);
      expect(screen.getByTestId('create-subtitles-action')).not.toBeDisabled();
      expect(onClose).not.toHaveBeenCalled();

      // --- CYCLE 5: Recovery and Final Success ---
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(5);

      // Progress & Window promotion
      act(() => {
        bridgeHandlers.onStageChanged?.({ stage: 'transcribing', message: 'Transcribing speech...' });
        bridgeHandlers.onWindowPromoted?.({
          windowIndex: 0,
          totalWindows: 1,
          wordCount: 88,
          turnCount: 4,
        });
      });

      // Completion
      act(() => {
        bridgeHandlers.onCompleted?.({
          status: 'completed',
          totalWords: 88,
          totalTurns: 4,
          windowsProcessed: 1,
        });
      });

      // Assert successful delivery and modal closure
      expect(onCompleted).toHaveBeenCalledTimes(1);
      expect(onCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          totalWords: 88,
          totalTurns: 4,
        })
      );
      expect(onProcess).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Dimension 2: Switching Between Whole Video and Selected Range During Retry Cycles', () => {
    it('seamlessly updates request timebase when switching Whole Video -> Selected Range -> Whole Video across retries', async () => {
      const selectedSegment = { start: 18.5, end: 54.25 };

      render(
        <CreateSubtitlesModal
          {...defaultProps}
          selectedSegment={selectedSegment}
        />
      );

      const wholeVideoBtn = screen.getByTestId('scope-whole-video');
      const selectedRangeBtn = screen.getByTestId('scope-selected-range');

      // 1. Initial Attempt with Selected Range (since selectedSegment provided, default scope is Selected Range)
      expect(selectedRangeBtn).toHaveClass('active');
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);
      expect(startWordNativeTranscription).toHaveBeenLastCalledWith(
        expect.objectContaining({
          rangeStartMs: 18500,
          rangeEndMs: 54250,
        }),
        expect.any(Object)
      );

      // 2. Failure on Selected Range (429 quota exhaustion)
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'job-native-v1',
          error: {
            code: 'quota_exceeded',
            message: 'Rate limit exceeded (429)',
          },
        });
      });

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByTestId('create-subtitles-action')).not.toBeDisabled();

      // 3. Switch scope to Whole Video in-dialog
      fireEvent.click(wholeVideoBtn);
      expect(wholeVideoBtn).toHaveClass('active');
      expect(selectedRangeBtn).not.toHaveClass('active');

      // 4. Retry with Whole Video scope
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
      expect(startWordNativeTranscription).toHaveBeenLastCalledWith(
        expect.objectContaining({
          rangeStartMs: 0,
          rangeEndMs: 120000,
        }),
        expect.any(Object)
      );

      // 5. Failure on Whole Video (audio pipeline failure)
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'job-native-v2',
          error: {
            code: 'no_audio',
            message: 'Audio extraction failed: no audio track',
          },
        });
      });

      expect(screen.getByTestId('create-subtitles-action')).not.toBeDisabled();

      // 6. Switch back to Selected Range
      fireEvent.click(selectedRangeBtn);
      expect(selectedRangeBtn).toHaveClass('active');

      // 7. Retry again with Selected Range
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      expect(startWordNativeTranscription).toHaveBeenCalledTimes(3);
      expect(startWordNativeTranscription).toHaveBeenLastCalledWith(
        expect.objectContaining({
          rangeStartMs: 18500,
          rangeEndMs: 54250,
        }),
        expect.any(Object)
      );

      // 8. Successful completion
      act(() => {
        bridgeHandlers.onCompleted?.({
          status: 'completed',
          totalWords: 42,
          totalTurns: 2,
        });
      });

      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    });

    it('blocks submission if user switches to an invalid sub-500ms range during retry, then unblocks on switching back to Whole Video', async () => {
      // selectedSegment duration is 300ms (< 500ms minimum)
      const invalidSegment = { start: 10.0, end: 10.3 };

      render(
        <CreateSubtitlesModal
          {...defaultProps}
          selectedSegment={invalidSegment}
        />
      );

      const wholeVideoBtn = screen.getByTestId('scope-whole-video');
      const selectedRangeBtn = screen.getByTestId('scope-selected-range');

      // Switch to Whole video first so submission is valid
      fireEvent.click(wholeVideoBtn);
      expect(screen.getByTestId('create-subtitles-action')).not.toBeDisabled();

      // Initial attempt fails
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'job-native-v1',
          error: {
            code: 'quota_exceeded',
            message: 'Rate limit 429',
          },
        });
      });

      // User tries switching to invalid selected range during retry cycle
      fireEvent.click(selectedRangeBtn);

      // Submit button MUST be disabled, preventing invalid API call!
      const submitBtn = screen.getByTestId('create-subtitles-action');
      expect(submitBtn).toBeDisabled();
      expect(screen.getByText(/Selection range too short/i)).toBeInTheDocument();

      // Clicking disabled submit button does NOT trigger transcription
      await act(async () => {
        fireEvent.click(submitBtn);
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

      // Switching back to Whole video re-enables submit button
      fireEvent.click(wholeVideoBtn);
      expect(screen.getByTestId('create-subtitles-action')).not.toBeDisabled();

      // Retry triggers job 2 with whole range
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
      expect(startWordNativeTranscription).toHaveBeenLastCalledWith(
        expect.objectContaining({
          rangeStartMs: 0,
          rangeEndMs: 120000,
        }),
        expect.any(Object)
      );
    });

    it('accurately respects exactly 500ms boundary range during retry', async () => {
      const boundarySegment = { start: 20.0, end: 20.5 }; // exactly 500ms

      render(
        <CreateSubtitlesModal
          {...defaultProps}
          selectedSegment={boundarySegment}
        />
      );

      expect(screen.getByTestId('create-subtitles-action')).not.toBeDisabled();

      // Attempt 1 fails
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'job-native-v1',
          error: { code: 'client_error', message: 'Temporary timeout' },
        });
      });

      // Attempt 2 succeeds with exactly 500ms range
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
      expect(startWordNativeTranscription).toHaveBeenLastCalledWith(
        expect.objectContaining({
          rangeStartMs: 20000,
          rangeEndMs: 20500,
        }),
        expect.any(Object)
      );
    });
  });

  describe('Dimension 3: State Reset & Deduplication Across Retries', () => {
    it('resets partial stats and progress fraction cleanly upon initiating retry', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      // Attempt 1
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Partial promotion: 1 window promoted with 50 words
      act(() => {
        bridgeHandlers.onWindowPromoted?.({
          windowIndex: 0,
          totalWindows: 2,
          wordCount: 50,
          turnCount: 3,
        });
      });

      // Window 1 fails
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'job-native-v1',
          error: {
            code: 'window_failed',
            message: 'Window 1 failed after 3 retries',
            windowIndex: 1,
          },
        });
      });

      // Partial progress banner is shown in error card
      expect(screen.getByText(/1 of 2 windows completed \(50 words saved\)/i)).toBeInTheDocument();

      // Click retry
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // During active execution of retry, error banner must be gone
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // Progress card must display fresh state: 0 words recognized
      expect(screen.getByText(/Words recognized: 0/i)).toBeInTheDocument();
    });

    it('deduplicates rapid consecutive clicks on retry button without firing duplicate jobs', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      // Attempt 1 fails
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'job-native-v1',
          error: { code: 'quota_exceeded', message: 'Rate limit 429' },
        });
      });

      // Fire 5 rapid clicks on retry button in the same tick
      const retryBtn = screen.getByTestId('create-subtitles-action');
      await act(async () => {
        fireEvent.click(retryBtn);
        fireEvent.click(retryBtn);
        fireEvent.click(retryBtn);
        fireEvent.click(retryBtn);
        fireEvent.click(retryBtn);
      });

      // MUST only launch 1 additional job (total 2), NOT 6!
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
    });
  });

  describe('Dimension 4: Cancellation and Hook-Level Retry Cycles', () => {
    it('allows repeated start -> cancel -> retry -> cancel -> retry sequences in bridge hook', async () => {
      const { result } = renderHook(() => useCreationDialogBridge());

      // Sequence 1: Start -> Cancel
      let p1;
      await act(async () => {
        p1 = result.current.startTranscription({ mediaAssetId: 'asset-1' });
      });
      await p1;
      expect(result.current.isExecuting).toBe(true);
      expect(result.current.activeTaskId).toBe('job-native-v1');

      await act(async () => {
        await result.current.cancelTranscription();
      });
      expect(cancelWordNativeTranscription).toHaveBeenCalledWith('job-native-v1');

      // Fire onCancelled
      act(() => {
        bridgeHandlers.onCancelled?.({ event: 'cancelled', jobId: 'job-native-v1' });
      });
      expect(result.current.isExecuting).toBe(false);
      expect(result.current.activeTaskId).toBeNull();
      expect(result.current.stage).toBe('idle');

      // Sequence 2: Retry -> Cancel again
      let p2;
      await act(async () => {
        p2 = result.current.startTranscription({ mediaAssetId: 'asset-1' });
      });
      await p2;
      expect(result.current.isExecuting).toBe(true);
      expect(result.current.activeTaskId).toBe('job-native-v2');

      await act(async () => {
        await result.current.cancelTranscription();
      });
      expect(cancelWordNativeTranscription).toHaveBeenCalledWith('job-native-v2');

      act(() => {
        bridgeHandlers.onCancelled?.({ event: 'cancelled', jobId: 'job-native-v2' });
      });
      expect(result.current.isExecuting).toBe(false);
      expect(result.current.activeTaskId).toBeNull();

      // Sequence 3: Retry -> Succeeds
      let p3;
      await act(async () => {
        p3 = result.current.startTranscription({ mediaAssetId: 'asset-1' });
      });
      await p3;
      expect(result.current.isExecuting).toBe(true);
      expect(result.current.activeTaskId).toBe('job-native-v3');

      act(() => {
        bridgeHandlers.onCompleted?.({ status: 'completed', totalWords: 99 });
      });
      expect(result.current.isExecuting).toBe(false);
      expect(result.current.activeTaskId).toBeNull();
      expect(result.current.stage).toBe('completed');
    });
  });

  describe('Dimension 5: Settings Mutation Across In-Dialog Retries', () => {
    it('applies updated language, diarization, and caption layout when user alters settings prior to retry', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      // Attempt 1: defaults (auto, identifySpeakers: false, Natural)
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenLastCalledWith(
        expect.objectContaining({
          diarization: false,
          config: { groupingPolicy: 'Natural' },
        }),
        expect.any(Object)
      );

      // Attempt 1 fails
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'job-native-v1',
          error: { code: 'quota_exceeded', message: 'Rate limit 429' },
        });
      });

      // User alters settings before clicking retry:
      // 1. Enable identify speakers
      const diarizationCheckbox = screen.getByLabelText(/Identify speakers/i);
      fireEvent.click(diarizationCheckbox);

      // 2. Change caption layout to 'One word'
      const oneWordCard = screen.getByText('One word').closest('[role="radio"]');
      fireEvent.click(oneWordCard);

      // Click retry
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Verify that retry request strictly incorporates the altered settings!
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
      expect(startWordNativeTranscription).toHaveBeenLastCalledWith(
        expect.objectContaining({
          diarization: true,
          config: { groupingPolicy: 'One word' },
        }),
        expect.any(Object)
      );
    });
  });

  describe('Dimension 6: In-Flight Escape Key & Cancellation Resilience in Modal', () => {
    it('triggers in-flight native cancellation on Escape key without premature dialog destruction', async () => {
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      // Launch transcription
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

      // While executing, press Escape
      fireEvent.keyDown(document, { key: 'Escape' });

      // Cancel request must be dispatched to native engine
      expect(cancelWordNativeTranscription).toHaveBeenCalledWith('job-native-v1');

      // CRITICAL: Modal must NOT have prematurely unmounted or called onClose yet!
      expect(onClose).not.toHaveBeenCalled();

      // Footer shows "Cancelling..."
      expect(screen.getByText('Cancelling...')).toBeInTheDocument();

      // Native engine responds with onCancelled
      act(() => {
        bridgeHandlers.onCancelled?.({ event: 'cancelled', jobId: 'job-native-v1' });
      });

      // NOW modal calls onClose cleanly
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('tolerates rejection of cancelWordNativeTranscription gracefully during cancellation without crash', async () => {
      cancelWordNativeTranscription.mockRejectedValueOnce(new Error('IPC pipe broken'));

      const { result } = renderHook(() => useCreationDialogBridge());

      await act(async () => {
        await result.current.startTranscription({ mediaAssetId: 'asset-1' });
      });

      // Cancellation invocation rejects
      await act(async () => {
        await result.current.cancelTranscription();
      });

      // Hook handles rejection without throwing unhandled error and stays in cancelling state
      expect(result.current.isCancelling).toBe(true);

      // When onCancelled event arrives, clears cleanly
      act(() => {
        bridgeHandlers.onCancelled?.({ event: 'cancelled', jobId: 'job-native-v1' });
      });
      expect(result.current.isCancelling).toBe(false);
      expect(result.current.isExecuting).toBe(false);
      expect(result.current.activeTaskId).toBeNull();
    });
  });
});
