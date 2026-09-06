import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import CreateSubtitlesModal from './CreateSubtitlesModal';
import {
  startWordNativeTranscription,
  cancelWordNativeTranscription,
} from '../platform/nativeWordTranscription';
import * as toastUtils from '../utils/toastUtils';

// Mock react-i18next
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

// Mock platform bridge
vi.mock('../platform/nativeWordTranscription', () => ({
  startWordNativeTranscription: vi.fn(),
  cancelWordNativeTranscription: vi.fn().mockResolvedValue({ id: 'task-test-456' }),
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

describe('Challenger 2: Concurrency, Escape Lifecycle & Error Cards Harness', () => {
  let bridgeHandlers = {};
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onProcess: vi.fn(),
    onCompleted: vi.fn(),
    videoFile: { assetId: 'media-adv-ch2', name: 'stress_test.mp4', duration: 120 },
    videoDuration: 120,
    selectedSegment: null,
    initialTask: 'Speech',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    bridgeHandlers = {};

    startWordNativeTranscription.mockImplementation((_request, handlers) => {
      bridgeHandlers = handlers;
      return Promise.resolve({ id: 'task-test-456' });
    });
  });

  // =========================================================================
  // SUITE 1: RAPID CONCURRENT CLICKS ON SUBMIT BUTTON
  // =========================================================================
  describe('Suite 1: Rapid Concurrent Clicks on Submit Button', () => {
    it('dispatches exactly 1 startWordNativeTranscription call on 10 rapid synchronous clicks', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);
      const createBtn = screen.getByTestId('create-subtitles-action');

      await act(async () => {
        for (let i = 0; i < 10; i++) {
          fireEvent.click(createBtn);
        }
      });

      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);
    });

    it('dispatches exactly 1 request when startWordNativeTranscription has high async latency (100ms)', async () => {
      let resolveStart;
      startWordNativeTranscription.mockImplementationOnce((_req, handlers) => {
        bridgeHandlers = handlers;
        return new Promise((resolve) => {
          resolveStart = () => resolve({ id: 'task-slow-1' });
        });
      });

      render(<CreateSubtitlesModal {...defaultProps} />);
      const createBtn = screen.getByTestId('create-subtitles-action');

      // First click: triggers pending promise
      act(() => {
        fireEvent.click(createBtn);
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

      // Multiple rapid clicks while promise is pending
      act(() => {
        for (let i = 0; i < 5; i++) {
          fireEvent.click(createBtn);
        }
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

      // Resolve the pending start
      await act(async () => {
        resolveStart();
      });

      // Still exactly 1 call
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

      // Once executing, further clicks are still ignored
      act(() => {
        fireEvent.click(createBtn);
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);
    });

    it('verifies non-Gemini tasks: rapid double clicks on local-asr', async () => {
      const onProcess = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onProcess={onProcess} />);

      // Switch to local-asr
      const engineSelect = screen.getByLabelText(/engine/i);
      fireEvent.change(engineSelect, { target: { value: 'local-asr' } });

      const createBtn = screen.getByTestId('create-subtitles-action');

      await act(async () => {
        fireEvent.click(createBtn);
        fireEvent.click(createBtn);
      });

      console.log(`[Adversarial local-asr rapid clicks] onProcess call count: ${onProcess.mock.calls.length}`);
      expect(onProcess.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('verifies non-Gemini tasks: rapid double clicks on Translate task', async () => {
      const onProcess = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onProcess={onProcess} initialTask="Translate" />);

      // Fill in target language
      const langSelect = screen.getByLabelText(/target language/i);
      fireEvent.change(langSelect, { target: { value: 'ja' } });

      const createBtn = screen.getByTestId('create-subtitles-action');

      await act(async () => {
        fireEvent.click(createBtn);
        fireEvent.click(createBtn);
      });

      console.log(`[Adversarial Translate rapid clicks] onProcess call count: ${onProcess.mock.calls.length}`);
      expect(onProcess.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('allows retry submission after initial startWordNativeTranscription rejects', async () => {
      startWordNativeTranscription.mockRejectedValueOnce(new Error('Initial network glitch'));
      render(<CreateSubtitlesModal {...defaultProps} />);
      const createBtn = screen.getByTestId('create-subtitles-action');

      // First attempt fails
      await act(async () => {
        fireEvent.click(createBtn);
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert')).toBeInTheDocument();

      // Button is re-enabled for retry
      expect(createBtn).not.toBeDisabled();

      // Second attempt succeeds
      startWordNativeTranscription.mockImplementationOnce((_req, handlers) => {
        bridgeHandlers = handlers;
        return Promise.resolve({ id: 'task-retry-success' });
      });

      await act(async () => {
        fireEvent.click(createBtn);
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // SUITE 2: ESCAPE KEY LIFECYCLE DURING ACTIVE TRANSCRIPTION
  // =========================================================================
  describe('Suite 2: Escape Key Lifecycle & Cooperative Cancellation', () => {
    it('pressing Escape during active transcription triggers cancellation without unmounting modal', async () => {
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      // Start transcription
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

      // Press Escape while executing
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      // Assert cooperative cancellation was initiated:
      expect(cancelWordNativeTranscription).toHaveBeenCalledTimes(1);
      expect(cancelWordNativeTranscription).toHaveBeenCalledWith('task-test-456');

      // Assert modal did NOT close prematurely:
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      // Assert cancellation in-flight status UI is shown:
      expect(screen.getByRole('button', { name: /cancelling\.\.\./i })).toBeDisabled();

      // Now engine responds with onCancelled
      act(() => {
        bridgeHandlers.onCancelled?.({ jobId: 'task-test-456' });
      });

      // Now onClose is called to cleanly unmount
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(toastUtils.showInfoToast).toHaveBeenCalledWith(
        expect.stringMatching(/transcription cancelled/i)
      );
      expect(toastUtils.showErrorToast).not.toHaveBeenCalled();
    });

    it('pressing Escape multiple times while cancelling does not send duplicate cancel requests', async () => {
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // First Escape triggers cancel
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      expect(cancelWordNativeTranscription).toHaveBeenCalledTimes(1);

      // Subsequent Escapes while cancelling
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      // Must NOT invoke cancel again or close prematurely
      expect(cancelWordNativeTranscription).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('pressing Escape when idle cleanly closes the modal', () => {
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(cancelWordNativeTranscription).not.toHaveBeenCalled();
    });

    it('pressing Escape when in error state cleanly closes the modal', async () => {
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Emit error
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-456',
          error: { code: 'window_failed', message: 'Fatal crash' },
        });
      });

      expect(screen.getByRole('alert')).toBeInTheDocument();

      // Press Escape to dismiss error dialog
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('investigates Escape when startWordNativeTranscription is pending before task ID arrives', async () => {
      let resolveStart;
      startWordNativeTranscription.mockImplementationOnce((_req, handlers) => {
        bridgeHandlers = handlers;
        return new Promise((resolve) => {
          resolveStart = () => resolve({ id: 'task-pending-id' });
        });
      });

      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      // Click to start (async pending)
      act(() => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Press Escape while start is pending
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });

      const cancelCalls = cancelWordNativeTranscription.mock.calls.length;
      console.log(`[Adversarial Escape Pending Start] cancelCalls=${cancelCalls}, onCloseCalls=${onClose.mock.calls.length}`);

      // Complete start
      await act(async () => {
        resolveStart();
      });

      // After start completes, cancel was never called!
      expect(cancelWordNativeTranscription).not.toHaveBeenCalled();
    });

    it('EMPIRICAL BUG CHECK: Cancel button clicked while start is pending drops cancellation', async () => {
      let resolveStart;
      startWordNativeTranscription.mockImplementationOnce((_req, handlers) => {
        bridgeHandlers = handlers;
        return new Promise((resolve) => {
          resolveStart = () => resolve({ id: 'task-slow-start-999' });
        });
      });

      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      // 1. User clicks "Create subtitles"
      act(() => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Modal is executing, "Cancel transcription" button appears
      const cancelBtn = screen.getByRole('button', { name: /cancel transcription/i });
      expect(cancelBtn).toBeInTheDocument();

      // 2. User immediately clicks "Cancel transcription" while start is pending
      act(() => {
        fireEvent.click(cancelBtn);
      });

      // 3. Start resolves with task ID
      await act(async () => {
        resolveStart();
      });

      // Did cancelWordNativeTranscription get called for task-slow-start-999?
      console.log(`[Adversarial Pending Cancel Check] cancelWordNativeTranscription calls: ${cancelWordNativeTranscription.mock.calls.length}`);
      // Bug: cancelWordNativeTranscription was never called because activeTaskIdRef was null when Cancel was clicked!
      const didCancel = cancelWordNativeTranscription.mock.calls.length > 0;
      expect(didCancel).toBe(false); // Demonstrates dropped cancellation
    });
  });

  // =========================================================================
  // SUITE 3: SIMULATED QUOTA (429) & AUDIO ERROR RECOVERY CARDS
  // =========================================================================
  describe('Suite 3: Simulated Quota (429) and Audio Error Cards', () => {
    it('classifies code="quota_exceeded" as Gemini API Quota Exceeded', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-456',
          error: {
            code: 'quota_exceeded',
            message: 'You have reached your daily quota limit',
          },
        });
      });

      expect(screen.getByText(/gemini api quota exceeded/i)).toBeInTheDocument();
      expect(screen.queryByText(/transcription failed/i)).toBeNull();
      expect(screen.getByRole('alert')).toHaveClass('creation-info-banner', 'error');
    });

    it('classifies code="window_failed" with message containing "429" as Quota Exceeded', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-456',
          error: {
            code: 'window_failed',
            message: 'HTTP 429 Too Many Requests: Rate limit exceeded',
          },
        });
      });

      expect(screen.getByText(/gemini api quota exceeded/i)).toBeInTheDocument();
      expect(screen.queryByText(/transcription failed/i)).toBeNull();
    });

    it('classifies code="RESOURCE_EXHAUSTED_429" in error code as Quota Exceeded', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-456',
          error: {
            code: 'provider_error_429',
            message: 'Resource exhausted',
          },
        });
      });

      expect(screen.getByText(/gemini api quota exceeded/i)).toBeInTheDocument();
      expect(screen.queryByText(/transcription failed/i)).toBeNull();
    });

    it('classifies code="no_audio" as No Audio Track Found', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-456',
          error: {
            code: 'no_audio',
            message: 'Asset does not contain any audio stream',
          },
        });
      });

      expect(screen.getByText(/no audio track found/i)).toBeInTheDocument();
      expect(screen.queryByText(/transcription failed/i)).toBeNull();
    });

    it('classifies message with "AUDIO" in uppercase as No Audio Track Found (case-insensitive)', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-456',
          error: {
            code: 'window_failed',
            message: 'PIPELINE ERROR: NO AUDIO STREAM DETECTED IN CONTAINER',
          },
        });
      });

      expect(screen.getByText(/no audio track found/i)).toBeInTheDocument();
      expect(screen.queryByText(/transcription failed/i)).toBeNull();
    });

    it('handles unexpected null error code and message gracefully without crashing', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-456',
          error: {
            code: null,
            message: null,
          },
        });
      });

      expect(screen.getByText(/transcription failed/i)).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('preserves partial progress count when 429 quota exhaustion strikes on window 2 of 4', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Promote window 0
      act(() => {
        bridgeHandlers.onWindowPromoted?.({
          event: 'windowPromoted',
          windowIndex: 0,
          totalWindows: 4,
          wordCount: 45,
          turnCount: 4,
        });
      });

      // Promote window 1
      act(() => {
        bridgeHandlers.onWindowPromoted?.({
          event: 'windowPromoted',
          windowIndex: 1,
          totalWindows: 4,
          wordCount: 38,
          turnCount: 3,
        });
      });

      // Window 2 fails with 429
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-456',
          error: {
            code: 'quota_exceeded',
            message: 'Quota exceeded 429',
            windowIndex: 2,
            totalWindows: 4,
          },
        });
      });

      expect(screen.getByText(/gemini api quota exceeded/i)).toBeInTheDocument();
      // Total words = 45 + 38 = 83 words across 2 windows
      expect(screen.getByText(/2 of 4 windows completed \(83 words saved\)/i)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // SUITE 4: BACKDROP & CLOSE BUTTON SHIELDING DURING EXECUTION
  // =========================================================================
  describe('Suite 4: Backdrop & Close Button Shielding During Execution', () => {
    it('prevents modal dismissal via backdrop click while executing', async () => {
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      const overlay = document.body.querySelector('.create-subtitles-modal-overlay');
      fireEvent.click(overlay);

      expect(onClose).not.toHaveBeenCalled();
    });

    it('permits modal dismissal via backdrop click when idle', () => {
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      const overlay = document.body.querySelector('.create-subtitles-modal-overlay');
      fireEvent.click(overlay);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps close button disabled during in-flight cancellation', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      const cancelBtn = screen.getByRole('button', { name: /cancel transcription/i });
      await act(async () => {
        fireEvent.click(cancelBtn);
      });

      const closeBtn = screen.getByLabelText(/close creation dialog/i);
      expect(closeBtn).toBeDisabled();
    });
  });
});
