import { v7 as uuidv7 } from 'uuid';

import { createNativeGeminiTranscription } from './nativeGeminiTranscription';

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

const createHarness = () => {
  const credentialId = uuidv7();
  const assetId = uuidv7();
  const jobId = uuidv7();
  const deliveryId = uuidv7();
  let handlers;
  const prepareCredentials = vi.fn().mockResolvedValue(undefined);
  const getCredentialId = vi.fn().mockResolvedValue(credentialId);
  const getCredentialSnapshot = vi.fn(() => ({
    gemini: { availableCredentialIds: [credentialId] },
  }));
  const rotateCredential = vi.fn().mockResolvedValue(null);
  const start = vi.fn().mockImplementation(async (_request, nextHandlers) => {
    handlers = nextHandlers;
    return { id: jobId };
  });
  const cancel = vi.fn().mockResolvedValue({ id: jobId, state: 'cancelling' });
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  const ensureRecovery = vi.fn().mockResolvedValue({ unavailable: false });
  const runner = createNativeGeminiTranscription({
    prepareCredentials,
    getCredentialId,
    getCredentialSnapshot,
    rotateCredential,
    start,
    cancel,
    acknowledge,
    ensureRecovery,
  });
  const request = {
    assetId,
    model: 'gemini-3.5-flash-lite',
    prompt: 'Transcribe this video.',
    emptySpeechPolicy: 'provenSilence',
    responseJsonSchema: { type: 'array' },
    thinkingLevel: 'minimal',
    mediaResolution: 'medium',
    projectId: uuidv7(),
    expectedProjectStateVersion: 12,
  };
  return {
    assetId,
    acknowledge,
    cancel,
    credentialId,
    getCredentialId,
    ensureRecovery,
    getHandlers: () => handlers,
    jobId,
    deliveryId,
    request,
    runner,
    start,
  };
};

it('uses only opaque credential/media IDs and returns the typed completed result', async () => {
  const harness = createHarness();
  const onStarted = vi.fn();
  const onChunk = vi.fn();
  const operation = harness.runner.run({ ...harness.request, onStarted, onChunk });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());

  expect(harness.start).toHaveBeenCalledWith(expect.objectContaining({
    credentialId: harness.credentialId,
    mediaAssetId: harness.assetId,
    task: 'transcribe',
    emptySpeechPolicy: 'provenSilence',
    projectId: harness.request.projectId,
    expectedProjectStateVersion: 12,
  }), expect.any(Object));
  expect(onStarted).toHaveBeenCalledWith(harness.jobId);
  harness.getHandlers().onChunk({ text: '[{"text":"hel' });
  harness.getHandlers().onChunk({ text: 'lo"}]' });
  harness.getHandlers().onCompleted({
    job: { id: harness.jobId, state: 'succeeded' },
    deliveryId: harness.deliveryId,
    text: '[{"text":"hello"}]',
    usage: null,
  });

  const result = await operation;
  expect(result).toMatchObject({
    text: '[{"text":"hello"}]',
    usage: null,
  });
  expect(harness.acknowledge).not.toHaveBeenCalled();
  await result.acknowledge();
  expect(harness.acknowledge).toHaveBeenCalledWith(harness.jobId, harness.deliveryId);
  expect(onChunk.mock.calls).toEqual([["[{\"text\":\"hel"], ['lo"}]']]);
});

it('never rotates credentials after exposing part of an attempt', async () => {
  const firstCredential = uuidv7();
  const secondCredential = uuidv7();
  const handlers = [];
  const start = vi.fn(async (_request, nextHandlers) => {
    handlers.push(nextHandlers);
    return { id: uuidv7() };
  });
  const rotateCredential = vi.fn().mockResolvedValue(undefined);
  const runner = createNativeGeminiTranscription({
    prepareCredentials: vi.fn().mockResolvedValue(undefined),
    getCredentialId: vi.fn()
      .mockResolvedValueOnce(firstCredential)
      .mockResolvedValueOnce(secondCredential),
    getCredentialSnapshot: vi.fn(() => ({
      gemini: { availableCredentialIds: [firstCredential, secondCredential] },
    })),
    rotateCredential,
    start,
    cancel: vi.fn().mockResolvedValue(undefined),
    ensureRecovery: vi.fn().mockResolvedValue({ unavailable: false }),
  });
  const onChunk = vi.fn();
  const operation = runner.run({
    assetId: uuidv7(),
    model: 'gemini-3.5-flash-lite',
    prompt: 'Transcribe this video.',
    onChunk,
  });
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  handlers[0].onChunk({ text: '[{"text":"partial"}' });
  handlers[0].onFailed({ error: { code: 'geminiRateLimited' } });

  await expect(operation).rejects.toMatchObject({ code: 'geminiRateLimited' });
  expect(onChunk).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(rotateCredential).not.toHaveBeenCalled();
});

it('cancels a malformed Channel and exposes no transport diagnostics', async () => {
  const harness = createHarness();
  const operation = harness.runner.run(harness.request);
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
  harness.getHandlers().onProtocolError(new Error('private provider payload'));

  await expect(operation).rejects.toMatchObject({
    name: 'NativeGeminiError',
    code: 'invalidGeminiResponse',
    message: 'The native Gemini operation could not be completed',
  });
  expect(harness.cancel).toHaveBeenCalledWith(harness.jobId);
});

it('settles UI cancellation immediately while still cancelling the native job', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  const operation = harness.runner.run({ ...harness.request, signal: controller.signal });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledOnce());
  controller.abort();

  await expect(operation).rejects.toMatchObject({ name: 'AbortError', code: 'geminiCancelled' });
  expect(harness.cancel).toHaveBeenCalledWith(harness.jobId);
});

it('never starts native work for a pre-aborted request or missing credential', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  controller.abort();
  await expect(harness.runner.run({ ...harness.request, signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(harness.start).not.toHaveBeenCalled();

  harness.getCredentialId.mockResolvedValueOnce(null);
  await expect(harness.runner.run(harness.request))
    .rejects.toMatchObject({ code: 'geminiCredentialUnavailable' });
  expect(harness.start).not.toHaveBeenCalled();
});
