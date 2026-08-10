import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { v7 as uuidv7 } from 'uuid';
import { useGeminiKeys } from './GeminiKeysManager';
import {
  addGeminiCredential,
  formatCredentialReference,
  getCredentialAvailability,
  initializeCredentialState,
  removeGeminiCredential,
  selectGeminiCredential,
  subscribeCredentialState,
} from '../../../platform/credentialStateController';
import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import {
  addKey,
  getActiveKeyIndex,
  getAllKeys,
  removeKey,
  setActiveKeyIndex,
} from '../../../services/gemini/keyManager';

global.IS_REACT_ACT_ENVIRONMENT = true;

const renderHook = (useHook) => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const result = { current: undefined };

  const HookHost = () => {
    result.current = useHook();
    return null;
  };

  document.body.appendChild(container);
  act(() => root.render(<HookHost />));

  return {
    result,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
vi.mock('../../../platform/desktopRuntime', () => ({
  isDesktopRuntime: vi.fn(),
}));
vi.mock('../../../platform/credentialStateController', () => ({
  addGeminiCredential: vi.fn(),
  formatCredentialReference: vi.fn((credential) => (
    `gemini:${credential.id}:${credential.state}:••••${credential.last4 ?? '----'}`
  )),
  getCredentialAvailability: vi.fn((snapshot) => ({
    gemini: snapshot.store === 'available'
      && snapshot.credentials.some(({ purpose, state }) => (
        purpose === 'geminiApiKey' && state === 'ready'
      )),
    youtube: false,
    genius: false,
  })),
  initializeCredentialState: vi.fn(),
  removeGeminiCredential: vi.fn(),
  selectGeminiCredential: vi.fn(),
  subscribeCredentialState: vi.fn(),
}));
vi.mock('../../../services/gemini/keyManager', () => ({
  addKey: vi.fn(),
  getActiveKeyIndex: vi.fn(),
  getAllKeys: vi.fn(),
  removeKey: vi.fn(),
  setActiveKeyIndex: vi.fn(),
}));

const nativeSnapshot = (credentials, activeIndex = 0) => ({
  initialized: true,
  store: 'available',
  credentials,
  gemini: {
    activeCredentialId: credentials[activeIndex]?.id ?? null,
    activeIndex: credentials.length === 0 ? -1 : activeIndex,
    availableCredentialIds: credentials.map(({ id }) => id),
    cooldowns: [],
  },
  legacyMigrationFailed: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  formatCredentialReference.mockImplementation((credential) => (
    `gemini:${credential.id}:${credential.state}:••••${credential.last4 ?? '----'}`
  ));
  getCredentialAvailability.mockImplementation((snapshot) => ({
    gemini: snapshot.store === 'available'
      && snapshot.credentials.some(({ purpose, state }) => (
        purpose === 'geminiApiKey' && state === 'ready'
      )),
    youtube: false,
    genius: false,
  }));
  initializeCredentialState.mockResolvedValue(undefined);
  addGeminiCredential.mockResolvedValue(uuidv7());
  removeGeminiCredential.mockResolvedValue(true);
  selectGeminiCredential.mockResolvedValue(undefined);
  subscribeCredentialState.mockImplementation(() => () => undefined);
});

it('keeps only unique safe references in native React state and selects by UUID', async () => {
  isDesktopRuntime.mockReturnValue(true);
  let subscriber;
  subscribeCredentialState.mockImplementation((next) => {
    subscriber = next;
    return () => undefined;
  });
  const first = {
    id: '01901234-5678-7abc-8def-0123456789ab',
    purpose: 'geminiApiKey', provider: 'gemini', state: 'ready', last4: '1234',
  };
  const second = {
    id: '01901234-5678-7abc-8def-0123456789ac',
    purpose: 'geminiApiKey', provider: 'gemini', state: 'ready', last4: '1234',
  };
  const setGeminiApiKey = vi.fn();
  const setApiKeysSet = vi.fn();
  const { result } = renderHook(() => useGeminiKeys({ setGeminiApiKey, setApiKeysSet }));

  act(() => subscriber(nativeSnapshot([first, second], 1)));

  expect(result.current.geminiApiKeys).toHaveLength(2);
  expect(result.current.geminiApiKeys).toEqual([
    `gemini:${first.id}:ready:••••1234`,
    `gemini:${second.id}:ready:••••1234`,
  ]);
  expect(JSON.stringify(result.current.geminiApiKeys)).not.toContain('full-secret');
  expect(result.current.activeKeyIndex).toBe(1);
  expect(setGeminiApiKey).not.toHaveBeenCalled();

  await act(async () => result.current.handleSetActiveKey(0));
  expect(selectGeminiCredential).toHaveBeenCalledWith(first.id);
  await act(async () => result.current.handleRemoveGeminiKey(
    result.current.geminiApiKeys[1]
  ));
  expect(removeGeminiCredential).toHaveBeenCalledWith(second.id);
});

it('uses a write-only native add buffer and clears it after success or failure', async () => {
  isDesktopRuntime.mockReturnValue(true);
  const { result } = renderHook(() => useGeminiKeys({
    setGeminiApiKey: vi.fn(),
    setApiKeysSet: vi.fn(),
  }));

  act(() => result.current.setNewGeminiKey('transient-native-secret'));
  await act(async () => result.current.handleAddGeminiKey());
  expect(addGeminiCredential).toHaveBeenCalledWith('transient-native-secret');
  expect(result.current.newGeminiKey).toBe('');

  addGeminiCredential.mockRejectedValueOnce(new Error('sanitized failure'));
  act(() => result.current.setNewGeminiKey('second-transient-secret'));
  await act(async () => result.current.handleAddGeminiKey());
  expect(result.current.newGeminiKey).toBe('');
});

it('does not report a ready key when the native credential store is unavailable', () => {
  isDesktopRuntime.mockReturnValue(true);
  let subscriber;
  subscribeCredentialState.mockImplementation((next) => {
    subscriber = next;
    return () => undefined;
  });
  const setApiKeysSet = vi.fn();
  renderHook(() => useGeminiKeys({
    setGeminiApiKey: vi.fn(),
    setApiKeysSet,
  }));
  const ready = {
    id: '01901234-5678-7abc-8def-0123456789ad',
    purpose: 'geminiApiKey', provider: 'gemini', state: 'ready', last4: '1234',
  };

  act(() => subscriber({ ...nativeSnapshot([ready]), store: 'unavailable' }));

  const stateUpdater = setApiKeysSet.mock.calls.at(-1)[0];
  expect(stateUpdater({ gemini: true, youtube: false, genius: false }).gemini).toBe(false);
});

it('serializes a native add double-click into one vault submission', async () => {
  isDesktopRuntime.mockReturnValue(true);
  let finishSubmission;
  addGeminiCredential.mockImplementationOnce(() => new Promise((resolve) => {
    finishSubmission = resolve;
  }));
  const { result } = renderHook(() => useGeminiKeys({
    setGeminiApiKey: vi.fn(),
    setApiKeysSet: vi.fn(),
  }));
  act(() => result.current.setNewGeminiKey('one-transient-secret'));

  await act(async () => {
    const first = result.current.handleAddGeminiKey();
    const duplicate = result.current.handleAddGeminiKey();
    await expect(duplicate).resolves.toBe(false);
    finishSubmission(uuidv7());
    await first;
  });

  expect(addGeminiCredential).toHaveBeenCalledTimes(1);
  expect(result.current.newGeminiKey).toBe('');
});

it('preserves the synchronous raw-string manager in a browser', async () => {
  isDesktopRuntime.mockReturnValue(false);
  getAllKeys.mockReturnValue(['browser-key-one']);
  getActiveKeyIndex.mockReturnValue(0);
  addKey.mockReturnValue(true);
  removeKey.mockReturnValue(true);
  const setGeminiApiKey = vi.fn();
  const setApiKeysSet = vi.fn();
  const { result } = renderHook(() => useGeminiKeys({ setGeminiApiKey, setApiKeysSet }));
  expect(result.current.geminiApiKeys).toEqual(['browser-key-one']);

  await act(async () => result.current.handleSetActiveKey(0));
  expect(setActiveKeyIndex).toHaveBeenCalledWith(0);
  expect(setGeminiApiKey).toHaveBeenCalledWith('browser-key-one');

  getAllKeys.mockReturnValue(['browser-key-one', 'browser-key-two']);
  act(() => result.current.setNewGeminiKey('browser-key-two'));
  await act(async () => result.current.handleAddGeminiKey());
  expect(addKey).toHaveBeenCalledWith('browser-key-two');
  expect(result.current.geminiApiKeys).toEqual(['browser-key-one', 'browser-key-two']);
});
