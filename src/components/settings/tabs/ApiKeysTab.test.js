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
vi.mock('../../common/CloseButton', () => ({
  default: ({ onClick, ariaLabel }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>close</button>
  ),
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

it('keeps the product notice without rendering or persisting the removed UDBM promotion', () => {
  localStorage.setItem('udbmMessageClosed', 'true');

  const { container } = render(<ApiKeysTab {...defaultProps} />);

  expect(screen.getByText('settings.gemini25ProPaused')).toBeInTheDocument();
  expect(screen.getByText(
    'Add multiple keys and OSG will distribute parallel Gemini work across them, rotating when a request can be retried.'
  )).toBeInTheDocument();
  expect(container.querySelector('.udbm-message')).toBeNull();
  expect(container.querySelector('a[href*="/udbm/"]')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'settings.closeMessage' }));
  expect(screen.getByText('settings.noNewNotifications')).toBeInTheDocument();
  expect(localStorage.getItem('udbmMessageClosed')).toBe('true');
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
