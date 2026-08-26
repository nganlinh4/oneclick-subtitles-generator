import { fireEvent, render, screen } from '@testing-library/react';

import PlaybackSpeedMenu from './PlaybackSpeedMenu';

vi.mock('../../common/LiquidGlass', () => ({
  default: ({ children, onClick, style }) => (
    <button type="button" onClick={onClick} style={style}>{children}</button>
  ),
}));
vi.mock('./ActionButtons', () => ({ default: () => null }));

test('choosing an expanded playback speed closes the menu immediately', () => {
  const video = { playbackRate: 1 };
  const setPlaybackSpeed = vi.fn();
  const setIsSpeedMenuVisible = vi.fn();
  const { container } = render(<PlaybackSpeedMenu
    isFullscreen={false}
    controlsVisible
    isVideoHovered
    videoRef={{ current: video }}
    playbackSpeed={1}
    setPlaybackSpeed={setPlaybackSpeed}
    isSpeedMenuVisible
    setIsSpeedMenuVisible={setIsSpeedMenuVisible}
    isCompactMode={false}
    isAudioFile={false}
    videoSource="media"
  />);

  fireEvent.mouseEnter(container.firstElementChild);
  fireEvent.click(screen.getByRole('button', { name: '1.5x' }));

  expect(setPlaybackSpeed).toHaveBeenCalledWith(1.5);
  expect(video.playbackRate).toBe(1.5);
  expect(setIsSpeedMenuVisible).toHaveBeenLastCalledWith(false);
});
