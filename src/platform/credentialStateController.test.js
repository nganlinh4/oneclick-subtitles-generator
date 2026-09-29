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
    upsertCredential: vi.fn(),
    replaceCredential: vi.fn(async (id, { purpose, secret }) => {
      const index = credentials.findIndex((credential) => credential.id === id);
      if (index < 0) throw new Error('safe test failure');
      credentials[index] = {
        ...credentials[index],
        purpose,
        last4: Array.from(secret).slice(-4).join(''),
        state: 'ready',
      };
      return credentials[index];
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

it.each(['status-read', 'selection-write'])(
  'keeps a confirmed Gemini key available despite a failed %s without any unrelated Save',
  async (failurePoint) => {
    const { controller, credentialApi, invokeCommand } = createHarness();
    await controller.initialize();
    expect(await controller.acquireGeminiCredential()).toBeNull();

    if (failurePoint === 'status-read') {
      credentialApi.getCredentialStatus.mockRejectedValueOnce(new Error('injected status read failure'));
    } else {
      invokeCommand.mockRejectedValueOnce(new Error('injected selection write failure'));
    }
    const readCount = credentialApi.getCredentialStatus.mock.calls.length;
    const id = await controller.addGeminiCredential('diagnostic-not-a-real-key');
    expect(credentialApi.getCredentialStatus).toHaveBeenCalledTimes(readCount);
    expect(controller.getSnapshot().selectionPersistenceFailed).toBe(failurePoint === 'selection-write');
    expect(getCredentialAvailability(controller.getSnapshot()).gemini).toBe(true);
    expect(await controller.acquireGeminiCredential()).toBe(id);
    expect(getCredentialAvailability(await controller.initialize()).gemini).toBe(true);
    expect(controller.getSnapshot().selectionPersistenceFailed).toBe(false);
    expect(credentialApi.upsertCredential).not.toHaveBeenCalled();
  },
);

it('reconciles an ambiguous native write once without replaying the secret-bearing mutation', async () => {
  const { controller, credentialApi } = createHarness();
  await controller.initialize();
  const nativeWrite = credentialApi.setCredential.getMockImplementation();
  credentialApi.setCredential.mockImplementationOnce(async (request) => {
    await nativeWrite(request);
    throw new Error('transport response lost with secret text');
  });
  await expect(controller.addGeminiCredential('diagnostic-value')).rejects.toMatchObject({
    code: 'credentialMutationFailed', message: 'The credential change could not be confirmed',
  });
  expect(credentialApi.setCredential).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().credentials).toHaveLength(1);
  expect(await controller.acquireGeminiCredential()).toBe(controller.getSnapshot().credentials[0].id);
});

it('fails closed after an ambiguous removal and recovers on reopening without Genius', async () => {
  const first = status('geminiApiKey');
  const { controller, credentialApi } = createHarness({ initialCredentials: [first] });
  await controller.initialize();
  const nativeDelete = credentialApi.deleteCredential.getMockImplementation();
  credentialApi.deleteCredential.mockImplementationOnce(async (id) => {
    await nativeDelete(id);
    throw new Error('response lost');
  });
  credentialApi.getCredentialStatus.mockRejectedValueOnce(new Error('read unavailable'));
  await expect(controller.removeGeminiCredential(first.id)).rejects.toMatchObject({ code: 'credentialMutationFailed' });
  expect(getCredentialAvailability(controller.getSnapshot()).gemini).toBe(false);
  expect(controller.getSnapshot().store).toBe('unavailable');
  await controller.initialize();
  expect(controller.getSnapshot().credentials).toEqual([]);
  expect(await controller.acquireGeminiCredential()).toBeNull();
});

it('keeps deletion, replacement and rotation authoritative while preference storage is down', async () => {
  const first = status('geminiApiKey');
  const second = status('geminiApiKey');
  const { controller, invokeCommand } = createHarness({ initialCredentials: [first, second] });
  await controller.initialize();
  invokeCommand.mockRejectedValue(new Error('preferences unavailable'));
  await controller.selectGeminiCredential(second.id);
  expect(controller.getSnapshot().gemini.activeCredentialId).toBe(second.id);
  await controller.rotateGeminiCredential({ cooldownCredentialId: second.id });
  expect(await controller.acquireGeminiCredential()).toBe(first.id);
  await controller.replaceGeminiCredential(second.id, 'replacement-5678');
  expect(controller.getSnapshot().credentials.map(({ id }) => id)).toEqual([first.id, second.id]);
  expect(controller.getSnapshot().credentials[1].last4).toBe('5678');
  expect(controller.getSnapshot().gemini.cooldowns).toEqual([]);
  await controller.removeGeminiCredential(first.id);
  expect(await controller.acquireGeminiCredential()).toBe(second.id);
  await controller.removeGeminiCredential(second.id);
  expect(await controller.acquireGeminiCredential()).toBeNull();
  expect(controller.getSnapshot().credentials).toEqual([]);
});

it('publishes singleton upserts from confirmed metadata without a second status-read dependency', async () => {
  const { controller, credentialApi } = createHarness();
  await controller.initialize();
  const readCount = credentialApi.getCredentialStatus.mock.calls.length;
  credentialApi.getCredentialStatus.mockRejectedValue(new Error('read unavailable'));
  credentialApi.upsertCredential.mockImplementation(async ({ purpose }) => status(purpose));
  await controller.upsertSingletonCredential('geniusAccessToken', 'one');
  await controller.upsertSingletonCredential('geniusAccessToken', 'two');
  expect(controller.getSnapshot().credentials).toHaveLength(1);
  expect(getCredentialAvailability(controller.getSnapshot()).genius).toBe(true);
  expect(credentialApi.getCredentialStatus).toHaveBeenCalledTimes(readCount);
});

it('never publishes an unsaved key and allows retry after a real write failure', async () => {
  const { controller, credentialApi } = createHarness();
  await controller.initialize();
  credentialApi.setCredential.mockRejectedValueOnce(new Error('vault rejected secret-value'));
  await expect(controller.addGeminiCredential('secret-value')).rejects.toMatchObject({ code: 'credentialMutationFailed' });
  expect(controller.getSnapshot().credentials).toEqual([]);
  expect(await controller.acquireGeminiCredential()).toBeNull();
  const id = await controller.addGeminiCredential('secret-value');
  expect(await controller.acquireGeminiCredential()).toBe(id);
});

it('rechecks a previously locked store when initialization is requested again', async () => {
  const { controller, credentialApi } = createHarness();
  credentialApi.getCredentialStatus.mockResolvedValueOnce({ store: 'locked', credentials: [] });
  credentialApi.getCredentialStatus.mockResolvedValueOnce({ store: 'locked', credentials: [] });
  await controller.initialize();
  expect(controller.getSnapshot().store).toBe('locked');
  await controller.initialize();
  expect(controller.getSnapshot().store).toBe('available');
});

it('admits a queued request after adding the first key without a settings Save', async () => {
  const { controller } = createHarness();
  await controller.initialize();
  expect(await controller.acquireGeminiCredential()).toBeNull();
  const addition = controller.addGeminiCredential('diagnostic-not-a-real-key');
  const admission = controller.acquireGeminiCredential();
  expect(await admission).toBe(await addition);
});

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

it('atomically round-robins concurrent Gemini admissions without changing the selected key', async () => {
  const first = status('geminiApiKey', { last4: '1111' });
  const second = status('geminiApiKey', { last4: '2222' });
  const third = status('geminiApiKey', { last4: '3333' });
  const { controller, getSelection } = createHarness({
    initialCredentials: [first, second, third],
    storedSelection: { activeId: second.id, cooldowns: [] },
  });
  await controller.initialize();

  await expect(Promise.all([
    controller.acquireGeminiCredential(),
    controller.acquireGeminiCredential(),
    controller.acquireGeminiCredential(),
    controller.acquireGeminiCredential(),
  ])).resolves.toEqual([first.id, second.id, third.id, first.id]);

  expect(controller.getSnapshot().gemini.activeCredentialId).toBe(second.id);
  expect(getSelection().activeId).toBe(second.id);
});

it('never admits a cooling credential and resumes it after the bounded cooldown', async () => {
  const first = status('geminiApiKey', { last4: '1111' });
  const second = status('geminiApiKey', { last4: '2222' });
  let currentTime = 1_000_000;
  const credentials = [first, second];
  let storedSelection = { activeId: first.id, cooldowns: [] };
  const credentialApi = {
    getCredentialStatus: vi.fn(async () => ({ store: 'available', credentials })),
    setCredential: vi.fn(),
    upsertCredential: vi.fn(),
    replaceCredential: vi.fn(),
    deleteCredential: vi.fn(),
  };
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'setting_get') return storedSelection;
    if (command === 'setting_set') { storedSelection = args.value; return undefined; }
    if (command === 'setting_delete') return true;
    throw new Error(`Unexpected command ${command}`);
  });
  const controller = createCredentialStateController({
    credentialApi,
    invokeCommand,
    storage: createStorage(),
    now: () => currentTime,
  });
  await controller.initialize();
  await controller.rotateGeminiCredential({ cooldownCredentialId: first.id, cooldownMs: 100 });

  await expect(controller.acquireGeminiCredential()).resolves.toBe(second.id);
  await expect(controller.acquireGeminiCredential()).resolves.toBe(second.id);
  currentTime += 101;
  await expect(controller.acquireGeminiCredential()).resolves.toBe(first.id);
});

it('removes a singleton credential by purpose without exposing its secret', async () => {
  const genius = status('geniusAccessToken');
  const youtube = status('youtubeApiKey');
  const { controller, credentialApi } = createHarness({
    initialCredentials: [genius, youtube],
  });
  await controller.initialize();

  await expect(controller.removeSingletonCredential('geniusAccessToken')).resolves.toBe(true);

  expect(credentialApi.deleteCredential).toHaveBeenCalledWith(genius.id);
  expect(controller.getSnapshot().credentials).toEqual([youtube]);
  await expect(controller.removeSingletonCredential('geminiApiKey'))
    .rejects.toBeInstanceOf(CredentialStateError);
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
