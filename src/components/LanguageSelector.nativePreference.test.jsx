import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  invokeDesktop: vi.fn(),
  i18n: {
    language: 'en',
    changeLanguage: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../platform/desktopRuntime', () => ({ invokeDesktop: mocks.invokeDesktop }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => fallback ?? key,
    i18n: mocks.i18n,
  }),
}));
vi.mock('./common/CustomDropdown', () => ({
  default: ({ value, onChange }) => (
    <button
      type="button"
      data-testid="language-dropdown"
      data-value={value}
      onClick={() => onChange('ko')}
    >
      {value}
    </button>
  ),
}));

import LanguageSelector from './LanguageSelector';

beforeEach(() => {
  localStorage.clear();
  mocks.invokeDesktop.mockReset();
  mocks.i18n.language = 'en';
  mocks.i18n.changeLanguage.mockReset().mockResolvedValue(undefined);
  mocks.i18n.on.mockReset();
  mocks.i18n.off.mockReset();
  window.addToast = vi.fn();
});

it('renders the effective language without persisting it on mount', () => {
  render(<LanguageSelector />);

  expect(screen.getByTestId('language-dropdown')).toHaveAttribute('data-value', 'en');
  expect(localStorage.getItem('preferred_language')).toBeNull();
  expect(mocks.invokeDesktop).not.toHaveBeenCalled();
  expect(mocks.i18n.changeLanguage).not.toHaveBeenCalled();
});

it('does not change language or its mirror until native accepts it', async () => {
  let releaseNative;
  mocks.invokeDesktop.mockImplementation(() => new Promise((resolve) => {
    releaseNative = resolve;
  }));
  render(<LanguageSelector />);

  fireEvent.click(screen.getByTestId('language-dropdown'));
  fireEvent.click(screen.getByTestId('language-dropdown'));
  await waitFor(() => expect(mocks.invokeDesktop).toHaveBeenCalledExactlyOnceWith('setting_set', {
    key: 'preferred_language', value: 'ko',
  }));
  expect(localStorage.getItem('preferred_language')).toBeNull();
  expect(mocks.i18n.changeLanguage).not.toHaveBeenCalled();
  expect(screen.getByTestId('language-dropdown')).toHaveAttribute('data-value', 'en');

  releaseNative();
  await waitFor(() => expect(screen.getByTestId('language-dropdown'))
    .toHaveAttribute('data-value', 'ko'));
  expect(localStorage.getItem('preferred_language')).toBe('ko');
  expect(mocks.i18n.changeLanguage).toHaveBeenCalledExactlyOnceWith('ko');
});

it('keeps the prior language mirror and UI when native rejects the write', async () => {
  localStorage.setItem('preferred_language', 'en');
  mocks.invokeDesktop.mockRejectedValue(new Error('native refusal'));
  render(<LanguageSelector />);

  fireEvent.click(screen.getByTestId('language-dropdown'));
  await waitFor(() => expect(window.addToast).toHaveBeenCalledExactlyOnceWith(
    'Settings could not be saved. Please try again.', 'error', 8000,
  ));
  expect(localStorage.getItem('preferred_language')).toBe('en');
  expect(mocks.i18n.changeLanguage).not.toHaveBeenCalled();
  expect(screen.getByTestId('language-dropdown')).toHaveAttribute('data-value', 'en');
});

it('keeps durable language selected and warns once when current-window i18n projection rejects', async () => {
  mocks.invokeDesktop.mockResolvedValue(undefined);
  mocks.i18n.changeLanguage.mockRejectedValue(new Error('catalog repaint failed'));
  render(<LanguageSelector />);

  fireEvent.click(screen.getByTestId('language-dropdown'));

  await waitFor(() => expect(window.addToast).toHaveBeenCalledExactlyOnceWith(
    'The setting was saved, but this window could not fully apply it. Restart OSG if it still looks unchanged.',
    'warning',
    8000,
    'settings-preference-projection-warning',
  ));
  expect(localStorage.getItem('preferred_language')).toBe('ko');
  expect(screen.getByTestId('language-dropdown')).toHaveAttribute('data-value', 'ko');
  expect(window.addToast).not.toHaveBeenCalledWith(
    expect.anything(), 'error', expect.anything(), expect.anything(),
  );
});
