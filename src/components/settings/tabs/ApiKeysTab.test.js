import { fireEvent, render, screen } from '@testing-library/react';

import ApiKeysTab from './ApiKeysTab';

const credentialMocks = vi.hoisted(() => ({
  removeSingletonCredential: vi.fn(),
  showConfirmationToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

vi.mock('../../../platform/credentialStateController', () => ({
  removeSingletonCredential: credentialMocks.removeSingletonCredential,
}));
vi.mock('../../../utils/toastUtils', () => ({
  showConfirmationToast: credentialMocks.showConfirmationToast,
  showErrorToast: credentialMocks.showErrorToast,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallbackOrValues, explicitValues = {}) => {
      const fallback = typeof fallbackOrValues === 'string' ? fallbackOrValues : key;
      const values = fallbackOrValues !== null && typeof fallbackOrValues === 'object'
        ? fallbackOrValues
        : explicitValues;
      return Object.entries(values).reduce(
        (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
        fallback
      );
    },
  }),
}));
vi.mock('./GeminiKeysManager', () => ({
  default: () => <div data-testid="gemini-keys-manager" />,
  useGeminiKeys: () => ({ geminiApiKeys: [] }),
}));
vi.mock('./YoutubeAuthSection', () => ({ default: () => <div /> }));

const defaultProps = {
  geminiApiKey: '',
  setGeminiApiKey: vi.fn(),
  youtubeApiKey: '',
  setYoutubeApiKey: vi.fn(),
  geniusApiKey: '',
  setGeniusApiKey: vi.fn(),
  showGeminiKey: false,
  setShowGeminiKey: vi.fn(),
  showYoutubeKey: false,
  setShowYoutubeKey: vi.fn(),
  showGeniusKey: false,
  setShowGeniusKey: vi.fn(),
  useOAuth: false,
  setUseOAuth: vi.fn(),
  youtubeClientId: '',
  setYoutubeClientId: vi.fn(),
  youtubeClientSecret: '',
  setYoutubeClientSecret: vi.fn(),
  showClientId: false,
  setShowClientId: vi.fn(),
  showClientSecret: false,
  setShowClientSecret: vi.fn(),
  isAuthenticated: false,
  setIsAuthenticated: vi.fn(),
  apiKeysSet: { gemini: false, genius: false, youtube: false },
  setApiKeysSet: vi.fn(),
  enableYoutubeSearch: false,
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it.each([null, 'true'])('omits the announcement area regardless of its old dismissal state: %s', (dismissed) => {
  if (dismissed !== null) localStorage.setItem('gemini25ProPausedMessageClosed', dismissed);
  const { container } = render(<ApiKeysTab {...defaultProps} />);

  expect(container.querySelector('.gemini-paused-message')).toBeNull();
  expect(container.querySelector('.notification-messages-container')).toBeNull();
  expect(container.querySelector('.notification-placeholder')).toBeNull();
  expect(screen.queryByText('settings.gemini25ProPaused')).not.toBeInTheDocument();
  expect(screen.queryByText('settings.noNewNotifications')).not.toBeInTheDocument();
  expect(localStorage.getItem('gemini25ProPausedMessageClosed')).toBe(dismissed);
});

it('places the compact usage link beside the key heading without changing key management', () => {
  const { container } = render(<ApiKeysTab {...defaultProps} />);
  const usage = screen.getByRole('link', { name: 'Gemini API usage' });
  expect(usage).toHaveAttribute('href',
    'https://aistudio.google.com/usage?timeRange=last-1-day&tab=rate-limit');
  expect(usage).toHaveAttribute('target', '_blank');
  expect(usage).toHaveAttribute('rel', 'noopener noreferrer');
  expect(usage.parentElement).toBe(container.querySelector('.gemini-key-header'));
  expect(usage.previousElementSibling).toHaveAttribute('for', 'new-gemini-key-input');
  expect(usage.previousElementSibling).toHaveTextContent('Gemini API Keys');
  expect(usage.previousElementSibling).toHaveTextContent('Not Set');
  expect(screen.getByTestId('gemini-keys-manager')).toBeInTheDocument();
  expect(screen.getByText(
    'Add multiple keys and OSG will distribute parallel Gemini work across them, rotating when a request can be retried.'
  )).toBeInTheDocument();
});

it('offers confirmed removal for an already-saved Genius credential', async () => {
  credentialMocks.removeSingletonCredential.mockResolvedValue(true);
  render(<ApiKeysTab
    {...defaultProps}
    apiKeysSet={{ ...defaultProps.apiKeysSet, genius: true }}
  />);

  fireEvent.click(screen.getByRole('button', { name: 'Clear saved credential' }));
  const request = credentialMocks.showConfirmationToast.mock.calls[0][0];
  expect(request.key).toBe('clear-geniusAccessToken');
  await expect(request.onConfirm()).resolves.toBe(true);
  expect(credentialMocks.removeSingletonCredential).toHaveBeenCalledWith('geniusAccessToken');
});
