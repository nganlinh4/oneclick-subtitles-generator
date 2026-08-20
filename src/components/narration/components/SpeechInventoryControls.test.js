import { act, render, waitFor } from '@testing-library/react';
import {
  getSpeechVoiceInventory,
  probeSpeechBackend,
  startSpeechJob,
  stopSpeechRuntime,
} from '../../../platform/speechService';
import EdgeTTSControls from './EdgeTTSControls';
import GTTSControls from './GTTSControls';

const lifecycle = vi.hoisted(() => {
  const snapshots = new Map();
  const listeners = new Set();
  return {
    reset() {
      snapshots.clear();
      listeners.clear();
    },
    apply(snapshot) {
      snapshots.set(snapshot.backend, snapshot);
      [...listeners].forEach((listener) => listener(snapshot));
    },
    get(backend) {
      return snapshots.get(backend) || null;
    },
    subscribe(listener) {
      listeners.add(listener);
      snapshots.forEach((snapshot) => listener(snapshot));
      return () => listeners.delete(listener);
    },
  };
});

vi.mock('react-i18next', () => {
  const translate = (_key, fallback) => fallback;
  return { useTranslation: () => ({ t: translate }) };
});
vi.mock('../../../platform/speechService', () => ({
  getSpeechLifecycleSnapshot: lifecycle.get,
  getSpeechVoiceInventory: vi.fn(),
  probeSpeechBackend: vi.fn(),
  startSpeechJob: vi.fn(),
  stopSpeechRuntime: vi.fn(),
  subscribeSpeechLifecycle: lifecycle.subscribe,
}));
vi.mock('../../common/SliderWithValue', () => ({ default: () => <div /> }));
vi.mock('../../common/MaterialSwitch', () => ({ default: () => <div /> }));
vi.mock('../../common/CustomDropdown', () => ({ default: () => <div /> }));
vi.mock('./VoiceSelectionModal', () => ({ default: () => null }));
vi.mock('./LanguageSelectionModal', () => ({ default: () => null }));

const edgeProps = (overrides = {}) => ({
  selectedVoice: '',
  setSelectedVoice: vi.fn(),
  rate: '+0%',
  setRate: vi.fn(),
  volume: '+0%',
  setVolume: vi.fn(),
  pitch: '+0Hz',
  setPitch: vi.fn(),
  isGenerating: false,
  detectedLanguage: { languageCode: 'en' },
  ...overrides,
});

const gttsProps = (overrides = {}) => ({
  selectedLanguage: '',
  setSelectedLanguage: vi.fn(),
  tld: 'com',
  setTld: vi.fn(),
  slow: false,
  setSlow: vi.fn(),
  isGenerating: false,
  detectedLanguage: { languageCode: 'en' },
  ...overrides,
});

beforeEach(() => {
  lifecycle.reset();
  lifecycle.apply({ backend: 'edgeTts', epoch: 11, enabled: true, warm: true });
  lifecycle.apply({ backend: 'gtts', epoch: 21, enabled: true, warm: true });
  window.addToast = vi.fn();
});

afterEach(() => {
  delete window.addToast;
  vi.clearAllMocks();
});

it.each([
  ['edgeTts', () => <EdgeTTSControls {...edgeProps({ isServiceAvailable: false })} />],
  ['gtts', () => <GTTSControls {...gttsProps({ isServiceAvailable: false })} />],
])('does not probe the stopped %s engine on mount', (_backend, renderControl) => {
  render(renderControl());
  expect(getSpeechVoiceInventory).not.toHaveBeenCalled();
  expect(probeSpeechBackend).not.toHaveBeenCalled();
  expect(startSpeechJob).not.toHaveBeenCalled();
});

it('ignores late inventories across an Edge-to-gTTS method switch and a concurrent Stop', async () => {
  let resolveEdge;
  let resolveGtts;
  getSpeechVoiceInventory.mockImplementation((backend) => new Promise((resolve) => {
    if (backend === 'edgeTts') resolveEdge = resolve;
    if (backend === 'gtts') resolveGtts = resolve;
  }));
  const setSelectedVoice = vi.fn();
  const setSelectedLanguage = vi.fn();
  const Harness = ({ method, available }) => method === 'edge-tts'
    ? <EdgeTTSControls {...edgeProps({ isServiceAvailable: available, setSelectedVoice })} />
    : <GTTSControls {...gttsProps({ isServiceAvailable: available, setSelectedLanguage })} />;
  const { rerender } = render(<Harness method="edge-tts" available />);

  await waitFor(() => expect(getSpeechVoiceInventory).toHaveBeenCalledWith('edgeTts', 11));
  rerender(<Harness method="gtts" available />);
  await waitFor(() => expect(getSpeechVoiceInventory).toHaveBeenCalledWith('gtts', 21));
  rerender(<Harness method="gtts" available={false} />);

  await act(async () => {
    resolveEdge({
      backend: 'edgeTts', epoch: 11, enabled: true, warm: true,
      voices: [{ id: 'en-US-AriaNeural', displayName: 'Aria', language: 'en-US', gender: 'female' }],
    });
    resolveGtts({
      backend: 'gtts', epoch: 21, enabled: true, warm: true,
      voices: [{ id: 'en', displayName: 'English', language: 'en', gender: 'unknown' }],
    });
    await Promise.resolve();
  });

  expect(setSelectedVoice).not.toHaveBeenCalled();
  expect(setSelectedLanguage).not.toHaveBeenCalled();
  expect(window.addToast).not.toHaveBeenCalled();
  expect(getSpeechVoiceInventory).toHaveBeenCalledTimes(2);
  expect(probeSpeechBackend).not.toHaveBeenCalled();
  expect(startSpeechJob).not.toHaveBeenCalled();
});

it('a real shared Tools Stop disables controls and rejects late inventory without a rerender', async () => {
  let resolveEdge;
  stopSpeechRuntime.mockImplementation(async (backend) => {
    const current = lifecycle.get(backend);
    lifecycle.apply({
      backend,
      epoch: current.epoch + 1,
      enabled: false,
      warm: false,
    });
    return lifecycle.get(backend);
  });
  getSpeechVoiceInventory.mockImplementation((backend) => {
    if (backend === 'edgeTts') {
      return new Promise((resolve) => { resolveEdge = resolve; });
    }
    throw new Error('stopped runtime inventory must not be requested');
  });
  const setSelectedVoice = vi.fn();
  const setSelectedLanguage = vi.fn();
  const Harness = ({ method }) => method === 'edge-tts'
    ? <EdgeTTSControls {...edgeProps({ isServiceAvailable: true, setSelectedVoice })} />
    : <GTTSControls {...gttsProps({ isServiceAvailable: true, setSelectedLanguage })} />;
  const { container, rerender } = render(<Harness method="edge-tts" />);

  await waitFor(() => expect(getSpeechVoiceInventory).toHaveBeenCalledWith('edgeTts', 11));
  await act(async () => { await stopSpeechRuntime('edgeTts'); });
  await act(async () => {
    resolveEdge({
      backend: 'edgeTts', epoch: 11, enabled: true, warm: true,
      voices: [{ id: 'en-US-AriaNeural', displayName: 'Aria', language: 'en-US', gender: 'female' }],
    });
    await Promise.resolve();
  });
  await waitFor(() => expect(container.querySelector('.model-dropdown-btn')).toBeDisabled());
  await act(async () => { await stopSpeechRuntime('gtts'); });
  rerender(<Harness method="gtts" />);
  await waitFor(() => expect(container.querySelector('.model-dropdown-btn')).toBeDisabled());

  expect(getSpeechVoiceInventory).toHaveBeenCalledTimes(1);
  expect(setSelectedVoice).not.toHaveBeenCalled();
  expect(setSelectedLanguage).not.toHaveBeenCalled();
  expect(probeSpeechBackend).not.toHaveBeenCalled();
  expect(startSpeechJob).not.toHaveBeenCalled();
});
