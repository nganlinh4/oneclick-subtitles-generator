import { act, render } from '@testing-library/react';
import BackgroundMusicSection from './BackgroundMusicSection';

const mocks = vi.hoisted(() => ({
  t: (_key, fallback) => fallback,
  trim: vi.fn(async () => null),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'en' } }),
}));
vi.mock('../platform/credentialStateController', () => ({
  getActiveGeminiCredentialId: () => null,
  initializeCredentialState: vi.fn(async () => undefined),
  subscribeCredentialState: vi.fn(() => () => undefined),
}));
vi.mock('../utils/audioTrim', () => ({ trimSilenceFromBlob: mocks.trim }));
vi.mock('./common/AudioPlayer', () => ({
  default: ({ audioSrc }) => <span data-testid="recording">{audioSrc}</span>,
}));
vi.mock('./common/CustomDropdown', () => ({ default: () => null }));
vi.mock('./common/MaterialSwitch', () => ({ default: () => null }));
vi.mock('./common/HelpIcon.jsx', () => ({ default: () => null }));

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let urlCount = 0;

beforeEach(() => {
  localStorage.removeItem('bg_music_collapsed');
  urlCount = 0;
  URL.createObjectURL = vi.fn(() => {
    urlCount += 1;
    return `blob:bg-${urlCount}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.restoreAllMocks();
});

test('a new recording URL does not re-subscribe the PromptDJ message listener', async () => {
  const addListener = vi.spyOn(window, 'addEventListener');
  const removeListener = vi.spyOn(window, 'removeEventListener');
  const view = render(<BackgroundMusicSection />);
  const frame = view.container.querySelector('iframe').contentWindow;
  const messageSubscriptions = () => addListener.mock.calls.filter(([type]) => type === 'message');
  const subscribedBefore = messageSubscriptions().length;
  expect(subscribedBefore).toBeGreaterThan(0);

  const stopRecording = async (text) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame,
        origin: window.location.origin,
        data: { type: 'pm-dj-recording-stopped', blob: new Blob([text], { type: 'audio/wav' }) },
      }));
    });
  };

  await stopRecording('first');
  expect(view.getByTestId('recording').textContent).toBe('blob:bg-1');
  await stopRecording('second');
  expect(view.getByTestId('recording').textContent).toBe('blob:bg-2');

  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bg-1');
  expect(messageSubscriptions()).toHaveLength(subscribedBefore);
  expect(removeListener.mock.calls.filter(([type]) => type === 'message')).toHaveLength(0);
  view.unmount();
});
