import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import CreateSubtitlesModal from './CreateSubtitlesModal';
import { SPEECH_TAB_DECOMMISSIONED_SELECTORS } from './CreationDialog.decommissioning.test.jsx';
import {
  startWordNativeTranscription,
  cancelWordNativeTranscription,
} from '../platform/nativeWordTranscription';
import * as toastUtils from '../utils/toastUtils';

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

// Mock platform bridge
vi.mock('../platform/nativeWordTranscription', () => ({
  startWordNativeTranscription: vi.fn(),
  cancelWordNativeTranscription: vi.fn().mockResolvedValue({ id: 'task-test-456' }),
  isNativeWordTranscriptionSupported: vi.fn().mockReturnValue(true),
}));

// Mock toast utilities with spies
vi.mock('../utils/toastUtils', () => ({
  showInfoToast: vi.fn(),
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
  showToast: vi.fn(),
}));

describe('CreationDialog Adversarial Stress Harness', () => {
  let bridgeHandlers = {};
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onProcess: vi.fn(),
    onCompleted: vi.fn(),
    videoFile: { assetId: 'media-adv-1', name: 'adversarial_test.mp4', duration: 240 },
    videoDuration: 240,
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
  // DIMENSION 1: DECOMMISSIONING SELECTORS DEEP SCAN & STATE COMBINATORICS
  // =========================================================================
  describe('Dimension 1: Exhaustive Decommissioned Selectors Negative Assertions', () => {
    const assertNoDecommissionedSelectors = (contextName) => {
      for (const selector of SPEECH_TAB_DECOMMISSIONED_SELECTORS) {
        const match = document.body.querySelector(selector);
        expect(
          match,
          `Decommissioned selector "${selector}" leaked into Speech tab during [${contextName}]`
        ).toBeNull();
      }
    };

    it('asserts zero decommissioned selectors on initial default render', () => {
      render(<CreateSubtitlesModal {...defaultProps} />);
      assertNoDecommissionedSelectors('Default Initial State');
    });

    it('asserts zero decommissioned selectors when Advanced Options accordion is expanded', () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      // Find and click the Advanced options accordion trigger
      const advancedTrigger = screen.getByRole('button', { name: /advanced options/i });
      fireEvent.click(advancedTrigger);

      expect(advancedTrigger).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByLabelText(/language hints/i)).toBeInTheDocument();
      expect(screen.getByText(/max window duration/i)).toBeInTheDocument();
      expect(screen.getByText(/sequential throttling delay/i)).toBeInTheDocument();

      assertNoDecommissionedSelectors('Advanced Options Expanded');

      // Specifically verify that new sliders do NOT share legacy IDs/classes
      expect(document.body.querySelector('#max-duration-slider')).toBeNull();
      expect(document.body.querySelector('#segment-processing-delay-slider')).toBeNull();
      expect(document.body.querySelector('[data-testid="segment-processing-delay"]')).toBeNull();
    });

    it('asserts zero decommissioned selectors across all caption layout policies (including Custom drawer)', () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      const layouts = ['Short', 'One word', 'Custom', 'Natural'];
      for (const layout of layouts) {
        const layoutCard = screen.getByText(new RegExp(`^${layout}$`, 'i'));
        fireEvent.click(layoutCard);

        if (layout === 'Custom') {
          // Custom opens words/duration sliders
          expect(screen.getByText(/max words/i)).toBeInTheDocument();
          expect(screen.getByText(/max duration/i)).toBeInTheDocument();

          // Assert custom sliders do NOT use decommissioned IDs
          expect(document.body.querySelector('#max-words-slider')).toBeNull();
          expect(document.body.querySelector('#max-duration-slider')).toBeNull();
          expect(document.body.querySelector('#auto-split-subtitles')).toBeNull();
        }

        assertNoDecommissionedSelectors(`Layout Policy: ${layout}`);
      }
    });

    it('asserts zero decommissioned selectors across all speech engine selections', () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      const engineSelect = screen.getByLabelText(/engine/i);
      const engines = ['gemini-3.5-transcribe', 'local-asr', 'gemini-general'];

      for (const eng of engines) {
        fireEvent.change(engineSelect, { target: { value: eng } });
        expect(engineSelect.value).toBe(eng);
        assertNoDecommissionedSelectors(`Engine: ${eng}`);
      }
    });

    it('asserts zero decommissioned selectors after switching tabs back and forth (tab round-trip)', () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      // Switch to Visual tab (where fps-slider exists legally)
      const visualTab = screen.getByRole('tab', { name: /visual/i });
      fireEvent.click(visualTab);
      expect(document.body.querySelector('#fps-slider')).not.toBeNull();

      // Switch back to Speech tab
      const speechTab = screen.getByRole('tab', { name: /speech/i });
      fireEvent.click(speechTab);

      // Now fps-slider MUST be purged
      assertNoDecommissionedSelectors('Post Tab Round-Trip to Visual and Back');
    });

    it('strictly prohibits any textarea or prompt controls inside the Speech task panel', () => {
      render(<CreateSubtitlesModal {...defaultProps} />);
      const speechPanel = screen.getByTestId('speech-task-panel');
      const textareas = speechPanel.querySelectorAll('textarea');
      expect(textareas.length, 'Speech tab must contain 0 textareas').toBe(0);

      // Prohibit token counters
      expect(speechPanel.querySelectorAll('.footer-token-info').length).toBe(0);
      expect(speechPanel.querySelectorAll('[data-testid="token-usage-counter"]').length).toBe(0);
    });
  });

  // =========================================================================
  // DIMENSION 2: IN-FLIGHT CANCELLATION & NEUTRAL FEEDBACK VERIFICATION
  // =========================================================================
  describe('Dimension 2: In-Flight Cancellation Lifecycle & Toast Neutrality', () => {
    it('gracefully cancels during audio extraction stage: dismisses dialog and shows neutral info toast', async () => {
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      // Submit transcription
      const createBtn = screen.getByTestId('create-subtitles-action');
      await act(async () => {
        fireEvent.click(createBtn);
      });

      // Dialog is now executing
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);
      const cancelBtn = screen.getByRole('button', { name: /cancel transcription/i });
      expect(cancelBtn).toBeInTheDocument();

      // Click cancel transcription
      await act(async () => {
        fireEvent.click(cancelBtn);
      });

      // Verification: cancelWordNativeTranscription invoked with active task id
      expect(cancelWordNativeTranscription).toHaveBeenCalledWith('task-test-456');

      // Simulate native engine emitting onCancelled
      act(() => {
        bridgeHandlers.onCancelled?.({
          event: 'cancelled',
          jobId: 'task-test-456',
        });
      });

      // Assertions:
      // 1. Dialog dismisses gracefully via onClose
      expect(onClose).toHaveBeenCalledTimes(1);

      // 2. Neutral info toast emitted
      expect(toastUtils.showInfoToast).toHaveBeenCalledWith(
        expect.stringMatching(/transcription cancelled/i)
      );

      // 3. Red error toast is STRICTLY forbidden
      expect(toastUtils.showErrorToast).not.toHaveBeenCalled();

      // 4. No error element rendered in DOM
      expect(document.body.querySelector('.creation-info-banner.error')).toBeNull();
    });

    it('gracefully cancels during mid-transcription after partial window promotion without losing state', async () => {
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      // Start transcription
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Window 0 promoted with 32 words
      act(() => {
        bridgeHandlers.onStageChanged?.({
          stage: 'transcribing_window_0',
          message: 'Transcribing window 1 of 2...',
          windowIndex: 0,
          totalWindows: 2,
        });
        bridgeHandlers.onWindowPromoted?.({
          event: 'windowPromoted',
          windowIndex: 0,
          totalWindows: 2,
          wordCount: 32,
          turnCount: 3,
        });
      });

      expect(screen.getByText(/words recognized: 32/i)).toBeInTheDocument();

      // User clicks Cancel
      const cancelBtn = screen.getByRole('button', { name: /cancel transcription/i });
      await act(async () => {
        fireEvent.click(cancelBtn);
      });

      // Engine acknowledges cancellation
      act(() => {
        bridgeHandlers.onCancelled?.({ jobId: 'task-test-456' });
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(toastUtils.showInfoToast).toHaveBeenCalledTimes(1);
      expect(toastUtils.showErrorToast).not.toHaveBeenCalled();
    });

    it('handles cancellation when cancelWordNativeTranscription rejects without crashing', async () => {
      cancelWordNativeTranscription.mockRejectedValueOnce(new Error('Tauri IPC timeout'));
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      const cancelBtn = screen.getByRole('button', { name: /cancel transcription/i });
      await act(async () => {
        fireEvent.click(cancelBtn);
      });

      // Even if cancel API rejected, engine eventually fires onCancelled
      act(() => {
        bridgeHandlers.onCancelled?.({ jobId: 'task-test-456' });
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(toastUtils.showErrorToast).not.toHaveBeenCalled();
    });

    it('disables close button and backdrop dismissal while transcription is executing', async () => {
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Close 'X' button must be disabled
      const closeBtn = screen.getByLabelText(/close creation dialog/i);
      expect(closeBtn).toBeDisabled();

      // Click close button -> should not trigger onClose
      fireEvent.click(closeBtn);
      expect(onClose).not.toHaveBeenCalled();

      // Click backdrop overlay -> should not trigger onClose
      const overlay = document.body.querySelector('.create-subtitles-modal-overlay');
      fireEvent.click(overlay);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('verifies Escape key handling while transcription is actively executing', async () => {
      const onClose = vi.fn();
      render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Press Escape while executing
      fireEvent.keyDown(document, { key: 'Escape' });

      // Check whether onClose was invoked prematurely without calling cancelWordNativeTranscription
      const didPrematurelyClose = onClose.mock.calls.length > 0;
      const didCancel = cancelWordNativeTranscription.mock.calls.length > 0;
      console.log(`[Adversarial Escape Check] didPrematurelyClose=${didPrematurelyClose}, didCancel=${didCancel}`);
      expect(didPrematurelyClose).toBe(false);
      expect(didCancel).toBe(true);
    });
  });

  // =========================================================================
  // DIMENSION 3: QUOTA EXHAUSTION (429) & MISSING AUDIO ERROR RECOVERY CARDS
  // =========================================================================
  describe('Dimension 3: Simulated 429 Quota Exhaustion & Missing Audio Errors', () => {
    it('surfaces actionable recovery card for Gemini Quota Exhaustion (429)', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Simulate native engine emitting 429 quota exhaustion failure
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-456',
          error: {
            code: 'window_failed',
            message: 'Resource exhausted: quota exceeded (429) for gemini-3.5-transcribe',
            windowIndex: 0,
            retryable: false,
          },
        });
      });

      // Verification of actionable recovery card:
      // 1. Role is alert for accessibility
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveClass('creation-info-banner', 'error');

      // 2. Specific Quota Exceeded title is presented
      expect(screen.getByText(/gemini api quota exceeded/i)).toBeInTheDocument();
      expect(screen.getByText(/resource exhausted: quota exceeded \(429\)/i)).toBeInTheDocument();

      // 3. Actionability: Dialog remains open, retry button re-enabled
      const retryBtn = screen.getByTestId('create-subtitles-action');
      expect(retryBtn).not.toBeDisabled();

      // 4. User can switch to Local ASR to recover immediately without quota
      const engineSelect = screen.getByLabelText(/engine/i);
      fireEvent.change(engineSelect, { target: { value: 'local-asr' } });
      expect(engineSelect.value).toBe('local-asr');

      // 5. Retrying with local-asr delegates to alternative method
      const onProcess = defaultProps.onProcess;
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      expect(onProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          task: 'Speech',
          engine: 'local-asr',
          method: 'nvidia-parakeet',
        })
      );
    });

    it('allows retrying native transcription directly in-dialog after initial failure', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      // First attempt
      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

      // Simulate failure
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-fail',
          error: {
            code: 'window_failed',
            message: 'Temporary network disconnect',
            windowIndex: 0,
            retryable: true,
          },
        });
      });

      // Assert error alert is visible and retry button is enabled
      expect(screen.getByRole('alert')).toBeInTheDocument();
      const retryBtn = screen.getByTestId('create-subtitles-action');
      expect(retryBtn).not.toBeDisabled();

      // Click retry without switching engine (still gemini-3.5-transcribe)
      await act(async () => {
        fireEvent.click(retryBtn);
      });

      // Must initiate a new native transcription call, NOT locked out!
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(2);
    });

    it('checks title categorization when 429 error code is quota_exceeded rather than window_failed', async () => {
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
            message: 'Resource exhausted: quota exceeded (429)',
            windowIndex: 0,
            retryable: false,
          },
        });
      });

      const hasQuotaTitle = screen.queryByText(/gemini api quota exceeded/i) !== null;
      const hasGenericTitle = screen.queryByText(/transcription failed/i) !== null;
      console.log(`[Adversarial Quota Code Check] hasQuotaTitle=${hasQuotaTitle}, hasGenericTitle=${hasGenericTitle}`);
      expect(hasQuotaTitle).toBe(true);
      expect(hasGenericTitle).toBe(false);
    });

    it('surfaces actionable recovery card for Missing Audio Track in media asset', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Simulate audio extraction failure due to missing audio stream
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-456',
          error: {
            code: 'window_failed',
            message: 'Pipeline error: the selected media has no audio stream',
            windowIndex: 0,
            retryable: false,
          },
        });
      });

      // Assertions:
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();

      // Specific missing audio header
      expect(screen.getByText(/no audio track found/i)).toBeInTheDocument();
      expect(screen.getByText(/the selected media has no audio stream/i)).toBeInTheDocument();

      // Dialog remains usable: user can cancel
      const cancelBtn = screen.getByRole('button', { name: /^cancel$/i });
      expect(cancelBtn).not.toBeDisabled();
      fireEvent.click(cancelBtn);
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it('checks case-sensitivity for audio track error message matching', async () => {
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
            message: 'Pipeline error: No Audio Stream Found', // Capitalized "Audio"
            windowIndex: 0,
            retryable: false,
          },
        });
      });

      const hasAudioTitle = screen.queryByText(/no audio track found/i) !== null;
      const hasGenericTitle = screen.queryByText(/transcription failed/i) !== null;
      console.log(`[Adversarial Audio Case Check] hasAudioTitle=${hasAudioTitle}, hasGenericTitle=${hasGenericTitle}`);
      expect(hasAudioTitle).toBe(true);
      expect(hasGenericTitle).toBe(false);
    });

    it('displays partial progress and saved words on mid-job failure', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Window 0 succeeds with 50 words
      act(() => {
        bridgeHandlers.onWindowPromoted?.({
          event: 'windowPromoted',
          windowIndex: 0,
          totalWindows: 3,
          wordCount: 50,
          turnCount: 5,
        });
      });

      // Window 1 fails with 429
      act(() => {
        bridgeHandlers.onFailed?.({
          event: 'failed',
          jobId: 'task-test-456',
          error: {
            code: 'window_failed',
            message: 'Resource exhausted: quota exceeded (429)',
            windowIndex: 1,
            retryable: false,
          },
        });
      });

      // Assert partial transcription preservation banner is visible
      const alert = screen.getByRole('alert');
      expect(screen.getByText(/gemini api quota exceeded/i)).toBeInTheDocument();
      expect(
        screen.getByText(/1 of 3 windows completed \(50 words saved\)/i)
      ).toBeInTheDocument();
    });
  });

  // =========================================================================
  // DIMENSION 4: CONCURRENCY, RAPID CANCELLATION & EDGE CASES
  // =========================================================================
  describe('Dimension 4: Concurrency, Rapid Interaction & Edge Cases', () => {
    it('guards against multiple concurrent startTranscription clicks', async () => {
      render(<CreateSubtitlesModal {...defaultProps} />);

      const createBtn = screen.getByTestId('create-subtitles-action');

      await act(async () => {
        fireEvent.click(createBtn);
        fireEvent.click(createBtn);
      });

      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);
    });

    it('handles unexpected client error during startWordNativeTranscription invocation', async () => {
      startWordNativeTranscription.mockRejectedValueOnce(new Error('IPC channel unavailable'));
      render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Error alert shown with invocation failed message
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(screen.getByText(/ipc channel unavailable/i)).toBeInTheDocument();

      // UI returns to non-executing state
      expect(screen.getByTestId('create-subtitles-action')).not.toBeDisabled();
    });

    it('verifies unmount behavior while transcription start is pending', async () => {
      let resolveStart;
      startWordNativeTranscription.mockImplementationOnce(() => {
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      });

      const { unmount } = render(<CreateSubtitlesModal {...defaultProps} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('create-subtitles-action'));
      });

      // Unmount modal while start promise is pending
      unmount();

      // Now resolve the promise
      await act(async () => {
        resolveStart({ id: 'task-late-999' });
      });

      // Should not throw uncaught error
      expect(cancelWordNativeTranscription).not.toHaveBeenCalled();
    });
  });
});
