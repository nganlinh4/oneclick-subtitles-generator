import { act, fireEvent, render, screen } from '@testing-library/react';
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

test('keeps the Material settings action floating and persists its discoverability count', () => {
  const onSettingsClick = vi.fn();
  const { container } = render(<Header onSettingsClick={onSettingsClick} />);
  const button = screen.getByRole('button', { name: 'header.settingsAria' });

  expect(button).toHaveClass('settings-button');
  expect(button).toHaveClass('floating-settings', 'floating-visible');
  expect(container.querySelector('.app-header > [data-app-action="open-settings"]')).toBe(button);

  fireEvent.click(button);
  expect(onSettingsClick).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('settings_open_count')).toBe('1');
});

test('removes the floating launcher from paint and focus while Settings owns the screen', () => {
  const { container } = render(<Header onSettingsClick={vi.fn()} settingsOpen />);
  const button = container.querySelector('[data-app-action="open-settings"]');

  expect(button).toHaveClass('floating-hidden');
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-hidden', 'true');
  expect(button).toHaveAttribute('tabindex', '-1');
});

test('hides an experienced-user action and reveals it in the top-right discovery zone', () => {
  vi.useFakeTimers();
  localStorage.setItem('settings_open_count', '5');
  render(<Header onSettingsClick={vi.fn()} />);
  const button = screen.getByRole('button', { name: 'header.settingsAria' });

  act(() => vi.advanceTimersByTime(5_000));
  expect(button).toHaveClass('floating-hidden');
  fireEvent.pointerMove(document, { clientX: window.innerWidth - 1, clientY: 1 });
  expect(button).toHaveClass('floating-visible');
  vi.useRealTimers();
});
