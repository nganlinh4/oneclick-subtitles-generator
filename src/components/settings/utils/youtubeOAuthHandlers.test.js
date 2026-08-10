import {
  authorizeYouTubeNative,
  clearYouTubeOAuthNative,
} from '../../../platform/providerService';
import {
  handleClearOAuth,
  handleOAuthAuthentication,
  storeClientCredentials,
} from './youtubeOAuthHandlers';

vi.mock('../../../platform/providerService', () => ({
  authorizeYouTubeNative: vi.fn(),
  clearYouTubeOAuthNative: vi.fn(),
}));
vi.mock('../../../i18n/i18n', () => {
  const translate = (_key, fallback) => fallback;
  return {
    default: { t: translate },
    t: translate,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.alert = vi.fn();
  window.open = vi.fn();
});

it('starts the system-browser native OAuth flow without legacy storage or popup transport', async () => {
  authorizeYouTubeNative.mockResolvedValue({
    authenticated: true,
    expiresAtUnixMs: 1_800_000_000_000,
  });
  const setIsAuthenticated = vi.fn();

  expect(storeClientCredentials('native-client-id', 'native-client-secret')).toBe(false);
  await expect(handleOAuthAuthentication(
    'native-client-id',
    'native-client-secret',
    setIsAuthenticated
  )).resolves.toBe(true);

  expect(localStorage.getItem('youtube_client_id')).toBeNull();
  expect(localStorage.getItem('youtube_client_secret')).toBeNull();
  expect(window.open).not.toHaveBeenCalled();
  expect(authorizeYouTubeNative).toHaveBeenCalledWith({
    clientId: 'native-client-id',
    clientSecret: 'native-client-secret',
  });
  expect(setIsAuthenticated).toHaveBeenCalledWith(true);
});

it('clears native OAuth only after confirmation', async () => {
  window.confirm = vi.fn().mockReturnValue(true);
  clearYouTubeOAuthNative.mockResolvedValue(true);
  const setIsAuthenticated = vi.fn();

  await expect(handleClearOAuth(setIsAuthenticated)).resolves.toBe(true);

  expect(clearYouTubeOAuthNative).toHaveBeenCalledTimes(1);
  expect(setIsAuthenticated).toHaveBeenCalledWith(false);
});

it('fails closed before IPC when either credential draft is missing', () => {
  expect(handleOAuthAuthentication('client-id', '', vi.fn())).toBe(false);
  expect(authorizeYouTubeNative).not.toHaveBeenCalled();
  expect(localStorage.getItem('youtube_client_id')).toBeNull();
  expect(localStorage.getItem('youtube_client_secret')).toBeNull();
});
