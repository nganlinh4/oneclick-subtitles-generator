import { act } from 'react';
import { createRoot } from 'react-dom/client';
import useSettingsState from './useSettingsState';
import {
  cancelYouTubeOAuthNative,
  getYouTubeOAuthStatusNative,
} from '../../../platform/providerService';

global.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../platform/providerService', () => ({
  cancelYouTubeOAuthNative: vi.fn(),
  getYouTubeOAuthStatusNative: vi.fn(),
}));
vi.mock('../../../services/geminiService', () => ({
  DEFAULT_TRANSCRIPTION_PROMPT: 'default prompt',
}));

const renderSettingsState = () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const result = { current: undefined };
  const Host = () => {
    result.current = useSettingsState();
    return null;
  };
  document.body.appendChild(container);
  act(() => root.render(<Host />));
  return { result, unmount: () => act(() => root.unmount()) };
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getYouTubeOAuthStatusNative.mockReturnValue(new Promise(() => {}));
  cancelYouTubeOAuthNative.mockResolvedValue(false);
});

it('never hydrates native form state or original snapshots from legacy secrets', () => {
  localStorage.setItem('gemini_api_key', 'native-gemini-secret');
  localStorage.setItem('youtube_api_key', 'native-youtube-secret');
  localStorage.setItem('genius_token', 'native-genius-secret');

  const { result, unmount } = renderSettingsState();

  expect(result.current.geminiApiKey).toBe('');
  expect(result.current.youtubeApiKey).toBe('');
  expect(result.current.geniusApiKey).toBe('');
  expect(result.current.youtubeClientId).toBe('');
  expect(result.current.youtubeClientSecret).toBe('');
  expect(result.current.originalSettings).toEqual(expect.objectContaining({
    geminiApiKey: '',
    youtubeApiKey: '',
    geniusApiKey: '',
    youtubeClientId: '',
    youtubeClientSecret: '',
  }));
  expect(getYouTubeOAuthStatusNative).toHaveBeenCalledTimes(1);
  unmount();
  expect(cancelYouTubeOAuthNative).toHaveBeenCalledTimes(1);
});

it('hydrates authentication only from native OAuth status metadata', async () => {
  getYouTubeOAuthStatusNative.mockResolvedValue({ authenticated: true });

  const { result, unmount } = renderSettingsState();
  await act(async () => Promise.resolve());

  expect(result.current.isAuthenticated).toBe(true);
  unmount();
});
