import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useAppState } from './AppState';
import {
  getCredentialAvailability,
  initializeCredentialState,
  subscribeCredentialState,
} from '../../platform/credentialStateController';

global.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => {
  const t = (_key, fallback) => fallback;
  return { useTranslation: () => ({ t }) };
});
vi.mock('../../utils/systemDetection', () => ({ getThemeWithFallback: () => 'dark' }));
vi.mock('../../hooks/useSubtitles', () => {
  const stableSubtitlesState = {
    subtitlesData: null,
    setSubtitlesData: vi.fn(),
    status: {},
    setStatus: vi.fn(),
    isGenerating: false,
    generateSubtitles: vi.fn(),
    retryGeneration: vi.fn(),
    retrySegment: vi.fn(),
    retryingSegments: [],
  };
  return { useSubtitles: () => stableSubtitlesState };
});
vi.mock('../../utils/userSubtitlesStore', () => ({
  getUserProvidedSubtitlesSync: () => '',
}));
vi.mock('../../utils/transcriptionRulesStore', () => ({
  getTranscriptionRulesSync: () => null,
}));
vi.mock('../../services/geminiService', () => ({
  PROMPT_PRESETS: [{ id: 'general', prompt: 'default prompt' }],
}));
vi.mock('../../utils/videoUtils', () => ({ cleanupInvalidBlobUrls: vi.fn() }));
vi.mock('../../config/geminiModels', () => ({
  DEFAULT_GEMINI_MODEL_ID: 'gemini-2.5-flash',
  migrateStoredGeminiModels: vi.fn(),
}));
vi.mock('../../platform/credentialStateController', () => ({
  getCredentialAvailability: vi.fn(),
  initializeCredentialState: vi.fn(),
  subscribeCredentialState: vi.fn(),
}));

const renderAppState = () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const result = { current: undefined };
  const Host = () => {
    result.current = useAppState();
    return null;
  };
  document.body.appendChild(container);
  act(() => root.render(<Host />));
  return {
    result,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(window.performance, 'getEntriesByType', {
    configurable: true,
    value: () => [],
  });
  subscribeCredentialState.mockImplementation(() => () => undefined);
  initializeCredentialState.mockResolvedValue({ initialized: false, store: 'unavailable' });
  getCredentialAvailability.mockImplementation((snapshot, { useOAuth } = {}) => {
    const ready = new Set(
      snapshot.store === 'available'
        ? snapshot.credentials.filter(({ state }) => state === 'ready').map(({ purpose }) => purpose)
        : []
    );
    return {
      gemini: ready.has('geminiApiKey'),
      youtube: useOAuth ? false : ready.has('youtubeApiKey'),
      genius: ready.has('geniusAccessToken'),
    };
  });
});

it('keeps clean-install defaults as read-time fallbacks instead of browser preferences', () => {
  const view = renderAppState();

  expect(view.result.current.activeTab).toBe('unified-url');
  for (const key of [
    'gemini_model',
    'onboarding_completed',
    'selected_preset_id',
    'transcription_prompt',
    'userPreferredTab',
  ]) {
    expect(localStorage.getItem(key), key).toBeNull();
  }
  view.unmount();
});

it('derives timing-generation enablement from the hydrated project text only', async () => {
  localStorage.setItem('use_user_provided_subtitles', 'true');
  const view = renderAppState();

  expect(view.result.current.useUserProvidedSubtitles).toBe(false);
  await act(async () => {
    window.dispatchEvent(new CustomEvent('userProvidedSubtitlesUpdated', {
      detail: { subtitlesText: 'Project-owned SRT' },
    }));
  });
  expect(view.result.current.userProvidedSubtitles).toBe('Project-owned SRT');
  expect(view.result.current.useUserProvidedSubtitles).toBe(true);

  await act(async () => {
    window.dispatchEvent(new CustomEvent('userProvidedSubtitlesUpdated', {
      detail: { subtitlesText: '' },
    }));
  });
  expect(view.result.current.userProvidedSubtitles).toBe('');
  expect(view.result.current.useUserProvidedSubtitles).toBe(false);
  view.unmount();
});

it('hydrates native API availability only from safe status metadata', async () => {
  const snapshot = {
    initialized: true,
    store: 'available',
    credentials: [
      { purpose: 'geminiApiKey', state: 'ready', last4: '1234' },
      { purpose: 'youtubeApiKey', state: 'pending', last4: '5678' },
      { purpose: 'geniusAccessToken', state: 'ready', last4: '9012' },
    ],
  };
  initializeCredentialState.mockResolvedValue(snapshot);
  localStorage.setItem('gemini_api_key', 'must-not-be-read');
  localStorage.setItem('youtube_api_key', 'must-not-be-read');
  localStorage.setItem('genius_token', 'must-not-be-read');

  const view = renderAppState();
  await act(async () => Promise.resolve());

  expect(view.result.current.apiKeysSet).toEqual({
    gemini: true,
    youtube: false,
    genius: true,
  });
  expect(JSON.stringify(view.result.current.apiKeysSet)).not.toContain('must-not-be-read');
  view.unmount();
});
