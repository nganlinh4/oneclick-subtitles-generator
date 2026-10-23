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
import { revealCredential } from '../../../platform/credentialService';

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
vi.mock('../../../platform/credentialService', () => ({
  revealCredential: vi.fn(),
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
  window.addToast = vi.fn();
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
  revealCredential.mockResolvedValue('revealed-native-secret');
  subscribeCredentialState.mockImplementation(() => () => undefined);
});

it('keeps only unique safe references in native React state and selects by UUID', async () => {
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
  const setApiKeysSet = vi.fn();
  const { result } = renderHook(() => useGeminiKeys({ setApiKeysSet }));

  act(() => subscriber(nativeSnapshot([first, second], 1)));

  expect(result.current.geminiApiKeys).toHaveLength(2);
  expect(result.current.geminiApiKeys).toEqual([
    `gemini:${first.id}:ready:••••1234`,
    `gemini:${second.id}:ready:••••1234`,
  ]);
  expect(JSON.stringify(result.current.geminiApiKeys)).not.toContain('full-secret');
  expect(result.current.activeKeyIndex).toBe(1);

  await act(async () => result.current.handleSetActiveKey(0));
  expect(selectGeminiCredential).toHaveBeenCalledWith(first.id);
  await act(async () => result.current.handleRemoveGeminiKey(
    result.current.geminiApiKeys[1]
  ));
  expect(removeGeminiCredential).toHaveBeenCalledWith(second.id);

});

it('uses a write-only native add buffer and clears it after success or failure', async () => {
  const { result } = renderHook(() => useGeminiKeys({
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
  expect(window.addToast).toHaveBeenLastCalledWith(
    'The key change could not be confirmed. Check the saved-key list before trying again.', 'error', 8000,
  );
  expect(JSON.stringify(window.addToast.mock.calls)).not.toContain('second-transient-secret');
});

it('shows one preference warning per failure and keeps saved keys usable', async () => {
  let subscriber;
  subscribeCredentialState.mockImplementation((next) => { subscriber = next; return () => undefined; });
  const credential = { id: uuidv7(), purpose: 'geminiApiKey', provider: 'gemini', state: 'ready', last4: '1234' };
  const { result, unmount } = renderHook(() => useGeminiKeys({ setApiKeysSet: vi.fn() }));
  const snapshot = { ...nativeSnapshot([credential]), selectionPersistenceFailed: true };
  act(() => { subscriber(snapshot); subscriber(snapshot); });
  expect(result.current.geminiApiKeys).toHaveLength(1);
  expect(window.addToast).toHaveBeenCalledTimes(1);
  expect(window.addToast).toHaveBeenCalledWith(
    'Only the preferred-key setting could not be saved. Reopen Settings to retry.', 'warning', 8000,
  );
  unmount();
});

it.each(['select', 'remove'])('reports %s failures through the global toast without exposing errors', async (operation) => {
  let subscriber;
  subscribeCredentialState.mockImplementation((next) => { subscriber = next; return () => undefined; });
  const credential = { id: uuidv7(), purpose: 'geminiApiKey', provider: 'gemini', state: 'ready', last4: '1234' };
  const { result, unmount } = renderHook(() => useGeminiKeys({ setApiKeysSet: vi.fn() }));
  act(() => subscriber(nativeSnapshot([credential])));
  (operation === 'select' ? selectGeminiCredential : removeGeminiCredential)
    .mockRejectedValueOnce(new Error('never echo secret-value'));
  await act(async () => {
    const success = operation === 'select'
      ? await result.current.handleSetActiveKey(0)
      : await result.current.handleRemoveGeminiKey(result.current.geminiApiKeys[0]);
    expect(success).toBe(false);
  });
  expect(window.addToast).toHaveBeenLastCalledWith(
    'The key change could not be confirmed. Check the saved-key list before trying again.', 'error', 8000,
  );
  expect(JSON.stringify(window.addToast.mock.calls)).not.toContain('secret-value');
  unmount();
});

it('reveals a native key only on demand and erases the revealed value when hidden', async () => {
  let subscriber;
  subscribeCredentialState.mockImplementation((next) => {
    subscriber = next;
    return () => undefined;
  });
  const credential = {
    id: '01901234-5678-7abc-8def-0123456789ab',
    purpose: 'geminiApiKey', provider: 'gemini', state: 'ready', last4: '1234',
  };
  const { result } = renderHook(() => useGeminiKeys({
    setApiKeysSet: vi.fn(),
  }));
  act(() => subscriber(nativeSnapshot([credential])));

  expect(revealCredential).not.toHaveBeenCalled();
  await act(async () => result.current.handleToggleKeyVisibility(0));
  expect(revealCredential).toHaveBeenCalledWith(credential.id);
  expect(result.current.revealedKeyValues[0]).toBe('revealed-native-secret');
  expect(result.current.visibleKeyIndices[0]).toBe(true);

  await act(async () => result.current.handleToggleKeyVisibility(0));
  expect(result.current.revealedKeyValues[0]).toBe('');
  expect(result.current.visibleKeyIndices[0]).toBe(false);
});

it('does not report a ready key when the native credential store is unavailable', () => {
  let subscriber;
  subscribeCredentialState.mockImplementation((next) => {
    subscriber = next;
    return () => undefined;
  });
  const setApiKeysSet = vi.fn();
  renderHook(() => useGeminiKeys({
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
  let finishSubmission;
  addGeminiCredential.mockImplementationOnce(() => new Promise((resolve) => {
    finishSubmission = resolve;
  }));
  const { result } = renderHook(() => useGeminiKeys({
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
