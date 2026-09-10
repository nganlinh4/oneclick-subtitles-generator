import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  invokeDesktop: vi.fn(),
  toggleTheme: vi.fn(),
}));

vi.mock('../../platform/desktopRuntime', () => ({ invokeDesktop: mocks.invokeDesktop }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback ?? _key }),
}));
vi.mock('../LanguageSelector', () => ({ default: () => null }));
vi.mock('../common/CustomDropdown', () => ({
  default: ({ value, onChange, className }) => (
    <button
      type="button"
      data-testid={className}
      data-value={value}
      onClick={() => onChange('system-ui')}
    >
      {value}
    </button>
  ),
}));
vi.mock('./utils/themeUtils', () => ({
  getThemeIcon: () => null,
  getThemeLabel: () => 'theme',
  initializeTheme: () => 'dark',
  setupSystemThemeListener: () => undefined,
  toggleTheme: mocks.toggleTheme,
}));

import SettingsFooterControls from './SettingsFooterControls';

beforeEach(() => {
  localStorage.clear();
  mocks.invokeDesktop.mockReset();
  mocks.toggleTheme.mockReset().mockResolvedValue('light');
  window.addToast = vi.fn();
  document.documentElement.style.removeProperty('--font-primary');
  document.documentElement.style.removeProperty('--font-title');
  document.documentElement.style.removeProperty('zoom');
});

it('commits interface scale natively before applying it to the window', async () => {
  mocks.invokeDesktop.mockResolvedValue(undefined);
  render(<SettingsFooterControls />);

  fireEvent.click(screen.getByRole('button', { name: 'Increase interface scale' }));

  await waitFor(() => expect(mocks.invokeDesktop).toHaveBeenCalledExactlyOnceWith('setting_set', {
    key: 'app_ui_scale', value: '110',
  }));
  expect(localStorage.getItem('app_ui_scale')).toBe('110');
  expect(document.documentElement.style.zoom).toBe('110%');
  expect(screen.getByText('110%')).toBeInTheDocument();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('renders the default app font without persisting it on mount', () => {
  render(<SettingsFooterControls showFontDropdown />);

  expect(screen.getByTestId('app-font-dropdown')).toHaveAttribute('data-value', 'google-sans');
  expect(localStorage.getItem('app_font')).toBeNull();
  expect(mocks.invokeDesktop).not.toHaveBeenCalled();
});

it('does not publish an app-font choice until native accepts it', async () => {
  let releaseNative;
  mocks.invokeDesktop.mockImplementation(() => new Promise((resolve) => {
    releaseNative = resolve;
  }));
  render(<SettingsFooterControls showFontDropdown />);

  fireEvent.click(screen.getByTestId('app-font-dropdown'));
  fireEvent.click(screen.getByTestId('app-font-dropdown'));
  await waitFor(() => expect(mocks.invokeDesktop).toHaveBeenCalledExactlyOnceWith('setting_set', {
    key: 'app_font', value: 'system-ui',
  }));
  expect(localStorage.getItem('app_font')).toBeNull();
  expect(screen.getByTestId('app-font-dropdown')).toHaveAttribute('data-value', 'google-sans');

  releaseNative();
  await waitFor(() => expect(screen.getByTestId('app-font-dropdown'))
    .toHaveAttribute('data-value', 'system-ui'));
  expect(localStorage.getItem('app_font')).toBe('system-ui');
});

it('still paints a committed font when settings closes before the native write resolves', async () => {
  let releaseNative;
  mocks.invokeDesktop.mockImplementation(() => new Promise((resolve) => {
    releaseNative = resolve;
  }));
  const view = render(<SettingsFooterControls showFontDropdown />);

  fireEvent.click(screen.getByTestId('app-font-dropdown'));
  await waitFor(() => expect(mocks.invokeDesktop).toHaveBeenCalledOnce());
  view.unmount();
  releaseNative();

  await waitFor(() => expect(document.documentElement.style.getPropertyValue('--font-primary'))
    .toContain('system-ui'));
  expect(localStorage.getItem('app_font')).toBe('system-ui');
});

it('keeps the prior app-font mirror and UI when native rejects the write', async () => {
  localStorage.setItem('app_font', 'google-sans');
  mocks.invokeDesktop.mockRejectedValue(new Error('native refusal'));
  render(<SettingsFooterControls showFontDropdown />);

  fireEvent.click(screen.getByTestId('app-font-dropdown'));
  await waitFor(() => expect(window.addToast).toHaveBeenCalledExactlyOnceWith(
    'Settings could not be saved. Please try again.', 'error', 8000,
  ));
  expect(localStorage.getItem('app_font')).toBe('google-sans');
  expect(screen.getByTestId('app-font-dropdown')).toHaveAttribute('data-value', 'google-sans');
});

it('warns once without reporting save failure when a committed font mirror cannot be written', async () => {
  mocks.invokeDesktop.mockResolvedValue(undefined);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage denied');
  });
  render(<SettingsFooterControls showFontDropdown />);

  fireEvent.click(screen.getByTestId('app-font-dropdown'));

  await waitFor(() => expect(window.addToast).toHaveBeenCalledExactlyOnceWith(
    'The setting was saved, but this window could not fully apply it. Restart OSG if it still looks unchanged.',
    'warning',
    8000,
    'settings-preference-projection-warning',
  ));
  expect(screen.getByTestId('app-font-dropdown')).toHaveAttribute('data-value', 'system-ui');
  expect(document.documentElement.style.getPropertyValue('--font-primary')).toContain('system-ui');
  expect(window.addToast).not.toHaveBeenCalledWith(
    expect.anything(), 'error', expect.anything(), expect.anything(),
  );
});

it('uses the same keyed warning when a committed theme has a projection warning', async () => {
  mocks.toggleTheme.mockImplementation(async (_theme, setTheme, { onProjectionWarning }) => {
    onProjectionWarning();
    setTheme('light');
    return 'light';
  });
  render(<SettingsFooterControls />);

  fireEvent.click(screen.getByRole('button', { name: 'theme' }));

  await waitFor(() => expect(window.addToast).toHaveBeenCalledExactlyOnceWith(
    'The setting was saved, but this window could not fully apply it. Restart OSG if it still looks unchanged.',
    'warning',
    8000,
    'settings-preference-projection-warning',
  ));
});
