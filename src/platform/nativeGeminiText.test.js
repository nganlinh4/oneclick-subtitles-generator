import { createNativeGeminiText } from './nativeGeminiText';

vi.mock('./credentialStateController', () => ({
  getActiveGeminiCredentialId: vi.fn(),
  getCredentialStateSnapshot: vi.fn(),
  initializeCredentialState: vi.fn(),
  refreshCredentialState: vi.fn(),
  rotateGeminiCredential: vi.fn(),
}));
vi.mock('./geminiService', () => ({
  cancelGeminiJob: vi.fn(),
  startGeminiJob: vi.fn(),
}));

const CREDENTIAL_A = '018f22ea-6f3e-7cc0-a555-111111111111';
const CREDENTIAL_B = '018f22ea-6f3e-7cc0-a555-222222222222';
const JOB_A = '018f22ea-6f3e-7cc0-a555-333333333333';
const DELIVERY_A = '018f22ea-6f3e-7cc0-a555-444444444444';
const PROJECT_A = '018f22ea-6f3e-7cc0-a555-555555555555';

const completedEvent = (text = '{"ok":true}') => ({
  event: 'completed',
  deliveryId: DELIVERY_A,
  job: {
    id: JOB_A,
    kind: 'translate',
    state: 'succeeded',
    progress: { basisPoints: 10_000 },
    sequence: 2,
  },
  text,
  usage: null,
});

const createHarness = ({ startImplementation, credentialIds = [CREDENTIAL_A] } = {}) => {
  let activeIndex = 0;
  const prepareCredentials = vi.fn().mockResolvedValue(undefined);
  const getCredentialId = vi.fn(() => credentialIds[activeIndex] ?? null);
  const getCredentialSnapshot = vi.fn(() => ({
    gemini: { availableCredentialIds: credentialIds },
  }));
  const rotateCredential = vi.fn(async () => {
    activeIndex += 1;
    return credentialIds[activeIndex] ?? null;
  });
  const cancel = vi.fn().mockResolvedValue(true);
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  const ensureRecovery = vi.fn().mockResolvedValue({ unavailable: false });
  const start = vi.fn(startImplementation ?? (async (_request, handlers) => {
    queueMicrotask(() => handlers.onCompleted(completedEvent()));
    return {
      id: JOB_A,
      kind: 'translate',
      state: 'running',
      progress: { basisPoints: 0 },
      sequence: 1,
    };
  }));

  return {
    service: createNativeGeminiText({
      prepareCredentials,
      getCredentialId,
      getCredentialSnapshot,
      rotateCredential,
      start,
      cancel,
      acknowledge,
      ensureRecovery,
    }),
    prepareCredentials,
    getCredentialId,
    rotateCredential,
    start,
    cancel,
    acknowledge,
    ensureRecovery,
  };
};

const request = {
  task: 'translate',
  model: 'gemini-3.5-flash-lite',
  prompt: 'Translate this',
  responseJsonSchema: { type: 'object' },
};

test('uses only an opaque credential id and returns the native terminal result', async () => {
  const harness = createHarness();

  const result = await harness.service.run(request);
  expect(result).toMatchObject({
    text: '{"ok":true}',
    usage: null,
    deliveryId: DELIVERY_A,
  });
  expect(harness.acknowledge).not.toHaveBeenCalled();
  await result.acknowledge();
  await result.acknowledge();
  expect(harness.acknowledge).toHaveBeenCalledExactlyOnceWith(JOB_A, DELIVERY_A);
  expect(harness.prepareCredentials).toHaveBeenCalledTimes(1);
  expect(harness.start).toHaveBeenCalledWith({
    ...request,
    credentialId: CREDENTIAL_A,
    systemInstruction: undefined,
    maxOutputTokens: undefined,
    thinkingLevel: undefined,
    mediaAssetId: null,
  }, expect.any(Object));
});

test('forwards exact project ownership to the native admission boundary as one pair', async () => {
  const harness = createHarness();

  await harness.service.run({
    ...request,
    projectId: PROJECT_A,
    expectedProjectStateVersion: 9,
  });

  expect(harness.start).toHaveBeenCalledWith({
    ...request,
    credentialId: CREDENTIAL_A,
    systemInstruction: undefined,
    maxOutputTokens: undefined,
    thinkingLevel: undefined,
    mediaAssetId: null,
    projectId: PROJECT_A,
    expectedProjectStateVersion: 9,
  }, expect.any(Object));
});

test('does not prepare credentials or start Gemini while durable recovery is unavailable', async () => {
  const harness = createHarness();
  harness.ensureRecovery.mockRejectedValue(Object.assign(new Error('recovery unavailable'), {
    code: 'nativeJobRecoveryUnavailable',
    retryable: true,
  }));

  await expect(harness.service.run(request)).rejects.toMatchObject({
    code: 'nativeJobRecoveryUnavailable',
    retryable: true,
  });
  expect(harness.prepareCredentials).not.toHaveBeenCalled();
  expect(harness.start).not.toHaveBeenCalled();
});

test('retains a result after acknowledgement transport failure and permits an exact retry', async () => {
  const harness = createHarness();
  harness.acknowledge
    .mockRejectedValueOnce(new Error('WebView transport closed'))
    .mockResolvedValueOnce(undefined);
  const result = await harness.service.run(request);

  await expect(result.acknowledge()).rejects.toThrow('WebView transport closed');
  await expect(result.acknowledge()).resolves.toBeUndefined();
  expect(harness.acknowledge).toHaveBeenCalledTimes(2);
  expect(harness.acknowledge).toHaveBeenNthCalledWith(1, JOB_A, DELIVERY_A);
  expect(harness.acknowledge).toHaveBeenNthCalledWith(2, JOB_A, DELIVERY_A);
});

test('rotates once after a rate limit and never repeats a credential', async () => {
  let calls = 0;
  const harness = createHarness({
    credentialIds: [CREDENTIAL_A, CREDENTIAL_B],
    startImplementation: async (_request, handlers) => {
      calls += 1;
      queueMicrotask(() => {
        if (calls === 1) {
          handlers.onFailed({ error: { code: 'geminiRateLimited' } });
        } else {
          handlers.onCompleted(completedEvent('done'));
        }
      });
      return {
        id: JOB_A,
        kind: 'translate',
        state: 'running',
        progress: { basisPoints: 0 },
        sequence: 1,
      };
    },
  });

  await expect(harness.service.run(request)).resolves.toMatchObject({ text: 'done' });
  expect(harness.start).toHaveBeenCalledTimes(2);
  expect(harness.rotateCredential).toHaveBeenCalledWith({
    cooldownCredentialId: CREDENTIAL_A,
  });
});

test('does not retry non-credential failures', async () => {
  const harness = createHarness({
    credentialIds: [CREDENTIAL_A, CREDENTIAL_B],
    startImplementation: async (_request, handlers) => {
      queueMicrotask(() => handlers.onFailed({ error: { code: 'geminiProvider' } }));
      return {
        id: JOB_A,
        kind: 'translate',
        state: 'running',
        progress: { basisPoints: 0 },
        sequence: 1,
      };
    },
  });

  await expect(harness.service.run(request)).rejects.toMatchObject({
    name: 'NativeGeminiError',
    code: 'geminiProvider',
  });
  expect(harness.start).toHaveBeenCalledTimes(1);
  expect(harness.rotateCredential).not.toHaveBeenCalled();
});

test('pre-aborted requests never initialize credentials or start a job', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  controller.abort();

  await expect(harness.service.run({ ...request, signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(harness.prepareCredentials).not.toHaveBeenCalled();
  expect(harness.start).not.toHaveBeenCalled();
});

test('aborting an active request cancels its durable job', async () => {
  const controller = new AbortController();
  const harness = createHarness({
    startImplementation: async () => ({
      id: JOB_A,
      kind: 'translate',
      state: 'running',
      progress: { basisPoints: 0 },
      sequence: 1,
    }),
  });

  const pending = harness.service.run({ ...request, signal: controller.signal });
  while (harness.start.mock.calls.length === 0) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
  controller.abort();

  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(harness.cancel).toHaveBeenCalledWith(JOB_A);
});

test('protocol corruption cancels the durable job and is never retried', async () => {
  const harness = createHarness({
    credentialIds: [CREDENTIAL_A, CREDENTIAL_B],
    startImplementation: async (_request, handlers) => {
      queueMicrotask(() => handlers.onProtocolError(new Error('private transport payload')));
      return {
        id: JOB_A,
        kind: 'translate',
        state: 'running',
        progress: { basisPoints: 0 },
        sequence: 1,
      };
    },
  });

  await expect(harness.service.run(request)).rejects.toMatchObject({
    code: 'invalidGeminiResponse',
  });
  expect(harness.cancel).toHaveBeenCalledWith(JOB_A);
  expect(harness.rotateCredential).not.toHaveBeenCalled();
});
