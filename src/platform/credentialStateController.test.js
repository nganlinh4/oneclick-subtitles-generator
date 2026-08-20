import { v7 as uuidv7 } from 'uuid';
import {
  GEMINI_CREDENTIAL_COOLDOWN_MS,
  GEMINI_SELECTION_SETTING_KEY,
  CredentialStateError,
  createCredentialStateController,
  formatCredentialReference,
  getCredentialAvailability,
} from './credentialStateController';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const status = (purpose, overrides = {}) => ({
  id: uuidv7(),
  purpose,
  provider: purpose === 'geminiApiKey'
    ? 'gemini'
    : purpose === 'geniusAccessToken' ? 'genius' : 'youtube',
  state: 'ready',
  last4: '1234',
  ...overrides,
});

const createStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    removeItem: vi.fn((key) => values.delete(key)),
    value: (key) => values.get(key) ?? null,
  };
};

const createHarness = ({
  initialCredentials = [],
  storedSelection = null,
  storage = createStorage(),
  currentTime = 1_000_000,
  setFailure = null,
} = {}) => {
  const credentials = [...initialCredentials];
  const credentialApi = {
    getCredentialStatus: vi.fn(async () => ({
      store: 'available',
      credentials: [...credentials],
    })),
    setCredential: vi.fn(async ({ purpose, secret }) => {
      if (setFailure?.(purpose, secret)) throw new Error('safe test failure');
      const created = status(purpose, { last4: Array.from(secret).slice(-4).join('') });
      credentials.push(created);
      return created;
    }),
    deleteCredential: vi.fn(async (id) => {
      const index = credentials.findIndex((credential) => credential.id === id);
      if (index < 0) return false;
      credentials.splice(index, 1);
      return true;
    }),
  };
  let selection = storedSelection;
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'setting_get') return selection;
    if (command === 'setting_set') {
      selection = args.value;
      return undefined;
    }
    if (command === 'setting_delete') {
      if (args.key === GEMINI_SELECTION_SETTING_KEY) selection = null;
      return true;
    }
    throw new Error(`Unexpected command ${command}`);
  });
  const controller = createCredentialStateController({
    credentialApi,
    invokeCommand,
    storage,
    now: () => currentTime,
  });
  return { controller, credentialApi, invokeCommand, storage, getSelection: () => selection };
};

it('migrates supported legacy secrets transiently and purges every legacy secret key', async () => {
  const storage = createStorage({
    gemini_api_key: 'gemini-primary-1111',
    gemini_api_keys: JSON.stringify(['gemini-primary-1111', 'gemini-second-2222']),
    gemini_blacklisted_keys: JSON.stringify({ 'gemini-primary-1111': 99 }),
    gemini_active_key_index: '1',
    genius_token: 'genius-3333',
    youtube_api_key: 'youtube-4444',
    youtube_client_id: 'client-id',
    youtube_client_secret: 'client-secret-5555',
    youtube_oauth_token: 'oauth-token-that-cannot-be-migrated',
  });
  const { controller, credentialApi, invokeCommand } = createHarness({ storage });

  const initialization = controller.initialize();
  expect(storage.value('gemini_api_key')).toBeNull();
  expect(storage.value('youtube_oauth_token')).toBeNull();
  const snapshot = await initialization;

  expect(credentialApi.setCredential.mock.calls.map(([request]) => request.purpose)).toEqual([
    'geminiApiKey',
    'geminiApiKey',
    'geniusAccessToken',
    'youtubeApiKey',
    'youtubeOauthClient',
  ]);
  expect(storage.removeItem).toHaveBeenCalledWith('gemini_api_key');
  expect(storage.removeItem).toHaveBeenCalledWith('gemini_api_keys');
  expect(storage.removeItem).toHaveBeenCalledWith('gemini_blacklisted_keys');
  expect(storage.removeItem).toHaveBeenCalledWith('youtube_oauth_token');
  expect(storage.removeItem).toHaveBeenCalledWith('gemini_active_key_index');
  expect(JSON.stringify(snapshot)).not.toContain('gemini-primary');
  expect(JSON.stringify(snapshot)).not.toContain('client-secret');
  expect(snapshot.credentials).toHaveLength(5);
  expect(invokeCommand).toHaveBeenCalledWith('setting_get', {
    key: GEMINI_SELECTION_SETTING_KEY,
  });
  expect(invokeCommand).toHaveBeenCalledWith('setting_delete', {
    key: 'gemini_api_key',
  });
  expect(invokeCommand).toHaveBeenCalledWith('setting_delete', {
    key: 'youtube_oauth_token',
  });
  expect(controller.getActiveGeminiCredentialId()).toBe(snapshot.gemini.activeCredentialId);
});

it('purges but never duplicates a purpose already present in the native vault', async () => {
  const existing = status('geminiApiKey');
  const storage = createStorage({
    gemini_api_key: 'legacy-secret-9999',
    gemini_api_keys: JSON.stringify(['legacy-secret-8888']),
  });
  const { controller, credentialApi } = createHarness({
    initialCredentials: [existing],
    storage,
  });

  await controller.initialize();

  expect(credentialApi.setCredential).not.toHaveBeenCalled();
  expect(storage.value('gemini_api_key')).toBeNull();
  expect(controller.getSnapshot().credentials).toEqual([existing]);
});

it('fails closed and reports only a boolean when legacy vault migration fails', async () => {
  const secret = 'never-surface-this-secret';
  const storage = createStorage({ gemini_api_key: secret });
  const { controller } = createHarness({
    storage,
    setFailure: () => true,
  });

  const snapshot = await controller.initialize();

  expect(storage.value('gemini_api_key')).toBeNull();
  expect(snapshot.legacyMigrationFailed).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain(secret);
});

it('restores an available opaque ID and bypasses a still-cooling selection', async () => {
  const first = status('geminiApiKey', { last4: '1111' });
  const second = status('geminiApiKey', { last4: '2222' });
  const { controller, getSelection } = createHarness({
    initialCredentials: [first, second],
    storedSelection: {
      activeId: second.id,
      cooldowns: [
        { id: first.id, untilMs: 999_999 },
        { id: second.id, untilMs: 1_060_000 },
      ],
    },
  });

  const snapshot = await controller.initialize();

  expect(snapshot.gemini.activeCredentialId).toBe(first.id);
  expect(snapshot.gemini.cooldowns).toEqual([{ id: second.id, untilMs: 1_060_000 }]);
  expect(controller.getActiveGeminiCredentialId()).toBe(first.id);
  expect(getSelection().activeId).toBe(first.id);
});

it('adds, selects, and removes Gemini credentials by opaque ID', async () => {
  const first = status('geminiApiKey', { last4: '1111' });
  const { controller, credentialApi, getSelection } = createHarness({
    initialCredentials: [first],
  });
  await controller.initialize();

  const secondId = await controller.addGeminiCredential('new-secret-2222');
  await controller.selectGeminiCredential(secondId);
  expect(controller.getSnapshot().gemini.activeCredentialId).toBe(secondId);
  expect(getSelection().activeId).toBe(secondId);

  await controller.removeGeminiCredential(secondId);
  expect(credentialApi.deleteCredential).toHaveBeenCalledWith(secondId);
  expect(controller.getSnapshot().gemini.activeCredentialId).toBe(first.id);
});

it('rotates around a cooling credential without exposing provider keys', async () => {
  const first = status('geminiApiKey', { last4: '1111' });
  const second = status('geminiApiKey', { last4: '2222' });
  const third = status('geminiApiKey', { last4: '3333' });
  const { controller, getSelection } = createHarness({
    initialCredentials: [first, second, third],
    storedSelection: { activeId: first.id, cooldowns: [] },
  });
  await controller.initialize();

  await expect(controller.rotateGeminiCredential({ cooldownCredentialId: first.id }))
    .resolves.toBe(second.id);

  const snapshot = controller.getSnapshot();
  expect(snapshot.gemini.activeCredentialId).toBe(second.id);
  expect(snapshot.gemini.cooldowns).toEqual([{
    id: first.id,
    untilMs: 1_000_000 + GEMINI_CREDENTIAL_COOLDOWN_MS,
  }]);
  expect(getSelection()).toEqual({
    activeId: second.id,
    cooldowns: [{ id: first.id, untilMs: 1_000_000 + GEMINI_CREDENTIAL_COOLDOWN_MS }],
  });
});

it('does not allow a singleton purpose to be overwritten without an atomic backend command', async () => {
  const existing = status('geniusAccessToken');
  const { controller, credentialApi } = createHarness({ initialCredentials: [existing] });
  await controller.initialize();

  await expect(controller.addSingletonCredential('geniusAccessToken', 'replacement-secret'))
    .rejects.toBeInstanceOf(CredentialStateError);
  expect(credentialApi.setCredential).not.toHaveBeenCalled();
});

it('formats a unique display reference using only safe metadata', () => {
  const credential = status('geminiApiKey', { last4: '9XYZ' });
  const reference = formatCredentialReference(credential);

  expect(reference).toContain(credential.id);
  expect(reference).toContain('9XYZ');
  expect(reference).not.toContain('secret');
});

it('counts only ready credentials and does not equate an OAuth client with login tokens', () => {
  const snapshot = {
    store: 'available',
    credentials: [
      status('geminiApiKey'),
      status('youtubeApiKey', { state: 'pending' }),
      status('youtubeOauthClient'),
      status('geniusAccessToken', { state: 'unavailable' }),
    ],
  };

  expect(getCredentialAvailability(snapshot)).toEqual({
    gemini: true,
    youtube: false,
    genius: false,
  });
  expect(getCredentialAvailability(snapshot, { useOAuth: true }).youtube).toBe(false);
});

it('removes every vault credential and its persisted selection during factory reset', async () => {
  const credentials = [status('geminiApiKey'), status('geniusAccessToken')];
  const { controller, credentialApi, invokeCommand } = createHarness({
    initialCredentials: credentials,
    storedSelection: { activeId: credentials[0].id, cooldowns: [] },
  });
  await controller.initialize();

  await expect(controller.clearCredentials()).resolves.toBe(true);

  expect(credentialApi.deleteCredential.mock.calls.map(([id]) => id)).toEqual(
    credentials.map(({ id }) => id)
  );
  expect(invokeCommand).toHaveBeenCalledWith('setting_delete', {
    key: GEMINI_SELECTION_SETTING_KEY,
  });
  expect(controller.getSnapshot().credentials).toEqual([]);
});
