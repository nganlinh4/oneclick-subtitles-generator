import { act, fireEvent, render, screen } from '@testing-library/react';

import { invokeDesktop } from '../../platform/desktopRuntime';
import { runExclusiveSettingsReset } from '../../platform/settingsMutationCoordinator';
import SettingsModal from './SettingsModal';

vi.mock('../../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  invokeDesktop: vi.fn(),
}));
vi.mock('../../platform/providerService', () => ({
  cancelYouTubeOAuthNative: vi.fn(() => Promise.resolve(false)),
  getYouTubeOAuthStatusNative: vi.fn(() => Promise.resolve({ authenticated: false })),
}));
vi.mock('../../platform/startupUpdateCoordinator', () => ({
  refreshDesktopUpdateCheck: vi.fn(),
  startStartupUpdateCheck: vi.fn(() => Promise.resolve({ configured: false, update: null })),
  subscribeDesktopUpdateStatus: vi.fn(() => () => undefined),
}));
vi.mock('./utils/settingsAnimationHelpers', () => ({
  useSettingsTabPillInit: vi.fn(),
  useSettingsTabPillUpdate: vi.fn(),
}));
vi.mock('./tabs/ApiKeysTab', () => ({ default: () => null }));
vi.mock('./tabs/PromptsTab', () => ({ default: () => null }));
vi.mock('./tabs/CacheTab', () => ({ default: () => null }));
vi.mock('./tabs/AboutTab', () => ({ default: () => null }));
vi.mock('./ModelManagementTab', () => ({ default: () => null }));
vi.mock('../engines/EnginesPanel', () => ({ default: () => null }));
vi.mock('./SettingsFooterControls', () => ({ default: () => null }));
vi.mock('../common/CloseButton', () => ({
  default: ({ onClick, disabled }) => (
    <button type="button" aria-label="Close" onClick={onClick} disabled={disabled}>
      Close
    </button>
  ),
}));
vi.mock('../common/LoadingIndicator', () => ({ default: () => null }));
vi.mock('./tabs/VideoProcessingTab', () => ({
  default: ({ setDownloadCookieSource }) => (
    <button type="button" data-testid="choose-firefox" onClick={() => setDownloadCookieSource('firefox')}>
      Choose Firefox
    </button>
  ),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  window.addToast = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  delete window.addToast;
});

it('repairs an unknown persisted tab instead of opening an empty Settings surface', async () => {
  localStorage.setItem('settings_last_active_tab', 'removed-or-corrupt-tab');
  render(
    <SettingsModal
      onClose={vi.fn()}
      onSave={vi.fn()}
      apiKeysSet={{ gemini: false, youtube: false, genius: false }}
      setApiKeysSet={vi.fn()}
    />
  );

  expect(screen.getByRole('button', { name: 'API Keys' })).toHaveClass('active');
  await act(async () => { await Promise.resolve(); });
  expect(localStorage.getItem('settings_last_active_tab')).toBe('api-keys');
});

it('discards a draft browser selection when Settings is cancelled', async () => {
  localStorage.setItem('use_cookies_for_download', 'true');
  localStorage.setItem('download_cookie_source', 'edge');
  const onClose = vi.fn();
  const onSave = vi.fn();
  render(
    <SettingsModal
      onClose={onClose}
      onSave={onSave}
      apiKeysSet={{ gemini: false, youtube: false, genius: false }}
      setApiKeysSet={vi.fn()}
    />
  );

  fireEvent.click(screen.getByTestId('choose-firefox'));
  expect(localStorage.getItem('download_cookie_source')).toBe('edge');
  fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
  await act(async () => { vi.advanceTimersByTime(300); });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSave).not.toHaveBeenCalled();
  expect(invokeDesktop).not.toHaveBeenCalledWith('settings_set_many', expect.anything());
  expect(localStorage.getItem('download_cookie_source')).toBe('edge');
});

it('keeps Settings open and reports a safe error when native persistence fails', async () => {
  localStorage.setItem('use_cookies_for_download', 'true');
  localStorage.setItem('download_cookie_source', 'edge');
  invokeDesktop.mockRejectedValueOnce(new Error('private database detail'));
  const onClose = vi.fn();
  const onSave = vi.fn();
  render(
    <SettingsModal
      onClose={onClose}
      onSave={onSave}
      apiKeysSet={{ gemini: false, youtube: false, genius: false }}
      setApiKeysSet={vi.fn()}
    />
  );

  fireEvent.click(screen.getByTestId('choose-firefox'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(invokeDesktop).toHaveBeenCalledWith('settings_set_many', expect.anything());
  expect(onSave).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(localStorage.getItem('download_cookie_source')).toBe('edge');
  expect(window.addToast).toHaveBeenCalledWith(
    'Settings could not be saved. Please try again.',
    'error',
    8000
  );
  expect(JSON.stringify(window.addToast.mock.calls)).not.toContain('private database detail');

  // A failed save must not have left a delayed close behind.
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(onClose).not.toHaveBeenCalled();

  // The lock is released after failure, so the still-open modal can be cancelled normally.
  fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('owns the modal through an in-flight save and closes exactly once after persistence', async () => {
  let settlePersistence;
  const persistence = new Promise((resolve) => {
    settlePersistence = resolve;
  });
  const order = [];
  invokeDesktop.mockImplementation((command) => {
    if (command === 'settings_set_many') {
      order.push('persistence-started');
      return persistence.then(() => { order.push('persistence-finished'); });
    }
    return Promise.resolve(undefined);
  });
  localStorage.setItem('download_cookie_source', 'edge');
  const onClose = vi.fn(() => { order.push('closed'); });
  const onSave = vi.fn(() => { order.push('published'); });
  render(
    <SettingsModal
      onClose={onClose}
      onSave={onSave}
      apiKeysSet={{ gemini: false, youtube: false, genius: false }}
      setApiKeysSet={vi.fn()}
    />
  );

  // Capture a reset confirmation before the save. Its delayed action must re-check ownership.
  fireEvent.click(screen.getByRole('button', { name: 'Factory Reset' }));
  const resetConfirmation = window.addToast.mock.calls.at(-1)[4].onClick;

  fireEvent.click(screen.getByTestId('choose-firefox'));
  const saveButton = screen.getByRole('button', { name: 'Save' });
  fireEvent.click(saveButton);
  fireEvent.click(saveButton);
  // Exercise the pre-render window too: the ref guard must own exits immediately, before the
  // disabled state is observable in the DOM.
  fireEvent.click(document.querySelector('.settings-modal-overlay'));
  fireEvent.keyDown(document, { key: 'Escape' });
  await act(async () => { await Promise.resolve(); });

  expect(invokeDesktop.mock.calls.filter(([command]) => command === 'settings_set_many')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Factory Reset/i })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(document.querySelector('.settings-modal-overlay'));
  fireEvent.keyDown(document, { key: 'Escape' });
  await act(async () => { await resetConfirmation(); });
  await act(async () => { vi.advanceTimersByTime(1000); });

  expect(onClose).not.toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
  expect(invokeDesktop.mock.calls.filter(([command]) => command !== 'settings_set_many')).toEqual([]);
  expect(order).toEqual(['persistence-started']);

  await act(async () => {
    settlePersistence();
    await persistence;
    await Promise.resolve();
  });

  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(order).toEqual(['persistence-started', 'persistence-finished', 'published']);

  // All exit paths remain idempotent while the successful close animation is pending.
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(document.querySelector('.settings-modal-overlay'));
  await act(async () => { vi.advanceTimersByTime(300); });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(order).toEqual([
    'persistence-started',
    'persistence-finished',
    'published',
    'closed',
  ]);
});

it('reflects process-wide reset ownership in the modal controls', async () => {
  let finishReset;
  const resetWork = new Promise((resolve) => {
    finishReset = resolve;
  });
  const reset = runExclusiveSettingsReset(() => resetWork);

  render(
    <SettingsModal
      onClose={vi.fn()}
      onSave={vi.fn()}
      apiKeysSet={{ gemini: false, youtube: false, genius: false }}
      setApiKeysSet={vi.fn()}
    />
  );

  expect(screen.getByRole('button', { name: 'Resetting...' })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();

  await act(async () => {
    finishReset();
    await reset;
  });

  expect(screen.getByRole('button', { name: 'Factory Reset' })).toBeEnabled();
});
