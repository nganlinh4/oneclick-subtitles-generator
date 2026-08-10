import { act, renderHook, waitFor } from '@testing-library/react';
import { getAsrStatus } from '../platform/asrService';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import { getSpeechStatus } from '../platform/speechService';
import {
  mapNativeAsrEngines,
  mapNativeSpeechEngines,
  useEngineStatus,
} from './useEngineStatus';

vi.mock('../platform/asrService', () => ({
  getAsrStatus: vi.fn(),
}));

vi.mock('../platform/desktopRuntime', () => ({
  isDesktopRuntime: vi.fn(),
}));

vi.mock('../platform/managedEngineCatalog', () => ({
  MANAGED_SPEECH_ENGINE_BINDINGS: Object.freeze([
    Object.freeze({
      engineId: 'f5tts', label: 'F5-TTS', packageBackend: 'f5-tts', runtimeBackend: 'f5Tts',
    }),
    Object.freeze({
      engineId: 'chatterbox', label: 'Chatterbox', packageBackend: 'chatterbox', runtimeBackend: 'chatterbox',
    }),
  ]),
}));

vi.mock('../platform/speechService', () => ({
  getSpeechStatus: vi.fn(),
}));

const nativeAsrStatus = {
  workerAvailable: true,
  engines: [
    {
      id: 'parakeet',
      label: 'Parakeet',
      installed: true,
      ready: true,
      warm: true,
      runtime: 'onnx',
      supportsForcedLanguage: false,
      requiresAligner: false,
    },
    {
      id: 'qwen3-asr-0.6b',
      label: 'Qwen3 ASR 0.6B',
      installed: true,
      ready: false,
      warm: false,
      runtime: 'py_torch',
      supportsForcedLanguage: true,
      requiresAligner: true,
    },
    {
      id: 'qwen3-asr-1.7b',
      label: 'Qwen3 ASR 1.7B',
      installed: false,
      ready: false,
      warm: false,
      runtime: 'py_torch',
      supportsForcedLanguage: true,
      requiresAligner: true,
    },
  ],
};

const speechBackend = (backend, overrides = {}) => ({
  backend,
  installed: false,
  ready: false,
  warm: false,
  requiresReference: backend === 'f5Tts' || backend === 'chatterbox',
  supportsVoiceInventory: false,
  supportsVoiceConversion: backend === 'chatterbox',
  requiresCredential: false,
  ...overrides,
});

const nativeSpeechStatus = {
  backends: [
    speechBackend('f5Tts', { installed: true, ready: true, warm: true }),
    speechBackend('chatterbox', { installed: true }),
  ],
  maxSegmentsPerJob: 1000,
  maxBatchTextBytes: 1048576,
};

beforeEach(() => {
  isDesktopRuntime.mockReturnValue(true);
  getAsrStatus.mockResolvedValue(nativeAsrStatus);
  getSpeechStatus.mockResolvedValue(nativeSpeechStatus);
});

afterEach(() => {
  vi.clearAllMocks();
  delete global.fetch;
});

it('maps native ASR readiness to the existing engine-card state contract', () => {
  expect(mapNativeAsrEngines(nativeAsrStatus)).toEqual({
    parakeet: {
      id: 'parakeet',
      label: 'Parakeet',
      installed: true,
      running: true,
      state: 'ready',
      warm: true,
      runtime: 'onnx',
      supportsForcedLanguage: false,
      requiresAligner: false,
      managedByElectron: false,
    },
    'qwen3-asr-0.6b': expect.objectContaining({
      installed: true,
      running: false,
      state: 'installed-stopped',
      managedByElectron: false,
    }),
    'qwen3-asr-1.7b': expect.objectContaining({
      installed: false,
      running: false,
      state: 'not-installed',
      managedByElectron: false,
    }),
  });
});

it('maps managed speech health and warmth without pretending cold packages are running', () => {
  expect(mapNativeSpeechEngines(nativeSpeechStatus)).toEqual({
    f5tts: expect.objectContaining({
      id: 'f5tts',
      installed: true,
      running: true,
      state: 'ready',
      runtime: 'native-speech',
    }),
    chatterbox: expect.objectContaining({
      id: 'chatterbox',
      installed: true,
      running: false,
      state: 'installed-stopped',
      runtime: 'native-speech',
    }),
  });
});

it('merges typed ASR and speech status without contacting the legacy HTTP service', async () => {
  global.fetch = vi.fn();

  const { result, unmount } = renderHook(() => useEngineStatus({ poll: false }));
  await waitFor(() => expect(result.current.loading).toBe(false));

  expect(getAsrStatus).toHaveBeenCalledTimes(1);
  expect(getSpeechStatus).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(result.current.isReady('parakeet')).toBe(true);
  expect(result.current.isReady('f5tts')).toBe(true);
  expect(result.current.isInstalled('chatterbox')).toBe(true);
  expect(result.current.isInstalled('qwen3-asr-1.7b')).toBe(false);
  unmount();
});

it('fails closed during browser-only inspection without probing native or legacy services', async () => {
  isDesktopRuntime.mockReturnValue(false);
  global.fetch = vi.fn();

  const { result, unmount } = renderHook(() => useEngineStatus({ poll: false }));
  await waitFor(() => expect(result.current.loading).toBe(false));

  expect(getAsrStatus).not.toHaveBeenCalled();
  expect(getSpeechStatus).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(result.current.engines).toEqual({});
  expect(result.current.isReady('chatterbox')).toBe(false);
  unmount();
});

it('updates a healthy family while retaining the last validated status for a transient failure', async () => {
  const { result, unmount } = renderHook(() => useEngineStatus({ poll: false }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const firstParakeet = result.current.engines.parakeet;
  getAsrStatus.mockRejectedValueOnce(new Error('worker temporarily unavailable'));
  getSpeechStatus.mockResolvedValueOnce({
    ...nativeSpeechStatus,
    backends: [
      speechBackend('f5Tts', { installed: true }),
      speechBackend('chatterbox', { installed: true, ready: true, warm: true }),
    ],
  });

  await act(async () => {
    await result.current.refresh();
  });

  expect(result.current.engines.parakeet).toBe(firstParakeet);
  expect(result.current.isReady('f5tts')).toBe(false);
  expect(result.current.isReady('chatterbox')).toBe(true);
  unmount();
});

it('ignores an older refresh that resolves after a newer mixed native snapshot', async () => {
  let resolveOldAsr;
  let resolveOldSpeech;
  getAsrStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveOldAsr = resolve; }));
  getSpeechStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveOldSpeech = resolve; }));
  const { result, unmount } = renderHook(() => useEngineStatus({ poll: false }));

  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.isReady('parakeet')).toBe(true);

  await act(async () => {
    resolveOldAsr({
      ...nativeAsrStatus,
      engines: nativeAsrStatus.engines.map((engine) => ({
        ...engine, ready: false, warm: false,
      })),
    });
    resolveOldSpeech({
      ...nativeSpeechStatus,
      backends: nativeSpeechStatus.backends.map((backend) => ({
        ...backend, ready: false, warm: false,
      })),
    });
    await Promise.resolve();
  });

  expect(result.current.isReady('parakeet')).toBe(true);
  expect(result.current.isReady('f5tts')).toBe(true);
  unmount();
});
