import { fireEvent, render, screen } from '@testing-library/react';

import YoutubeAuthSection from './YoutubeAuthSection';

const oauthMocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('../utils/keyVisibilityAnimation', () => ({ animateToggle: vi.fn() }));
vi.mock('../utils/youtubeOAuthHandlers', () => ({
  handleOAuthAuthentication: oauthMocks.authenticate,
  handleClearOAuth: oauthMocks.clear,
}));

const props = {
  youtubeApiKey: '',
  setYoutubeApiKey: vi.fn(),
  showYoutubeKey: false,
  setShowYoutubeKey: vi.fn(),
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
  apiKeysSet: { youtube: false },
  setApiKeysSet: vi.fn(),
  onClearApiKey: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

it('offers removal when a YouTube API key is already stored', () => {
  render(<YoutubeAuthSection
    {...props}
    apiKeysSet={{ youtube: true }}
  />);

  fireEvent.click(screen.getByRole('button', { name: 'Clear saved credential' }));
  expect(props.onClearApiKey).toHaveBeenCalledOnce();
});

it('offers OAuth cleanup even when authentication did not complete', () => {
  render(<YoutubeAuthSection {...props} useOAuth />);

  fireEvent.click(screen.getByRole('button', { name: 'Clear Authentication' }));
  expect(oauthMocks.clear).toHaveBeenCalledWith(props.setIsAuthenticated);
});
