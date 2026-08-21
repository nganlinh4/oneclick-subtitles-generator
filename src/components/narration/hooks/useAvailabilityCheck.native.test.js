import { act, renderHook, waitFor } from '@testing-library/react';
import useAvailabilityCheck, {
  checkNativeNarrationAvailability,
  getGeminiCredentialAvailability,
} from './useAvailabilityCheck';

const mocks = vi.hoisted(() => ({
  isDesktopRuntime: vi.fn(),
  getStatus: vi.fn(),
  probe: vi.fn(),
  stopRuntime: vi.fn(),
  subscribeSpeechLifecycle: vi.fn(),
  lifecycleSubscriber: null,
  initializeCredentialState: vi.fn(),
  subscribeCredentialState: vi.fn(),
}));

vi.mock('../../../platform/desktopRuntime', () => ({
  isDesktopRuntime: mocks.isDesktopRuntime,
}));
vi.mock('../../../platform/nativeNarrationAdapter', () => ({
  nativeNarrationAdapter: {
    getStatus: mocks.getStatus,
    probe: mocks.probe,
    stopRuntime: mocks.stopRuntime,
  },
}));
vi.mock('../../../platform/speechService', () => ({
  subscribeSpeechLifecycle: mocks.subscribeSpeechLifecycle,
}));
vi.mock('../../../platform/credentialStateController', () => ({
  initializeCredentialState: mocks.initializeCredentialState,
  subscribeCredentialState: mocks.subscribeCredentialState,
}));

const backend = (name, overrides = {}) => ({
  backend: name,
  epoch: overrides.epoch ?? 0,
  enabled: overrides.enabled ?? overrides.ready ?? false,
  installed: false,
  ready: false,
  warm: false,
  requiresCredential: name === 'geminiTts',
  ...overrides,
});

const status = (overrides = {}) => ({
  backends: [
    backend('f5Tts', overrides.f5Tts),
    backend('chatterbox', overrides.chatterbox),
    backend('edgeTts', overrides.edgeTts),
    backend('gtts', overrides.gtts),
    backend('geminiTts', overrides.geminiTts),
  ],
});

const credentialSnapshot = (state = 'ready') => {
  const hasCredential = state !== null;
  const ready = state === 'ready';
  return Object.freeze({
    initialized: true,
    store: 'available',
    credentials: hasCredential
      ? Object.freeze([Object.freeze({
        id: 'opaque-gemini-id',
        purpose: 'geminiApiKey',
        provider: 'gemini',
        state,
        last4: '1234',
      })])
      : Object.freeze([]),
    gemini: Object.freeze({
      activeCredentialId: ready ? 'opaque-gemini-id' : null,
      availableCredentialIds: ready ? Object.freeze(['opaque-gemini-id']) : Object.freeze([]),
    }),
  });
};

const setterHarness = () => ({
  setIsAvailable: vi.fn(),
  setIsGeminiAvailable: vi.fn(),
  setIsChatterboxAvailable: vi.fn(),
  setIsEdgeTTSAvailable: vi.fn(),
  setIsGTTSAvailable: vi.fn(),
  setIsCheckingAvailability: vi.fn(),
  setError: vi.fn(),
});

beforeEach(() => {
  const credentials = credentialSnapshot();
  mocks.isDesktopRuntime.mockReturnValue(true);
  mocks.getStatus.mockResolvedValue(status());
  mocks.probe.mockResolvedValue({ status: { ready: true, warm: true } });
  mocks.stopRuntime.mockResolvedValue(undefined);
  mocks.lifecycleSubscriber = null;
  mocks.subscribeSpeechLifecycle.mockImplementation((subscriber) => {
    mocks.lifecycleSubscriber = subscriber;
    return vi.fn();
  });
  mocks.initializeCredentialState.mockResolvedValue(credentials);
  mocks.subscribeCredentialState.mockImplementation((subscriber) => {
    subscriber(credentials);
    return vi.fn();
  });
});

afterEach(() => vi.clearAllMocks());

it('fails every method closed on a fresh install without probing missing packages', async () => {
  const adapter = {
    getStatus: vi.fn().mockResolvedValue(status()),
    probe: vi.fn(),
    stopRuntime: vi.fn(),
  };

  const result = await checkNativeNarrationAvailability(adapter, { probeInstalled: true });
  Object.values(result).forEach((entry) => {
    expect(entry).toEqual({
      available: false, reason: 'not-installed', message: 'SERVICE_UNAVAILABLE',
    });
  });
  expect(adapter.probe).not.toHaveBeenCalled();
  expect(adapter.getStatus).toHaveBeenCalledTimes(1);
});

it('probes installed backends and accepts only the verified ready-and-warm snapshot', async () => {
  const initial = status({
    f5Tts: { installed: true },
    edgeTts: { installed: true },
    geminiTts: { installed: true },
  });
  const verified = status({
    f5Tts: { installed: true, ready: true, warm: true },
    edgeTts: { installed: true, ready: true, warm: true },
    geminiTts: { installed: true, ready: true, warm: true },
  });
  const adapter = {
    getStatus: vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(verified),
    probe: vi.fn().mockResolvedValue({ status: { ready: true, warm: true } }),
    stopRuntime: vi.fn(),
  };

  const result = await checkNativeNarrationAvailability(adapter, { probeInstalled: true });
  expect(result.f5Status.available).toBe(true);
  expect(result.edgeTtsStatus.available).toBe(true);
  expect(result.geminiTtsStatus.available).toBe(true);
  expect(result.chatterboxStatus.reason).toBe('not-installed');
  expect(result.gttsStatus.reason).toBe('not-installed');
  expect(adapter.probe.mock.calls.map(([name]) => name)).toEqual([
    'f5Tts', 'edgeTts', 'geminiTts',
  ]);
});

it('isolates probe failures and native health changes by backend', async () => {
  const installed = status(Object.fromEntries([
    'f5Tts', 'chatterbox', 'edgeTts', 'gtts', 'geminiTts',
  ].map((name) => [name, { installed: true }])));
  const verified = status({
    f5Tts: { installed: true, ready: true, warm: true },
    chatterbox: { installed: true, ready: true, warm: true },
    edgeTts: { installed: true, ready: false, warm: false },
    gtts: { installed: true, ready: false, warm: false },
    geminiTts: { installed: true, ready: true, warm: true },
  });
  const adapter = {
    getStatus: vi.fn()
      .mockResolvedValueOnce(installed)
      .mockResolvedValueOnce(verified),
    probe: vi.fn(async (name) => {
      if (name === 'edgeTts') throw new Error('provider unavailable');
      return { status: { ready: true, warm: true } };
    }),
    stopRuntime: vi.fn(),
  };

  const result = await checkNativeNarrationAvailability(adapter, { probeInstalled: true });
  expect(result.edgeTtsStatus.reason).toBe('probe-failed');
  expect(result.gttsStatus.reason).toBe('not-ready');
  expect(result.f5Status.available).toBe(true);
  expect(result.chatterboxStatus.available).toBe(true);
  expect(result.geminiTtsStatus.available).toBe(true);
});

it('fails closed on a late-probe snapshot without mutating lifecycle state', async () => {
  const adapter = {
    getStatus: vi.fn()
      .mockResolvedValueOnce(status({ edgeTts: { installed: true } }))
      .mockResolvedValueOnce(status({
        edgeTts: { installed: true, ready: true, warm: false },
      })),
    probe: vi.fn().mockResolvedValue({ status: { ready: true, warm: false } }),
    stopRuntime: vi.fn().mockResolvedValue(undefined),
  };

  const result = await checkNativeNarrationAvailability(adapter, { probeInstalled: true });
  expect(result.edgeTtsStatus).toEqual({
    available: false, reason: 'not-ready', message: 'SERVICE_UNAVAILABLE',
  });
  expect(adapter.stopRuntime).not.toHaveBeenCalled();
});

it('uses status-only readiness polling without restarting stopped engines', async () => {
  const adapter = {
    getStatus: vi.fn().mockResolvedValue(status({
      f5Tts: { installed: true, ready: false, warm: false },
      chatterbox: { installed: true, ready: true, warm: true },
      gtts: { installed: true, ready: true, warm: false },
    })),
    probe: vi.fn(),
  };

  const result = await checkNativeNarrationAvailability(adapter, { probeInstalled: false });
  expect(result.f5Status.reason).toBe('not-ready');
  expect(result.chatterboxStatus.available).toBe(true);
  expect(result.gttsStatus.reason).toBe('not-ready');
  expect(adapter.probe).not.toHaveBeenCalled();
});

it.each([
  [null, 'missing'],
  ['pending', 'unusable'],
  ['unavailable', 'unusable'],
])('rejects a %s Gemini credential as %s without returning credential data', (state, reason) => {
  const result = getGeminiCredentialAvailability(credentialSnapshot(state));
  expect(result).toEqual({ checked: true, available: false, reason });
  expect(JSON.stringify(result)).not.toContain('1234');
  expect(JSON.stringify(result)).not.toContain('opaque-gemini-id');
});

it('accepts only the active ready Gemini credential metadata', () => {
  expect(getGeminiCredentialAvailability(credentialSnapshot())).toEqual({
    checked: true, available: true, reason: 'ready',
  });
});

it.each([null, 'unavailable'])('gates a ready Gemini worker without turning passive status into an error when credential state is %s', async (state) => {
  const credentials = credentialSnapshot(state);
  mocks.subscribeCredentialState.mockImplementationOnce((subscriber) => {
    subscriber(credentials);
    return vi.fn();
  });
  mocks.initializeCredentialState.mockResolvedValueOnce(credentials);
  mocks.getStatus.mockResolvedValueOnce(status({
    geminiTts: { installed: true, ready: true, warm: true },
  }));
  const setters = setterHarness();
  const { unmount } = renderHook(() => useAvailabilityCheck({
    narrationMethod: 'gemini',
    ...setters,
    t: (_key, fallback) => fallback,
  }));

  await waitFor(() => expect(setters.setIsCheckingAvailability).toHaveBeenLastCalledWith(false));
  expect(setters.setIsGeminiAvailable).toHaveBeenLastCalledWith(false);
  expect(setters.setError).not.toHaveBeenCalled();
  unmount();
});

it('never starts stopped engines on mount or narration-method changes', async () => {
  mocks.getStatus.mockResolvedValueOnce(status({
    edgeTts: { installed: true, ready: false, warm: false },
    gtts: { installed: true, ready: true, warm: true },
  }));
  const setters = setterHarness();
  const { rerender, unmount } = renderHook(
    ({ method }) => useAvailabilityCheck({
      narrationMethod: method,
      ...setters,
      t: (_key, fallback) => fallback,
    }),
    { initialProps: { method: 'edge-tts' } }
  );

  await waitFor(() => expect(setters.setIsCheckingAvailability).toHaveBeenLastCalledWith(false));
  expect(setters.setIsEdgeTTSAvailable).toHaveBeenLastCalledWith(false);
  rerender({ method: 'gtts' });
  expect(setters.setIsGTTSAvailable).toHaveBeenLastCalledWith(true);
  expect(mocks.probe).not.toHaveBeenCalled();
  expect(mocks.getStatus).toHaveBeenCalledTimes(1);
  unmount();
});

it('applies a Tools Stop lifecycle event immediately without waiting for the private poll', async () => {
  mocks.getStatus.mockResolvedValueOnce(status({
    edgeTts: { epoch: 5, installed: true, ready: true, warm: true },
  }));
  const setters = setterHarness();
  const { unmount } = renderHook(() => useAvailabilityCheck({
    narrationMethod: 'edge-tts',
    ...setters,
    t: (_key, fallback) => fallback,
  }));

  await waitFor(() => expect(setters.setIsEdgeTTSAvailable).toHaveBeenLastCalledWith(true));
  act(() => {
    mocks.lifecycleSubscriber(backend('edgeTts', {
      epoch: 6,
      installed: true,
      enabled: false,
      ready: false,
      warm: false,
    }));
  });

  expect(setters.setIsEdgeTTSAvailable).toHaveBeenLastCalledWith(false);
  expect(mocks.getStatus).toHaveBeenCalledTimes(1);
  expect(mocks.probe).not.toHaveBeenCalled();
  unmount();
});

it('does not let an in-flight stale status overwrite a newer Stop epoch', async () => {
  let resolveStatus;
  mocks.getStatus.mockImplementationOnce(() => new Promise((resolve) => {
    resolveStatus = resolve;
  }));
  const setters = setterHarness();
  const { unmount } = renderHook(() => useAvailabilityCheck({
    narrationMethod: 'edge-tts',
    ...setters,
    t: (_key, fallback) => fallback,
  }));

  await waitFor(() => expect(mocks.subscribeSpeechLifecycle).toHaveBeenCalledTimes(1));
  act(() => {
    mocks.lifecycleSubscriber(backend('edgeTts', {
      epoch: 12,
      installed: true,
      enabled: false,
      ready: false,
      warm: false,
    }));
  });
  await act(async () => {
    resolveStatus(status({
      edgeTts: { epoch: 11, installed: true, ready: true, warm: true },
    }));
    await Promise.resolve();
  });

  expect(setters.setIsEdgeTTSAvailable).toHaveBeenLastCalledWith(false);
  expect(mocks.probe).not.toHaveBeenCalled();
  unmount();
});

it('marks every method unavailable on an unsupported non-desktop platform', async () => {
  mocks.isDesktopRuntime.mockReturnValue(false);
  const setters = setterHarness();
  const { unmount } = renderHook(() => useAvailabilityCheck({
    narrationMethod: 'edge-tts',
    ...setters,
    t: (_key, fallback) => fallback,
  }));

  await waitFor(() => expect(setters.setIsCheckingAvailability).toHaveBeenLastCalledWith(false));
  expect(setters.setIsAvailable).toHaveBeenLastCalledWith(false);
  expect(setters.setIsGeminiAvailable).toHaveBeenLastCalledWith(false);
  expect(setters.setIsChatterboxAvailable).toHaveBeenLastCalledWith(false);
  expect(setters.setIsEdgeTTSAvailable).toHaveBeenLastCalledWith(false);
  expect(setters.setIsGTTSAvailable).toHaveBeenLastCalledWith(false);
  expect(mocks.getStatus).not.toHaveBeenCalled();
  expect(mocks.probe).not.toHaveBeenCalled();
  unmount();
});

it('observes an installed-and-started package on the next non-invasive poll', async () => {
  vi.useFakeTimers();
  try {
    mocks.getStatus
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({
        edgeTts: { installed: true, ready: true, warm: true },
      }));
    const setters = setterHarness();
    const { unmount } = renderHook(() => useAvailabilityCheck({
      narrationMethod: 'edge-tts',
      ...setters,
      t: (_key, fallback) => fallback,
    }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setters.setIsEdgeTTSAvailable).toHaveBeenLastCalledWith(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(setters.setIsEdgeTTSAvailable).toHaveBeenLastCalledWith(true);
    expect(mocks.probe).not.toHaveBeenCalled();
    unmount();
  } finally {
    vi.useRealTimers();
  }
});
