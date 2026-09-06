import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TranscriptSurface } from './TranscriptSurface';

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => defaultValue,
  }),
}));

describe('TranscriptSurface', () => {
  const mockWords = [
    { id: 'w1', text: 'Hello', start_ms: 1000, end_ms: 1400, speaker_id: 'host' },
    { id: 'w2', text: 'world,', start_ms: 1450, end_ms: 1900, speaker_id: 'host' },
    { id: 'w3', text: 'welcome', start_ms: 2500, end_ms: 2900, speaker_id: 'guest' },
    { id: 'w4', text: 'guest.', start_ms: 2950, end_ms: 3400, speaker_id: 'guest' },
  ];

  it('renders speaker turns and avatars', () => {
    render(<TranscriptSurface words={mockWords} />);
    expect(screen.getByTestId('transcript-surface')).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('guest.')).toBeInTheDocument();
    expect(screen.getAllByTestId(/speaker-name-/)).toHaveLength(2);
  });

  it('seeks to exact word start_ms when clicked', () => {
    const onWordClick = vi.fn();
    render(<TranscriptSurface words={mockWords} onWordClick={onWordClick} />);

    const wordToken = screen.getByTestId('word-token-w3');
    fireEvent.click(wordToken);
    // w3 start_ms is 2500, so seek time should be 2.5s
    expect(onWordClick).toHaveBeenCalledWith(2.5);
  });

  it('highlights the active word during media playback', () => {
    // Current time 1.6s -> 1600ms, which is within w2 [1450, 1900]
    render(<TranscriptSurface words={mockWords} currentTime={1.6} />);

    const w2 = screen.getByTestId('word-token-w2');
    expect(w2).toHaveClass('active');

    const w1 = screen.getByTestId('word-token-w1');
    expect(w1).not.toHaveClass('active');
  });

  it('supports inline speaker renaming across turns', () => {
    const onSpeakerRename = vi.fn();
    render(<TranscriptSurface words={mockWords} onSpeakerRename={onSpeakerRename} />);

    const speakerDisplay = screen.getByTestId('speaker-name-host');
    fireEvent.click(speakerDisplay);

    const input = screen.getByTestId('speaker-rename-input-host');
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Alice' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSpeakerRename).toHaveBeenCalledWith('host', 'Alice');
  });

  it('suspends follow playback on user scroll and resumes on chip click', () => {
    render(<TranscriptSurface words={mockWords} currentTime={1.0} />);

    const surface = screen.getByTestId('transcript-surface');
    fireEvent.wheel(surface);

    // After manual wheel scroll, resume follow button appears
    const resumeBtn = screen.getByTestId('resume-follow-btn');
    expect(resumeBtn).toBeInTheDocument();

    fireEvent.click(resumeBtn);
    expect(screen.queryByTestId('resume-follow-btn')).not.toBeInTheDocument();
  });

  it('renders and supports click-to-seek and highlighting with camelCase Rust DTOs', () => {
    const camelWords = [
      { id: 'cw-1', text: 'Good', startMs: 1200, endMs: 1600, speakerId: 'spk-a' },
      { id: 'cw-2', text: 'morning', startMs: 1650, endMs: 2200, speakerId: 'spk-a' },
    ];
    const camelTurns = [
      { id: 'turn-1', speakerId: 'spk-a', startMs: 1200, endMs: 2200, text: 'Good morning' },
    ];
    const onWordClick = vi.fn();

    render(
      <TranscriptSurface
        turns={camelTurns}
        words={camelWords}
        currentTime={1.8}
        onWordClick={onWordClick}
      />
    );

    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.getByText('morning')).toBeInTheDocument();

    // At 1.8s (1800ms), cw-2 [1650, 2200] is active
    const w2 = screen.getByTestId('word-token-cw-2');
    expect(w2).toHaveClass('active');

    // Click cw-1 (1200ms) seeks to 1.2s
    const w1 = screen.getByTestId('word-token-cw-1');
    fireEvent.click(w1);
    expect(onWordClick).toHaveBeenCalledWith(1.2);
  });
});
