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
});
