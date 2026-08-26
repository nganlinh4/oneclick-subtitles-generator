import { fireEvent, render, screen } from '@testing-library/react';
import Header from './Header';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback ?? _key }),
}));
vi.mock('./GeminiHeaderAnimation', () => ({ default: () => null }));
vi.mock('../platform/startupService', () => ({
  detectStartupMode: vi.fn().mockResolvedValue({ backendAvailable: true, isVercelMode: false }),
}));
vi.mock('../platform/startupUpdateCoordinator', () => ({
  refreshDesktopUpdateCheck: vi.fn().mockResolvedValue({ configured: false, update: null }),
  startStartupUpdateCheck: vi.fn().mockResolvedValue({ configured: false, update: null }),
  subscribeDesktopUpdateStatus: vi.fn(() => () => undefined),
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('enable_gemini_effects', 'false');
});

test('does not expose the retired source-branch switch as an installed-app action', () => {
  const { container } = render(<Header onSettingsClick={vi.fn()} />);

  expect(container.querySelector('.branch-switch-button')).toBeNull();
  expect(screen.getByRole('button', { name: 'header.settingsAria' })).toBeEnabled();
});

test('keeps Settings in normal header layout without a scroll-owned floating state machine', () => {
  const onSettingsClick = vi.fn();
  const { container } = render(<Header onSettingsClick={onSettingsClick} />);
  const button = screen.getByRole('button', { name: 'header.settingsAria' });

  expect(button).toHaveClass('settings-button');
  expect(button).not.toHaveClass('floating-settings');
  expect(container.querySelector('.app-header > [data-app-action="open-settings"]')).toBe(button);

  fireEvent.click(button);
  expect(onSettingsClick).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('settings_open_count')).toBeNull();
});
