import { act, render, waitFor } from '@testing-library/react';

import {
  startManagedEngineRuntime,
  stopManagedEngineRuntime,
} from '../../../platform/managedEngineService';
import EdgeTTSControls from './EdgeTTSControls';
import GTTSControls from './GTTSControls';

const native = vi.hoisted(() => ({
  invokeDesktop: vi.fn(),
  states: new Map(),
  commands: [],
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock('../../../platform/desktopRuntime', () => ({
  invokeDesktop: native.invokeDesktop,
  isDesktopRuntime: () => true,
}));
vi.mock('../../../platform/enginePackageService', () => ({
  ENGINE_PACKAGE_ENGINE_IDS: [],
  cancelEnginePackageJob: vi.fn(),
  getEnginePackagesStatus: vi.fn(),
  installEnginePackage: vi.fn(),
  removeEnginePackage: vi.fn(),
  startEngineRuntime: vi.fn(),
  stopEngineRuntime: vi.fn(),
}));
vi.mock('../../../platform/speechPackageService', () => ({
  cancelSpeechPackageJob: vi.fn(),
  getSpeechPackagesStatus: vi.fn(),
  installSpeechPackage: vi.fn(),
  removeSpeechPackage: vi.fn(),
}));
vi.mock('react-i18next', () => {
  const translate = (_key, fallback) => fallback;
  return { useTranslation: () => ({ t: translate }) };
});
vi.mock('../../common/SliderWithValue', () => ({ default: () => <div /> }));
vi.mock('../../common/MaterialSwitch', () => ({ default: () => <div /> }));
vi.mock('../../common/CustomDropdown', () => ({ default: () => <div /> }));
vi.mock('./VoiceSelectionModal', () => ({ default: () => null }));
vi.mock('./LanguageSelectionModal', () => ({ default: () => null }));

const backendStatus = (backend, state) => ({
  backend,
  epoch: state.epoch,
  enabled: state.enabled,
  installed: true,
  ready: state.enabled,
  warm: state.enabled,
  requiresReference: backend === 'f5Tts' || backend === 'chatterbox',
  supportsVoiceInventory: ['edgeTts', 'gtts', 'geminiTts'].includes(backend),
  supportsVoiceConversion: backend === 'chatterbox',
  requiresCredential: backend === 'geminiTts',
});

const voicesFor = (backend) => backend === 'edgeTts'
  ? [{
    id: 'en-US-AriaNeural', displayName: 'Aria', language: 'en-US', gender: 'female',
  }]
  : [{ id: 'en', displayName: 'English', language: 'en', gender: 'unknown' }];

const edgeProps = () => ({
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
  isServiceAvailable: true,
});

const gttsProps = () => ({
  selectedLanguage: '',
  setSelectedLanguage: vi.fn(),
  tld: 'com',
  setTld: vi.fn(),
  slow: false,
  setSlow: vi.fn(),
  isGenerating: false,
  detectedLanguage: { languageCode: 'en' },
  isServiceAvailable: true,
});

beforeEach(() => {
  native.commands.length = 0;
  native.states.clear();
  native.states.set('edgeTts', { epoch: 100, enabled: false });
  native.states.set('gtts', { epoch: 200, enabled: false });
  native.invokeDesktop.mockImplementation(async (command, args) => {
    native.commands.push([command, args]);
    const state = native.states.get(args.backend);
    if (command === 'speech_probe') {
      state.enabled = true;
      return { status: backendStatus(args.backend, state), voices: voicesFor(args.backend) };
    }
    if (command === 'speech_voice_inventory') {
      if (!state.enabled || state.epoch !== args.epoch) throw new Error('stale inventory');
      return {
        backend: args.backend,
        epoch: state.epoch,
        enabled: true,
        warm: true,
        voices: voicesFor(args.backend),
      };
    }
    if (command === 'speech_runtime_stop') {
      state.epoch += 1;
      state.enabled = false;
      return backendStatus(args.backend, state);
    }
    throw new Error(`unexpected command: ${command}`);
  });
  window.addToast = vi.fn();
});

afterEach(() => {
  delete window.addToast;
  vi.clearAllMocks();
});

it.each([
  ['edge-tts', 'edgeTts', () => <EdgeTTSControls {...edgeProps()} />],
  ['gtts', 'gtts', () => <GTTSControls {...gttsProps()} />],
])(
  'preserves the loaded %s controls when Tools stops only the transient worker',
  async (engineId, backend, renderControl) => {
    await startManagedEngineRuntime(engineId);
    const { container, unmount } = render(renderControl());
    await waitFor(() => expect(container.querySelector('.model-dropdown-btn')).toBeEnabled());
    const probesBeforeStop = native.commands.filter(([command]) => command === 'speech_probe').length;

    await act(async () => { await stopManagedEngineRuntime(engineId); });

    await waitFor(() => expect(container.querySelector('.model-dropdown-btn')).toBeEnabled());
    expect(native.commands.filter(([command]) => command === 'speech_probe')).toHaveLength(
      probesBeforeStop
    );
    expect(native.commands.some(([command]) => command === 'speech_start')).toBe(false);
    expect(native.states.get(backend)).toMatchObject({ enabled: false });
    unmount();
  }
);
