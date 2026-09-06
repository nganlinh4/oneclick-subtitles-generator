import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React, { useState } from 'react';
import CreateSubtitlesModal from './CreateSubtitlesModal';
import { formatTimeHms, validateRangeDuration, ScopeSelector } from './ScopeSelector';
import useFocusTrap from './useFocusTrap';

describe('Adversarial Challenge: Range Boundaries & Formatting', () => {
  describe('validateRangeDuration unit checks', () => {
    it('refuses duration strictly less than 500ms', () => {
      expect(validateRangeDuration(10, 10.499)).toEqual({
        valid: false,
        error: 'Selection range too short (minimum 500ms)',
      });
      expect(validateRangeDuration(0, 0.499).valid).toBe(false);
      expect(validateRangeDuration(10, 10).valid).toBe(false);
    });

    it('accepts duration >= 500ms for positive non-inverted ranges', () => {
      expect(validateRangeDuration(10, 10.5)).toEqual({ valid: true });
      expect(validateRangeDuration(0, 0.5)).toEqual({ valid: true });
      expect(validateRangeDuration(100, 100.5)).toEqual({ valid: true });
    });

    it('handles inverted ranges (start > end)', () => {
      // Inverted positive range
      const result = validateRangeDuration(20, 10);
      expect(result.valid).toBe(false);
    });

    it('EMPIRICAL BUG CHECK: handles negative range values in validateRangeDuration', () => {
      // What happens if startSec is negative and endSec is negative, but endSec - startSec >= 0.5?
      // e.g. start = -10, end = -5 -> end - start = 5s (5000ms >= 500ms)
      const negativeBoth = validateRangeDuration(-10, -5);
      // BUG: Currently returns { valid: true }!
      // Strict requirement: Negative time offsets are invalid media positions.
      expect(negativeBoth.valid).toBe(false);

      const negativeStart = validateRangeDuration(-5, 10);
      expect(negativeStart.valid).toBe(false);
    });
  });

  describe('formatTimeHms unit checks', () => {
    it('formats durations >= 10 hours with 2-digit padded hours (HH:MM:SS)', () => {
      expect(formatTimeHms(36000)).toBe('10:00:00'); // 10h exact
      expect(formatTimeHms(36185)).toBe('10:03:05'); // 10h 3m 5s
      expect(formatTimeHms(360000)).toBe('100:00:00'); // 100h
    });

    it('formats durations < 10 hours and < 1 hour', () => {
      expect(formatTimeHms(3600)).toBe('01:00:00'); // 1h
      expect(formatTimeHms(3599)).toBe('59:59'); // 59m 59s
      expect(formatTimeHms(65)).toBe('01:05');
      expect(formatTimeHms(0)).toBe('00:00');
    });

    it('handles negative, null, undefined, NaN, and Infinity safely', () => {
      expect(formatTimeHms(-10)).toBe('00:00');
      expect(formatTimeHms(null)).toBe('00:00');
      expect(formatTimeHms(undefined)).toBe('00:00');
      expect(formatTimeHms(NaN)).toBe('00:00');
      // BUG: formatTimeHms(Infinity) produces "Infinity:NaN:NaN"
      const infResult = formatTimeHms(Infinity);
      expect(infResult).not.toContain('NaN');
    });
  });

  describe('Modal UI Range boundary enforcement', () => {
    const defaultProps = {
      isOpen: true,
      onClose: vi.fn(),
      onProcess: vi.fn(),
      videoFile: { assetId: 'media-1', name: 'sample.mp4' },
      videoDuration: 120,
    };

    it('blocks submission and shows error for inverted range (start > end)', () => {
      render(
        <CreateSubtitlesModal
          {...defaultProps}
          selectedSegment={{ start: 50, end: 20 }}
        />
      );

      const submitBtn = screen.getByTestId('create-subtitles-action');
      expect(submitBtn).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(/selection range too short/i);
    });

    it('EMPIRICAL BUG CHECK: negative ranges in CreateSubtitlesModal', () => {
      const onProcess = vi.fn();
      render(
        <CreateSubtitlesModal
          {...defaultProps}
          onProcess={onProcess}
          selectedSegment={{ start: -10, end: -5 }}
        />
      );

      const submitBtn = screen.getByTestId('create-subtitles-action');
      // Negative range MUST disable submit button
      expect(submitBtn).toBeDisabled();
    });

    it('EMPIRICAL BUG CHECK: negative start with positive end in CreateSubtitlesModal', () => {
      const onProcess = vi.fn();
      render(
        <CreateSubtitlesModal
          {...defaultProps}
          onProcess={onProcess}
          selectedSegment={{ start: -5, end: 10 }}
        />
      );

      const submitBtn = screen.getByTestId('create-subtitles-action');
      // Negative start time MUST disable submit button or clamp to 0
      expect(submitBtn).toBeDisabled();
    });

    it('displays extreme >10h durations in ScopeSelector and summary without crashing', () => {
      const tenHours = 36185; // 10:03:05
      render(
        <CreateSubtitlesModal
          {...defaultProps}
          videoDuration={tenHours}
          selectedSegment={{ start: 36000, end: 36185 }}
        />
      );

      const badge = screen.getByTestId('scope-duration-badge');
      expect(badge).toHaveTextContent('10:00:00 – 10:03:05 (185.0s)');

      // Check summary line
      expect(screen.getByText(/10:00:00–10:03:05/)).toBeInTheDocument();
    });
  });
});

describe('Adversarial Challenge: Audio-Only File Loading in Visual Tab', () => {
  const audioProps = {
    isOpen: true,
    onClose: vi.fn(),
    onProcess: vi.fn(),
    initialTask: 'VisualCustom',
    videoDuration: 180,
  };

  it('identifies audio-only from kind === "audio"', () => {
    render(
      <CreateSubtitlesModal
        {...audioProps}
        videoFile={{ kind: 'audio', name: 'audio.bin' }}
      />
    );
    expect(screen.getByText(/this task requires video frames/i)).toBeInTheDocument();
    expect(screen.getByTestId('subtask-ocr')).toBeDisabled();
    expect(screen.getByTestId('subtask-descriptions')).toBeDisabled();
    expect(screen.getByTestId('subtask-chapters')).toBeDisabled();
    expect(screen.getByTestId('subtask-custom')).not.toBeDisabled();
  });

  it('identifies audio-only from mime-type starting with "audio/"', () => {
    render(
      <CreateSubtitlesModal
        {...audioProps}
        videoFile={{ type: 'audio/wav', name: 'recording.wav' }}
      />
    );
    expect(screen.getByText(/this task requires video frames/i)).toBeInTheDocument();
  });

  it('identifies audio-only from extensions: mp3, wav, ogg, flac, m4a, aac, wma', () => {
    const audioExts = ['track.MP3', 'rec.WAV', 'sound.ogg', 'audio.flac', 'voice.M4A', 'stream.aac', 'sample.wma'];
    for (const filename of audioExts) {
      const { unmount } = render(
        <CreateSubtitlesModal
          {...audioProps}
          videoFile={{ name: filename }}
        />
      );
      expect(screen.getByText(/this task requires video frames/i)).toBeInTheDocument();
      unmount();
    }
  });

  it('does NOT disable visual subtasks when loading a video file (.mp4, .mkv, .mov, etc.)', () => {
    render(
      <CreateSubtitlesModal
        {...audioProps}
        videoFile={{ name: 'video.mp4', type: 'video/mp4' }}
      />
    );
    expect(screen.queryByText(/this task requires video frames/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('subtask-ocr')).not.toBeDisabled();
    expect(screen.getByTestId('subtask-descriptions')).not.toBeDisabled();
    expect(screen.getByTestId('subtask-chapters')).not.toBeDisabled();
  });

  it('disables submit button when Visual subtask is ocr, descriptions, or chapters on audio file', () => {
    render(
      <CreateSubtitlesModal
        {...audioProps}
        videoFile={{ kind: 'audio', name: 'podcast.mp3' }}
      />
    );
    const submitBtn = screen.getByTestId('create-subtitles-action');
    expect(submitBtn).toBeDisabled();
  });

  it('enables submit button when Visual subtask is custom prompt on audio file', () => {
    const onProcess = vi.fn();
    render(
      <CreateSubtitlesModal
        {...audioProps}
        onProcess={onProcess}
        videoFile={{ kind: 'audio', name: 'podcast.mp3' }}
      />
    );

    // Switch subtask to custom
    const customPill = screen.getByTestId('subtask-custom');
    fireEvent.click(customPill);

    const submitBtn = screen.getByTestId('create-subtitles-action');
    expect(submitBtn).not.toBeDisabled();

    // Click submit and inspect onProcess payload
    fireEvent.click(submitBtn);
    expect(onProcess).toHaveBeenCalledTimes(1);
    const payload = onProcess.mock.calls[0][0];
    // BUG: Line 289 of CreateSubtitlesModal.jsx hardcodes `audioOnly: false` for VisualCustom,
    // even when isAudioOnly is true and videoFile is an audio file!
    expect(payload.audioOnly).toBe(true);
  });
});

describe('Adversarial Challenge: Rapid Tab Switching & State Retention', () => {
  it('rapidly switches between tabs 30 times without crashing or losing state', () => {
    render(
      <CreateSubtitlesModal
        isOpen={true}
        onClose={vi.fn()}
        onProcess={vi.fn()}
        videoFile={{ name: 'clip.mp4' }}
        videoDuration={60}
        subtitlesData={[{ id: '1', text: 'Existing transcript' }]}
      />
    );

    // Set custom values in Speech tab
    const diarizationCheckbox = screen.getByLabelText(/identify speakers/i);
    fireEvent.click(diarizationCheckbox);
    expect(diarizationCheckbox).toBeChecked();

    // Switch to Translate tab and set target language
    fireEvent.click(screen.getByRole('tab', { name: /translate/i }));
    const langSelect = screen.getByLabelText(/target language/i);
    fireEvent.change(langSelect, { target: { value: 'ko' } });
    expect(langSelect.value).toBe('ko');

    // Switch to Visual tab and set custom prompt
    fireEvent.click(screen.getByRole('tab', { name: /visual/i }));
    fireEvent.click(screen.getByTestId('subtask-custom'));
    const promptInput = screen.getByLabelText(/custom prompt instructions/i);
    fireEvent.change(promptInput, { target: { value: 'Adversarial visual prompt rule' } });
    expect(promptInput.value).toBe('Adversarial visual prompt rule');

    // Rapidly switch tabs 30 times
    const tabNames = [/speech/i, /translate/i, /visual/i];
    for (let i = 0; i < 30; i++) {
      const tabTarget = tabNames[i % 3];
      fireEvent.click(screen.getByRole('tab', { name: tabTarget }));
    }

    // Verify all states are intact
    fireEvent.click(screen.getByRole('tab', { name: /speech/i }));
    expect(screen.getByLabelText(/identify speakers/i)).toBeChecked();

    fireEvent.click(screen.getByRole('tab', { name: /translate/i }));
    expect(screen.getByLabelText(/target language/i).value).toBe('ko');

    fireEvent.click(screen.getByRole('tab', { name: /visual/i }));
    expect(screen.getByTestId('subtask-custom')).toHaveClass('active');
    expect(screen.getByLabelText(/custom prompt instructions/i).value).toBe('Adversarial visual prompt rule');
  });
});

describe('Adversarial Challenge: Focus Trap, Escape Cycles & Focus Restoration', () => {
  let triggerBtn;
  let testContainer;

  beforeEach(() => {
    localStorage.clear();
    testContainer = document.createElement('div');
    document.body.appendChild(testContainer);

    triggerBtn = document.createElement('button');
    triggerBtn.id = 'trigger-btn';
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

  it('restores focus to the triggering button when modal closes via Escape', async () => {
    triggerBtn.focus();
    expect(document.activeElement).toBe(triggerBtn);

    const TestHarness = () => {
      const [isOpen, setIsOpen] = useState(true);
      return (
        <div>
          <CreateSubtitlesModal
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            videoDuration={60}
          />
        </div>
      );
    };

    render(<TestHarness />);

    // Press Escape
    fireEvent.keyDown(document, { key: 'Escape' });

    // Verify modal is closed
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Verify focus was restored to triggerBtn
    expect(document.activeElement).toBe(triggerBtn);
  });

  it('rapidly cycles open and Escape 20 times without listener leakage', () => {
    const onCloseSpy = vi.fn();

    const TestHarness = () => {
      const [isOpen, setIsOpen] = useState(false);
      return (
        <div>
          <button id="toggle" onClick={() => setIsOpen((prev) => !prev)}>Toggle</button>
          <CreateSubtitlesModal
            isOpen={isOpen}
            onClose={() => {
              onCloseSpy();
              setIsOpen(false);
            }}
            videoDuration={60}
          />
        </div>
      );
    };

    render(<TestHarness />);
    const toggleBtn = screen.getByText('Toggle');

    for (let i = 0; i < 20; i++) {
      fireEvent.click(toggleBtn); // Open
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' }); // Close via Escape
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    }

    expect(onCloseSpy).toHaveBeenCalledTimes(20);
  });

  it('EMPIRICAL FOCUS TRAP CHECK: Tab cycling with browser layout simulation', () => {
    // Simulate browser layout where offsetParent returns parentNode
    const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() {
        return this.parentNode;
      },
    });

    try {
      const FocusTrapTester = ({ isActive }) => {
        const containerRef = React.useRef(null);
        useFocusTrap(containerRef, isActive);

        return (
          <div ref={containerRef}>
            <button id="btn1">Button 1</button>
            <button id="btn2">Button 2</button>
            <button id="btn3">Button 3</button>
          </div>
        );
      };

      const { unmount } = render(<FocusTrapTester isActive={true} />);
      const btn1 = screen.getByText('Button 1');
      const btn2 = screen.getByText('Button 2');
      const btn3 = screen.getByText('Button 3');

      // Test Tab on last element (btn3): should wrap to first element (btn1)
      btn3.focus();
      expect(document.activeElement).toBe(btn3);
      const tabForward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.dispatchEvent(tabForward);
      expect(document.activeElement).toBe(btn1);

      // Test Shift+Tab on first element (btn1): should wrap to last element (btn3)
      btn1.focus();
      expect(document.activeElement).toBe(btn1);
      const tabBackward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(tabBackward);
      expect(document.activeElement).toBe(btn3);

      unmount();
    } finally {
      if (originalOffsetParent) {
        Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent);
      } else {
        delete HTMLElement.prototype.offsetParent;
      }
    }
  });

  it('EMPIRICAL BUG CHECK: focus stolen while modal open if onClose changes identity', () => {
    triggerBtn.focus();
    expect(document.activeElement).toBe(triggerBtn);

    const ParentWithModal = () => {
      const [count, setCount] = useState(0);
      return (
        <div>
          <button id="counter-btn" onClick={() => setCount((c) => c + 1)}>
            Count: {count}
          </button>
          <CreateSubtitlesModal
            isOpen={true}
            onClose={() => {}} // New function reference on every render!
            videoDuration={60}
          />
        </div>
      );
    };

    render(<ParentWithModal />);

    // User is interacting inside modal, focusing an input or select
    const languageSelect = screen.getByLabelText(/language/i);
    languageSelect.focus();
    expect(document.activeElement).toBe(languageSelect);

    // Now parent re-renders (e.g. state update, time update, etc.)
    const counterBtn = screen.getByText(/count:/i);
    act(() => {
      counterBtn.click();
    });

    console.log('After parent re-render, activeElement is:', document.activeElement.id || document.activeElement.tagName);
    // Did focus remain inside the modal on languageSelect, or was it yanked away to triggerBtn?
    expect(document.activeElement).toBe(languageSelect);
  });
});
