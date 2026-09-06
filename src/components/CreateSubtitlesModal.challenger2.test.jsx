import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React, { useState, useEffect } from 'react';
import CreateSubtitlesModal from './CreateSubtitlesModal';
import { formatTimeHms, validateRangeDuration, ScopeSelector } from './ScopeSelector';
import useFocusTrap from './useFocusTrap';
import { startWordNativeTranscription } from '../platform/nativeWordTranscription';

vi.mock('../platform/nativeWordTranscription', () => ({
  startWordNativeTranscription: vi.fn(),
  cancelWordNativeTranscription: vi.fn().mockResolvedValue({ id: 'task-test' }),
  isNativeWordTranscriptionSupported: vi.fn().mockReturnValue(true),
}));

describe('Challenger 1 Adversarial Suite: Extreme Range Boundaries & Focus Stability', () => {

  describe('Dimension 1: Deep Boundary & Extreme Values for validateRangeDuration', () => {
    it('strictly rejects negative start values regardless of end value or duration', () => {
      expect(validateRangeDuration(-1, 10).valid).toBe(false);
      expect(validateRangeDuration(-0.0001, 1).valid).toBe(false);
      expect(validateRangeDuration(-10, -5).valid).toBe(false);
      expect(validateRangeDuration(-1e-9, 10).valid).toBe(false);
      expect(validateRangeDuration(-Infinity, 10).valid).toBe(false);
    });

    it('strictly rejects negative end values', () => {
      expect(validateRangeDuration(0, -1).valid).toBe(false);
      expect(validateRangeDuration(-10, -1).valid).toBe(false);
      expect(validateRangeDuration(5, -0.0001).valid).toBe(false);
      expect(validateRangeDuration(0, -Infinity).valid).toBe(false);
    });

    it('strictly rejects inverted ranges where start > end', () => {
      expect(validateRangeDuration(10, 5).valid).toBe(false);
      expect(validateRangeDuration(100, 0).valid).toBe(false);
      expect(validateRangeDuration(1.0001, 1.0).valid).toBe(false);
      expect(validateRangeDuration(500, 499.5).valid).toBe(false);
      expect(validateRangeDuration(10, -10).valid).toBe(false);
    });

    it('strictly rejects equal start and end (0ms duration)', () => {
      expect(validateRangeDuration(0, 0).valid).toBe(false);
      expect(validateRangeDuration(10, 10).valid).toBe(false);
      expect(validateRangeDuration(36000, 36000).valid).toBe(false);
    });

    it('sub-millisecond duration checks near 500ms threshold', () => {
      // 0ms to 498.9ms -> invalid
      expect(validateRangeDuration(0, 0.4989).valid).toBe(false);
      // 499.0ms -> invalid
      expect(validateRangeDuration(0, 0.4990).valid).toBe(false);
      // 499.4ms -> invalid
      expect(validateRangeDuration(0, 0.4994).valid).toBe(false);
      // Exactly 500ms -> valid
      expect(validateRangeDuration(0, 0.500).valid).toBe(true);
      // 500.1ms -> valid
      expect(validateRangeDuration(0, 0.5001).valid).toBe(true);
      // Large offset with 500ms duration
      expect(validateRangeDuration(36000, 36000.5).valid).toBe(true);
      // Large offset with 499ms duration
      expect(validateRangeDuration(36000, 36000.499).valid).toBe(false);
    });

    it('strictly rejects non-finite and special numeric values', () => {
      expect(validateRangeDuration(Infinity, Infinity).valid).toBe(false);
      expect(validateRangeDuration(0, Infinity).valid).toBe(false);
      expect(validateRangeDuration(Infinity, 100).valid).toBe(false);
      expect(validateRangeDuration(-Infinity, Infinity).valid).toBe(false);
      expect(validateRangeDuration(NaN, 10).valid).toBe(false);
      expect(validateRangeDuration(10, NaN).valid).toBe(false);
      expect(validateRangeDuration(NaN, NaN).valid).toBe(false);
    });

    it('strictly rejects non-number types (type safety against accidental string/object injection)', () => {
      expect(validateRangeDuration('0', '10').valid).toBe(false);
      expect(validateRangeDuration(0, '10').valid).toBe(false);
      expect(validateRangeDuration(null, 10).valid).toBe(false);
      expect(validateRangeDuration(10, null).valid).toBe(false);
      expect(validateRangeDuration(undefined, 10).valid).toBe(false);
      expect(validateRangeDuration(10, undefined).valid).toBe(false);
      expect(validateRangeDuration({}, []).valid).toBe(false);
      expect(validateRangeDuration(true, false).valid).toBe(false);
    });

    it('handles extreme > 10 hours and > 100 hours valid ranges safely', () => {
      // 10 hours: 36000s to 36010s (10s)
      expect(validateRangeDuration(36000, 36010).valid).toBe(true);
      // 100 hours: 360000s to 360005s (5s)
      expect(validateRangeDuration(360000, 360005).valid).toBe(true);
      // 1000 hours: 3600000s to 3600001s (1s)
      expect(validateRangeDuration(3600000, 3600001).valid).toBe(true);
    });
  });

  describe('Dimension 2: Extreme Values for formatTimeHms', () => {
    it('formats extreme >10 hours, >100 hours, and >1000 hours correctly', () => {
      expect(formatTimeHms(36000)).toBe('10:00:00'); // 10h exact
      expect(formatTimeHms(36185)).toBe('10:03:05'); // 10h 3m 5s
      expect(formatTimeHms(72000)).toBe('20:00:00'); // 20h
      expect(formatTimeHms(360000)).toBe('100:00:00'); // 100h
      expect(formatTimeHms(360061)).toBe('100:01:01'); // 100h 1m 1s
      expect(formatTimeHms(3600000)).toBe('1000:00:00'); // 1000h
    });

    it('formats boundary conditions (0, negative, sub-second, non-finite)', () => {
      expect(formatTimeHms(0)).toBe('00:00');
      expect(formatTimeHms(-0)).toBe('00:00');
      expect(formatTimeHms(-1)).toBe('00:00');
      expect(formatTimeHms(-99999)).toBe('00:00');
      expect(formatTimeHms(0.499)).toBe('00:00');
      expect(formatTimeHms(0.999)).toBe('00:00');
      expect(formatTimeHms(1)).toBe('00:01');
      expect(formatTimeHms(59.9)).toBe('00:59');
      expect(formatTimeHms(60)).toBe('01:00');
      expect(formatTimeHms(3599.9)).toBe('59:59');
      expect(formatTimeHms(3600)).toBe('01:00:00');
      expect(formatTimeHms(Infinity)).toBe('00:00');
      expect(formatTimeHms(-Infinity)).toBe('00:00');
      expect(formatTimeHms(NaN)).toBe('00:00');
      expect(formatTimeHms(null)).toBe('00:00');
      expect(formatTimeHms(undefined)).toBe('00:00');
      expect(formatTimeHms('invalid')).toBe('00:00');
    });
  });

  describe('Dimension 3: Modal UI Integration with Extreme & Adversarial Range Values', () => {
    const baseProps = {
      isOpen: true,
      onClose: vi.fn(),
      onProcess: vi.fn(),
      videoFile: { assetId: 'media-extreme', name: 'extreme_journey.mp4' },
      videoDuration: 36000, // 10 hours
    };

    it('blocks submission and shows error banner for sub-millisecond range (< 500ms)', () => {
      render(
        <CreateSubtitlesModal
          {...baseProps}
          selectedSegment={{ start: 100.0, end: 100.499 }}
        />
      );

      const submitBtn = screen.getByTestId('create-subtitles-action');
      expect(submitBtn).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(/selection range too short/i);
    });

    it('blocks submission for inverted range (start > end)', () => {
      render(
        <CreateSubtitlesModal
          {...baseProps}
          selectedSegment={{ start: 500, end: 200 }}
        />
      );

      const submitBtn = screen.getByTestId('create-subtitles-action');
      expect(submitBtn).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(/selection range too short/i);
    });

    it('blocks submission for negative range offsets', () => {
      render(
        <CreateSubtitlesModal
          {...baseProps}
          selectedSegment={{ start: -10, end: 10 }}
        />
      );

      const submitBtn = screen.getByTestId('create-subtitles-action');
      expect(submitBtn).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(/selection range too short/i);
    });

    it('blocks submission for NaN and non-finite range values', () => {
      render(
        <CreateSubtitlesModal
          {...baseProps}
          selectedSegment={{ start: NaN, end: 100 }}
        />
      );

      const submitBtn = screen.getByTestId('create-subtitles-action');
      expect(submitBtn).toBeDisabled();
    });

    it('renders extreme >10 hour range in ScopeSelector without layout breakage or NaN', () => {
      render(
        <CreateSubtitlesModal
          {...baseProps}
          videoDuration={72000}
          selectedSegment={{ start: 36000, end: 36185.5 }}
        />
      );

      const badge = screen.getByTestId('scope-duration-badge');
      expect(badge).toHaveTextContent('10:00:00 – 10:03:05 (185.5s)');

      const submitBtn = screen.getByTestId('create-subtitles-action');
      expect(submitBtn).not.toBeDisabled();
    });

    it('safely clamps range coordinates to non-negative integers on submit', async () => {
      const onProcess = vi.fn();
      render(
        <CreateSubtitlesModal
          {...baseProps}
          initialTask="Speech"
          onProcess={onProcess}
          selectedSegment={{ start: 10.5, end: 15.2 }}
        />
      );

      // Switch engine to local-asr to directly trigger onProcess
      const engineSelect = screen.getByLabelText(/^Engine/i);
      fireEvent.change(engineSelect, { target: { value: 'local-asr' } });

      const submitBtn = screen.getByTestId('create-subtitles-action');
      fireEvent.click(submitBtn);

      expect(onProcess).toHaveBeenCalledTimes(1);
      const callArg = onProcess.mock.calls[0][0];
      expect(callArg.segment).toEqual({ start: 10.5, end: 15.2 });
    });
  });

  describe('Dimension 4: Focus Trap Stability Under Rapid Parent Re-rendering (Zero Focus Stealing)', () => {
    let triggerBtn;
    let testContainer;

    beforeEach(() => {
      testContainer = document.createElement('div');
      document.body.appendChild(testContainer);

      triggerBtn = document.createElement('button');
      triggerBtn.id = 'external-trigger-btn';
      triggerBtn.textContent = 'Open Dialog';
      testContainer.appendChild(triggerBtn);
      triggerBtn.focus();
    });

    afterEach(() => {
      if (testContainer && testContainer.parentNode) {
        testContainer.parentNode.removeChild(testContainer);
      }
      vi.clearAllMocks();
    });

    it('confirms ZERO focus stealing when parent re-renders 100 times while modal control is active', () => {
      triggerBtn.focus();
      expect(document.activeElement).toBe(triggerBtn);

      const RapidReRenderParent = () => {
        const [renderCount, setRenderCount] = useState(0);
        const [playbackTime, setPlaybackTime] = useState(0);

        // Expose a way to blast re-renders
        useEffect(() => {
          window.__triggerRapidRerender = (count = 100) => {
            for (let i = 0; i < count; i++) {
              act(() => {
                setRenderCount((c) => c + 1);
                setPlaybackTime((t) => t + 0.016); // simulate 60fps timeupdate
              });
            }
          };
          return () => {
            delete window.__triggerRapidRerender;
          };
        }, []);

        return (
          <div>
            <div data-testid="render-counter">Renders: {renderCount}</div>
            <CreateSubtitlesModal
              isOpen={true}
              onClose={() => {}} // recreated on every render
              onProcess={() => {}} // recreated on every render
              videoDuration={3600}
              videoFile={{ name: 'clip.mp4' }}
            />
          </div>
        );
      };

      render(<RapidReRenderParent />);

      // Focus an input element inside the modal
      const languageSelect = screen.getByLabelText(/language/i);
      languageSelect.focus();
      expect(document.activeElement).toBe(languageSelect);

      // Execute 100 rapid parent re-renders
      window.__triggerRapidRerender(100);

      expect(screen.getByTestId('render-counter')).toHaveTextContent('Renders: 100');

      // CRITICAL ASSERTION: Focus must NOT have been stolen by the parent or returned to triggerBtn!
      expect(document.activeElement).toBe(languageSelect);
      expect(document.activeElement).not.toBe(triggerBtn);
    });

    it('confirms ZERO focus stealing when focusing custom textarea during 50 parent re-renders', () => {
      const RapidReRenderVisual = () => {
        const [tick, setTick] = useState(0);

        return (
          <div>
            <button id="tick-btn" onClick={() => setTick((t) => t + 1)}>Tick: {tick}</button>
            <CreateSubtitlesModal
              isOpen={true}
              initialTask="VisualCustom"
              onClose={() => {}}
              videoDuration={120}
              videoFile={{ name: 'sample.mp4' }}
            />
          </div>
        );
      };

      render(<RapidReRenderVisual />);

      // Switch to custom subtask
      fireEvent.click(screen.getByTestId('subtask-custom'));
      const customTextarea = screen.getByLabelText(/custom prompt instructions/i);
      customTextarea.focus();
      expect(document.activeElement).toBe(customTextarea);

      // Blast 50 re-renders via tick button
      const tickBtn = screen.getByText(/tick:/i);
      for (let i = 0; i < 50; i++) {
        act(() => {
          tickBtn.click();
        });
      }

      // Assert focus is still firmly on customTextarea
      expect(document.activeElement).toBe(customTextarea);
    });

    it('confirms tab cycling wraps without focus escaping to outer document', () => {
      const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get() {
          return this.parentNode;
        },
      });

      try {
        render(
          <CreateSubtitlesModal
            isOpen={true}
            onClose={() => {}}
            videoDuration={120}
            videoFile={{ name: 'clip.mp4' }}
          />
        );

        const modal = screen.getByRole('dialog');
        expect(modal).toBeInTheDocument();

        // Get all focusable elements inside modal
        const focusable = Array.from(
          modal.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')
        );
        expect(focusable.length).toBeGreaterThan(0);

        const firstElement = focusable[0];
        const lastElement = focusable[focusable.length - 1];

        // Focus last element and press Tab -> should wrap to firstElement
        lastElement.focus();
        expect(document.activeElement).toBe(lastElement);

        const tabForward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        document.dispatchEvent(tabForward);
        expect(document.activeElement).toBe(firstElement);

        // Focus first element and press Shift+Tab -> should wrap to lastElement
        firstElement.focus();
        expect(document.activeElement).toBe(firstElement);

        const tabBackward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(tabBackward);
        expect(document.activeElement).toBe(lastElement);
      } finally {
        if (originalOffsetParent) {
          Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent);
        } else {
          delete HTMLElement.prototype.offsetParent;
        }
      }
    });

    it('restores focus cleanly to previousActiveElement when modal is closed', () => {
      triggerBtn.focus();
      expect(document.activeElement).toBe(triggerBtn);

      const ModalHarness = () => {
        const [isOpen, setIsOpen] = useState(true);
        return (
          <div>
            <button id="close-trigger" onClick={() => setIsOpen(false)}>Close</button>
            <CreateSubtitlesModal
              isOpen={isOpen}
              onClose={() => setIsOpen(false)}
              videoDuration={60}
            />
          </div>
        );
      };

      render(<ModalHarness />);

      // Close modal
      const closeBtn = screen.getByText('Close');
      act(() => {
        closeBtn.click();
      });

      // Dialog is removed
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      // Focus should be restored to triggerBtn
      expect(document.activeElement).toBe(triggerBtn);
    });
  });

  describe('Dimension 5: Concurrency Re-entrance and In-Flight Invalidation', () => {
    it('synchronously blocks duplicate clicks on Create Subtitles button before async resolution', async () => {
      let resolveJob;
      startWordNativeTranscription.mockImplementation(
        () => new Promise((resolve) => {
          resolveJob = resolve;
        })
      );

      render(
        <CreateSubtitlesModal
          isOpen={true}
          initialTask="Speech"
          onClose={() => {}}
          onProcess={() => {}}
          videoFile={{ assetId: 'asset-1', name: 'sample.mp4' }}
          videoDuration={100}
        />
      );

      const submitBtn = screen.getByTestId('create-subtitles-action');

      // Blast 10 rapid clicks synchronously before bridge resolves
      await act(async () => {
        for (let i = 0; i < 10; i++) {
          fireEvent.click(submitBtn);
        }
      });

      // The underlying native IPC invoke should only have been called ONCE
      expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);

      // Resolve job
      act(() => {
        resolveJob?.({
          taskId: 'task-1',
          state: 'completed',
        });
      });
    });

    it('invokes the freshest onClose callback when Escape is pressed after 100 parent re-renders', () => {
      let callHistory = [];

      const DynamicOnCloseParent = () => {
        const [renderId, setRenderId] = useState(0);

        // Expose render trigger
        useEffect(() => {
          window.__triggerParentRender = () => setRenderId((r) => r + 1);
        }, []);

        return (
          <div>
            <span data-testid="render-indicator">Render: {renderId}</span>
            <CreateSubtitlesModal
              isOpen={true}
              onClose={() => {
                callHistory.push(renderId);
              }}
              videoDuration={60}
            />
          </div>
        );
      };

      render(<DynamicOnCloseParent />);

      // Re-render 100 times, creating 100 distinct onClose closures
      for (let i = 0; i < 100; i++) {
        act(() => {
          window.__triggerParentRender();
        });
      }

      expect(screen.getByTestId('render-indicator')).toHaveTextContent('Render: 100');

      // Press Escape
      fireEvent.keyDown(document, { key: 'Escape' });

      // Must call the latest closure (100), not a stale closure (0 or older)
      expect(callHistory).toEqual([100]);
    });

    it('toggles scope 50 times between Whole video and Selected range without state corruption', () => {
      render(
        <CreateSubtitlesModal
          isOpen={true}
          videoDuration={120}
          selectedSegment={{ start: 10, end: 25 }}
        />
      );

      const wholeBtn = screen.getByTestId('scope-whole-video');
      const rangeBtn = screen.getByTestId('scope-selected-range');

      for (let i = 0; i < 25; i++) {
        fireEvent.click(wholeBtn);
        expect(wholeBtn).toHaveClass('active');
        expect(rangeBtn).not.toHaveClass('active');

        fireEvent.click(rangeBtn);
        expect(rangeBtn).toHaveClass('active');
        expect(wholeBtn).not.toHaveClass('active');
      }

      // Check duration badge
      const badge = screen.getByTestId('scope-duration-badge');
      expect(badge).toHaveTextContent('00:10 – 00:25 (15.0s)');
    });
  });
});

