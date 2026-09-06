import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CreateSubtitlesModal from './CreateSubtitlesModal';

describe('CreateSubtitlesModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onProcess: vi.fn(),
    videoFile: { assetId: 'media-1', name: 'sample.mp4', duration: 120 },
    videoDuration: 120,
    selectedSegment: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders modal dialog with default Speech task and whole video scope', () => {
    render(<CreateSubtitlesModal {...defaultProps} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /create subtitles/i })).toBeInTheDocument();
    expect(screen.getByTestId('scope-whole-video')).toHaveClass('active');
    expect(screen.getByTestId('scope-duration-badge')).toHaveTextContent('00:00 – 02:00 (120s)');
    expect(screen.getByTestId('speech-task-panel')).toBeInTheDocument();
  });

  it('initializes with selected range scope when selectedSegment is provided', () => {
    render(
      <CreateSubtitlesModal
        {...defaultProps}
        selectedSegment={{ start: 10, end: 40 }}
      />
    );

    expect(screen.getByTestId('scope-selected-range')).toHaveClass('active');
    expect(screen.getByTestId('scope-duration-badge')).toHaveTextContent('00:10 – 00:40 (30.0s)');
  });

  it('refuses micro-duration selection range (<500ms) with error message', () => {
    render(
      <CreateSubtitlesModal
        {...defaultProps}
        selectedSegment={{ start: 10, end: 10.3 }}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/selection range too short/i);
    const submitBtn = screen.getByTestId('create-subtitles-action');
    expect(submitBtn).toBeDisabled();
  });

  it('switches between task tabs upon click and preserves state', () => {
    render(
      <CreateSubtitlesModal
        {...defaultProps}
        subtitlesData={[{ id: 'cue-1', text: 'Hello' }]}
      />
    );

    // Switch to Translate tab
    const translateTab = screen.getByRole('tab', { name: /translate/i });
    fireEvent.click(translateTab);
    expect(screen.getByTestId('translate-task-panel')).toBeInTheDocument();

    // Select target language
    const langSelect = screen.getByLabelText(/target language/i);
    fireEvent.change(langSelect, { target: { value: 'vi' } });
    expect(langSelect.value).toBe('vi');

    // Switch to Visual tab
    const visualTab = screen.getByRole('tab', { name: /visual/i });
    fireEvent.click(visualTab);
    expect(screen.getByTestId('visual-custom-task-panel')).toBeInTheDocument();

    // Switch back to Translate tab and verify language is preserved
    fireEvent.click(screen.getByRole('tab', { name: /translate/i }));
    expect(screen.getByLabelText(/target language/i).value).toBe('vi');
  });

  it('navigates task tabs with keyboard Arrow keys', () => {
    render(<CreateSubtitlesModal {...defaultProps} />);

    const speechTab = screen.getByRole('tab', { name: /speech/i });
    speechTab.focus();

    // Press ArrowRight to move to Translate tab
    fireEvent.keyDown(speechTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /translate/i })).toHaveClass('active');

    // Press ArrowRight to move to Visual tab
    const translateTab = screen.getByRole('tab', { name: /translate/i });
    fireEvent.keyDown(translateTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /visual/i })).toHaveClass('active');

    // Press ArrowRight to wrap around to Speech tab
    const visualTab = screen.getByRole('tab', { name: /visual/i });
    fireEvent.keyDown(visualTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /speech/i })).toHaveClass('active');
  });

  it('shows warning and disables video-required subtasks for audio-only assets', () => {
    const audioFile = {
      assetId: 'audio-1',
      name: 'podcast.mp3',
      type: 'audio/mpeg',
      duration: 300,
    };

    render(
      <CreateSubtitlesModal
        {...defaultProps}
        videoFile={audioFile}
        initialTask="VisualCustom"
      />
    );

    expect(
      screen.getByText(/this task requires video frames/i)
    ).toBeInTheDocument();

    expect(screen.getByTestId('subtask-ocr')).toBeDisabled();
    expect(screen.getByTestId('subtask-descriptions')).toBeDisabled();
    expect(screen.getByTestId('subtask-chapters')).toBeDisabled();
    expect(screen.getByTestId('subtask-custom')).not.toBeDisabled();
  });

  it('calls onClose when close button or cancel is clicked', () => {
    const onClose = vi.fn();
    render(<CreateSubtitlesModal {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
