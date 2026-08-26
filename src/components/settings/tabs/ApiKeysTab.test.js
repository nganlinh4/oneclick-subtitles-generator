import { fireEvent, render, screen } from '@testing-library/react';

import ApiKeysTab from './ApiKeysTab';

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
});

it('keeps the product notice without rendering or persisting the removed UDBM promotion', () => {
  localStorage.setItem('udbmMessageClosed', 'true');

  const { container } = render(<ApiKeysTab {...defaultProps} />);

  expect(screen.getByText('settings.gemini25ProPaused')).toBeInTheDocument();
  expect(container.querySelector('.udbm-message')).toBeNull();
  expect(container.querySelector('a[href*="/udbm/"]')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'settings.closeMessage' }));
  expect(screen.getByText('settings.noNewNotifications')).toBeInTheDocument();
  expect(localStorage.getItem('udbmMessageClosed')).toBe('true');
});
