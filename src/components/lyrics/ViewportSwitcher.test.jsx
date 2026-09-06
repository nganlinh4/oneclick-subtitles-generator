import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewportSwitcher } from './ViewportSwitcher';

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => defaultValue,
  }),
}));

describe('ViewportSwitcher', () => {
  it('renders both Transcript and Captions buttons', () => {
    render(<ViewportSwitcher activeViewport="captions" turnCount={5} cueCount={12} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(screen.getByText('Transcript')).toBeInTheDocument();
    expect(screen.getByText('Captions')).toBeInTheDocument();
  });

  it('displays turn count and cue count badges', () => {
    render(<ViewportSwitcher activeViewport="captions" turnCount={5} cueCount={12} />);
    expect(screen.getByTestId('transcript-badge')).toHaveTextContent('5');
    expect(screen.getByTestId('captions-badge')).toHaveTextContent('12');
  });

  it('highlights the active tab with aria-selected', () => {
    const { rerender } = render(<ViewportSwitcher activeViewport="captions" />);
    const captionTab = screen.getByTestId('viewport-tab-captions');
    const transcriptTab = screen.getByTestId('viewport-tab-transcript');

    expect(captionTab).toHaveAttribute('aria-selected', 'true');
    expect(transcriptTab).toHaveAttribute('aria-selected', 'false');

    rerender(<ViewportSwitcher activeViewport="transcript" />);
    expect(captionTab).toHaveAttribute('aria-selected', 'false');
    expect(transcriptTab).toHaveAttribute('aria-selected', 'true');
  });

  it('calls onViewportChange when tab is clicked', () => {
    const onViewportChange = vi.fn();
    render(<ViewportSwitcher activeViewport="captions" onViewportChange={onViewportChange} />);

    fireEvent.click(screen.getByTestId('viewport-tab-transcript'));
    expect(onViewportChange).toHaveBeenCalledWith('transcript');
  });

  it('navigates between tabs using arrow keys', () => {
    const onViewportChange = vi.fn();
    render(<ViewportSwitcher activeViewport="captions" onViewportChange={onViewportChange} />);

    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(onViewportChange).toHaveBeenCalledWith('transcript');

    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(onViewportChange).toHaveBeenCalledWith('transcript');

    fireEvent.keyDown(tablist, { key: 'End' });
    expect(onViewportChange).toHaveBeenCalledWith('captions');
  });
});
