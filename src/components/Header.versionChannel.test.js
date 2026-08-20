import { render, screen } from '@testing-library/react';
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
