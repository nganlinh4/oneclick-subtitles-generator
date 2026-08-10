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

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const createHarness = () => {
  const credentialId = uuidv7();
  const assetId = uuidv7();
  const jobId = uuidv7();
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
  const runner = createNativeGeminiTranscription({
    prepareCredentials,
    getCredentialId,
    getCredentialSnapshot,
    rotateCredential,
    start,
    cancel,
  });
  const request = {
    assetId,
    model: 'gemini-3.5-flash-lite',
    prompt: 'Transcribe this video.',
    responseJsonSchema: { type: 'array' },
    thinkingLevel: 'minimal',
    mediaResolution: 'medium',
  };
  return {
    assetId,
    cancel,
    credentialId,
    getCredentialId,
    getHandlers: () => handlers,
    jobId,
    request,
    runner,
    start,
  };
};

it('uses only opaque credential/media IDs and returns the typed completed result', async () => {
  const harness = createHarness();
  const onStarted = vi.fn();
  const operation = harness.runner.run({ ...harness.request, onStarted });
  await flush();

  expect(harness.start).toHaveBeenCalledWith(expect.objectContaining({
    credentialId: harness.credentialId,
    mediaAssetId: harness.assetId,
    task: 'transcribe',
  }), expect.any(Object));
  expect(onStarted).toHaveBeenCalledWith(harness.jobId);
  harness.getHandlers().onCompleted({
    job: { id: harness.jobId, state: 'succeeded' },
    text: '[{"text":"hello"}]',
    usage: null,
  });

  await expect(operation).resolves.toMatchObject({
    text: '[{"text":"hello"}]',
    usage: null,
  });
});

it('cancels a malformed Channel and exposes no transport diagnostics', async () => {
  const harness = createHarness();
  const operation = harness.runner.run(harness.request);
  await flush();
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
  await flush();
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
