const pillMocks = vi.hoisted(() => ({
  position: vi.fn(),
}));

vi.mock('./settingsTabPillAnimation', () => ({
  positionPillForActiveTab: pillMocks.position,
}));

import initSettingsTabsDrag from './settingsTabsDrag';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '<div class="settings-tabs"></div>';
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

it('replaces an existing drag lifecycle and leaves cleanup ownership with the replacement', () => {
  const tabs = document.querySelector('.settings-tabs');
  const cleanupFirst = initSettingsTabsDrag('.settings-tabs');
  const cleanupSecond = initSettingsTabsDrag('.settings-tabs');

  tabs.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(50);
  expect(pillMocks.position).toHaveBeenCalledTimes(1);

  cleanupFirst();
  tabs.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(50);
  expect(pillMocks.position).toHaveBeenCalledTimes(2);

  cleanupSecond();
  tabs.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(50);
  expect(pillMocks.position).toHaveBeenCalledTimes(2);
});

it('cancels a pending debounced pill update during cleanup', () => {
  const tabs = document.querySelector('.settings-tabs');
  const cleanup = initSettingsTabsDrag('.settings-tabs');

  tabs.dispatchEvent(new Event('scroll'));
  cleanup();
  vi.advanceTimersByTime(50);

  expect(pillMocks.position).not.toHaveBeenCalled();
  expect(tabs).not.toHaveClass('dragging');
});
